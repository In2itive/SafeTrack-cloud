-- Human-readable numbering, assigned by the database:
--   batch number        YYYY####          e.g. 20260001   (per church, per batch-date year)
--   transaction number  YYYY####NNNNNN    e.g. 20260001000001 (batch number + 6-digit sequence)
-- Numbers are permanent: never edited, never reused (deleted rows leave gaps,
-- and the audit log records why). UUIDs remain the internal keys.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.batches add column legacy_batch_number text;      -- number from the offline app, if imported
alter table public.batches add column last_txn_seq integer not null default 0;
alter table public.donations add column transaction_number text;

create table private.batch_counters (
  church_id uuid not null references public.churches (id) on delete cascade,
  year      integer not null,
  last_seq  integer not null default 0,
  primary key (church_id, year)
);
revoke all on private.batch_counters from public, anon, authenticated;
alter table private.batch_counters enable row level security;  -- no policies: triggers only

-- ---------------------------------------------------------------------------
-- Assign numbers
-- ---------------------------------------------------------------------------
create function private.assign_batch_number()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_year integer := extract(year from new.batch_date)::integer;
  v_seq  integer;
begin
  -- A number supplied on insert can only come from an import: keep it for reference.
  if new.batch_number is not null and new.batch_number !~ '^[0-9]{8}$' then
    new.legacy_batch_number := coalesce(new.legacy_batch_number, new.batch_number);
  end if;

  insert into private.batch_counters as c (church_id, year, last_seq)
  values (new.church_id, v_year, 1)
  on conflict (church_id, year) do update set last_seq = c.last_seq + 1
  returning last_seq into v_seq;

  if v_seq > 9999 then
    raise exception 'Batch numbers for % are exhausted (9999 per year)', v_year;
  end if;

  new.batch_number := v_year::text || lpad(v_seq::text, 4, '0');
  new.last_txn_seq := 0;
  return new;
end $$;

create trigger batches_number before insert on public.batches
  for each row execute function private.assign_batch_number();

-- Runs after the other donation BEFORE triggers (names sort alphabetically),
-- so the finalized-batch lock has already been checked.
create function private.assign_transaction_number()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch_number text;
  v_seq integer;
begin
  update public.batches set last_txn_seq = last_txn_seq + 1
  where id = new.batch_id
  returning batch_number, last_txn_seq into v_batch_number, v_seq;

  if v_seq > 999999 then
    raise exception 'Transaction numbers for batch % are exhausted', v_batch_number;
  end if;
  new.transaction_number := v_batch_number || lpad(v_seq::text, 6, '0');
  return new;
end $$;

create trigger donations_zz_transaction_number before insert on public.donations
  for each row execute function private.assign_transaction_number();

-- Numbers can't be changed once assigned (not even by the service role)
create function private.guard_numbers()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  -- (nested ifs: plpgsql doesn't short-circuit, and each table lacks the other's column)
  if tg_table_name = 'batches' then
    if new.batch_number is distinct from old.batch_number then
      raise exception 'Batch numbers cannot be changed';
    end if;
  else
    if new.transaction_number is distinct from old.transaction_number then
      raise exception 'Transaction numbers cannot be changed';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Backfill existing rows (before the immutability guard is switched on)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  perform set_config('safetrack.allow_locked_changes', 'on', true);

  -- Keep any previous identifier for reference
  update public.batches set legacy_batch_number = batch_number
  where legacy_batch_number is null and batch_number is not null;

  -- Batches: per church, per year, in date order
  for r in
    select id, church_id, extract(year from batch_date)::integer as yr,
           row_number() over (partition by church_id, extract(year from batch_date)
                              order by batch_date, created_at, id) as seq
    from public.batches
  loop
    update public.batches set batch_number = r.yr::text || lpad(r.seq::text, 4, '0') where id = r.id;
  end loop;

  insert into private.batch_counters (church_id, year, last_seq)
  select church_id, extract(year from batch_date)::integer, count(*)
  from public.batches group by 1, 2;

  -- Transactions: per batch, in screen order
  for r in
    select d.id, b.batch_number, d.batch_id,
           row_number() over (partition by d.batch_id order by d.sort_order, d.created_at, d.id) as seq
    from public.donations d join public.batches b on b.id = d.batch_id
  loop
    update public.donations set transaction_number = r.batch_number || lpad(r.seq::text, 6, '0') where id = r.id;
  end loop;

  update public.batches b set last_txn_seq = coalesce((select count(*) from public.donations d where d.batch_id = b.id), 0);

  perform set_config('safetrack.allow_locked_changes', 'off', true);
end $$;

alter table public.donations alter column transaction_number set not null;
alter table public.donations add constraint donations_church_transaction_number_uq unique (church_id, transaction_number);
alter table public.batches add constraint batches_number_format check (batch_number ~ '^[0-9]{8}$');

revoke execute on function private.guard_numbers() from public;
revoke execute on function private.assign_batch_number() from public;
revoke execute on function private.assign_transaction_number() from public;

create trigger batches_guard_number before update on public.batches
  for each row execute function private.guard_numbers();
create trigger donations_guard_number before update on public.donations
  for each row execute function private.guard_numbers();

-- ---------------------------------------------------------------------------
-- Privileges: numbers are server-assigned
-- ---------------------------------------------------------------------------
revoke insert, update on public.batches from authenticated;
grant insert (church_id, batch_date, source) on public.batches to authenticated;
grant update (batch_date, source) on public.batches to authenticated;

-- ---------------------------------------------------------------------------
-- Audit log: counter bumps are bookkeeping, not changes
-- ---------------------------------------------------------------------------
create or replace function private.write_audit_log()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old    jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new    jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row    jsonb := coalesce(v_new, v_old);
  v_church uuid;
  v_uid    uuid := (select auth.uid());
  v_name   text;
begin
  v_church := case when tg_table_name = 'churches' then (v_row ->> 'id')::uuid
                   else (v_row ->> 'church_id')::uuid end;

  v_old := v_old - 'bank_logo' - 'church_logo' - 'content_changed_at' - 'last_txn_seq';
  v_new := v_new - 'bank_logo' - 'church_logo' - 'content_changed_at' - 'last_txn_seq';
  if tg_op = 'UPDATE' and v_old = v_new then
    return null;
  end if;

  select m.display_name into v_name from public.church_members m
  where m.church_id = v_church and m.user_id = v_uid;

  insert into public.audit_log (church_id, table_name, record_id, action, actor_id, actor_name, old_data, new_data)
  values (v_church, tg_table_name,
          case when tg_table_name = 'church_members' then (v_row ->> 'user_id')::uuid
               when tg_table_name = 'church_settings' then v_church
               else (v_row ->> 'id')::uuid end,
          tg_op, v_uid, v_name, v_old, v_new);
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- save_batch no longer sends a batch number (the trigger assigns it)
-- ---------------------------------------------------------------------------
create or replace function public.save_batch(
  p_church_id      uuid,
  p_batch          jsonb,
  p_donations      jsonb,
  p_deleted_ids    uuid[] default '{}',
  p_new_giver_ids  uuid[] default '{}'
)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_batch   uuid := nullif(p_batch ->> 'id', '')::uuid;
  v_don     uuid;
  v_ids     uuid[] := '{}';
  d         jsonb;
  v_ord     integer := 0;
  v_old_splits jsonb;
  v_new_splits jsonb;
begin
  if v_batch is null then
    insert into public.batches (church_id, batch_date, source)
    values (p_church_id,
            coalesce((p_batch ->> 'batch_date')::date, current_date),
            coalesce((p_batch ->> 'source')::public.batch_source, 'in_person'))
    returning id into v_batch;
  else
    update public.batches
    set batch_date = coalesce((p_batch ->> 'batch_date')::date, batch_date),
        source     = coalesce((p_batch ->> 'source')::public.batch_source, source)
    where id = v_batch and church_id = p_church_id
      and (batch_date, source) is distinct from
          (coalesce((p_batch ->> 'batch_date')::date, batch_date),
           coalesce((p_batch ->> 'source')::public.batch_source, source));
    if not exists (select 1 from public.batches where id = v_batch and church_id = p_church_id and status = 'open') then
      raise exception 'Batch not found or already finalized';
    end if;
  end if;

  if coalesce(array_length(p_deleted_ids, 1), 0) > 0 then
    delete from public.donations where batch_id = v_batch and id = any (p_deleted_ids);
  end if;

  for d in select value from jsonb_array_elements(coalesce(p_donations, '[]'::jsonb)) loop
    v_ord := v_ord + 1;
    v_don := nullif(d ->> 'id', '')::uuid;

    if v_don is null then
      insert into public.donations (church_id, batch_id, giver_id, amount, payment_method,
                                    cheque_number, notes, cash_counts, sort_order)
      values (p_church_id, v_batch, (d ->> 'giver_id')::uuid, (d ->> 'amount')::numeric,
              (d ->> 'payment_method')::public.payment_method,
              nullif(d ->> 'cheque_number', ''), nullif(d ->> 'notes', ''),
              case when d -> 'cash_counts' = 'null'::jsonb then null else d -> 'cash_counts' end,
              v_ord)
      returning id into v_don;
    else
      update public.donations set
        giver_id = (d ->> 'giver_id')::uuid,
        amount = (d ->> 'amount')::numeric,
        payment_method = (d ->> 'payment_method')::public.payment_method,
        cheque_number = nullif(d ->> 'cheque_number', ''),
        notes = nullif(d ->> 'notes', ''),
        cash_counts = case when d -> 'cash_counts' = 'null'::jsonb then null else d -> 'cash_counts' end,
        sort_order = v_ord
      where id = v_don and batch_id = v_batch
        and (giver_id, amount, payment_method, cheque_number, notes, cash_counts, sort_order)
            is distinct from
            ((d ->> 'giver_id')::uuid, (d ->> 'amount')::numeric,
             (d ->> 'payment_method')::public.payment_method,
             nullif(d ->> 'cheque_number', ''), nullif(d ->> 'notes', ''),
             case when d -> 'cash_counts' = 'null'::jsonb then null else d -> 'cash_counts' end,
             v_ord);
      if not exists (select 1 from public.donations where id = v_don and batch_id = v_batch) then
        raise exception 'Donation % does not belong to this batch', v_don;
      end if;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('f', s.fund_id, 'i', s.internal_account_id, 'a', s.amount)
                              order by s.fund_id, s.internal_account_id, s.amount), '[]'::jsonb)
    into v_old_splits
    from public.donation_splits s where s.donation_id = v_don;

    select coalesce(jsonb_agg(jsonb_build_object('f', (x ->> 'fund_id')::uuid,
                                                 'i', nullif(x ->> 'internal_account_id', '')::uuid,
                                                 'a', (x ->> 'amount')::numeric(12, 2))
                              order by (x ->> 'fund_id')::uuid, nullif(x ->> 'internal_account_id', '')::uuid,
                                       (x ->> 'amount')::numeric(12, 2)), '[]'::jsonb)
    into v_new_splits
    from jsonb_array_elements(coalesce(d -> 'splits', '[]'::jsonb)) x
    where (x ->> 'amount')::numeric <> 0;

    if v_old_splits is distinct from v_new_splits then
      delete from public.donation_splits where donation_id = v_don;
      insert into public.donation_splits (church_id, donation_id, fund_id, internal_account_id, amount)
      select p_church_id, v_don, (x ->> 'fund_id')::uuid, nullif(x ->> 'internal_account_id', '')::uuid,
             (x ->> 'amount')::numeric
      from jsonb_array_elements(coalesce(d -> 'splits', '[]'::jsonb)) x
      where (x ->> 'amount')::numeric <> 0;
    end if;

    v_ids := v_ids || v_don;
  end loop;

  if coalesce(array_length(p_new_giver_ids, 1), 0) > 0 then
    update public.givers set created_in_batch_id = v_batch
    where church_id = p_church_id and id = any (p_new_giver_ids) and created_in_batch_id is null;
  end if;

  return jsonb_build_object('batch_id', v_batch, 'donation_ids', to_jsonb(v_ids));
end $$;

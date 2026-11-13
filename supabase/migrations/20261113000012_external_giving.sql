-- External giving: online gifts that arrive from a giving platform rather
-- than being counted by tellers.
--
-- Provider-agnostic by design. Pushpay (CSV export) is the first provider;
-- a Stripe module (webhook) or an e-Transfer bank-file import plugs into the
-- same pipeline:
--
--   provider data ──► external_transactions (staging, one row per gift,
--                     deduplicated on provider + external_id)
--                 ──► match giver + fund (remembered per provider)
--                 ──► post_external_batch(): one normal SafeTrack batch,
--                     source = provider, still finalized with two-person
--                     sign-off like any other batch.
--
-- The provider is identified by the existing batch_source enum, so a batch
-- created from Pushpay gifts is a 'pushpay' batch and one from Stripe gifts
-- is a 'stripe' batch.

-- ---------------------------------------------------------------------------
-- Enum additions (not referenced as literals below: new enum labels can't be
-- used in the transaction that adds them)
-- ---------------------------------------------------------------------------
alter type public.payment_method add value if not exists 'card';
alter type public.payment_method add value if not exists 'bank_debit';
alter type public.payment_method add value if not exists 'online';
alter type public.batch_source   add value if not exists 'stripe';

-- ---------------------------------------------------------------------------
-- Staging: one row per gift reported by a provider
-- ---------------------------------------------------------------------------
create table public.external_transactions (
  id                 uuid primary key default gen_random_uuid(),
  church_id          uuid not null references public.churches (id) on delete cascade,
  provider           public.batch_source not null check (provider <> 'in_person'),
  external_id        text not null check (length(trim(external_id)) > 0),
  gift_date          date not null,
  amount             numeric(12, 2) not null check (amount > 0),   -- gross
  fee                numeric(12, 2) not null default 0 check (fee >= 0),
  currency           text,
  payment_method     public.payment_method not null,
  status             text not null check (status in ('succeeded', 'pending', 'failed', 'refunded')),
  payer_external_id  text,
  payer_envelope     integer,       -- the church's envelope number, when the provider has it
  payer_first_name   text,
  payer_last_name    text,
  payer_name         text,
  payer_email        text,
  payer_phone        text,
  payer_address      text,
  fund_key           text,          -- the provider's fund code, or its name
  fund_name          text,
  memo               text,
  deposit_ref        text,          -- provider batch / deposit / payout id
  raw                jsonb not null default '{}'::jsonb,
  -- Resolution (set by the person reviewing the import)
  giver_id           uuid references public.givers (id) on delete set null,
  fund_id            uuid references public.funds (id) on delete set null,
  ignored            boolean not null default false,
  -- Set when posted. Deleting the donation (open batch only) releases the
  -- gift so it can be posted again.
  donation_id        uuid unique references public.donations (id) on delete set null,
  posted_at          timestamptz,
  staged_by          uuid references auth.users (id) on delete set null default auth.uid(),
  staged_at          timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (church_id, provider, external_id)
);
create index external_tx_church_open_idx on public.external_transactions (church_id, provider, gift_date)
  where donation_id is null;
create index external_tx_giver_idx on public.external_transactions (giver_id);
create index external_tx_fund_idx on public.external_transactions (fund_id);
create index external_tx_staged_by_idx on public.external_transactions (staged_by);

-- Remembered links: provider payer id -> giver, provider fund -> fund
create table public.giver_external_ids (
  church_id    uuid not null references public.churches (id) on delete cascade,
  provider     public.batch_source not null,
  external_id  text not null,
  giver_id     uuid not null references public.givers (id) on delete cascade,
  updated_at   timestamptz not null default now(),
  primary key (church_id, provider, external_id)
);
create index giver_external_ids_giver_idx on public.giver_external_ids (giver_id);

create table public.external_fund_map (
  church_id     uuid not null references public.churches (id) on delete cascade,
  provider      public.batch_source not null,
  external_key  text not null,      -- lower(trim(fund code or name))
  fund_id       uuid not null references public.funds (id) on delete cascade,
  updated_at    timestamptz not null default now(),
  primary key (church_id, provider, external_key)
);
create index external_fund_map_fund_idx on public.external_fund_map (fund_id);

-- ---------------------------------------------------------------------------
-- Privileges + RLS. Everyone in the church can see; administrators and
-- treasurers resolve and post. Staging and posting go through RPCs.
-- ---------------------------------------------------------------------------
revoke all on public.external_transactions, public.giver_external_ids, public.external_fund_map from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.external_transactions, public.giver_external_ids, public.external_fund_map from authenticated;
grant select on public.external_transactions, public.giver_external_ids, public.external_fund_map to authenticated;
grant update (giver_id, fund_id, ignored) on public.external_transactions to authenticated;

alter table public.external_transactions enable row level security;
alter table public.giver_external_ids   enable row level security;
alter table public.external_fund_map    enable row level security;

create policy external_tx_select on public.external_transactions for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy external_tx_update on public.external_transactions for update to authenticated
  using ((select private.has_role(church_id, array['administrator', 'treasurer']::public.member_role[]))
         and donation_id is null)
  with check ((select private.has_role(church_id, array['administrator', 'treasurer']::public.member_role[]))
              and donation_id is null);
create policy giver_external_ids_select on public.giver_external_ids for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy external_fund_map_select on public.external_fund_map for select to authenticated
  using (church_id in (select private.my_church_ids()));

-- Same-church integrity for the resolution columns
create function private.external_tx_same_church()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.giver_id is not null and not exists (
       select 1 from public.givers where id = new.giver_id and church_id = new.church_id) then
    raise exception 'Giver must belong to the same church';
  end if;
  if new.fund_id is not null and not exists (
       select 1 from public.funds where id = new.fund_id and church_id = new.church_id) then
    raise exception 'Fund must belong to the same church';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger external_tx_same_church before insert or update on public.external_transactions
  for each row execute function private.external_tx_same_church();

-- Ignoring a gift (or un-ignoring it) is control-relevant: audit it. The raw
-- provider payload is left out of the audit trail.
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

  v_old := v_old - 'bank_logo' - 'church_logo' - 'content_changed_at' - 'last_txn_seq' - 'raw' - 'updated_at';
  v_new := v_new - 'bank_logo' - 'church_logo' - 'content_changed_at' - 'last_txn_seq' - 'raw' - 'updated_at';
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

create trigger external_transactions_audit after update or delete on public.external_transactions
  for each row execute function private.write_audit_log();

-- ---------------------------------------------------------------------------
-- Staging. private.stage_external_transactions() is the single entry point
-- for every provider; it does no permission check of its own.
--   * public.stage_external_transactions()          browser (admin/treasurer)
--   * public.stage_external_transactions_server()   service role only, for a
--     webhook such as a future Stripe module
-- Row shape (snake_case): external_id, gift_date, amount, fee, currency,
-- payment_method, status, payer_external_id, payer_envelope, payer_first_name,
-- payer_last_name, payer_name, payer_email, payer_phone, payer_address,
-- fund_key, fund_name, memo, deposit_ref, raw
-- ---------------------------------------------------------------------------
create function private.stage_external_transactions(
  p_church_id uuid,
  p_provider  public.batch_source,
  p_rows      jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_posted   integer := 0;
  v_refunded_after_post integer := 0;
begin
  if p_provider = 'in_person' then
    raise exception 'in_person is not an external provider';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;

  create temp table if not exists pg_temp.ext_in (like public.external_transactions including defaults) on commit drop;
  truncate pg_temp.ext_in;

  insert into pg_temp.ext_in (id, church_id, provider, external_id, gift_date, amount, fee, currency,
                              payment_method, status, payer_external_id, payer_envelope, payer_first_name, payer_last_name,
                              payer_name, payer_email, payer_phone, payer_address, fund_key, fund_name,
                              memo, deposit_ref, raw)
  select distinct on (trim(r ->> 'external_id'))
         gen_random_uuid(), p_church_id, p_provider, trim(r ->> 'external_id'),
         (r ->> 'gift_date')::date, (r ->> 'amount')::numeric, coalesce(nullif(r ->> 'fee', '')::numeric, 0),
         nullif(r ->> 'currency', ''),
         (r ->> 'payment_method')::public.payment_method, r ->> 'status',
         nullif(trim(r ->> 'payer_external_id'), ''), nullif(trim(r ->> 'payer_envelope'), '')::integer,
         nullif(trim(r ->> 'payer_first_name'), ''),
         nullif(trim(r ->> 'payer_last_name'), ''), nullif(trim(r ->> 'payer_name'), ''),
         nullif(lower(trim(r ->> 'payer_email')), ''), nullif(trim(r ->> 'payer_phone'), ''),
         nullif(trim(r ->> 'payer_address'), ''), nullif(trim(r ->> 'fund_key'), ''),
         nullif(trim(r ->> 'fund_name'), ''), nullif(trim(r ->> 'memo'), ''),
         nullif(trim(r ->> 'deposit_ref'), ''), coalesce(r -> 'raw', '{}'::jsonb)
  from jsonb_array_elements(p_rows) r
  order by trim(r ->> 'external_id');

  -- Posted gifts are never rewritten; only a later refund is recorded.
  with u as (
    update public.external_transactions t set status = i.status
    from pg_temp.ext_in i
    where t.church_id = p_church_id and t.provider = p_provider and t.external_id = i.external_id
      and t.donation_id is not null and t.status is distinct from i.status
    returning t.status)
  select count(*) filter (where status = 'refunded') into v_refunded_after_post from u;

  select count(*) into v_posted
  from public.external_transactions t join pg_temp.ext_in i using (external_id)
  where t.church_id = p_church_id and t.provider = p_provider and t.donation_id is not null;

  -- Unposted gifts take the provider's latest data; resolutions are kept.
  with u as (
    update public.external_transactions t set
      gift_date = i.gift_date, amount = i.amount, fee = i.fee, currency = i.currency,
      payment_method = i.payment_method, status = i.status,
      payer_external_id = i.payer_external_id, payer_envelope = i.payer_envelope, payer_first_name = i.payer_first_name,
      payer_last_name = i.payer_last_name, payer_name = i.payer_name, payer_email = i.payer_email,
      payer_phone = i.payer_phone, payer_address = i.payer_address, fund_key = i.fund_key,
      fund_name = i.fund_name, memo = i.memo, deposit_ref = i.deposit_ref, raw = i.raw
    from pg_temp.ext_in i
    where t.church_id = p_church_id and t.provider = p_provider and t.external_id = i.external_id
      and t.donation_id is null
      and (t.gift_date, t.amount, t.fee, t.status, t.payment_method, t.raw)
          is distinct from (i.gift_date, i.amount, i.fee, i.status, i.payment_method, i.raw)
    returning 1)
  select count(*) into v_updated from u;

  with ins as (
    insert into public.external_transactions
      (church_id, provider, external_id, gift_date, amount, fee, currency, payment_method, status,
       payer_external_id, payer_envelope, payer_first_name, payer_last_name, payer_name, payer_email, payer_phone,
       payer_address, fund_key, fund_name, memo, deposit_ref, raw)
    select church_id, provider, external_id, gift_date, amount, fee, currency, payment_method, status,
           payer_external_id, payer_envelope, payer_first_name, payer_last_name, payer_name, payer_email, payer_phone,
           payer_address, fund_key, fund_name, memo, deposit_ref, raw
    from pg_temp.ext_in
    on conflict (church_id, provider, external_id) do nothing
    returning 1)
  select count(*) into v_inserted from ins;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'already_posted', v_posted, 'refunded_after_post', v_refunded_after_post);
end $$;

revoke all on function private.stage_external_transactions(uuid, public.batch_source, jsonb) from public, anon, authenticated;

create function public.stage_external_transactions(
  p_church_id uuid,
  p_provider  public.batch_source,
  p_rows      jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_role(p_church_id, array['administrator', 'treasurer']::public.member_role[]) then
    raise exception 'Only an administrator or treasurer can import gifts';
  end if;
  return private.stage_external_transactions(p_church_id, p_provider, p_rows);
end $$;

revoke execute on function public.stage_external_transactions(uuid, public.batch_source, jsonb) from public, anon;
grant execute on function public.stage_external_transactions(uuid, public.batch_source, jsonb) to authenticated;

create function public.stage_external_transactions_server(
  p_church_id uuid,
  p_provider  public.batch_source,
  p_rows      jsonb
)
returns jsonb
language sql security definer set search_path = ''
as $$ select private.stage_external_transactions(p_church_id, p_provider, p_rows) $$;

revoke execute on function public.stage_external_transactions_server(uuid, public.batch_source, jsonb)
  from public, anon, authenticated;
grant execute on function public.stage_external_transactions_server(uuid, public.batch_source, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Posting: turn resolved gifts into one SafeTrack batch, atomically.
-- The batch is an ordinary open batch; it still needs two-person sign-off.
-- ---------------------------------------------------------------------------
create function public.post_external_batch(
  p_church_id  uuid,
  p_provider   public.batch_source,
  p_ids        uuid[],
  p_batch_date date default null,
  -- Reviewer's choices, applied in the same transaction: [{id, giver_id, fund_id}]
  p_resolutions jsonb default '[]'::jsonb
)
returns jsonb               -- {batch_id, batch_number, count, total, fees}
language plpgsql security definer set search_path = ''
as $$
declare
  v_n       integer := coalesce(array_length(p_ids, 1), 0);
  v_found   integer;
  v_bad     text;
  v_batch   uuid;
  v_number  text;
  v_don     uuid;
  v_total   numeric(12, 2) := 0;
  v_fees    numeric(12, 2) := 0;
  v_ord     integer := 0;
  t         public.external_transactions;
  v_label   text := case p_provider::text when 'pushpay' then 'Pushpay'
                                          when 'stripe' then 'Stripe'
                                          when 'e_transfer' then 'e-Transfer'
                                          else p_provider::text end;
begin
  if not private.has_role(p_church_id, array['administrator', 'treasurer']::public.member_role[]) then
    raise exception 'Only an administrator or treasurer can post imported gifts';
  end if;
  if p_provider = 'in_person' then
    raise exception 'in_person is not an external provider';
  end if;
  if v_n = 0 then
    raise exception 'No gifts selected';
  end if;
  if v_n <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'Duplicate gifts in selection';
  end if;

  -- Lock and validate every selected gift
  perform 1 from public.external_transactions
  where id = any (p_ids) and church_id = p_church_id and provider = p_provider
  for update;
  get diagnostics v_found = row_count;
  if v_found <> v_n then
    raise exception 'One or more selected gifts were not found for this church and provider';
  end if;

  update public.external_transactions x set
    giver_id = coalesce(nullif(r ->> 'giver_id', '')::uuid, x.giver_id),
    fund_id  = coalesce(nullif(r ->> 'fund_id', '')::uuid, x.fund_id)
  from jsonb_array_elements(coalesce(p_resolutions, '[]'::jsonb)) r
  where x.id = (r ->> 'id')::uuid and x.id = any (p_ids) and x.donation_id is null;

  select string_agg(external_id || ': ' || reason, '; ') into v_bad from (
    select external_id,
           case when donation_id is not null then 'already posted'
                when ignored then 'ignored'
                when status <> 'succeeded' then 'status is ' || status
                when giver_id is null then 'no giver'
                when fund_id is null then 'no fund'
           end as reason
    from public.external_transactions where id = any (p_ids)) x
  where reason is not null;
  if v_bad is not null then
    raise exception 'Cannot post: %', v_bad;
  end if;

  insert into public.batches (church_id, batch_date, source)
  values (p_church_id,
          coalesce(p_batch_date, (select max(gift_date) from public.external_transactions where id = any (p_ids))),
          p_provider)
  returning id, batch_number into v_batch, v_number;

  for t in
    select * from public.external_transactions where id = any (p_ids)
    order by gift_date, payer_last_name nulls last, payer_first_name nulls last, external_id
  loop
    v_ord := v_ord + 1;
    insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, notes, sort_order)
    values (p_church_id, v_batch, t.giver_id, t.amount, t.payment_method,
            left(v_label || ' ' || t.external_id || coalesce(' — ' || t.memo, ''), 500), v_ord)
    returning id into v_don;

    insert into public.donation_splits (church_id, donation_id, fund_id, amount)
    values (p_church_id, v_don, t.fund_id, t.amount);

    update public.external_transactions set donation_id = v_don, posted_at = now() where id = t.id;

    if t.payer_external_id is not null then
      insert into public.giver_external_ids (church_id, provider, external_id, giver_id)
      values (p_church_id, p_provider, t.payer_external_id, t.giver_id)
      on conflict (church_id, provider, external_id)
      do update set giver_id = excluded.giver_id, updated_at = now();

      if p_provider::text = 'pushpay' then
        update public.givers set pushpay_id = t.payer_external_id
        where id = t.giver_id and not is_system and coalesce(pushpay_id, '') = '';
      end if;
    end if;

    if coalesce(t.fund_key, t.fund_name) is not null then
      insert into public.external_fund_map (church_id, provider, external_key, fund_id)
      values (p_church_id, p_provider, lower(trim(coalesce(t.fund_key, t.fund_name))), t.fund_id)
      on conflict (church_id, provider, external_key)
      do update set fund_id = excluded.fund_id, updated_at = now();
    end if;

    v_total := v_total + t.amount;
    v_fees  := v_fees + t.fee;
  end loop;

  return jsonb_build_object('batch_id', v_batch, 'batch_number', v_number,
                            'count', v_n, 'total', v_total, 'fees', v_fees);
end $$;

revoke execute on function public.post_external_batch(uuid, public.batch_source, uuid[], date, jsonb) from public, anon;
grant execute on function public.post_external_batch(uuid, public.batch_source, uuid[], date, jsonb) to authenticated;

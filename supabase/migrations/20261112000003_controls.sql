-- SafeTrack Cloud: integrity triggers and control RPCs
-- The dual-teller rule, the blind audit, and the finalized-batch lock are
-- enforced here, in the database — not in the browser.

-- ===========================================================================
-- Integrity triggers
-- ===========================================================================

-- Every child row must belong to the same church as the rows it points at.
create function private.enforce_same_church()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'donations' then
    if not exists (select 1 from public.batches where id = new.batch_id and church_id = new.church_id)
       or not exists (select 1 from public.givers where id = new.giver_id and church_id = new.church_id) then
      raise exception 'Batch and giver must belong to the same church as the donation';
    end if;
  elsif tg_table_name = 'donation_splits' then
    if not exists (select 1 from public.donations where id = new.donation_id and church_id = new.church_id)
       or not exists (select 1 from public.funds where id = new.fund_id and church_id = new.church_id)
       or (new.internal_account_id is not null and not exists (
             select 1 from public.internal_accounts where id = new.internal_account_id and church_id = new.church_id)) then
      raise exception 'Donation, fund and internal account must belong to the same church as the split';
    end if;
  elsif tg_table_name = 'givers' then
    if new.created_in_batch_id is not null and not exists (
         select 1 from public.batches where id = new.created_in_batch_id and church_id = new.church_id) then
      raise exception 'created_in_batch_id must reference a batch in the same church';
    end if;
  end if;
  return new;
end $$;

create trigger donations_same_church before insert or update on public.donations
  for each row execute function private.enforce_same_church();
create trigger splits_same_church before insert or update on public.donation_splits
  for each row execute function private.enforce_same_church();
create trigger givers_same_church before insert or update on public.givers
  for each row execute function private.enforce_same_church();

-- Finalized batches are immutable (even for the service role) until an
-- administrator unlocks them through unlock_batch().
create function private.guard_batch_contents()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch_id uuid;
  v_status   public.batch_status;
begin
  if current_setting('safetrack.allow_locked_changes', true) = 'on' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'donations' then
    v_batch_id := coalesce(new.batch_id, old.batch_id);
    -- Moving a donation between batches is never allowed.
    if tg_op = 'UPDATE' then
      if new.batch_id <> old.batch_id then
        raise exception 'Donations cannot be moved between batches';
      end if;
    end if;
  else
    select d.batch_id into v_batch_id
    from public.donations d where d.id = coalesce(new.donation_id, old.donation_id);
  end if;

  select status into v_status from public.batches where id = v_batch_id;
  if v_status = 'finalized' then
    raise exception 'Batch is finalized. An administrator must unlock it before changes can be made.';
  end if;

  if v_batch_id is not null then
    update public.batches set content_changed_at = clock_timestamp() where id = v_batch_id;
  end if;
  return coalesce(new, old);
end $$;

create trigger donations_guard before insert or update or delete on public.donations
  for each row execute function private.guard_batch_contents();
create trigger splits_guard before insert or update or delete on public.donation_splits
  for each row execute function private.guard_batch_contents();

create function private.guard_batch_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if current_setting('safetrack.allow_locked_changes', true) = 'on' then
    return new;
  end if;
  -- Only the control RPCs may change status/revision (they set the flag above).
  if new.status is distinct from old.status or new.revision is distinct from old.revision
     or new.finalized_at is distinct from old.finalized_at then
    raise exception 'Batch status can only be changed with finalize_batch() or unlock_batch()';
  end if;
  if old.status = 'finalized'
     and (new.batch_number, new.batch_date, new.source) is distinct from (old.batch_number, old.batch_date, old.source) then
    raise exception 'Batch is finalized. An administrator must unlock it before changes can be made.';
  end if;
  return new;
end $$;

create trigger batches_guard before update on public.batches
  for each row execute function private.guard_batch_row();

-- Envelope numbers: assign the next number when none is given; keep the
-- counter ahead of any number entered by hand.
create function private.assign_envelope_number()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_next integer;
begin
  if new.is_system then
    return new;
  end if;

  select next_envelope_number into v_next
  from public.church_settings where church_id = new.church_id
  for update;

  if new.envelope_number is null then
    -- skip any numbers already taken by hand-entered givers
    while exists (select 1 from public.givers where church_id = new.church_id and envelope_number = v_next) loop
      v_next := v_next + 1;
    end loop;
    new.envelope_number := v_next;
  end if;

  if new.envelope_number < 2 then
    raise exception 'Envelope numbers 0 and 1 are reserved (Loose Giving, Internal)';
  end if;

  update public.church_settings
  set next_envelope_number = greatest(v_next, new.envelope_number + 1)
  where church_id = new.church_id;
  return new;
end $$;

create trigger givers_envelope before insert on public.givers
  for each row execute function private.assign_envelope_number();

-- System funds keep their names (reports and the Internal-fund rule depend on them).
create function private.guard_system_fund()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.is_system and new.name is distinct from old.name then
    raise exception 'System funds cannot be renamed';
  end if;
  return new;
end $$;

create trigger funds_guard before update on public.funds
  for each row execute function private.guard_system_fund();

-- A church must always keep at least one active administrator.
create function private.guard_last_admin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_church uuid := coalesce(new.church_id, old.church_id);
begin
  if exists (select 1 from public.churches where id = v_church)
     and not exists (select 1 from public.church_members
                     where church_id = v_church and role = 'administrator' and is_active) then
    raise exception 'A church must keep at least one active administrator';
  end if;
  return null;
end $$;

create constraint trigger members_keep_admin
  after update or delete on public.church_members
  deferrable initially deferred
  for each row execute function private.guard_last_admin();

-- updated_at
create function private.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;

create trigger givers_touch before update on public.givers
  for each row execute function private.touch_updated_at();
create trigger settings_touch before update on public.church_settings
  for each row execute function private.touch_updated_at();

-- ===========================================================================
-- RPCs
-- ===========================================================================

-- Create a church; the caller becomes its first administrator.
create function public.create_church(p_name text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_church uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  insert into public.churches (name, created_by) values (trim(p_name), v_uid)
  returning id into v_church;

  insert into public.church_members (church_id, user_id, role, display_name)
  values (v_church, v_uid, 'administrator', trim(p_display_name));

  insert into public.church_settings (church_id) values (v_church);

  insert into public.funds (church_id, name, is_system, sort_order)
  select v_church, f.name, true, f.ord
  from unnest(array['General', 'Benevolent', 'Missions', 'Building', 'Capital', 'Interns', 'Internal'])
       with ordinality as f(name, ord);

  insert into public.givers (church_id, envelope_number, name, is_system) values
    (v_church, 0, 'Loose Giving', true),
    (v_church, 1, 'Internal', true);

  return v_church;
end $$;

-- A teller signs off on the current revision of an open batch. In a
-- two-teller session, the second teller's own signed-in session calls this
-- right before the first teller finalizes.
create function public.sign_batch(p_batch_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_b   public.batches;
  v_m   public.church_members;
begin
  select * into v_b from public.batches where id = p_batch_id;
  if not found then raise exception 'Batch not found'; end if;

  select * into v_m from public.church_members
  where church_id = v_b.church_id and user_id = v_uid and is_active;
  if not found then raise exception 'Batch not found'; end if;

  if v_b.status <> 'open' then
    raise exception 'Batch is already finalized';
  end if;

  insert into public.batch_signoffs (church_id, batch_id, revision, user_id, display_name, role)
  values (v_b.church_id, v_b.id, v_b.revision, v_uid, v_m.display_name, v_m.role)
  on conflict (batch_id, revision, user_id)
  do update set signed_at = now(), display_name = excluded.display_name, role = excluded.role;
end $$;

-- Blind audit + dual control + lock, in one transaction.
create function public.finalize_batch(
  p_batch_id      uuid,
  p_cash_counts   jsonb,
  p_cheque_count  integer,
  p_cheque_total  numeric
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_b            public.batches;
  v_settings     public.church_settings;
  v_items        integer;
  v_total        numeric(12, 2);
  v_chq_count    integer;
  v_chq_total    numeric(12, 2);
  v_signers      integer;
  v_admin_signed boolean;
  v_allowed_denoms numeric[] := array[100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05];
begin
  select * into v_b from public.batches where id = p_batch_id for update;
  if not found or not private.has_role(v_b.church_id,
       array['administrator', 'treasurer', 'envelope', 'teller']::public.member_role[]) then
    raise exception 'Batch not found';
  end if;
  if v_b.status <> 'open' then
    raise exception 'Batch is already finalized';
  end if;

  select * into v_settings from public.church_settings where church_id = v_b.church_id;

  -- 1. Batch has content
  select count(*), coalesce(sum(amount), 0) into v_items, v_total
  from public.donations where batch_id = v_b.id;
  if v_items = 0 then
    raise exception 'Batch has no donations';
  end if;

  -- 2. Every donation's fund splits add up to its amount
  if exists (
    select 1 from public.donations d
    left join (select donation_id, sum(amount) as s from public.donation_splits group by donation_id) x
      on x.donation_id = d.id
    where d.batch_id = v_b.id and coalesce(x.s, 0) <> d.amount) then
    raise exception 'One or more donations have fund splits that do not add up to the donation amount';
  end if;

  -- 3. Internal-fund splits name an internal account
  if exists (
    select 1 from public.donation_splits s
    join public.donations d on d.id = s.donation_id
    join public.funds f on f.id = s.fund_id
    where d.batch_id = v_b.id and f.is_system and lower(f.name) = 'internal'
      and s.internal_account_id is null) then
    raise exception 'Internal fund allocations must have an internal account code';
  end if;

  -- 4. Each cash row's denomination count equals its amount
  if exists (
    select 1 from public.donations d
    where d.batch_id = v_b.id and d.payment_method = 'cash'
      and (select coalesce(sum(e.key::numeric * e.value::numeric), 0)
           from jsonb_each_text(d.cash_counts) e) <> d.amount) then
    raise exception 'One or more cash donations have denomination counts that do not match the amount';
  end if;

  -- 5. Blind cash audit: physical count matches the system, denomination by denomination
  if jsonb_typeof(p_cash_counts) <> 'object' then
    raise exception 'Cash audit must be an object of denomination -> quantity';
  end if;
  if exists (
    select 1 from jsonb_each_text(p_cash_counts) e
    where e.key !~ '^[0-9]+(\.[0-9]+)?$'
       or not (e.key::numeric = any (v_allowed_denoms))
       or e.value !~ '^[0-9]+$') then
    raise exception 'Cash audit contains an unknown denomination or an invalid quantity';
  end if;
  if exists (
    with sys as (
      select e.key::numeric as denom, sum(e.value::integer) as qty
      from public.donations d, jsonb_each_text(d.cash_counts) e
      where d.batch_id = v_b.id and d.payment_method = 'cash'
      group by 1),
    aud as (
      select e.key::numeric as denom, sum(e.value::integer) as qty
      from jsonb_each_text(p_cash_counts) e
      group by 1)
    select 1 from sys full join aud using (denom)
    where coalesce(sys.qty, 0) <> coalesce(aud.qty, 0)) then
    raise exception 'Cash audit does not balance';
  end if;

  -- 6. Blind cheque audit
  select count(*), coalesce(sum(amount), 0) into v_chq_count, v_chq_total
  from public.donations where batch_id = v_b.id and payment_method = 'cheque';
  if coalesce(p_cheque_count, -1) <> v_chq_count or coalesce(p_cheque_total, -1) <> v_chq_total then
    raise exception 'Cheque audit does not balance';
  end if;

  -- 7. Dual control. The caller signs now; any other sign-off must be on
  --    this revision and newer than the last change to the batch contents.
  perform public.sign_batch(v_b.id);

  select count(distinct s.user_id), coalesce(bool_or(s.role = 'administrator'), false)
  into v_signers, v_admin_signed
  from public.batch_signoffs s
  where s.batch_id = v_b.id
    and s.revision = v_b.revision
    and s.signed_at >= v_b.content_changed_at;

  if v_b.revision = 1 then
    if not (v_signers >= 2 or (v_admin_signed and v_settings.allow_admin_solo_finalize)) then
      raise exception 'Two different tellers must sign off before this batch can be finalized';
    end if;
  else
    -- Re-finalizing after an admin unlock requires an administrator
    if not v_admin_signed then
      raise exception 'An administrator must sign off on an adjusted batch';
    end if;
    if not v_settings.allow_admin_solo_finalize and v_signers < 2 then
      raise exception 'Two different users must sign off before this batch can be finalized';
    end if;
  end if;

  -- 8. Lock it
  perform set_config('safetrack.allow_locked_changes', 'on', true);
  update public.batches set status = 'finalized', finalized_at = now() where id = v_b.id;
  perform set_config('safetrack.allow_locked_changes', 'off', true);

  insert into public.batch_finalizations
    (church_id, batch_id, revision, finalized_by, audit_cash_counts,
     audit_cheque_count, audit_cheque_total, system_total)
  values
    (v_b.church_id, v_b.id, v_b.revision, v_uid, p_cash_counts,
     p_cheque_count, p_cheque_total, v_total);
end $$;

-- Administrator unlocks a finalized batch for adjustment. History is kept:
-- the original sign-offs and finalization stay, the revision goes up.
create function public.unlock_batch(p_batch_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_b public.batches;
begin
  select * into v_b from public.batches where id = p_batch_id for update;
  if not found or not private.is_admin(v_b.church_id) then
    raise exception 'Only an administrator can unlock a batch';
  end if;
  if v_b.status <> 'finalized' then
    raise exception 'Batch is not finalized';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to unlock a finalized batch';
  end if;

  insert into public.batch_unlocks (church_id, batch_id, from_revision, unlocked_by, reason)
  values (v_b.church_id, v_b.id, v_b.revision, (select auth.uid()), trim(p_reason));

  perform set_config('safetrack.allow_locked_changes', 'on', true);
  update public.batches
  set status = 'open', revision = revision + 1, finalized_at = null,
      content_changed_at = clock_timestamp()
  where id = v_b.id;
  perform set_config('safetrack.allow_locked_changes', 'off', true);
end $$;

-- SMTP settings: admins can write them and see everything except the password.
create function public.set_smtp_settings(
  p_church_id uuid, p_host text, p_port integer, p_username text,
  p_password text, p_from_address text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin(p_church_id) then
    raise exception 'Only an administrator can change email settings';
  end if;
  insert into private.church_smtp (church_id, host, port, username, password, from_address)
  values (p_church_id, p_host, p_port, p_username, coalesce(p_password, ''), p_from_address)
  on conflict (church_id) do update set
    host = excluded.host, port = excluded.port, username = excluded.username,
    -- null password = keep the existing one
    password = coalesce(p_password, private.church_smtp.password),
    from_address = excluded.from_address, updated_at = now();
end $$;

create function public.get_smtp_settings(p_church_id uuid)
returns table (host text, port integer, username text, from_address text, has_password boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin(p_church_id) then
    raise exception 'Only an administrator can view email settings';
  end if;
  return query
    select s.host, s.port, s.username, s.from_address, length(s.password) > 0
    from private.church_smtp s where s.church_id = p_church_id;
end $$;

-- Lock down: RPCs callable by signed-in users only; trigger functions by nobody.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_church(text, text) to authenticated;
grant execute on function public.sign_batch(uuid) to authenticated;
grant execute on function public.finalize_batch(uuid, jsonb, integer, numeric) to authenticated;
grant execute on function public.unlock_batch(uuid, text) to authenticated;
grant execute on function public.set_smtp_settings(uuid, text, integer, text, text, text) to authenticated;
grant execute on function public.get_smtp_settings(uuid) to authenticated;

revoke execute on function private.enforce_same_church() from public;
revoke execute on function private.guard_batch_contents() from public;
revoke execute on function private.guard_batch_row() from public;
revoke execute on function private.assign_envelope_number() from public;
revoke execute on function private.guard_system_fund() from public;
revoke execute on function private.guard_last_admin() from public;
revoke execute on function private.touch_updated_at() from public;

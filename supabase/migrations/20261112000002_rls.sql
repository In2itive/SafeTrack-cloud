-- SafeTrack Cloud: row-level security
-- Rule of thumb: a signed-in user sees only rows for churches they are an
-- active member of. Controls tables (sign-offs, finalizations, unlocks) are
-- read-only from the browser; only security-definer RPCs write them.

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so policies don't recurse into RLS)
-- ---------------------------------------------------------------------------
create function private.my_church_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.church_id
  from public.church_members m
  where m.user_id = (select auth.uid()) and m.is_active
$$;

create function private.has_role(p_church uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.church_members m
    where m.church_id = p_church
      and m.user_id = (select auth.uid())
      and m.is_active
      and m.role = any (p_roles)
  )
$$;

create function private.is_admin(p_church uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_role(p_church, array['administrator']::public.member_role[])
$$;

grant usage on schema private to authenticated;
grant execute on function private.my_church_ids() to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_admin(uuid) to authenticated;
revoke all on private.church_smtp from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Baseline privileges: nothing for anon; column-scoped writes for authenticated
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on public.batch_totals from anon;
-- TRUNCATE ignores RLS; nobody outside the service role gets it.
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- churches: only the name is editable; rows are created by create_church()
revoke insert, update, delete on public.churches from authenticated;
grant update (name) on public.churches to authenticated;

-- church_members: admins manage role/name/active; adding members goes via RPC
revoke insert, update on public.church_members from authenticated;
grant update (role, display_name, is_active) on public.church_members to authenticated;

-- church_settings: row is created by create_church(); envelope counter is
-- editable (admins set the starting number) but church_id is not
revoke insert, delete, update on public.church_settings from authenticated;
grant update (next_envelope_number, allow_admin_solo_finalize,
              accounting_recipients, envelope_recipients, deposit_recipients,
              bank_logo, account_of, branch_number, account_number,
              church_logo, church_address_line1, church_address_line2,
              church_address_line3) on public.church_settings to authenticated;

-- funds: no deletes (deactivate instead, so history keeps resolving)
revoke delete, update on public.funds from authenticated;
grant update (name, is_active, sort_order) on public.funds to authenticated;

revoke delete, update on public.internal_accounts from authenticated;
grant update (code, is_active) on public.internal_accounts to authenticated;

-- givers: is_system and church_id are never client-writable
revoke insert, update on public.givers from authenticated;
grant insert (church_id, envelope_number, name, name2, email, email2,
              address1, address2, address3, etransfer_id, etransfer_id2,
              pushpay_id, created_in_batch_id) on public.givers to authenticated;
grant update (envelope_number, name, name2, email, email2, address1, address2,
              address3, etransfer_id, etransfer_id2, pushpay_id)
  on public.givers to authenticated;

-- batches: status / revision / finalized_at change only through RPCs
revoke insert, update on public.batches from authenticated;
grant insert (church_id, batch_number, batch_date, source) on public.batches to authenticated;
grant update (batch_number, batch_date, source) on public.batches to authenticated;

-- donations / splits: church_id and parent ids are fixed after insert
revoke update on public.donations from authenticated;
grant update (giver_id, amount, payment_method, cheque_number, notes,
              cash_counts, sort_order) on public.donations to authenticated;
revoke update on public.donation_splits from authenticated;
grant update (fund_id, internal_account_id, amount) on public.donation_splits to authenticated;

-- controls tables: read-only from the client
revoke insert, update, delete on public.batch_signoffs from authenticated;
revoke insert, update, delete on public.batch_finalizations from authenticated;
revoke insert, update, delete on public.batch_unlocks from authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.churches            enable row level security;
alter table public.church_members      enable row level security;
alter table public.church_settings     enable row level security;
alter table public.funds               enable row level security;
alter table public.internal_accounts   enable row level security;
alter table public.givers              enable row level security;
alter table public.batches             enable row level security;
alter table public.donations           enable row level security;
alter table public.donation_splits     enable row level security;
alter table public.batch_signoffs      enable row level security;
alter table public.batch_finalizations enable row level security;
alter table public.batch_unlocks       enable row level security;
alter table private.church_smtp        enable row level security;  -- no policies: deny all

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- churches
create policy churches_select on public.churches for select to authenticated
  using (id in (select private.my_church_ids()));
create policy churches_update on public.churches for update to authenticated
  using ((select private.is_admin(id))) with check ((select private.is_admin(id)));

-- church_members
create policy members_select on public.church_members for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy members_update on public.church_members for update to authenticated
  using ((select private.is_admin(church_id))) with check ((select private.is_admin(church_id)));
create policy members_delete on public.church_members for delete to authenticated
  using ((select private.is_admin(church_id)));

-- church_settings
create policy settings_select on public.church_settings for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy settings_update on public.church_settings for update to authenticated
  using ((select private.is_admin(church_id))) with check ((select private.is_admin(church_id)));

-- funds (admin-managed)
create policy funds_select on public.funds for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy funds_insert on public.funds for insert to authenticated
  with check ((select private.is_admin(church_id)) and not is_system);
create policy funds_update on public.funds for update to authenticated
  using ((select private.is_admin(church_id))) with check ((select private.is_admin(church_id)));

-- internal accounts (tellers may add a code while entering a batch)
create policy internal_select on public.internal_accounts for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy internal_insert on public.internal_accounts for insert to authenticated
  with check (church_id in (select private.my_church_ids()));
create policy internal_update on public.internal_accounts for update to authenticated
  using ((select private.is_admin(church_id))) with check ((select private.is_admin(church_id)));

-- givers (any member can register/edit; system givers are read-only)
create policy givers_select on public.givers for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy givers_insert on public.givers for insert to authenticated
  with check (church_id in (select private.my_church_ids()));
create policy givers_update on public.givers for update to authenticated
  using (church_id in (select private.my_church_ids()) and not is_system)
  with check (church_id in (select private.my_church_ids()) and not is_system);
create policy givers_delete on public.givers for delete to authenticated
  using ((select private.is_admin(church_id)) and not is_system);

-- batches
create policy batches_select on public.batches for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy batches_insert on public.batches for insert to authenticated
  with check (church_id in (select private.my_church_ids()));
create policy batches_update on public.batches for update to authenticated
  using (church_id in (select private.my_church_ids()) and status = 'open')
  with check (church_id in (select private.my_church_ids()) and status = 'open');
create policy batches_delete on public.batches for delete to authenticated
  using ((select private.is_admin(church_id)) and status = 'open');

-- donations: only while the parent batch is open
create policy donations_select on public.donations for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy donations_insert on public.donations for insert to authenticated
  with check (
    church_id in (select private.my_church_ids())
    and exists (select 1 from public.batches b
                where b.id = batch_id and b.church_id = donations.church_id and b.status = 'open'));
create policy donations_update on public.donations for update to authenticated
  using (
    church_id in (select private.my_church_ids())
    and exists (select 1 from public.batches b
                where b.id = batch_id and b.status = 'open'))
  with check (church_id in (select private.my_church_ids()));
create policy donations_delete on public.donations for delete to authenticated
  using (
    church_id in (select private.my_church_ids())
    and exists (select 1 from public.batches b
                where b.id = batch_id and b.status = 'open'));

-- donation splits: only while the grandparent batch is open
create policy splits_select on public.donation_splits for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy splits_insert on public.donation_splits for insert to authenticated
  with check (
    church_id in (select private.my_church_ids())
    and exists (select 1 from public.donations d join public.batches b on b.id = d.batch_id
                where d.id = donation_id and d.church_id = donation_splits.church_id
                  and b.status = 'open'));
create policy splits_update on public.donation_splits for update to authenticated
  using (
    church_id in (select private.my_church_ids())
    and exists (select 1 from public.donations d join public.batches b on b.id = d.batch_id
                where d.id = donation_id and b.status = 'open'))
  with check (church_id in (select private.my_church_ids()));
create policy splits_delete on public.donation_splits for delete to authenticated
  using (
    church_id in (select private.my_church_ids())
    and exists (select 1 from public.donations d join public.batches b on b.id = d.batch_id
                where d.id = donation_id and b.status = 'open'));

-- controls: readable by members, written only by RPCs
create policy signoffs_select on public.batch_signoffs for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy finalizations_select on public.batch_finalizations for select to authenticated
  using (church_id in (select private.my_church_ids()));
create policy unlocks_select on public.batch_unlocks for select to authenticated
  using (church_id in (select private.my_church_ids()));

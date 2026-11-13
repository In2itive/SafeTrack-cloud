-- SafeTrack Cloud: append-only audit log
-- Every insert/update/delete on church data is recorded with who did it and
-- the before/after values. Nobody can edit or delete entries from the app.

create table public.audit_log (
  id          bigint generated always as identity primary key,
  church_id   uuid not null,
  table_name  text not null,
  record_id   uuid,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id    uuid,
  actor_name  text,
  at          timestamptz not null default now(),
  old_data    jsonb,
  new_data    jsonb
);
create index audit_log_church_at_idx on public.audit_log (church_id, at desc);
create index audit_log_record_idx on public.audit_log (record_id);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon;
revoke insert, update, delete, truncate, references, trigger on public.audit_log from authenticated;

create policy audit_select on public.audit_log for select to authenticated
  using ((select private.has_role(church_id,
           array['administrator', 'treasurer']::public.member_role[])));

create function private.write_audit_log()
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

  -- Logos are large data URLs and add nothing to an audit trail.
  -- content_changed_at is bookkeeping bumped on every donation edit.
  v_old := v_old - 'bank_logo' - 'church_logo' - 'content_changed_at';
  v_new := v_new - 'bank_logo' - 'church_logo' - 'content_changed_at';
  if tg_op = 'UPDATE' and v_old = v_new then
    return null;  -- e.g. only a logo or the change stamp moved
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

revoke execute on function private.write_audit_log() from public;

do $$
declare
  t text;
begin
  foreach t in array array['churches', 'church_members', 'church_settings', 'funds',
                           'internal_accounts', 'givers', 'batches', 'donations',
                           'donation_splits']
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function private.write_audit_log()',
      t || '_audit', t);
  end loop;
end $$;

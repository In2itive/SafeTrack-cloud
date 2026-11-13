-- Sign-offs are compared against content_changed_at, which uses
-- clock_timestamp(). now() is frozen at transaction start, so a sign-off made
-- later in the same transaction as an edit would look older than the edit.
-- Use the real clock for both.
alter table public.batch_signoffs alter column signed_at set default clock_timestamp();

create or replace function public.sign_batch(p_batch_id uuid)
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

  insert into public.batch_signoffs (church_id, batch_id, revision, user_id, display_name, role, signed_at)
  values (v_b.church_id, v_b.id, v_b.revision, v_uid, v_m.display_name, v_m.role, clock_timestamp())
  on conflict (batch_id, revision, user_id)
  do update set signed_at = clock_timestamp(), display_name = excluded.display_name, role = excluded.role;
end $$;

-- The email server needs a church's SMTP credentials. The private schema isn't
-- exposed over the API, so this function hands them to the service role only.
-- Browsers (anon / authenticated) cannot execute it.

create function public.get_smtp_for_server(p_church_id uuid)
returns table (host text, port integer, username text, password text, from_address text)
language sql stable security definer set search_path = ''
as $$
  select s.host, s.port, s.username, s.password, s.from_address
  from private.church_smtp s where s.church_id = p_church_id
$$;

revoke execute on function public.get_smtp_for_server(uuid) from public, anon, authenticated;
grant execute on function public.get_smtp_for_server(uuid) to service_role;

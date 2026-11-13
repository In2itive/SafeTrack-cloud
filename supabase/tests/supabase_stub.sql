-- Minimal stand-in for Supabase's auth schema and roles, so migrations and
-- tests can run against plain Postgres. Not applied to Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- Minimal stand-in for Supabase Vault (encrypted secrets). Plain text here; tests only.
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    create schema vault;
    create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique,
      description text default '', secret text not null, updated_at timestamptz default now());
    create view vault.decrypted_secrets as
      select id, name, description, secret, secret as decrypted_secret, updated_at from vault.secrets;
    create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
      returns uuid language sql as $f$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $f$;
    create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
      returns void language sql as $f$ update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name), updated_at = now() where id = secret_id $f$;
    revoke all on schema vault from public;
  end if;
end $$;

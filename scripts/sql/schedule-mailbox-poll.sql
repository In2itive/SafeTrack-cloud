-- Run once per Supabase project (not a migration: the URL is project-specific).
-- Calls the mailbox-poll Edge Function every 10 minutes. The shared secret
-- lives in Vault (created by migration 14); the function checks it.
-- Replace <PROJECT_REF> before running.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('safetrack-mailbox-poll')
where exists (select 1 from cron.job where jobname = 'safetrack-mailbox-poll');

select cron.schedule('safetrack-mailbox-poll', '*/10 * * * *', $job$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/mailbox-poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-poll-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'safetrack_mailbox_poll_secret')),
    body    := '{"action":"poll"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);

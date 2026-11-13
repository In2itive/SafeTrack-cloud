-- Automatic e-Transfer intake: mailbox settings (Vault), inbox log, review
-- flags, strict auto-matching, weekly auto-batches.

\set QUIET on
\pset tuples_only on
\pset format unaligned
\set ON_ERROR_STOP on

create function pg_temp.expect_error(p_stmts text[], p_pattern text, p_label text)
returns void language plpgsql as $$
declare s text;
begin
  begin
    foreach s in array p_stmts loop execute s; end loop;
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception 'FAIL [%]: expected error ~ "%", got "%"', p_label, p_pattern, sqlerrm;
    end if;
    raise notice 'ok  %', p_label;
    return;
  end;
  raise exception 'FAIL [%]: expected an error, statement succeeded', p_label;
end $$;

create function pg_temp.expect_eq(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok  %', p_label;
end $$;

-- a gift row + its email, as the Edge Function sends them
create function pg_temp.gift(p_ref text, p_date text, p_amount numeric, p_email text, p_env integer, p_memo text,
                             p_flags text[] default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('external_id', p_ref, 'gift_date', p_date, 'amount', p_amount, 'fee', 0,
    'payment_method', 'e_transfer', 'status', 'succeeded', 'payer_external_id', p_email, 'payer_email', p_email,
    'payer_envelope', p_env, 'payer_name', 'Someone', 'memo', p_memo, 'memo_raw', '  ' || p_memo || '  ',
    'review_flags', to_jsonb(p_flags), 'raw', jsonb_build_object('reference', p_ref))
$$;
create function pg_temp.msg(p_key text) returns jsonb language sql as $$
  select jsonb_build_object('message_key', p_key, 'received_at', '2026-11-08T15:00:00Z',
    'from', 'notify@payments.interac.ca', 'subject', 'INTERAC e-Transfer', 'raw', 'RAW EMAIL ' || p_key)
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'm1@m.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'm2@m.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'm3@m.test');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
select public.create_church('Church M', 'Max Admin') as church \gset
reset role;
insert into public.church_members (church_id, user_id, role, display_name) values
  (:'church', '00000000-0000-0000-0000-0000000000d2', 'treasurer', 'Tess Treasurer'),
  (:'church', '00000000-0000-0000-0000-0000000000d3', 'teller', 'Tom Teller');
insert into public.givers (church_id, envelope_number, name, etransfer_id) values (:'church', 100, 'John Smith', 'john@x.com') returning id as g_john \gset
insert into public.givers (church_id, envelope_number, name, email) values (:'church', 101, 'Sam Lee', 'sam@x.com') returning id as g_sam \gset
insert into public.givers (church_id, envelope_number, name) values (:'church', 102, 'Ann Nguyen') returning id as g_ann \gset
select id as f_general from public.funds where church_id = :'church' and name = 'General' \gset
select id as f_building from public.funds where church_id = :'church' and name = 'Building' \gset

-- ---------- mailbox settings ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d3';
select pg_temp.expect_error(array[format('select public.set_mailbox_settings(%L, ''{"kind":"imap"}'', ''pw'')', :'church')],
  'administrator', 'a teller cannot set the mailbox');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
select public.set_mailbox_settings(:'church',
  '{"kind":"imap","enabled":true,"imap_host":"mail.church.example","imap_username":"giving@church.example","since_date":"2026-11-01"}',
  'S3cret-App-Password');
select pg_temp.expect_eq((select (public.get_mailbox_settings(:'church') ->> 'has_secret') || ' ' ||
                                 (public.get_mailbox_settings(:'church') ? 'secret') || ' ' ||
                                 (public.get_mailbox_settings(:'church') ->> 'imap_port')),
  'true false 993', 'settings saved; secret never returned');
select pg_temp.expect_error(array[format('select public.set_mailbox_settings(%L, ''{"kind":"imap","time_zone":"Mars/Base"}'')', :'church')],
  'Unknown time zone', 'time zone validated');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.expect_eq((public.get_mailbox_settings(:'church') ->> 'imap_host'), 'mail.church.example', 'treasurer can read settings');
select pg_temp.expect_error(array[format('select * from public.mailboxes_due_server(%L)', :'church')],
  'permission denied', 'browser users cannot read the mailbox secret');
select pg_temp.expect_error(array['select public.mailbox_poll_secret_server()'], 'permission denied', 'browser users cannot read the poll secret');
reset role;

set role service_role;
select pg_temp.expect_eq((select secret from public.mailboxes_due_server() where church_id = :'church'), 'S3cret-App-Password',
  'server reads the secret from Vault');
select pg_temp.expect_eq((select length(public.mailbox_poll_secret_server()) >= 32)::text, 'true', 'poll secret generated');

-- ---------- intake ----------
select pg_temp.expect_eq((public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m1'),
  pg_temp.gift('CA0000000001', '2026-11-08', 100, 'john@x.com', 100, 'Tithe env 100')) ->> 'status'), 'staged', 'email 1 staged');
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m2'),
  pg_temp.gift('CA0000000002', '2026-11-07', 40, 'ann@x.com', 102, 'Building'));
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m3'),
  pg_temp.gift('CA0000000003', '2026-11-08', 500, 'stranger@x.com', 100, 'env 100'));
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m4'),
  pg_temp.gift('CA0000000004', '2026-11-08', 25, 'who@x.com', 999, 'env 999'));
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m5'),
  pg_temp.gift('CA0000000005', '2026-11-08', 60, 'sam@x.com', null, 'Youth trip'));
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m6'),
  pg_temp.gift('CA0000000006', '2026-11-08', 15, 'sam@x.com', null, 'thanks', array['not_from_interac']));
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m7'),
  pg_temp.gift('CA0000000007', '2026-11-12', 30, 'sam@x.com', null, ''));
select pg_temp.expect_eq((public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m1'),
  pg_temp.gift('CA0000000001', '2026-11-08', 100, 'john@x.com', 100, 'Tithe env 100')) ->> 'status'), 'duplicate', 'same email read twice: ignored');
select pg_temp.expect_eq((public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m1-fwd'),
  pg_temp.gift('CA0000000001', '2026-11-08', 100, 'john@x.com', 100, 'Tithe env 100')) ->> 'status'), 'duplicate', 'same e-Transfer in a second email: duplicate');
select pg_temp.expect_eq((public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m-req'), null,
  'Not a deposit (request)') ->> 'status'), 'skipped', 'non-deposit email logged as skipped');
select pg_temp.expect_eq((select status || ':' || raw from public.inbound_messages where church_id = :'church' and message_key = 'm-req'),
  'skipped:RAW EMAIL m-req', 'skipped email kept raw');
select pg_temp.expect_eq((select memo_raw from public.external_transactions where church_id = :'church' and external_id = 'CA0000000001'),
  '  Tithe env 100  ', 'memo kept exactly as sent');

-- ---------- auto-post ----------
select public.auto_post_external_server(:'church', 'e_transfer') as auto \gset
select pg_temp.expect_eq((:'auto'::jsonb ->> 'posted') || '/' || (:'auto'::jsonb ->> 'held_for_review'), '3/4', '3 posted, 4 held for review');
select pg_temp.expect_eq((select string_agg(external_id || '=' || array_to_string(review_flags || match_flags, '+'), ',' order by external_id)
                          from public.external_transactions where church_id = :'church' and donation_id is null),
  'CA0000000003=envelope_email_mismatch,CA0000000004=envelope_not_found,CA0000000005=fund_unclear,CA0000000006=not_from_interac',
  'each held gift says why');
select pg_temp.expect_eq((select string_agg(b.batch_date::text || ' ' || b.source || ' ' || b.status || ' ' || b.auto_batch_key || ' n=' ||
                                 (select count(*) from public.donations d where d.batch_id = b.id), ', ' order by b.batch_date)
                          from public.batches b where b.church_id = :'church'),
  '2026-11-08 e_transfer open e_transfer:2026-11-02 n=2, 2026-11-15 e_transfer open e_transfer:2026-11-09 n=1',
  'weekly batches, dated the Sunday, still open');
select pg_temp.expect_eq((select string_agg(g.name || ':' || f.name, ',' order by g.name)
                          from public.external_transactions t join public.givers g on g.id = t.giver_id
                          join public.donations d on d.id = t.donation_id join public.donation_splits s on s.donation_id = d.id
                          join public.funds f on f.id = s.fund_id
                          where t.church_id = :'church'),
  'Ann Nguyen:Building,John Smith:General,Sam Lee:General', 'givers by envelope / email; funds from memo, General when memo says nothing');
select pg_temp.expect_eq((select d.notes from public.donations d join public.external_transactions t on t.donation_id = d.id
                          where t.external_id = 'CA0000000001'), 'e-Transfer CA0000000001 —   Tithe env 100  ', 'donation note carries the exact memo');
select pg_temp.expect_eq((select etransfer_id from public.givers where id = :'g_ann'), 'ann@x.com', 'Ann''s e-Transfer email learned');

-- fix the registry, run again: the mismatch clears and posts into the same week's batch
reset role;
update public.givers set etransfer_id2 = 'stranger@x.com' where id = :'g_john';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d3';
select pg_temp.expect_error(array[format('select public.auto_post_external(%L, ''e_transfer'')', :'church')],
  'administrator or treasurer', 'a teller cannot run auto-post');
select pg_temp.expect_eq((select count(*)::text from public.inbound_messages where church_id = :'church'), '0', 'a teller cannot read raw emails');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.expect_eq((select count(*)::text from public.inbound_messages where church_id = :'church'), '9', 'treasurer sees the inbox log');
select pg_temp.expect_eq((public.auto_post_external(:'church', 'e_transfer') ->> 'posted'), '1', 'fixed gift posts on the next run');
select pg_temp.expect_eq((select count(*)::text from public.donations d join public.batches b on b.id = d.batch_id
                          where b.church_id = :'church' and b.auto_batch_key = 'e_transfer:2026-11-02'), '3', 'appended to the open weekly batch');

-- finalize that week; a late gift for the same week opens a new batch
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d3';
select id as wk from public.batches where church_id = :'church' and auto_batch_key = 'e_transfer:2026-11-02' \gset
select public.sign_batch(:'wk');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d2';
select public.finalize_batch(:'wk', '{}', 0, 0);
reset role;
set role service_role;
select public.ingest_inbound_email_server(:'church', 'e_transfer', 'imap', pg_temp.msg('m8'),
  pg_temp.gift('CA0000000008', '2026-11-08', 20, 'john@x.com', null, 'general'));
select public.auto_post_external_server(:'church', 'e_transfer');
select pg_temp.expect_eq((select count(*)::text from public.batches where church_id = :'church' and auto_batch_key = 'e_transfer:2026-11-02'),
  '2', 'late gift after finalizing opens a second batch for that week');

-- cursor + status
select public.mailbox_poll_result_server(:'church', '{"imap_uid_validity": 7, "imap_last_uid": 42}', null, '{"fetched": 9}');
reset role;
select pg_temp.expect_eq((select imap_uid_validity || '/' || imap_last_uid || '/' || (last_error is null) || '/' || (last_result ->> 'fetched')
                          from private.church_mailboxes where church_id = :'church'), '7/42/true/9', 'cursor and status saved');

-- changing the mailbox resets the cursor
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
select public.set_mailbox_settings(:'church', '{"kind":"imap","enabled":true,"imap_host":"mail.church.example","imap_username":"other@church.example"}');
reset role;
select pg_temp.expect_eq((select imap_last_uid::text || ' ' || (secret_id is not null) from private.church_mailboxes where church_id = :'church'),
  '0 true', 'new mailbox: cursor reset, secret kept');

\echo
\echo E-TRANSFER MAILBOX TESTS PASSED

-- SafeTrack Cloud: tenant isolation + dual-control tests.
-- Run against plain Postgres after supabase_stub.sql and all migrations:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/controls_test.sql
-- Any failed expectation raises and stops the run.

\set QUIET on
\pset tuples_only on
\pset format unaligned
\set ON_ERROR_STOP on

-- ---------- helpers ----------
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

-- users: A1 admin of A, A2/A3 tellers of A, B1 admin of B
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@a.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'a2@a.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'a3@a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'b1@b.test');

-- ---------- church creation ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.create_church('Church A', 'Alice Admin') as church_a \gset
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select public.create_church('Church B', 'Bob Admin') as church_b \gset
reset role;

-- add tellers to A (an invite RPC/edge function comes later)
insert into public.church_members (church_id, user_id, role, display_name) values
  (:'church_a', '00000000-0000-0000-0000-0000000000a2', 'teller', 'Tina Teller'),
  (:'church_a', '00000000-0000-0000-0000-0000000000a3', 'teller', 'Tom Teller');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.expect_eq((select count(*)::text from public.funds where church_id = :'church_a'), '7', 'seeded 7 system funds');
select pg_temp.expect_eq((select string_agg(envelope_number || ':' || name, ',' order by envelope_number)
                          from public.givers where church_id = :'church_a'), '0:Loose Giving,1:Internal', 'seeded system givers');

-- ---------- tenant isolation ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.expect_eq((select count(*)::text from public.churches), '1', 'B sees only its own church');
select pg_temp.expect_eq((select count(*)::text from public.givers where church_id = :'church_a'), '0', 'B cannot read A givers');
select pg_temp.expect_eq((select count(*)::text from public.funds where church_id = :'church_a'), '0', 'B cannot read A funds');
select pg_temp.expect_error(array[format(
  'insert into public.givers (church_id, name) values (%L, ''Intruder'')', :'church_a')],
  'row-level security', 'B cannot insert a giver into A');

-- ---------- givers + envelope numbers ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
insert into public.givers (church_id, name) values (:'church_a', 'Jane Doe') returning id as giver_jane \gset
select pg_temp.expect_eq((select envelope_number::text from public.givers where id = :'giver_jane'), '100', 'first envelope auto-assigned 100');
insert into public.givers (church_id, envelope_number, name) values (:'church_a', 250, 'John Smith');
insert into public.givers (church_id, name) values (:'church_a', 'Next Person') returning envelope_number as env_next \gset
select pg_temp.expect_eq(:'env_next', '251', 'counter jumps past hand-entered #250');
select pg_temp.expect_error(array[format(
  'insert into public.givers (church_id, envelope_number, name) values (%L, 0, ''Fake Loose'')', :'church_a')],
  'reserved', 'envelope 0/1 reserved');
select pg_temp.expect_eq((select count(*)::text from public.givers where church_id = :'church_a' and is_system), '2', 'tellers cannot touch system givers (still 2)');
update public.givers set name = 'Hacked' where church_id = :'church_a' and envelope_number = 0;
select pg_temp.expect_eq((select name from public.givers where church_id = :'church_a' and envelope_number = 0), 'Loose Giving', 'system giver not editable');

-- ---------- build a batch ----------
select id as fund_general from public.funds where church_id = :'church_a' and name = 'General' \gset
select id as fund_internal from public.funds where church_id = :'church_a' and name = 'Internal' \gset
insert into public.internal_accounts (church_id, code) values (:'church_a', 'YOUTH-01') returning id as acct \gset
insert into public.batches (church_id, batch_number) values (:'church_a', '2026-11-15-A') returning id as batch \gset

insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, cash_counts)
values (:'church_a', :'batch', :'giver_jane', 50, 'cash', '{"20": 2, "10": 1}') returning id as don_cash \gset
insert into public.donation_splits (church_id, donation_id, fund_id, amount) values (:'church_a', :'don_cash', :'fund_general', 50);

insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, cheque_number)
values (:'church_a', :'batch', :'giver_jane', 100, 'cheque', '123') returning id as don_chq \gset
insert into public.donation_splits (church_id, donation_id, fund_id, amount) values (:'church_a', :'don_chq', :'fund_general', 60);
insert into public.donation_splits (church_id, donation_id, fund_id, internal_account_id, amount)
  values (:'church_a', :'don_chq', :'fund_internal', :'acct', 40);

-- deletes work while open (and the guard trigger handles DELETE rows)
insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, cheque_number)
values (:'church_a', :'batch', :'giver_jane', 5, 'cheque', 'tmp') returning id as don_tmp \gset
insert into public.donation_splits (church_id, donation_id, fund_id, amount) values (:'church_a', :'don_tmp', :'fund_general', 5);
delete from public.donation_splits where donation_id = :'don_tmp';
delete from public.donations where id = :'don_tmp';
select pg_temp.expect_eq((select count(*)::text from public.donations where id = :'don_tmp'), '0', 'delete donation + split while open');
select pg_temp.expect_eq((select total_amount::text || '/' || item_count from public.batch_totals where batch_id = :'batch'), '150.00/2', 'batch_totals view');
select pg_temp.expect_error(array[format(
  'insert into public.donations (church_id, batch_id, giver_id, amount, payment_method) values (%L, %L, %L, 5, ''cheque'')',
  :'church_a', :'batch', :'giver_jane')], 'cheque_needs_number', 'cheque needs a number');
select pg_temp.expect_error(array[format(
  'update public.batches set status = ''finalized'' where id = %L', :'batch')],
  'permission denied', 'cannot set status directly');

-- ---------- dual control ----------
select pg_temp.expect_error(array[format(
  'select public.finalize_batch(%L, ''{"20":2,"10":1}'', 1, 100)', :'batch')],
  'Two different tellers', 'one teller alone cannot finalize');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select public.sign_batch(:'batch');

-- A2 edits after A3 signed: A3's sign-off must no longer count
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_sleep(0.01);
update public.donations set notes = 'edited after sign-off' where id = :'don_chq';
select pg_temp.expect_error(array[format(
  'select public.finalize_batch(%L, ''{"20":2,"10":1}'', 1, 100)', :'batch')],
  'Two different tellers', 'stale sign-off (signed before an edit) does not count');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select pg_sleep(0.01);
select public.sign_batch(:'batch');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.expect_error(array[format(
  'select public.finalize_batch(%L, ''{"20":1,"10":3}'', 1, 100)', :'batch')],
  'Cash audit does not balance', 'same cash total, wrong denominations -> rejected');
select pg_temp.expect_error(array[format(
  'select public.finalize_batch(%L, ''{"20":2,"10":1}'', 1, 99.99)', :'batch')],
  'Cheque audit does not balance', 'wrong cheque total -> rejected');
select pg_temp.expect_error(array[format(
  'select public.finalize_batch(%L, ''{"20":2,"10":1,"3":1}'', 1, 100)', :'batch')],
  'unknown denomination', 'bogus denomination -> rejected');
select public.finalize_batch(:'batch', '{"20":2,"10":1}', 1, 100);
select pg_temp.expect_eq((select status::text from public.batches where id = :'batch'), 'finalized', 'two tellers + balanced audit -> finalized');
select pg_temp.expect_eq((select string_agg(display_name, ',' order by display_name) from public.batch_signoffs where batch_id = :'batch'),
                         'Tina Teller,Tom Teller', 'sign-offs recorded');

-- ---------- lock ----------
update public.donations set amount = 1 where id = :'don_cash';
select pg_temp.expect_eq((select amount::text from public.donations where id = :'don_cash'), '50.00', 'finalized donation not editable');
select pg_temp.expect_error(array[format(
  'insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, cheque_number) values (%L, %L, %L, 5, ''cheque'', ''9'')',
  :'church_a', :'batch', :'giver_jane')], 'row-level security|finalized', 'cannot add to finalized batch');
reset role;
select pg_temp.expect_error(array[format('update public.donations set amount = 1 where id = %L', :'don_cash')],
  'finalized', 'even the database owner cannot edit a finalized batch');
select pg_temp.expect_error(array[format('delete from public.donation_splits where donation_id = %L', :'don_cash')],
  'finalized', 'even the database owner cannot delete from a finalized batch');
set role authenticated;

-- ---------- unlock / adjustment ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.expect_error(array[format('select public.unlock_batch(%L, ''oops'')', :'batch')],
  'Only an administrator', 'teller cannot unlock');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.expect_error(array[format('select public.unlock_batch(%L, '' '')', :'batch')],
  'reason is required', 'unlock needs a reason');
select public.unlock_batch(:'batch', 'Cheque 123 was actually $110');
select pg_temp.expect_eq((select status || '/r' || revision from public.batches where id = :'batch'), 'open/r2', 'unlocked -> open, revision 2');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
update public.donations set amount = 110 where id = :'don_chq';
update public.donation_splits set amount = 70 where donation_id = :'don_chq' and fund_id = :'fund_general';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select pg_sleep(0.01);
select public.sign_batch(:'batch');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.expect_error(array[format(
  'select public.finalize_batch(%L, ''{"20":2,"10":1}'', 1, 110)', :'batch')],
  'administrator must sign', 'adjusted batch needs an admin sign-off');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.finalize_batch(:'batch', '{"20":2,"10":1}', 1, 110);
select pg_temp.expect_eq((select string_agg('r' || revision || ':' || display_name, ',' order by revision, display_name)
                          from public.batch_signoffs where batch_id = :'batch'),
  'r1:Tina Teller,r1:Tom Teller,r2:Alice Admin,r2:Tom Teller',
  'original r1 sign-offs kept; failed attempt left no sign-off; r2 = admin + teller');
select pg_temp.expect_eq((select count(*)::text from public.batch_finalizations where batch_id = :'batch'), '2', 'both finalizations on record');

-- ---------- cross-church RPC abuse ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.expect_error(array[format('select public.unlock_batch(%L, ''x'')', :'batch')],
  'Only an administrator', 'B admin cannot unlock A batch');
select pg_temp.expect_error(array[format('select public.sign_batch(%L)', :'batch')],
  'not found', 'B cannot sign A batch');

-- ---------- audit log ----------
select pg_temp.expect_eq((select count(*)::text from public.audit_log where church_id = :'church_a'), '0', 'B cannot read A audit log');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.expect_eq((select count(*)::text from public.audit_log), '0', 'tellers cannot read the audit log');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.expect_eq((select (count(*) > 0)::text from public.audit_log
                          where table_name = 'donations' and action = 'UPDATE'
                            and old_data ->> 'amount' = '100.00' and new_data ->> 'amount' = '110.00'),
                         'true', 'audit log captured the $100 -> $110 adjustment');
select pg_temp.expect_error(array['delete from public.audit_log'], 'permission denied', 'audit log cannot be deleted');

-- ---------- admin safety ----------
select pg_temp.expect_error(array[
  'set constraints all immediate',
  format('update public.church_members set role = ''teller'' where church_id = %L and user_id = %L',
         :'church_a', '00000000-0000-0000-0000-0000000000a1')],
  'at least one active administrator', 'last admin cannot demote themselves');

-- ---------- privilege hardening ----------
select pg_temp.expect_error(array['truncate public.givers'], 'permission denied', 'no TRUNCATE (would bypass RLS)');
select pg_temp.expect_error(array['select * from private.church_smtp'], 'permission denied', 'SMTP table unreachable from client');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.expect_error(array[format('select * from public.get_smtp_settings(%L)', :'church_a')],
  'Only an administrator', 'teller cannot read SMTP settings');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.set_smtp_settings(:'church_a', 'smtp.example.com', 587, 'user', 's3cret', 'reports@a.test');
select pg_temp.expect_eq((select host || '/' || has_password from public.get_smtp_settings(:'church_a')),
                         'smtp.example.com/true', 'admin sees SMTP settings without the password');

reset role;
set role anon;
select pg_temp.expect_error(array['select * from public.givers'], 'permission denied', 'anonymous users get nothing');
select pg_temp.expect_error(array['select public.create_church(''x'', ''y'')'], 'permission denied', 'anonymous cannot create a church');
reset role;

-- ---------- regression: edit + admin solo finalize in ONE transaction ----------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into public.batches (church_id, batch_number) values (:'church_a', 'SAME-TXN') returning id as b2 \gset
insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, cheque_number)
values (:'church_a', :'b2', :'giver_jane', 25, 'cheque', '42') returning id as d2 \gset
insert into public.donation_splits (church_id, donation_id, fund_id, amount) values (:'church_a', :'d2', :'fund_general', 25);
select public.finalize_batch(:'b2', '{}', 1, 25);
select pg_temp.expect_eq((select status::text from public.batches where id = :'b2'), 'finalized', 'admin solo finalize works even in the same transaction as the edits');
commit;

\echo
\echo ALL TESTS PASSED

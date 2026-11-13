-- External giving (Pushpay now, Stripe later): staging, dedupe, posting,
-- permissions and tenant isolation. Self-contained: makes its own churches.

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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@e.test'),   -- admin of E
  ('00000000-0000-0000-0000-0000000000e2', 'e2@e.test'),   -- teller of E
  ('00000000-0000-0000-0000-0000000000e3', 'e3@e.test'),   -- treasurer of E
  ('00000000-0000-0000-0000-0000000000f1', 'f1@f.test');   -- admin of F

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
select public.create_church('Church E', 'Erin Admin') as church_e \gset
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
select public.create_church('Church F', 'Fred Admin') as church_f \gset
reset role;
insert into public.church_members (church_id, user_id, role, display_name) values
  (:'church_e', '00000000-0000-0000-0000-0000000000e2', 'teller', 'Ted Teller'),
  (:'church_e', '00000000-0000-0000-0000-0000000000e3', 'treasurer', 'Tara Treasurer');

\set rows '[{"external_id":"PP-1","gift_date":"2026-11-08","amount":"100.00","fee":"2.50","payment_method":"card","status":"succeeded","payer_external_id":"P-77","payer_first_name":"Mary","payer_last_name":"Jones","payer_email":"Mary@Example.com","fund_key":"Tithes","fund_name":"Tithes","raw":{"a":1}},{"external_id":"PP-2","gift_date":"2026-11-08","amount":"50","fee":"0.50","payment_method":"bank_debit","status":"succeeded","payer_first_name":"Sam","payer_last_name":"Lee","fund_name":"Missions"},{"external_id":"PP-3","gift_date":"2026-11-09","amount":"20","payment_method":"card","status":"failed","payer_first_name":"Al","payer_last_name":"Fail","fund_name":"Tithes"},{"external_id":"PP-1","gift_date":"2026-11-08","amount":"100.00","fee":"2.50","payment_method":"card","status":"succeeded","payer_first_name":"Mary","payer_last_name":"Jones","fund_name":"Tithes"}]'

-- ---------- permissions ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e2';
select pg_temp.expect_error(array[format('select public.stage_external_transactions(%L, ''pushpay'', %L)', :'church_e', :'rows')],
  'administrator or treasurer', 'a teller cannot import gifts');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.expect_error(array[format('select public.stage_external_transactions(%L, ''pushpay'', %L)', :'church_e', :'rows')],
  'administrator or treasurer', 'another church''s admin cannot import into E');
select pg_temp.expect_error(array[format('select public.stage_external_transactions_server(%L, ''pushpay'', %L)', :'church_e', :'rows')],
  'permission denied', 'browser users cannot call the server staging entry point');

-- ---------- staging + dedupe ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e3';
select pg_temp.expect_eq((select public.stage_external_transactions(:'church_e', 'pushpay', :'rows') ->> 'inserted'), '3',
  'treasurer stages 3 gifts (duplicate row in the file collapsed)');
select pg_temp.expect_eq((select public.stage_external_transactions(:'church_e', 'pushpay', :'rows') ->> 'inserted'), '0',
  're-importing the same file adds nothing');
select pg_temp.expect_eq((select payer_email from public.external_transactions where church_id = :'church_e' and external_id = 'PP-1'),
  'mary@example.com', 'email normalised to lower case');
select pg_temp.expect_error(array[format('select public.stage_external_transactions(%L, ''in_person'', %L)', :'church_e', :'rows')],
  'not an external provider', 'in_person is not a provider');
select pg_temp.expect_error(array[format(
  'select public.stage_external_transactions(%L, ''pushpay'', ''[{"external_id":"X","gift_date":"2026-11-01","amount":"0","payment_method":"card","status":"succeeded"}]'')', :'church_e')],
  'amount_check', 'zero amounts are rejected');

-- the same external id can exist for a different provider
select pg_temp.expect_eq((select public.stage_external_transactions(:'church_e', 'stripe',
  '[{"external_id":"PP-1","gift_date":"2026-11-08","amount":"10","payment_method":"card","status":"succeeded"}]') ->> 'inserted'), '1',
  'ids are unique per provider, not globally');

-- ---------- tenant isolation ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.expect_eq((select count(*)::text from public.external_transactions where church_id = :'church_e'), '0',
  'church F cannot see church E gifts');
select id as fund_f from public.funds where church_id = :'church_f' and name = 'General' \gset

-- ---------- resolve + post ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e3';
select id as tx1 from public.external_transactions where church_id = :'church_e' and provider = 'pushpay' and external_id = 'PP-1' \gset
select id as tx2 from public.external_transactions where church_id = :'church_e' and provider = 'pushpay' and external_id = 'PP-2' \gset
select id as tx3 from public.external_transactions where church_id = :'church_e' and provider = 'pushpay' and external_id = 'PP-3' \gset
select id as fund_gen from public.funds where church_id = :'church_e' and name = 'General' \gset
select id as fund_mis from public.funds where church_id = :'church_e' and name = 'Missions' \gset
insert into public.givers (church_id, name, email) values (:'church_e', 'Mary Jones', 'mary@example.com') returning id as g_mary \gset
insert into public.givers (church_id, name) values (:'church_e', 'Sam Lee') returning id as g_sam \gset

select pg_temp.expect_error(array[format('select public.post_external_batch(%L, ''pushpay'', array[%L]::uuid[])', :'church_e', :'tx1')],
  'no giver', 'cannot post an unresolved gift');

update public.external_transactions set giver_id = :'g_mary', fund_id = :'fund_gen' where id = :'tx1';
select pg_temp.expect_error(array[format('update public.external_transactions set fund_id = %L where id = %L', :'fund_f', :'tx1')],
  'same church', 'cannot map a gift to another church''s fund');
select pg_temp.expect_error(array[format('update public.external_transactions set amount = 1 where id = %L', :'tx1')],
  'permission denied', 'gift amounts are not editable');
select pg_temp.expect_error(array[format('select public.post_external_batch(%L, ''pushpay'', array[%L, %L]::uuid[])', :'church_e', :'tx1', :'tx3')],
  'status is failed', 'failed gifts cannot be posted');
select pg_temp.expect_error(array[format('select public.post_external_batch(%L, ''pushpay'', array[%L]::uuid[], null, %L)', :'church_e', :'tx2',
  jsonb_build_array(jsonb_build_object('id', :'tx2', 'giver_id', :'g_sam', 'fund_id', :'fund_f')))],
  'same church', 'resolutions are checked too (no cross-church fund)');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e2';
update public.external_transactions set ignored = true where id = :'tx1';
select pg_temp.expect_eq((select ignored::text from public.external_transactions where id = :'tx1'), 'false', 'a teller cannot ignore a gift');
select pg_temp.expect_error(array[format('select public.post_external_batch(%L, ''pushpay'', array[%L]::uuid[])', :'church_e', :'tx1')],
  'administrator or treasurer', 'a teller cannot post');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e3';
select public.post_external_batch(:'church_e', 'pushpay', array[:'tx1', :'tx2']::uuid[], null,
  jsonb_build_array(jsonb_build_object('id', :'tx2', 'giver_id', :'g_sam', 'fund_id', :'fund_mis'))) as posted \gset
select (:'posted'::jsonb ->> 'batch_id') as pbatch \gset
select pg_temp.expect_eq((select giver_id::text from public.external_transactions where id = :'tx2'), :'g_sam', 'resolutions applied at post time');
select pg_temp.expect_eq((:'posted'::jsonb ->> 'total') || '/' || (:'posted'::jsonb ->> 'fees') || '/' || (:'posted'::jsonb ->> 'count'),
  '150.00/3.00/2', 'posted batch totals gross, fees and count');
select pg_temp.expect_eq((select source::text || ' ' || status::text || ' ' || batch_date::text from public.batches where id = :'pbatch'),
  'pushpay open 2026-11-08', 'batch is an open pushpay batch dated by the gifts');
select pg_temp.expect_eq((select string_agg(payment_method::text || ':' || amount || ':' || (transaction_number is not null)::text, ',' order by sort_order)
                          from public.donations where batch_id = :'pbatch'),
  'card:100.00:true,bank_debit:50.00:true', 'donations carry method, amount and a transaction number');
select pg_temp.expect_eq((select count(*)::text from public.donation_splits s join public.donations d on d.id = s.donation_id
                          where d.batch_id = :'pbatch' and s.amount = d.amount), '2', 'one full-amount split per gift');
select pg_temp.expect_eq((select giver_id::text from public.giver_external_ids where church_id = :'church_e' and provider = 'pushpay' and external_id = 'P-77'),
  :'g_mary', 'payer id remembered for next time');
select pg_temp.expect_eq((select pushpay_id from public.givers where id = :'g_mary'), 'P-77', 'giver registry picks up the Pushpay ID');
select pg_temp.expect_eq((select fund_id::text from public.external_fund_map where church_id = :'church_e' and provider = 'pushpay' and external_key = 'tithes'),
  :'fund_gen', 'fund mapping remembered for next time');
select pg_temp.expect_error(array[format('select public.post_external_batch(%L, ''pushpay'', array[%L]::uuid[])', :'church_e', :'tx1')],
  'already posted', 'a gift can only be posted once');
update public.external_transactions set giver_id = null where id = :'tx1';
select pg_temp.expect_eq((select giver_id::text from public.external_transactions where id = :'tx1'), :'g_mary', 'posted gift unchanged');

-- re-staging after posting records a refund but never rewrites the gift
select pg_temp.expect_eq((select public.stage_external_transactions(:'church_e', 'pushpay',
  '[{"external_id":"PP-1","gift_date":"2026-11-08","amount":"999","payment_method":"card","status":"refunded"}]') ->> 'refunded_after_post'), '1',
  'refund after posting is flagged');
select pg_temp.expect_eq((select amount::text || ' ' || status from public.external_transactions where id = :'tx1'), '100.00 refunded',
  'posted amount kept, status updated');

-- ---------- the posted batch goes through normal controls ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e2';
select public.sign_batch(:'pbatch');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e3';
select public.finalize_batch(:'pbatch', '{}', 0, 0);
select pg_temp.expect_eq((select status::text from public.batches where id = :'pbatch'), 'finalized',
  'electronic batch finalizes with an empty cash/cheque audit after two sign-offs');

-- ---------- deleting an open batch releases its gifts ----------
update public.external_transactions set giver_id = :'g_sam', fund_id = :'fund_gen'
  where church_id = :'church_e' and provider = 'stripe' and external_id = 'PP-1';
select id as tx_s from public.external_transactions where church_id = :'church_e' and provider = 'stripe' and external_id = 'PP-1' \gset
select (public.post_external_batch(:'church_e', 'stripe', array[:'tx_s']::uuid[]) ->> 'batch_id') as sbatch \gset
select pg_temp.expect_eq((select source::text from public.batches where id = :'sbatch'), 'stripe', 'a second provider posts the same way');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
delete from public.batches where id = :'sbatch';
select pg_temp.expect_eq((select (donation_id is null)::text from public.external_transactions where id = :'tx_s'), 'true',
  'deleting the batch makes its gifts available again');

-- ---------- ignore is audited ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e3';
update public.external_transactions set ignored = true where id = :'tx3';
reset role;
select pg_temp.expect_eq((select count(*)::text from public.audit_log
                          where table_name = 'external_transactions' and record_id = :'tx3'
                            and (new_data ->> 'ignored') = 'true' and not (new_data ? 'raw')), '1',
  'ignoring a gift is in the audit log (without the raw payload)');

\echo
\echo EXTERNAL GIVING TESTS PASSED

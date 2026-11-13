-- Automatic e-Transfer intake: read the church's mailbox (IMAP now, Microsoft
-- 365 / Graph later), keep every email raw, flag anything doubtful, and
-- post confident gifts into an open weekly batch that still needs two-person
-- sign-off.
--
--   mailbox-poll Edge Function (service role)
--     -> public.mailboxes_due_server()          which mailboxes to read (+ secret)
--     -> public.ingest_inbound_email_server()   store raw email, stage the gift
--     -> public.auto_post_external_server()     match + post confident gifts
--     -> public.mailbox_poll_result_server()    save cursor / last error

-- ---------------------------------------------------------------------------
-- Gifts: review flags, exact memo, link to the email they came from
-- ---------------------------------------------------------------------------
alter table public.external_transactions
  add column review_flags  text[] not null default '{}',   -- problems found in the email itself
  add column match_flags   text[] not null default '{}',   -- problems matching it (recomputed each run)
  add column memo_raw      text,                           -- memo exactly as sent
  add column inbound_message_id uuid,
  add column auto_posted   boolean not null default false;

-- ---------------------------------------------------------------------------
-- Inbox log: every email the poller fetched, kept raw, with what happened
-- ---------------------------------------------------------------------------
create table public.inbound_messages (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches (id) on delete cascade,
  provider      public.batch_source not null,
  source        text not null check (source in ('imap', 'graph', 'forward', 'upload')),
  message_key   text not null,               -- Message-ID, or a hash of the raw email
  received_at   timestamptz,
  from_address  text,
  subject       text,
  raw           text not null check (length(raw) <= 2000000),
  status        text not null check (status in ('staged', 'duplicate', 'skipped', 'error')),
  reason        text,
  external_transaction_id uuid references public.external_transactions (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (church_id, message_key)
);
create index inbound_messages_church_created_idx on public.inbound_messages (church_id, created_at desc);
create index inbound_messages_tx_idx on public.inbound_messages (external_transaction_id);

alter table public.external_transactions
  add constraint external_tx_inbound_fk foreign key (inbound_message_id)
  references public.inbound_messages (id) on delete set null;
create index external_tx_inbound_idx on public.external_transactions (inbound_message_id);

revoke all on public.inbound_messages from anon;
revoke insert, update, delete, truncate, references, trigger on public.inbound_messages from authenticated;
grant select on public.inbound_messages to authenticated;
alter table public.inbound_messages enable row level security;
-- Raw emails hold personal data: administrators and treasurers only.
create policy inbound_messages_select on public.inbound_messages for select to authenticated
  using ((select private.has_role(church_id, array['administrator', 'treasurer']::public.member_role[])));

-- ---------------------------------------------------------------------------
-- Weekly auto-batches
-- ---------------------------------------------------------------------------
alter table public.batches add column auto_batch_key text;   -- e.g. 'e_transfer:2026-11-02' (week start)
create unique index batches_open_auto_key_uq on public.batches (church_id, auto_batch_key)
  where status = 'open' and auto_batch_key is not null;

-- ---------------------------------------------------------------------------
-- Mailbox connection (one per church). Password / client secret in Vault.
-- ---------------------------------------------------------------------------
create table private.church_mailboxes (
  church_id         uuid primary key references public.churches (id) on delete cascade,
  kind              text not null check (kind in ('imap', 'graph')),
  enabled           boolean not null default false,
  auto_post         boolean not null default true,
  time_zone         text not null default 'America/Toronto',
  since_date        date not null default (current_date - 14),   -- ignore older mail
  sender_filter     text default 'payments.interac.ca',           -- '' = every message in the folder
  imap_host         text,
  imap_port         integer default 993 check (imap_port between 1 and 65535),
  imap_tls          boolean not null default true,
  imap_username     text,
  imap_folder       text not null default 'INBOX',
  graph_tenant_id   text,
  graph_client_id   text,
  graph_mailbox     text,
  graph_folder      text not null default 'inbox',
  secret_id         uuid,                                          -- vault.secrets
  -- cursor
  imap_uid_validity bigint,
  imap_last_uid     bigint not null default 0,
  graph_last_received timestamptz,
  -- status
  last_polled_at    timestamptz,
  last_success_at   timestamptz,
  last_error        text,
  last_result       jsonb,
  updated_at        timestamptz not null default now()
);
revoke all on private.church_mailboxes from public, anon, authenticated;
alter table private.church_mailboxes enable row level security;  -- no policies: RPCs only

-- Admin: save settings. The secret is write-only (Vault); pass null to keep it.
create function public.set_mailbox_settings(p_church_id uuid, p_settings jsonb, p_secret text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old private.church_mailboxes;
  v_secret uuid;
  v_reset boolean;
begin
  if not private.is_admin(p_church_id) then
    raise exception 'Only an administrator can change the mailbox connection';
  end if;
  if coalesce(p_settings ->> 'kind', '') not in ('imap', 'graph') then
    raise exception 'Mailbox kind must be imap or graph';
  end if;
  if (p_settings ->> 'time_zone') is not null
     and not exists (select 1 from pg_catalog.pg_timezone_names where name = p_settings ->> 'time_zone') then
    raise exception 'Unknown time zone %', p_settings ->> 'time_zone';
  end if;

  select * into v_old from private.church_mailboxes where church_id = p_church_id;
  v_secret := v_old.secret_id;
  if nullif(p_secret, '') is not null then
    if v_secret is null then
      v_secret := vault.create_secret(p_secret, 'safetrack_mailbox_' || p_church_id::text);
    else
      perform vault.update_secret(v_secret, p_secret);
    end if;
  end if;

  -- A different mailbox or folder: start reading from scratch (since_date still applies)
  v_reset := v_old.church_id is null
    or (p_settings ->> 'kind') is distinct from v_old.kind
    or coalesce(p_settings ->> 'imap_host', '') is distinct from coalesce(v_old.imap_host, '')
    or coalesce(p_settings ->> 'imap_username', '') is distinct from coalesce(v_old.imap_username, '')
    or coalesce(p_settings ->> 'imap_folder', 'INBOX') is distinct from v_old.imap_folder
    or coalesce(p_settings ->> 'graph_mailbox', '') is distinct from coalesce(v_old.graph_mailbox, '')
    or coalesce(p_settings ->> 'graph_folder', 'inbox') is distinct from v_old.graph_folder;

  insert into private.church_mailboxes as m (
    church_id, kind, enabled, auto_post, time_zone, since_date, sender_filter,
    imap_host, imap_port, imap_tls, imap_username, imap_folder,
    graph_tenant_id, graph_client_id, graph_mailbox, graph_folder, secret_id, updated_at)
  values (
    p_church_id, p_settings ->> 'kind',
    coalesce((p_settings ->> 'enabled')::boolean, false),
    coalesce((p_settings ->> 'auto_post')::boolean, true),
    coalesce(nullif(p_settings ->> 'time_zone', ''), 'America/Toronto'),
    coalesce(nullif(p_settings ->> 'since_date', '')::date, current_date - 14),
    coalesce(p_settings ->> 'sender_filter', 'payments.interac.ca'),
    nullif(trim(p_settings ->> 'imap_host'), ''), coalesce(nullif(p_settings ->> 'imap_port', '')::integer, 993),
    coalesce((p_settings ->> 'imap_tls')::boolean, true), nullif(trim(p_settings ->> 'imap_username'), ''),
    coalesce(nullif(trim(p_settings ->> 'imap_folder'), ''), 'INBOX'),
    nullif(trim(p_settings ->> 'graph_tenant_id'), ''), nullif(trim(p_settings ->> 'graph_client_id'), ''),
    nullif(trim(p_settings ->> 'graph_mailbox'), ''), coalesce(nullif(trim(p_settings ->> 'graph_folder'), ''), 'inbox'),
    v_secret, now())
  on conflict (church_id) do update set
    kind = excluded.kind, enabled = excluded.enabled, auto_post = excluded.auto_post,
    time_zone = excluded.time_zone, since_date = excluded.since_date, sender_filter = excluded.sender_filter,
    imap_host = excluded.imap_host, imap_port = excluded.imap_port, imap_tls = excluded.imap_tls,
    imap_username = excluded.imap_username, imap_folder = excluded.imap_folder,
    graph_tenant_id = excluded.graph_tenant_id, graph_client_id = excluded.graph_client_id,
    graph_mailbox = excluded.graph_mailbox, graph_folder = excluded.graph_folder,
    secret_id = excluded.secret_id, updated_at = now(),
    imap_uid_validity = case when v_reset then null else m.imap_uid_validity end,
    imap_last_uid = case when v_reset then 0 else m.imap_last_uid end,
    graph_last_received = case when v_reset then null else m.graph_last_received end,
    last_error = case when v_reset then null else m.last_error end;
end $$;

-- Admin / treasurer: read settings + status (never the secret)
create function public.get_mailbox_settings(p_church_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare m private.church_mailboxes;
begin
  if not private.has_role(p_church_id, array['administrator', 'treasurer']::public.member_role[]) then
    raise exception 'Not allowed';
  end if;
  select * into m from private.church_mailboxes where church_id = p_church_id;
  if not found then return null; end if;
  return (to_jsonb(m) - 'secret_id' - 'church_id') || jsonb_build_object('has_secret', m.secret_id is not null);
end $$;

revoke execute on function public.set_mailbox_settings(uuid, jsonb, text) from public, anon;
grant execute on function public.set_mailbox_settings(uuid, jsonb, text) to authenticated;
revoke execute on function public.get_mailbox_settings(uuid) from public, anon;
grant execute on function public.get_mailbox_settings(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Staging now carries review flags and the exact memo
-- ---------------------------------------------------------------------------
create or replace function private.stage_external_transactions(
  p_church_id uuid,
  p_provider  public.batch_source,
  p_rows      jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_posted   integer := 0;
  v_refunded_after_post integer := 0;
begin
  if p_provider = 'in_person' then
    raise exception 'in_person is not an external provider';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;

  if to_regclass('pg_temp.ext_in') is not null then drop table pg_temp.ext_in; end if;
  create temp table ext_in (like public.external_transactions including defaults) on commit drop;

  insert into pg_temp.ext_in (id, church_id, provider, external_id, gift_date, amount, fee, currency,
                              payment_method, status, payer_external_id, payer_envelope, payer_first_name, payer_last_name,
                              payer_name, payer_email, payer_phone, payer_address, fund_key, fund_name,
                              memo, deposit_ref, raw, memo_raw, review_flags)
  select distinct on (trim(r ->> 'external_id'))
         gen_random_uuid(), p_church_id, p_provider, trim(r ->> 'external_id'),
         (r ->> 'gift_date')::date, (r ->> 'amount')::numeric, coalesce(nullif(r ->> 'fee', '')::numeric, 0),
         nullif(r ->> 'currency', ''),
         (r ->> 'payment_method')::public.payment_method, r ->> 'status',
         nullif(trim(r ->> 'payer_external_id'), ''), nullif(trim(r ->> 'payer_envelope'), '')::integer,
         nullif(trim(r ->> 'payer_first_name'), ''),
         nullif(trim(r ->> 'payer_last_name'), ''), nullif(trim(r ->> 'payer_name'), ''),
         nullif(lower(trim(r ->> 'payer_email')), ''), nullif(trim(r ->> 'payer_phone'), ''),
         nullif(trim(r ->> 'payer_address'), ''), nullif(trim(r ->> 'fund_key'), ''),
         nullif(trim(r ->> 'fund_name'), ''), nullif(trim(r ->> 'memo'), ''),
         nullif(trim(r ->> 'deposit_ref'), ''), coalesce(r -> 'raw', '{}'::jsonb),
         nullif(r ->> 'memo_raw', ''),
         coalesce(array(select jsonb_array_elements_text(coalesce(r -> 'review_flags', '[]'::jsonb))), '{}')
  from jsonb_array_elements(p_rows) r
  order by trim(r ->> 'external_id');

  -- Posted gifts are never rewritten; only a later refund is recorded.
  with u as (
    update public.external_transactions t set status = i.status
    from pg_temp.ext_in i
    where t.church_id = p_church_id and t.provider = p_provider and t.external_id = i.external_id
      and t.donation_id is not null and t.status is distinct from i.status
    returning t.status)
  select count(*) filter (where status = 'refunded') into v_refunded_after_post from u;

  select count(*) into v_posted
  from public.external_transactions t join pg_temp.ext_in i using (external_id)
  where t.church_id = p_church_id and t.provider = p_provider and t.donation_id is not null;

  -- Unposted gifts take the provider's latest data; resolutions are kept.
  with u as (
    update public.external_transactions t set
      gift_date = i.gift_date, amount = i.amount, fee = i.fee, currency = i.currency,
      payment_method = i.payment_method, status = i.status,
      payer_external_id = i.payer_external_id, payer_envelope = i.payer_envelope, payer_first_name = i.payer_first_name,
      payer_last_name = i.payer_last_name, payer_name = i.payer_name, payer_email = i.payer_email,
      payer_phone = i.payer_phone, payer_address = i.payer_address, fund_key = i.fund_key,
      fund_name = i.fund_name, memo = i.memo, deposit_ref = i.deposit_ref, raw = i.raw,
      memo_raw = i.memo_raw, review_flags = i.review_flags
    from pg_temp.ext_in i
    where t.church_id = p_church_id and t.provider = p_provider and t.external_id = i.external_id
      and t.donation_id is null
      and (t.gift_date, t.amount, t.fee, t.status, t.payment_method, t.raw, t.review_flags)
          is distinct from (i.gift_date, i.amount, i.fee, i.status, i.payment_method, i.raw, i.review_flags)
    returning 1)
  select count(*) into v_updated from u;

  with ins as (
    insert into public.external_transactions
      (church_id, provider, external_id, gift_date, amount, fee, currency, payment_method, status,
       payer_external_id, payer_envelope, payer_first_name, payer_last_name, payer_name, payer_email, payer_phone,
       payer_address, fund_key, fund_name, memo, deposit_ref, raw, memo_raw, review_flags)
    select church_id, provider, external_id, gift_date, amount, fee, currency, payment_method, status,
           payer_external_id, payer_envelope, payer_first_name, payer_last_name, payer_name, payer_email, payer_phone,
           payer_address, fund_key, fund_name, memo, deposit_ref, raw, memo_raw, review_flags
    from pg_temp.ext_in
    on conflict (church_id, provider, external_id) do nothing
    returning 1)
  select count(*) into v_inserted from ins;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'already_posted', v_posted, 'refunded_after_post', v_refunded_after_post);
end $$;


-- ---------------------------------------------------------------------------
-- Posting, split so gifts can be added to an existing (weekly) batch
-- ---------------------------------------------------------------------------
create function private.post_gifts_into_batch(
  p_church_id uuid, p_provider public.batch_source, p_batch_id uuid, p_ids uuid[]
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_don   uuid;
  v_total numeric(12, 2) := 0;
  v_fees  numeric(12, 2) := 0;
  v_n     integer := 0;
  v_ord   integer;
  t       public.external_transactions;
  v_label text := case p_provider::text when 'pushpay' then 'Pushpay'
                                        when 'stripe' then 'Stripe'
                                        when 'e_transfer' then 'e-Transfer'
                                        else p_provider::text end;
begin
  select coalesce(max(sort_order), 0) into v_ord from public.donations where batch_id = p_batch_id;

  for t in
    select * from public.external_transactions where id = any (p_ids)
    order by gift_date, payer_last_name nulls last, payer_first_name nulls last, external_id
  loop
    v_ord := v_ord + 1;
    insert into public.donations (church_id, batch_id, giver_id, amount, payment_method, notes, sort_order)
    values (p_church_id, p_batch_id, t.giver_id, t.amount, t.payment_method,
            left(v_label || ' ' || t.external_id || coalesce(' — ' || coalesce(t.memo_raw, t.memo), ''), 500), v_ord)
    returning id into v_don;

    insert into public.donation_splits (church_id, donation_id, fund_id, amount)
    values (p_church_id, v_don, t.fund_id, t.amount);

    update public.external_transactions set donation_id = v_don, posted_at = now() where id = t.id;

    if t.payer_external_id is not null then
      insert into public.giver_external_ids (church_id, provider, external_id, giver_id)
      values (p_church_id, p_provider, t.payer_external_id, t.giver_id)
      on conflict (church_id, provider, external_id)
      do update set giver_id = excluded.giver_id, updated_at = now();

      if p_provider::text = 'pushpay' then
        update public.givers set pushpay_id = t.payer_external_id
        where id = t.giver_id and not is_system and coalesce(pushpay_id, '') = '';
      elsif p_provider::text = 'e_transfer' then
        update public.givers set
          etransfer_id  = case when coalesce(etransfer_id, '') = '' then t.payer_external_id else etransfer_id end,
          etransfer_id2 = case when coalesce(etransfer_id, '') <> '' then t.payer_external_id else etransfer_id2 end
        where id = t.giver_id and not is_system
          and lower(t.payer_external_id) not in (lower(coalesce(etransfer_id, '')), lower(coalesce(etransfer_id2, '')))
          and (coalesce(etransfer_id, '') = '' or coalesce(etransfer_id2, '') = '');
      end if;
    end if;

    if coalesce(t.fund_key, t.fund_name) is not null then
      insert into public.external_fund_map (church_id, provider, external_key, fund_id)
      values (p_church_id, p_provider, lower(trim(coalesce(t.fund_key, t.fund_name))), t.fund_id)
      on conflict (church_id, provider, external_key)
      do update set fund_id = excluded.fund_id, updated_at = now();
    end if;

    v_n := v_n + 1;
    v_total := v_total + t.amount;
    v_fees  := v_fees + t.fee;
  end loop;

  return jsonb_build_object('count', v_n, 'total', v_total, 'fees', v_fees);
end $$;
revoke all on function private.post_gifts_into_batch(uuid, public.batch_source, uuid, uuid[]) from public, anon, authenticated;

create or replace function public.post_external_batch(
  p_church_id  uuid,
  p_provider   public.batch_source,
  p_ids        uuid[],
  p_batch_date date default null,
  p_resolutions jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_n       integer := coalesce(array_length(p_ids, 1), 0);
  v_found   integer;
  v_bad     text;
  v_batch   uuid;
  v_number  text;
  v_res     jsonb;
begin
  if not private.has_role(p_church_id, array['administrator', 'treasurer']::public.member_role[]) then
    raise exception 'Only an administrator or treasurer can post imported gifts';
  end if;
  if p_provider = 'in_person' then
    raise exception 'in_person is not an external provider';
  end if;
  if v_n = 0 then
    raise exception 'No gifts selected';
  end if;
  if v_n <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'Duplicate gifts in selection';
  end if;

  perform 1 from public.external_transactions
  where id = any (p_ids) and church_id = p_church_id and provider = p_provider
  for update;
  get diagnostics v_found = row_count;
  if v_found <> v_n then
    raise exception 'One or more selected gifts were not found for this church and provider';
  end if;

  update public.external_transactions x set
    giver_id = coalesce(nullif(r ->> 'giver_id', '')::uuid, x.giver_id),
    fund_id  = coalesce(nullif(r ->> 'fund_id', '')::uuid, x.fund_id)
  from jsonb_array_elements(coalesce(p_resolutions, '[]'::jsonb)) r
  where x.id = (r ->> 'id')::uuid and x.id = any (p_ids) and x.donation_id is null;

  select string_agg(external_id || ': ' || reason, '; ') into v_bad from (
    select external_id,
           case when donation_id is not null then 'already posted'
                when ignored then 'ignored'
                when status <> 'succeeded' then 'status is ' || status
                when giver_id is null then 'no giver'
                when fund_id is null then 'no fund'
           end as reason
    from public.external_transactions where id = any (p_ids)) x
  where reason is not null;
  if v_bad is not null then
    raise exception 'Cannot post: %', v_bad;
  end if;

  insert into public.batches (church_id, batch_date, source)
  values (p_church_id,
          coalesce(p_batch_date, (select max(gift_date) from public.external_transactions where id = any (p_ids))),
          p_provider)
  returning id, batch_number into v_batch, v_number;

  v_res := private.post_gifts_into_batch(p_church_id, p_provider, v_batch, p_ids);
  return v_res || jsonb_build_object('batch_id', v_batch, 'batch_number', v_number);
end $$;

-- ---------------------------------------------------------------------------
-- Matching for automatic posting (deliberately stricter than the screen's
-- suggestions: anything uncertain gets a match flag and waits for a person)
-- ---------------------------------------------------------------------------
create function private.norm_words(p text)
returns text language sql immutable set search_path = ''
as $$ select ' ' || trim(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]+', ' ', 'g')) || ' ' $$;

-- Words in a memo that don't say anything about the fund
create function private.memo_noise_words()
returns text[] language sql immutable set search_path = ''
as $$ select array['env','envl','envelope','enveloppe','no','num','number','numero','numéro','n','tithe','tithes','tithing',
  'offering','offerings','general','donation','donations','gift','gifts','thanks','thank','you','church','god','bless',
  'blessings','for','the','and','from','to','my','our','weekly','monthly','sunday','week','of','fund','a','in','on','this',
  'dime','dîme','offrande','offrandes','don','dons','merci','pour','la','le','les','de','du','des','fonds','general',
  'général','semaine','dimanche','eglise','église','none','na','aucun','e','transfer','etransfer'] $$;

create function private.resolve_external_gift(p_tx uuid)
returns jsonb       -- {giver_id, fund_id, flags[]}
language plpgsql stable security definer set search_path = ''
as $$
declare
  t        public.external_transactions;
  g        public.givers;
  v_giver  uuid;
  v_fund   uuid;
  v_flags  text[] := '{}';
  v_memo   text;
  v_hits   uuid[];
  v_known  text[];
  v_left   text;
begin
  select * into t from public.external_transactions where id = p_tx;

  -- ---- giver ----
  if t.payer_envelope is not null then
    select * into g from public.givers
    where church_id = t.church_id and envelope_number = t.payer_envelope and not is_system;
    if not found then
      v_flags := array_append(v_flags, 'envelope_not_found');
    else
      v_known := array(select lower(x) from unnest(array[g.email, g.email2, g.etransfer_id, g.etransfer_id2]) x
                       where x like '%@%');
      if cardinality(v_known) > 0 and t.payer_email is not null and not (lower(t.payer_email) = any (v_known)) then
        v_flags := array_append(v_flags, 'envelope_email_mismatch');
      else
        v_giver := g.id;
      end if;
    end if;
  else
    select l.giver_id into v_giver from public.giver_external_ids l
    join public.givers gg on gg.id = l.giver_id
    where l.church_id = t.church_id and l.provider = t.provider and l.external_id = t.payer_external_id;
    if v_giver is null and t.payer_email is not null then
      select (array_agg(id))[1] into v_giver from (
        select id from public.givers
        where church_id = t.church_id and not is_system
          and lower(t.payer_email) in (lower(coalesce(email, '')), lower(coalesce(email2, '')),
                                       lower(coalesce(etransfer_id, '')), lower(coalesce(etransfer_id2, '')))
      ) x having count(*) = 1;
    end if;
    if v_giver is null then v_flags := array_append(v_flags, 'needs_giver'); end if;
  end if;

  -- ---- fund ----
  if coalesce(t.fund_key, t.fund_name) is not null then
    select m.fund_id into v_fund from public.external_fund_map m join public.funds f on f.id = m.fund_id and f.is_active
    where m.church_id = t.church_id and m.provider = t.provider and m.external_key = lower(trim(coalesce(t.fund_key, t.fund_name)));
    if v_fund is null then
      select id into v_fund from public.funds
      where church_id = t.church_id and is_active and lower(name) in (lower(coalesce(t.fund_name, '')), lower(coalesce(t.fund_key, '')));
    end if;
    if v_fund is null then v_flags := array_append(v_flags, 'fund_unclear'); end if;
  else
    v_memo := private.norm_words(t.memo);
    v_hits := array(select f.id from public.funds f
                    where f.church_id = t.church_id and f.is_active and lower(f.name) <> 'internal'
                      and lower(f.name) <> 'general'
                      and v_memo like '%' || private.norm_words(f.name) || '%');
    if cardinality(v_hits) = 1 then
      v_fund := v_hits[1];
    elsif cardinality(v_hits) > 1 then
      v_flags := array_append(v_flags, 'fund_unclear');
    else
      -- Nothing named: General, but only if the memo says nothing else
      select string_agg(w, ' ') into v_left
      from regexp_split_to_table(trim(v_memo), ' ') w
      where w <> '' and w !~ '^[0-9]+$' and not (w = any (private.memo_noise_words()));
      if v_left is null then
        select id into v_fund from public.funds
        where church_id = t.church_id and is_active and lower(name) = 'general';
      end if;
      if v_fund is null then v_flags := array_append(v_flags, 'fund_unclear'); end if;
    end if;
  end if;

  return jsonb_build_object('giver_id', v_giver, 'fund_id', v_fund, 'flags', to_jsonb(v_flags));
end $$;
revoke all on function private.resolve_external_gift(uuid) from public, anon, authenticated;

-- Post every confident, unflagged gift into its week's open batch
create function private.auto_post_external(p_church_id uuid, p_provider public.batch_source)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t        public.external_transactions;
  r        jsonb;
  v_flags  text[];
  v_week   date;
  v_key    text;
  v_batch  uuid;
  v_posted integer := 0;
  v_held   integer := 0;
  v_batches jsonb := '{}'::jsonb;
  v_number text;
begin
  for t in
    select * from public.external_transactions
    where church_id = p_church_id and provider = p_provider and donation_id is null and not ignored
    order by gift_date, staged_at
    for update skip locked
  loop
    r := private.resolve_external_gift(t.id);
    v_flags := array(select jsonb_array_elements_text(r -> 'flags'));
    if t.status <> 'succeeded' then v_flags := array_append(v_flags, 'status_not_succeeded'); end if;
    update public.external_transactions set match_flags = v_flags,
      giver_id = coalesce(giver_id, nullif(r ->> 'giver_id', '')::uuid),
      fund_id  = coalesce(fund_id, nullif(r ->> 'fund_id', '')::uuid)
    where id = t.id;

    if cardinality(t.review_flags) > 0 or cardinality(v_flags) > 0 then
      v_held := v_held + 1;
      continue;
    end if;

    v_week := t.gift_date - ((extract(isodow from t.gift_date)::integer) - 1);   -- Monday
    v_key := p_provider::text || ':' || v_week::text;
    select id, batch_number into v_batch, v_number from public.batches
    where church_id = p_church_id and auto_batch_key = v_key and status = 'open';
    if v_batch is null then
      insert into public.batches (church_id, batch_date, source, auto_batch_key)
      values (p_church_id, v_week + 6, p_provider, v_key)                         -- dated the Sunday
      returning id, batch_number into v_batch, v_number;
    end if;

    perform private.post_gifts_into_batch(p_church_id, p_provider, v_batch, array[t.id]);
    update public.external_transactions set auto_posted = true where id = t.id;
    v_posted := v_posted + 1;
    v_batches := v_batches || jsonb_build_object(v_number, coalesce((v_batches ->> v_number)::integer, 0) + 1);
  end loop;
  return jsonb_build_object('posted', v_posted, 'held_for_review', v_held, 'batches', v_batches);
end $$;
revoke all on function private.auto_post_external(uuid, public.batch_source) from public, anon, authenticated;

-- Admin / treasurer can run the matcher on demand (e.g. after fixing the registry)
create function public.auto_post_external(p_church_id uuid, p_provider public.batch_source)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_role(p_church_id, array['administrator', 'treasurer']::public.member_role[]) then
    raise exception 'Only an administrator or treasurer can post imported gifts';
  end if;
  return private.auto_post_external(p_church_id, p_provider);
end $$;
revoke execute on function public.auto_post_external(uuid, public.batch_source) from public, anon;
grant execute on function public.auto_post_external(uuid, public.batch_source) to authenticated;

-- ---------------------------------------------------------------------------
-- Server-only entry points for the mailbox-poll Edge Function
-- ---------------------------------------------------------------------------
create function public.mailboxes_due_server(p_church_id uuid default null)
returns table (church_id uuid, settings jsonb, secret text)
language sql stable security definer set search_path = ''
as $$
  select m.church_id,
         to_jsonb(m) - 'secret_id',
         (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.secret_id)
  from private.church_mailboxes m
  where (p_church_id is null and m.enabled) or m.church_id = p_church_id
$$;

create function public.ingest_inbound_email_server(
  p_church_id uuid, p_provider public.batch_source, p_source text,
  p_message jsonb,                -- {message_key, received_at, from, subject, raw}
  p_gift jsonb default null,      -- staging row, or null when skipped
  p_skip_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_msg   uuid;
  v_tx    uuid;
  v_stage jsonb;
  v_status text;
begin
  insert into public.inbound_messages (church_id, provider, source, message_key, received_at, from_address, subject, raw, status, reason)
  values (p_church_id, p_provider, p_source, p_message ->> 'message_key', nullif(p_message ->> 'received_at', '')::timestamptz,
          p_message ->> 'from', p_message ->> 'subject', coalesce(p_message ->> 'raw', ''),
          case when p_gift is null then 'skipped' else 'staged' end, p_skip_reason)
  on conflict (church_id, message_key) do nothing
  returning id into v_msg;
  if v_msg is null then
    return jsonb_build_object('status', 'duplicate');     -- this email was read before
  end if;
  if p_gift is null then
    return jsonb_build_object('status', 'skipped', 'inbound_message_id', v_msg);
  end if;

  v_stage := private.stage_external_transactions(p_church_id, p_provider, jsonb_build_array(p_gift));
  select id into v_tx from public.external_transactions
  where church_id = p_church_id and provider = p_provider and external_id = trim(p_gift ->> 'external_id');
  v_status := case when (v_stage ->> 'inserted')::integer = 1 then 'staged' else 'duplicate' end;
  update public.external_transactions set inbound_message_id = coalesce(inbound_message_id, v_msg) where id = v_tx;
  update public.inbound_messages set external_transaction_id = v_tx, status = v_status,
    reason = case when v_status = 'duplicate' then 'This e-Transfer was already brought in (same reference number)' end
  where id = v_msg;
  return jsonb_build_object('status', v_status, 'inbound_message_id', v_msg, 'external_transaction_id', v_tx);
exception when others then
  -- Never lose an email: keep it, marked as an error, for a person to look at
  insert into public.inbound_messages (church_id, provider, source, message_key, received_at, from_address, subject, raw, status, reason)
  values (p_church_id, p_provider, p_source, coalesce(p_message ->> 'message_key', gen_random_uuid()::text) || ':error:' || gen_random_uuid()::text,
          nullif(p_message ->> 'received_at', '')::timestamptz, p_message ->> 'from', p_message ->> 'subject',
          left(coalesce(p_message ->> 'raw', ''), 2000000), 'error', sqlerrm);
  return jsonb_build_object('status', 'error', 'reason', sqlerrm);
end $$;

create function public.auto_post_external_server(p_church_id uuid, p_provider public.batch_source)
returns jsonb language sql security definer set search_path = ''
as $$ select private.auto_post_external(p_church_id, p_provider) $$;

create function public.mailbox_poll_result_server(p_church_id uuid, p_cursor jsonb, p_error text, p_result jsonb)
returns void
language sql security definer set search_path = ''
as $$
  update private.church_mailboxes set
    imap_uid_validity  = coalesce((p_cursor ->> 'imap_uid_validity')::bigint, imap_uid_validity),
    imap_last_uid      = coalesce((p_cursor ->> 'imap_last_uid')::bigint, imap_last_uid),
    graph_last_received = coalesce((p_cursor ->> 'graph_last_received')::timestamptz, graph_last_received),
    last_polled_at = now(),
    last_success_at = case when p_error is null then now() else last_success_at end,
    last_error = p_error,
    last_result = p_result
  where church_id = p_church_id
$$;

-- Shared secret the scheduler sends to the Edge Function
create function public.mailbox_poll_secret_server()
returns text language sql stable security definer set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'safetrack_mailbox_poll_secret' $$;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'safetrack_mailbox_poll_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'safetrack_mailbox_poll_secret', 'Scheduler -> mailbox-poll Edge Function');
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.mailboxes_due_server(uuid)',
    'public.ingest_inbound_email_server(uuid, public.batch_source, text, jsonb, jsonb, text)',
    'public.auto_post_external_server(uuid, public.batch_source)',
    'public.mailbox_poll_result_server(uuid, jsonb, text, jsonb)',
    'public.mailbox_poll_secret_server()']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

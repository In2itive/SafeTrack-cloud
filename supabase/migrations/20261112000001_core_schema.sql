-- SafeTrack Cloud: core multi-tenant schema
-- Every data row carries church_id. Row-level security (next migration)
-- uses it to wall each church off from every other church.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role    as enum ('administrator', 'treasurer', 'envelope', 'teller');
create type public.batch_status   as enum ('open', 'finalized');
create type public.batch_source   as enum ('in_person', 'e_transfer', 'pushpay');
create type public.payment_method as enum ('cash', 'cheque', 'e_transfer');

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.churches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null default auth.uid()
);

create table public.church_members (
  church_id     uuid not null references public.churches (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.member_role not null,
  display_name  text not null check (length(trim(display_name)) > 0),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  primary key (church_id, user_id)
);
create index church_members_user_idx on public.church_members (user_id);

-- Non-secret per-church configuration (was AppSettings).
create table public.church_settings (
  church_id                  uuid primary key references public.churches (id) on delete cascade,
  next_envelope_number       integer not null default 100 check (next_envelope_number >= 2),
  -- Matches the original app: an administrator may finalize a batch alone.
  -- Churches that want strict two-person control turn this off.
  allow_admin_solo_finalize  boolean not null default true,
  accounting_recipients      text[] not null default '{}',
  envelope_recipients        text[] not null default '{}',
  deposit_recipients         text[] not null default '{}',
  bank_logo                  text,   -- data URL for now; moves to Storage later
  account_of                 text,
  branch_number              text,
  account_number             text,
  church_logo                text,
  church_address_line1       text,
  church_address_line2       text,
  church_address_line3       text,
  updated_at                 timestamptz not null default now()
);

-- SMTP credentials live in the private schema: not exposed through the API
-- and never readable from the browser. Only server-side code (service role)
-- and the admin-only RPCs in a later migration touch this table.
create table private.church_smtp (
  church_id     uuid primary key references public.churches (id) on delete cascade,
  host          text not null,
  port          integer not null check (port between 1 and 65535),
  username      text not null,
  password      text not null,
  from_address  text not null,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table public.funds (
  id          uuid primary key default gen_random_uuid(),
  church_id   uuid not null references public.churches (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  is_system   boolean not null default false,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index funds_church_name_uq on public.funds (church_id, lower(name));

create table public.internal_accounts (
  id          uuid primary key default gen_random_uuid(),
  church_id   uuid not null references public.churches (id) on delete cascade,
  code        text not null check (length(trim(code)) > 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index internal_accounts_church_code_uq on public.internal_accounts (church_id, lower(code));

-- ---------------------------------------------------------------------------
-- Givers
-- ---------------------------------------------------------------------------
create table public.givers (
  id                   uuid primary key default gen_random_uuid(),
  church_id            uuid not null references public.churches (id) on delete cascade,
  envelope_number      integer not null check (envelope_number >= 0),
  name                 text not null check (length(trim(name)) > 0),
  name2                text,
  email                text,
  email2               text,
  address1             text,
  address2             text,
  address3             text,
  etransfer_id         text,
  etransfer_id2        text,
  pushpay_id           text,
  -- #0 Loose Giving and #1 Internal are seeded per church and cannot be edited.
  is_system            boolean not null default false,
  created_in_batch_id  uuid,   -- FK added after batches exists
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (church_id, envelope_number)
);
create index givers_church_name_idx on public.givers (church_id, lower(name));
create index givers_church_etransfer_idx on public.givers (church_id, lower(etransfer_id));

-- ---------------------------------------------------------------------------
-- Batches and donations
-- ---------------------------------------------------------------------------
create table public.batches (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches (id) on delete cascade,
  batch_number  text not null,
  batch_date    date not null default current_date,
  status        public.batch_status not null default 'open',
  source        public.batch_source not null default 'in_person',
  -- Starts at 1. Each admin unlock bumps it, so sign-offs and audits are
  -- tied to the exact version of the batch they approved.
  revision      integer not null default 1 check (revision >= 1),
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  finalized_at  timestamptz,
  -- Bumped by trigger whenever a donation/split changes. A sign-off only
  -- counts if it happened after the last change, so nobody can sign and
  -- then have the batch edited underneath them.
  content_changed_at timestamptz not null default clock_timestamp(),
  unique (church_id, batch_number)
);
create index batches_church_date_idx on public.batches (church_id, batch_date desc);

alter table public.givers
  add constraint givers_created_in_batch_fk
  foreign key (created_in_batch_id) references public.batches (id) on delete set null;
create index givers_created_in_batch_idx on public.givers (created_in_batch_id);

create table public.donations (
  id              uuid primary key default gen_random_uuid(),
  church_id       uuid not null references public.churches (id) on delete cascade,
  batch_id        uuid not null references public.batches (id) on delete cascade,
  giver_id        uuid not null references public.givers (id) on delete restrict,
  amount          numeric(12, 2) not null check (amount > 0),
  payment_method  public.payment_method not null,
  cheque_number   text,
  notes           text,
  -- Denomination -> quantity, e.g. {"100": 1, "20": 3, "0.25": 4}
  cash_counts     jsonb,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  constraint cheque_needs_number
    check (payment_method <> 'cheque' or length(trim(coalesce(cheque_number, ''))) > 0),
  constraint cash_needs_counts
    check (payment_method <> 'cash' or cash_counts is not null)
);
create index donations_batch_idx on public.donations (batch_id, sort_order);
create index donations_giver_idx on public.donations (giver_id);
create index donations_church_idx on public.donations (church_id);

create table public.donation_splits (
  id                   uuid primary key default gen_random_uuid(),
  church_id            uuid not null references public.churches (id) on delete cascade,
  donation_id          uuid not null references public.donations (id) on delete cascade,
  fund_id              uuid not null references public.funds (id) on delete restrict,
  internal_account_id  uuid references public.internal_accounts (id) on delete restrict,
  amount               numeric(12, 2) not null check (amount > 0)
);
create index donation_splits_donation_idx on public.donation_splits (donation_id);
create index donation_splits_fund_idx on public.donation_splits (fund_id);
create index donation_splits_internal_idx on public.donation_splits (internal_account_id);
create index donation_splits_church_idx on public.donation_splits (church_id);

-- ---------------------------------------------------------------------------
-- Controls: sign-offs and finalization records (written only by RPCs)
-- ---------------------------------------------------------------------------
create table public.batch_signoffs (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches (id) on delete cascade,
  batch_id      uuid not null references public.batches (id) on delete cascade,
  revision      integer not null,
  user_id       uuid not null references auth.users (id) on delete restrict,
  display_name  text not null,          -- snapshot: survives renames/removals
  role          public.member_role not null,
  signed_at     timestamptz not null default now(),
  unique (batch_id, revision, user_id)
);
create index batch_signoffs_church_idx on public.batch_signoffs (church_id);
create index batch_signoffs_user_idx on public.batch_signoffs (user_id);

create table public.batch_finalizations (
  id               uuid primary key default gen_random_uuid(),
  church_id        uuid not null references public.churches (id) on delete cascade,
  batch_id         uuid not null references public.batches (id) on delete cascade,
  revision         integer not null,
  finalized_by     uuid not null references auth.users (id) on delete restrict,
  finalized_at     timestamptz not null default now(),
  -- What the tellers physically counted at the blind audit
  audit_cash_counts  jsonb not null,
  audit_cheque_count integer not null,
  audit_cheque_total numeric(12, 2) not null,
  -- What the system had at that moment
  system_total       numeric(12, 2) not null,
  unique (batch_id, revision)
);
create index batch_finalizations_church_idx on public.batch_finalizations (church_id);
create index batch_finalizations_user_idx on public.batch_finalizations (finalized_by);

create table public.batch_unlocks (
  id           uuid primary key default gen_random_uuid(),
  church_id    uuid not null references public.churches (id) on delete cascade,
  batch_id     uuid not null references public.batches (id) on delete cascade,
  from_revision integer not null,
  unlocked_by  uuid not null references auth.users (id) on delete restrict,
  reason       text not null check (length(trim(reason)) > 0),
  unlocked_at  timestamptz not null default now()
);
create index batch_unlocks_batch_idx on public.batch_unlocks (batch_id);
create index batch_unlocks_church_idx on public.batch_unlocks (church_id);
create index batch_unlocks_user_idx on public.batch_unlocks (unlocked_by);

-- ---------------------------------------------------------------------------
-- Convenience view: batch totals (respects caller's RLS)
-- ---------------------------------------------------------------------------
create view public.batch_totals with (security_invoker = true) as
select b.id as batch_id,
       b.church_id,
       coalesce(sum(d.amount), 0)::numeric(12, 2) as total_amount,
       count(d.id)::integer as item_count
from public.batches b
left join public.donations d on d.batch_id = b.id
group by b.id, b.church_id;

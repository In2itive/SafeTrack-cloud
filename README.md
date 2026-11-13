# SafeTrack Cloud

Church donation counting with dual-teller controls, blind audit, and standard reports.
Multi-church, backed by Supabase (Postgres + Auth, Canada region). See `docs/SCHEMA.md`.

## Run locally

```bash
npm install
cp .env.example .env        # URL + publishable key are already filled in for the dev project
npm run dev                 # http://localhost:3000
```

First run: click **Set up your church**, create the admin login, confirm the email Supabase sends,
then sign in and name the church. Add tellers under **User Management**.

Optional: put the project's secret key in `.env` as `SUPABASE_SECRET_KEY` to enable emailing reports.

## Demo church

```bash
node --env-file=.env scripts/seed-demo.mjs
```

Creates **Grace Community Church (Demo)**: 4 logins (admin, treasurer, two tellers), 20 givers,
six Sundays of counted batches (one corrected by the admin, one left open to audit).
Prints the logins when done. Needs "Confirm email" off on the target project.

## Tests

```bash
supabase/tests/run_local.sh   # needs a local Postgres (PGHOST/PGPORT/PGUSER); also runs in CI
npm run typecheck
```

## Moving an existing church in

Admin / Backup → **Import from SafeTrack (offline version)** → choose the `.json` file from
*Generate Backup* in the old app. Finalized batches stay finalized with their original tellers.

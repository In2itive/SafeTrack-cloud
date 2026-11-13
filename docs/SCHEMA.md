# SafeTrack Cloud — database design

Supabase Postgres, region `ca-central-1`. Migrations live in `supabase/migrations/`
and are the source of truth. Tests: `supabase/tests/run_local.sh` (also runs in CI).

## Tenancy
Every data row has `church_id`. A user sees a row only if they are an active
member of that church (`church_members`). This is enforced by row-level security,
not by the app, so a bug or a tampered browser can't cross churches.

| Table | Was (Dexie) | Notes |
|---|---|---|
| `churches`, `church_members` | `users` | Logins are Supabase Auth (email + password). Roles: administrator, treasurer, envelope, teller |
| `church_settings` | `settings` | Non-secret config. `allow_admin_solo_finalize` (default **on**, matches today's app) |
| `private.church_smtp` | `settings.smtp*` | Not reachable from the browser. Admin RPCs write it; server code reads it |
| `funds`, `internal_accounts` | same | System funds can't be renamed; nothing is hard-deleted |
| `givers` | same | `#0 Loose Giving` and `#1 Internal` are real seeded rows. Envelope # auto-assigned |
| `batches`, `donations`, `donation_splits` | `batches`, `donations` (splits were JSON) | Money is `numeric(12,2)`, never floating point |
| `batch_signoffs`, `batch_finalizations`, `batch_unlocks` | `batch.finalizedBy` | Written only by RPCs. Full history kept across admin adjustments |
| `audit_log` | — | Every insert/update/delete, who and before/after. Admins + treasurers can read; nobody can edit |

## Controls (enforced in the database)
- **Dual teller:** `finalize_batch()` requires sign-offs from two different users on the
  current revision, made *after* the last change to the batch. The second teller signs
  from their own signed-in session with `sign_batch()`. An admin may finalize alone
  only if `allow_admin_solo_finalize` is on.
- **Blind audit:** `finalize_batch()` takes the physical cash count (per denomination) and
  cheque count/total and checks them against the entered rows. It also checks every
  split balances and every Internal-fund split has an account code.
- **Lock:** finalized batches can't be edited by anyone — including the database owner —
  until an administrator calls `unlock_batch(id, reason)`. That bumps the revision;
  original sign-offs stay on record, and re-finalizing needs an admin sign-off.

## RPCs
`create_church(name, display_name)` · `sign_batch(batch_id)` ·
`finalize_batch(batch_id, cash_counts, cheque_count, cheque_total)` ·
`unlock_batch(batch_id, reason)` · `set_smtp_settings(...)` · `get_smtp_settings(church_id)`

## Not built yet
- Inviting members (needs a server-side function using the Supabase admin API)
- Logos → Supabase Storage (currently data URLs in `church_settings`)
- Import of an existing SafeTrack JSON backup

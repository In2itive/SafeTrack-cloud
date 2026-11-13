#!/usr/bin/env bash
# Rebuild a scratch database from the migrations and run the test suite.
# Usage: supabase/tests/run_local.sh   (needs a local Postgres; see PGHOST/PGPORT)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${TEST_DB:-safetrack_test}
psql -q -c "drop database if exists $DB" -c "create database $DB" postgres
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
for t in supabase/tests/controls_test.sql supabase/tests/external_giving_test.sql supabase/tests/etransfer_mailbox_test.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$t" 2>&1 | sed 's/^psql:[^ ]* //' | grep -v '^$'
done

#!/usr/bin/env bash
# Prepare a fresh container to run this project.
#
# Postgres is installed but not running in most sandbox images, and the test
# suite talks to a real database on purpose — the behaviours worth proving here
# (row locks under concurrent authorizations, idempotency via unique indexes,
# the four-eyes CHECK constraint) are database behaviours a mock would assert
# away.
#
# Safe to re-run: every step is idempotent.
set -uo pipefail

log() { printf '  %s\n' "$*"; }

# --- Postgres --------------------------------------------------------------
if command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -q 2>/dev/null; then
    log 'starting postgres'
    (pg_ctlcluster 16 main start 2>/dev/null \
      || service postgresql start 2>/dev/null \
      || pg_ctlcluster "$(ls /etc/postgresql 2>/dev/null | head -1)" main start 2>/dev/null) >/dev/null

    for _ in $(seq 1 20); do
      pg_isready -q 2>/dev/null && break
      sleep 1
    done
  fi

  if pg_isready -q 2>/dev/null; then
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='wealth'\"" 2>/dev/null | grep -q 1 \
      || su postgres -c "psql -q -c \"CREATE ROLE wealth LOGIN PASSWORD 'wealth' SUPERUSER\"" >/dev/null 2>&1

    for db in wealthcard wealthcard_test; do
      su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" 2>/dev/null | grep -q 1 \
        || su postgres -c "psql -q -c \"CREATE DATABASE $db OWNER wealth\"" >/dev/null 2>&1
    done
    log 'postgres ready (wealthcard, wealthcard_test)'
  else
    log 'postgres could not be started — integration tests will not run'
  fi
else
  log 'postgres is not installed — only the domain core tests will run'
fi

# --- Dependencies ----------------------------------------------------------
if [ ! -d node_modules ]; then
  log 'installing dependencies'
  pnpm install --silent >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1
fi

# --- Schema ----------------------------------------------------------------
if pg_isready -q 2>/dev/null; then
  npx tsx scripts/migrate.ts >/dev/null 2>&1 && log 'schema up to date'
fi

exit 0

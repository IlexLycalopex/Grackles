#!/usr/bin/env bash
# The check() helper and the role preambles, shared by test.sh and ai.sh.
#
# Sourced rather than copied: the two suites verify different migrations, but a
# test harness that exists twice is one that drifts, and the half that drifts is
# always the half nobody is looking at.
#
# Override connection details with PGHOST/PGPORT/PGUSER/PGDATABASE as needed.
PSQL="psql -d ${PGDATABASE:-grackles} -qAt"
JAMIE='1d34b078-bfad-41a7-a32f-3bf39f91f2a6'
ROB='9a1f0c22-0000-4000-8000-000000000001'
pass=0; fail=0

# $1 = description, $2 = expected ('ok' or an SQLSTATE), $3 = sql, $4 = role/claims preamble
#
# Everything runs inside a transaction that is rolled back, so a test that
# writes cannot affect the one after it. Anything a suite needs to persist has
# to be inserted outside check().
check() {
  local desc="$1" expect="$2" sql="$3" pre="$4"
  local out rc
  out=$($PSQL -v ON_ERROR_STOP=1 <<SQL 2>&1
\set VERBOSITY verbose
begin;
$pre
$sql
rollback;
SQL
)
  rc=$?
  if [ "$expect" = "ok" ]; then
    if [ $rc -eq 0 ]; then echo "  PASS  $desc"; pass=$((pass+1));
    else echo "  FAIL  $desc"; echo "        $out"; fail=$((fail+1)); fi
  else
    if echo "$out" | grep -q "$expect"; then echo "  PASS  $desc (rejected: $expect)"; pass=$((pass+1));
    else echo "  FAIL  $desc — expected $expect"; echo "        $out"; fail=$((fail+1)); fi
  fi
}

as_jamie="set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$JAMIE\",\"email\":\"alexander.jameswatts@gmail.com\"}';"
as_rob="set local role authenticated;   set local request.jwt.claims = '{\"sub\":\"$ROB\",\"email\":\"rob@example.com\"}';"
as_anon="set local role anon;            set local request.jwt.claims = '{}';"

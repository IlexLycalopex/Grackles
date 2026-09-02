#!/usr/bin/env bash
# Every column the archive search would select, against the real tables.
#
# The one check that would have caught the `slug` bug: runPlan asked every
# source for a column two of them had, so three of the five refused every query
# and had done since they shipped. Nothing noticed because the vocabulary lives
# in TypeScript and the columns live in Postgres, and nothing compared them.
. "$(dirname "$0")/harness.sh"

emitted=$(node --experimental-strip-types \
  --import "$(dirname "$0")/../../scripts/register-ts.mjs" \
  "$(dirname "$0")/fixtures/emit-search-columns.mjs" 2>/dev/null)

if [ -z "$emitted" ]; then
  echo "  FAIL  could not read the search vocabulary"
  echo ""; echo "passed: 0   failed: 1"; exit 1
fi

result=$($PSQL -c "$emitted" 2>&1)

if [ "$result" = "EVERY SEARCH COLUMN EXISTS" ]; then
  echo "  PASS  every column the archive search selects exists on its table"
  pass=1
else
  echo "  FAIL  the archive search names columns that do not exist"
  echo "$result" | sed 's/^/        /'
  fail=1
fi

echo ""
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]

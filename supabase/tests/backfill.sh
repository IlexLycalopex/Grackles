#!/usr/bin/env bash
# The backfill, against a reading list with the awkward cases in it.
#
# Run differently from the other suites, and it has to be: this migration is a
# one-way transformation of somebody's reading history, so the test builds the
# database up to the migration *before* it, seeds a list, and only then applies
# it. Applying everything first and seeding afterwards would test nothing —
# the backfill would have run against no rows.
#
#   supabase/tests/backfill.sh
#
# Needs a cluster it may drop and recreate, named by PGDATABASE (default
# grackles). Unlike the other suites this one is destructive by design.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB="${PGDATABASE:-grackles}"
BACKFILL=20260828120100_reading_backfill.sql

pass=0; fail=0
say() { printf '  %-6s %s\n' "$1" "$2"; }
ok()   { say PASS "$1"; pass=$((pass+1)); }
bad()  { say FAIL "$1"; [ -n "${2:-}" ] && echo "        $2"; fail=$((fail+1)); }

Q() { psql -d "$DB" -qAt -c "$1"; }

# Expect a scalar query to equal a value.
is() {
  local desc="$1" want="$2" got
  got=$(Q "$3" 2>&1)
  if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc" "expected [$want], got [$got]"; fi
}

echo "── building to the migration before the backfill"
psql -d postgres -qAt -c "drop database if exists $DB with (force);" >/dev/null
psql -d postgres -qAt -c "create database $DB;" >/dev/null
psql -d "$DB" -qAt -c "create extension if not exists citext; create extension if not exists pgcrypto;" >/dev/null 2>&1
psql -d "$DB" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/baseline.sql" >/dev/null 2>&1
for f in "$REPO"/supabase/migrations/*.sql; do
  [ "$(basename "$f")" = "$BACKFILL" ] && break
  psql -d "$DB" -qAt -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "could not apply $(basename "$f")"; exit 1; }
done

WS=$(Q "select id from public.workspaces where app='reading-list' limit 1")
[ -n "$WS" ] || { echo "no reading-list workspace in the baseline"; exit 1; }
psql -d "$DB" -qAt -v ws="$WS" -v ON_ERROR_STOP=1 -f "$HERE/fixtures/reading-list.sql" >/dev/null || exit 1

echo "── the dry run, before anything is written"
# The report has to be readable *before* the migration that uses it, or it
# cannot do the job it exists for. It lives in the previous migration for that
# reason, and this is the check that it stayed there.
is "the report runs against an un-backfilled list" "14" \
   "select value from app.rl_backfill_report() where measure='readings'"
is "it predicts the number of books" "11" \
   "select value from app.rl_backfill_report() where measure='books'"
is "it predicts what will collapse" "3" \
   "select value from app.rl_backfill_report() where measure='collapsed'"
is "the library is still empty" "0" "select count(*) from public.rl_library"

echo "── applying the backfill"
if out=$(psql -d "$DB" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/$BACKFILL" 2>&1); then
  ok "the migration applies"
else
  bad "the migration applies" "$(echo "$out" | tail -3)"; echo; echo "passed: $pass   failed: $fail"; exit 1
fi

echo "── what it produced"
is "every reading has a book" "0" "select count(*) from public.rl_books where library_id is null"
is "the predicted number of books is the actual number" "11" "select count(*) from public.rl_library"
is "the invariant is now enforced" "NO" \
   "select is_nullable from information_schema.columns
     where table_name='rl_books' and column_name='library_id'"

echo "── the cases that make it worth testing"
is "a re-read is one book with two readings" "2" \
   "select times_read from public.rl_library where title='Piranesi'"
is "and it takes the later date" "2024-01-09" \
   "select last_read_on from public.rl_library where title='Piranesi'"
is "two spellings of an author are one book" "2" \
   "select times_read from public.rl_library where title='The Dispossessed'"
is "an accented author folds to the same book" "1" \
   "select count(*) from public.rl_library where title='2666'"
is "and keeps the spelling it was written with" "Roberto Bolaño" \
   "select author from public.rl_library where title='2666'"
is "two volumes of a series stay two books" "2" \
   "select count(*) from public.rl_library where title like 'Chew%'"
is "each keeps its volume number" "3,9" \
   "select string_agg(series_index::text, ',' order by series_index)
      from public.rl_library where title like 'Chew%'"

# The fold keeps the leading article on purpose, so this pair does NOT merge.
# That is the recoverable error by design: it shows up as a near-duplicate for
# somebody to confirm, rather than silently becoming one book.
is "two spellings of a title stay two books" "2" \
   "select count(*) from public.rl_library where title like '%Left Hand of Darkness'"
is "and are offered as a near-duplicate" "1" \
   "select count(*) from public.rl_near_duplicates()"
is "the near-duplicate is the pair we expect" "Left Hand of Darkness|The Left Hand of Darkness" \
   "select a_title || '|' || b_title from public.rl_near_duplicates()"

echo "── read state, across the whole history"
is "a finished reading marks its book read" "t" \
   "select read from public.rl_library where title='Piranesi'"
is "an abandoned book is not read" "f" \
   "select read from public.rl_library where title='Infinite Jest'"
is "a book being read now is not read" "f" \
   "select read from public.rl_library where title='The Fifth Season'"
is "but is marked as in progress" "t" \
   "select reading from public.rl_library where title='The Fifth Season'"
is "a book on next year's plan is not read" "f" \
   "select read from public.rl_library where title='Middlemarch'"
is "eight books came out read" "8" "select count(*) from public.rl_library where read"
is "no reading was invented for any of them" "14" "select count(*) from public.rl_books"

echo "── what the backfill carried across"
is "the fuller page count wins over a null" "341" \
   "select pages from public.rl_library where title='The Dispossessed'"
is "a publisher recorded on one reading reaches the book" "Gollancz" \
   "select publisher from public.rl_library where title='The Dispossessed'"
is "tags are the union across readings, not the last one" "chunkster" \
   "select array_to_string(tags,',') from public.rl_library where title='2666'"
is "and a re-read's own tag joins the book's" "fantasy,reread" \
   "select array_to_string(tags,',') from public.rl_library where title='Piranesi'"
is "an author recorded on one reading beats a blank on another" "Ursula K. Le Guin" \
   "select author from public.rl_library where title='The Dispossessed'"
is "everything came in owned" "11" \
   "select count(*) from public.rl_library where ownership='owned'"
is "and marked as having come from the log" "11" \
   "select count(*) from public.rl_library where source='log'"

echo "── the invariant holds afterwards"
got=$(psql -d "$DB" -qAt -c "insert into public.rl_books (workspace_id, year_id, order_read, title)
      values ('$WS', (select id from public.rl_years where workspace_id='$WS' and year=2019), 99, 'Nowhere');" 2>&1)
if echo "$got" | grep -q "23502\|null value in column \"library_id\""; then
  ok "a reading with no book is refused"
else
  bad "a reading with no book is refused" "$got"
fi

echo "── running it twice"
if out=$(psql -d "$DB" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/$BACKFILL" 2>&1); then
  ok "the backfill is idempotent"
  is "and minted nothing the second time" "11" "select count(*) from public.rl_library"
else
  bad "the backfill is idempotent" "$(echo "$out" | tail -3)"
fi

echo ""
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]

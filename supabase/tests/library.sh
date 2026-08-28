#!/usr/bin/env bash
# Behavioural verification of the library migrations.
#
# Two halves, and the first is the one that matters most. The identity fold
# exists twice — app.rl_work_key() here and workKey() in src/lib/library.ts —
# and two implementations of one rule drift. Both read
# tests/fixtures/work-keys.json, so a case added anywhere is asserted in both
# languages, and a fold that has been improved on one side only goes red here.
#
# Run against a throwaway cluster loaded with tests/baseline.sql + migrations/.
. "$(dirname "$0")/harness.sh"
FIXTURE="$(dirname "$0")/fixtures/work-keys.json"

$PSQL -c "insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
          insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;" >/dev/null

# A reading list to hang everything off. Created outside check() because every
# check() rolls back, so anything the suite needs to persist has to be here.
WS=$($PSQL -c "select id from public.workspaces where app='reading-list' limit 1")
if [ -z "$WS" ]; then echo "no reading-list workspace in the baseline"; exit 1; fi
YEAR=$($PSQL -c "insert into public.rl_years (workspace_id, year, status)
                 values ('$WS', 2019, 'complete')
                 on conflict (workspace_id, year) do update set status='complete'
                 returning id")

echo "── the fold, against the fixture the unit test reads"

# Emitted from the fixture rather than written out, so the two suites cannot
# assert different things. $q$ quoting because titles contain apostrophes.
node "$(dirname "$0")/fixtures/emit-cases.mjs" "$FIXTURE" > /tmp/rl-fixture-cases.txt

while IFS='|' read -r desc kind left right; do
  case "$kind" in
    exact) check "key: $desc" ok \
      "do \$\$ begin if app.rl_work_key($left) is distinct from $right
         then raise exception 'got %', app.rl_work_key($left); end if; end \$\$;" ;;
    same)  check "same: $desc" ok \
      "do \$\$ begin if app.rl_work_key($left) is distinct from app.rl_work_key($right)
         then raise exception '% <> %', app.rl_work_key($left), app.rl_work_key($right); end if; end \$\$;" ;;
    diff)  check "apart: $desc" ok \
      "do \$\$ begin if app.rl_work_key($left) = app.rl_work_key($right)
         then raise exception 'both are %', app.rl_work_key($left); end if; end \$\$;" ;;
  esac
done < /tmp/rl-fixture-cases.txt

echo "── the volume rule"
# The one that silently deletes a series if it is got wrong: cleanTitle() in
# book-lookup.ts strips these and throws them away on purpose, and this must not.
check "two volumes of one series are two books" ok \
  "do \$\$ begin if app.rl_work_key('Chew Vol 3 Just Desserts','John Layman')
                = app.rl_work_key('Chew Vol 9 Chicken Tenders','John Layman')
     then raise exception 'a series collapsed to one row'; end if; end \$\$;"
check "an explicit index beats the one in the title" ok \
  "do \$\$ begin if app.rl_work_key('Chew','John Layman',3) is distinct from app.rl_work_key('Chew Vol 3','John Layman')
     then raise exception 'column and title disagree'; end if; end \$\$;"
check "a title that merely contains a number keeps it" ok \
  "do \$\$ begin if app.rl_work_key('1984','George Orwell') <> '1984|orwell g'
     then raise exception 'got %', app.rl_work_key('1984','George Orwell'); end if; end \$\$;"

echo "── one row per book"
check "an entry gets its key without being sent one" ok \
  "insert into public.rl_library (workspace_id, title, author) values ('$WS','The Dispossessed','Ursula K. Le Guin');
   do \$\$ begin if (select work_key from public.rl_library where title='The Dispossessed')
                <> 'the dispossessed|le guin u' then raise exception 'key not set'; end if; end \$\$;" "$as_jamie"
check "the same book spelled differently is refused" 23505 \
  "insert into public.rl_library (workspace_id, title, author) values ('$WS','The Dispossessed','Ursula K. Le Guin');
   insert into public.rl_library (workspace_id, title, author) values ('$WS','The Dispossessed','Le Guin, Ursula K.');" "$as_jamie"
check "renaming an entry re-folds its key" ok \
  "insert into public.rl_library (workspace_id, title, author) values ('$WS','Wrong Title','Susanna Clarke');
   update public.rl_library set title='Piranesi' where title='Wrong Title';
   do \$\$ begin if (select work_key from public.rl_library where title='Piranesi') <> 'piranesi|clarke s'
     then raise exception 'key not refolded'; end if; end \$\$;" "$as_jamie"
check "two projects may each hold the same book" ok \
  "insert into public.rl_library (workspace_id, title, author) values ('$WS','Piranesi','Susanna Clarke');
   select public.create_workspace('reading-list','second-list','Second List');
   insert into public.rl_library (workspace_id, title, author)
     values ((select id from public.workspaces where slug='second-list'),'Piranesi','Susanna Clarke');" "$as_jamie"

echo "── read state"
check "a finished reading makes a book read" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111111','$WS','Piranesi','Susanna Clarke');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('$WS','$YEAR','11111111-1111-4111-8111-111111111111',1,'Piranesi','2019-04-01');
   do \$\$ begin if not (select read from public.rl_library where id='11111111-1111-4111-8111-111111111111')
     then raise exception 'not marked read'; end if;
     if (select times_read from public.rl_library where id='11111111-1111-4111-8111-111111111111') <> 1
     then raise exception 'times_read wrong'; end if;
     if (select last_read_on from public.rl_library where id='11111111-1111-4111-8111-111111111111') <> '2019-04-01'
     then raise exception 'last_read_on wrong'; end if; end \$\$;" "$as_jamie"
check "an unfinished reading does not" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111112','$WS','Piranesi','Susanna Clarke');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, date_started, reading)
     values ('$WS','$YEAR','11111111-1111-4111-8111-111111111112',2,'Piranesi','2019-04-01',true);
   do \$\$ begin if (select read from public.rl_library where id='11111111-1111-4111-8111-111111111112')
     then raise exception 'an abandoned book counted as read'; end if;
     if not (select reading from public.rl_library where id='11111111-1111-4111-8111-111111111112')
     then raise exception 'not marked as being read'; end if; end \$\$;" "$as_jamie"
check "a re-read is two readings and one book" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111113','$WS','Piranesi','Susanna Clarke');
   insert into public.rl_years (workspace_id, year, status) values ('$WS', 2024, 'complete');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('$WS','$YEAR','11111111-1111-4111-8111-111111111113',3,'Piranesi','2019-04-01'),
            ('$WS',(select id from public.rl_years where workspace_id='$WS' and year=2024),
             '11111111-1111-4111-8111-111111111113',1,'Piranesi','2024-02-02');
   do \$\$ begin if (select times_read from public.rl_library where id='11111111-1111-4111-8111-111111111113') <> 2
     then raise exception 'expected two readings'; end if;
     if (select last_read_on from public.rl_library where id='11111111-1111-4111-8111-111111111113') <> '2024-02-02'
     then raise exception 'last_read_on took the wrong one'; end if; end \$\$;" "$as_jamie"

# The case the obvious implementation gets wrong, and the reason the trigger
# recounts OLD as well as NEW.
check "moving a reading away un-reads the book it left" ok \
  "insert into public.rl_library (id, workspace_id, title, author) values
     ('11111111-1111-4111-8111-11111111111a','$WS','Piranesi','Susanna Clarke'),
     ('11111111-1111-4111-8111-11111111111b','$WS','Jonathan Strange','Susanna Clarke');
   insert into public.rl_books (id, workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('22222222-2222-4222-8222-222222222222','$WS','$YEAR','11111111-1111-4111-8111-11111111111a',4,'Piranesi','2019-04-01');
   update public.rl_books set library_id='11111111-1111-4111-8111-11111111111b'
     where id='22222222-2222-4222-8222-222222222222';
   do \$\$ begin if (select read from public.rl_library where id='11111111-1111-4111-8111-11111111111a')
     then raise exception 'the book it left is still marked read'; end if;
     if not (select read from public.rl_library where id='11111111-1111-4111-8111-11111111111b')
     then raise exception 'the book it moved to is not'; end if; end \$\$;" "$as_jamie"
check "deleting the only reading un-reads the book" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-11111111111c','$WS','Piranesi','Susanna Clarke');
   insert into public.rl_books (id, workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('22222222-2222-4222-8222-222222222223','$WS','$YEAR','11111111-1111-4111-8111-11111111111c',5,'Piranesi','2019-04-01');
   delete from public.rl_books where id='22222222-2222-4222-8222-222222222223';
   do \$\$ begin if (select read from public.rl_library where id='11111111-1111-4111-8111-11111111111c')
     then raise exception 'still read with no readings'; end if; end \$\$;" "$as_jamie"
check "clearing a finish date un-reads the book" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-11111111111d','$WS','Piranesi','Susanna Clarke');
   insert into public.rl_books (id, workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('22222222-2222-4222-8222-222222222224','$WS','$YEAR','11111111-1111-4111-8111-11111111111d',6,'Piranesi','2019-04-01');
   update public.rl_books set date_finished = null where id='22222222-2222-4222-8222-222222222224';
   do \$\$ begin if (select read from public.rl_library where id='11111111-1111-4111-8111-11111111111d')
     then raise exception 'still read with no finish date'; end if; end \$\$;" "$as_jamie"

echo "── the override"
# Half the feature, not an escape hatch: the majority of this library was read
# before the reading list existed and has no reading to derive from.
check "an override marks a book read with no reading at all" ok \
  "insert into public.rl_library (id, workspace_id, title, author, read_override)
     values ('11111111-1111-4111-8111-11111111111e','$WS','Dune','Frank Herbert',true);
   do \$\$ begin if not (select read from public.rl_library where id='11111111-1111-4111-8111-11111111111e')
     then raise exception 'override ignored'; end if;
     if (select times_read from public.rl_library where id='11111111-1111-4111-8111-11111111111e') <> 0
     then raise exception 'a reading was invented'; end if;
     if (select last_read_on from public.rl_library where id='11111111-1111-4111-8111-11111111111e') is not null
     then raise exception 'a date was invented'; end if; end \$\$;" "$as_jamie"
check "an override of false beats a finished reading" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-11111111111f','$WS','Dune','Frank Herbert');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('$WS','$YEAR','11111111-1111-4111-8111-11111111111f',7,'Dune','2019-04-01');
   update public.rl_library set read_override=false where id='11111111-1111-4111-8111-11111111111f';
   do \$\$ begin if (select read from public.rl_library where id='11111111-1111-4111-8111-11111111111f')
     then raise exception 'override of false ignored'; end if; end \$\$;" "$as_jamie"
check "clearing the override hands the question back to the readings" ok \
  "insert into public.rl_library (id, workspace_id, title, author, read_override)
     values ('11111111-1111-4111-8111-111111111120','$WS','Dune','Frank Herbert',true);
   update public.rl_library set read_override=null where id='11111111-1111-4111-8111-111111111120';
   do \$\$ begin if (select read from public.rl_library where id='11111111-1111-4111-8111-111111111120')
     then raise exception 'still read after the override was cleared'; end if; end \$\$;" "$as_jamie"

echo "── the mirror"
check "a reading takes its title from the book" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111121','$WS','The Left Hand of Darkness','Ursula K. Le Guin');
   insert into public.rl_books (id, workspace_id, year_id, library_id, order_read, title, author)
     values ('22222222-2222-4222-8222-222222222225','$WS','$YEAR','11111111-1111-4111-8111-111111111121',8,'Left Hand of Darkness','U. Le Guin');
   do \$\$ begin if (select title from public.rl_books where id='22222222-2222-4222-8222-222222222225')
                <> 'The Left Hand of Darkness' then raise exception 'title not mirrored'; end if; end \$\$;" "$as_jamie"
check "renaming a book renames its readings" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111122','$WS','Wrong','Ursula K. Le Guin');
   insert into public.rl_books (id, workspace_id, year_id, library_id, order_read, title)
     values ('22222222-2222-4222-8222-222222222226','$WS','$YEAR','11111111-1111-4111-8111-111111111122',9,'Wrong');
   update public.rl_library set title='The Lathe of Heaven' where id='11111111-1111-4111-8111-111111111122';
   do \$\$ begin if (select title from public.rl_books where id='22222222-2222-4222-8222-222222222226')
                <> 'The Lathe of Heaven' then raise exception 'rename not propagated'; end if; end \$\$;" "$as_jamie"
check "a reading keeps its own particulars" ok \
  "insert into public.rl_library (id, workspace_id, title, author, publisher, pages)
     values ('11111111-1111-4111-8111-111111111123','$WS','Dune','Frank Herbert','Gollancz',912);
   insert into public.rl_books (id, workspace_id, year_id, library_id, order_read, title, publisher, pages, format)
     values ('22222222-2222-4222-8222-222222222227','$WS','$YEAR','11111111-1111-4111-8111-111111111123',10,'Dune','New English Library',536,'audio');
   update public.rl_library set title='Dune' where id='11111111-1111-4111-8111-111111111123';
   do \$\$ begin if (select publisher from public.rl_books where id='22222222-2222-4222-8222-222222222227') <> 'New English Library'
     then raise exception 'the reading lost its own publisher'; end if;
     if (select pages from public.rl_books where id='22222222-2222-4222-8222-222222222227') <> 536
     then raise exception 'the reading lost its own page count'; end if; end \$\$;" "$as_jamie"

echo "── deleting"
check "a book that has been read cannot be deleted" 23503 \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111124','$WS','Dune','Frank Herbert');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title)
     values ('$WS','$YEAR','11111111-1111-4111-8111-111111111124',11,'Dune');
   delete from public.rl_library where id='11111111-1111-4111-8111-111111111124';" "$as_jamie"
check "one that has not, can" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('11111111-1111-4111-8111-111111111125','$WS','Dune','Frank Herbert');
   delete from public.rl_library where id='11111111-1111-4111-8111-111111111125';" "$as_jamie"

echo "── access"
check "a stranger cannot read another project's library" ok \
  "insert into public.rl_library (workspace_id, title, author) values ('$WS','Secret Book','Nobody');" "$as_jamie"
check "a stranger sees nothing" ok \
  "do \$\$ begin if exists (select 1 from public.rl_library where workspace_id='$WS')
     then raise exception 'a stranger can read the library'; end if; end \$\$;" "$as_rob"
check "a stranger cannot add to it" 42501 \
  "insert into public.rl_library (workspace_id, title, author) values ('$WS','Intruder','Nobody');" "$as_rob"

echo ""
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]

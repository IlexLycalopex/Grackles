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

echo "── merging two entries that are one book"
# The button on the other end of rl_near_duplicates(). It can only ever be a
# manual correction of a near-match, because the unique index means two rows
# that fold the same cannot both exist.
check "every reading moves to the survivor" ok \
  "insert into public.rl_library (id, workspace_id, title, author) values
     ('bbbbbbbb-0000-4000-8000-000000000001','$WS','The Left Hand of Darkness','Ursula K. Le Guin'),
     ('bbbbbbbb-0000-4000-8000-000000000002','$WS','Left Hand of Darkness','Ursula Le Guin');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('$WS','$YEAR','bbbbbbbb-0000-4000-8000-000000000001',40,'x','2019-01-01'),
            ('$WS','$YEAR','bbbbbbbb-0000-4000-8000-000000000002',41,'y','2023-01-01');
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000002');
   do \$\$ begin
     if (select count(*) from public.rl_books where library_id='bbbbbbbb-0000-4000-8000-000000000001') <> 2
       then raise exception 'readings did not all move'; end if;
     if exists (select 1 from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000002')
       then raise exception 'the loser survived'; end if;
   end \$\$;" "$as_jamie"
check "and the counts are right afterwards" ok \
  "insert into public.rl_library (id, workspace_id, title, author) values
     ('bbbbbbbb-0000-4000-8000-000000000003','$WS','The Left Hand of Darkness','Ursula K. Le Guin'),
     ('bbbbbbbb-0000-4000-8000-000000000004','$WS','Left Hand of Darkness','Ursula Le Guin');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, date_finished)
     values ('$WS','$YEAR','bbbbbbbb-0000-4000-8000-000000000003',42,'x','2019-01-01'),
            ('$WS','$YEAR','bbbbbbbb-0000-4000-8000-000000000004',43,'y','2023-01-01');
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-000000000003','bbbbbbbb-0000-4000-8000-000000000004');
   do \$\$ begin
     if (select times_read from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000003') <> 2
       then raise exception 'times_read wrong after merge'; end if;
     if (select last_read_on from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000003') <> '2023-01-01'
       then raise exception 'last_read_on wrong after merge'; end if;
   end \$\$;" "$as_jamie"
check "a blank on the survivor takes the loser's value" ok \
  "insert into public.rl_library (id, workspace_id, title, author, pages, genre, tags) values
     ('bbbbbbbb-0000-4000-8000-000000000005','$WS','Dune','Frank Herbert',null,'',array['owned']),
     ('bbbbbbbb-0000-4000-8000-000000000006','$WS','Dune Messiah','Frank Herbert',912,'SF',array['sf']);
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-000000000005','bbbbbbbb-0000-4000-8000-000000000006');
   do \$\$ begin
     if (select pages from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000005') <> 912
       then raise exception 'a blank did not take the value'; end if;
     if (select genre from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000005') <> 'SF'
       then raise exception 'genre not carried'; end if;
     if (select array_to_string(tags,',') from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000005') <> 'owned,sf'
       then raise exception 'tags not unioned'; end if;
   end \$\$;" "$as_jamie"
check "the survivor's own value is never overwritten" ok \
  "insert into public.rl_library (id, workspace_id, title, author, pages) values
     ('bbbbbbbb-0000-4000-8000-000000000007','$WS','Dune','Frank Herbert',536),
     ('bbbbbbbb-0000-4000-8000-000000000008','$WS','Dune Messiah','Frank Herbert',912);
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-000000000007','bbbbbbbb-0000-4000-8000-000000000008');
   do \$\$ begin
     if (select pages from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000007') <> 536
       then raise exception 'the survivor lost to the loser'; end if;
   end \$\$;" "$as_jamie"
check "an override on either side survives" ok \
  "insert into public.rl_library (id, workspace_id, title, author, read_override) values
     ('bbbbbbbb-0000-4000-8000-000000000009','$WS','Dune','Frank Herbert',null),
     ('bbbbbbbb-0000-4000-8000-00000000000a','$WS','Dune Messiah','Frank Herbert',true);
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-000000000009','bbbbbbbb-0000-4000-8000-00000000000a');
   do \$\$ begin
     if not (select read from public.rl_library where id='bbbbbbbb-0000-4000-8000-000000000009')
       then raise exception 'a stated fact was lost in the merge'; end if;
   end \$\$;" "$as_jamie"
check "ownership takes the more present of the two" ok \
  "insert into public.rl_library (id, workspace_id, title, author, ownership) values
     ('bbbbbbbb-0000-4000-8000-00000000000b','$WS','Dune','Frank Herbert','none'),
     ('bbbbbbbb-0000-4000-8000-00000000000c','$WS','Dune Messiah','Frank Herbert','owned');
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-00000000000b','bbbbbbbb-0000-4000-8000-00000000000c');
   do \$\$ begin
     if (select ownership from public.rl_library where id='bbbbbbbb-0000-4000-8000-00000000000b') <> 'owned'
       then raise exception 'a book on the shelf was recorded as unowned'; end if;
   end \$\$;" "$as_jamie"
check "two notes are both kept" ok \
  "insert into public.rl_library (id, workspace_id, title, author, notes) values
     ('bbbbbbbb-0000-4000-8000-00000000000d','$WS','Dune','Frank Herbert','mine'),
     ('bbbbbbbb-0000-4000-8000-00000000000e','$WS','Dune Messiah','Frank Herbert','theirs');
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-00000000000d','bbbbbbbb-0000-4000-8000-00000000000e');
   do \$\$ begin
     if (select notes from public.rl_library where id='bbbbbbbb-0000-4000-8000-00000000000d') not like '%mine%'
       or (select notes from public.rl_library where id='bbbbbbbb-0000-4000-8000-00000000000d') not like '%theirs%'
       then raise exception 'a note was deleted by the merge'; end if;
   end \$\$;" "$as_jamie"
check "a book cannot be merged into itself" GRK33 \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('bbbbbbbb-0000-4000-8000-00000000000f','$WS','Dune','Frank Herbert');
   select public.rl_merge_library('bbbbbbbb-0000-4000-8000-00000000000f','bbbbbbbb-0000-4000-8000-00000000000f');" "$as_jamie"
check "a stranger cannot merge someone else's books" ok \
  "do \$\$ begin
     begin perform public.rl_merge_library('aaaaaaaa-0000-4000-8000-000000000099','aaaaaaaa-0000-4000-8000-000000000098');
       raise exception 'a stranger merged books';
     exception when sqlstate 'GRK32' then null;
     end; end \$\$;" "$as_rob"

echo "── near duplicates"
check "a pair is reported once, in a stable order" ok \
  "insert into public.rl_library (workspace_id, title, author) values
     ('$WS','The Trial','Franz Kafka'), ('$WS','Trial','Franz Kafka');
   do \$\$ begin
     if (select count(*) from public.rl_near_duplicates('$WS')) <> 1
       then raise exception 'expected exactly one pair, got %',
         (select count(*) from public.rl_near_duplicates('$WS')); end if;
     if (select a_title from public.rl_near_duplicates('$WS')) <> 'The Trial'
       then raise exception 'the pair is not in title order'; end if;
   end \$\$;" "$as_jamie"
check "two volumes of a series are not a near duplicate" ok \
  "insert into public.rl_library (workspace_id, title, author, series_index) values
     ('$WS','Chew Vol 3',   'John Layman', 3),
     ('$WS','Chew Vol 9',   'John Layman', 9);
   do \$\$ begin if exists (select 1 from public.rl_near_duplicates('$WS'))
     then raise exception 'a series was reported as duplicated'; end if; end \$\$;" "$as_jamie"
check "two authors of one surname are not a near duplicate" ok \
  "insert into public.rl_library (workspace_id, title, author) values
     ('$WS','Blindness','José Saramago'), ('$WS','Blindness','Henry Green');
   do \$\$ begin if exists (select 1 from public.rl_near_duplicates('$WS'))
     then raise exception 'two different books were paired'; end if; end \$\$;" "$as_jamie"

echo "── enrichment against a library entry"
# The feature was written for rl_books and now runs against both. What that
# costs is one branch; what it must not cost is the proposal ledger losing
# track of which table an answer was about.
# The whole path, through the real gates: a job is admitted, a call opened, and
# the proposal lands naming the library rather than the reading list.
#
# ai_proposals.target_table is unconstrained free text with no CHECK on it, so
# nothing in the database stops a proposal pointing anywhere. That is why
# api/ai/decide.ts maps it through an explicit allowlist rather than passing the
# value to .from() — this check is that the honest value survives the round
# trip, not that the column would refuse a dishonest one.
check "a proposal from a real job can name a library entry" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('cccccccc-0000-4000-8000-000000000001','$WS','Dune','Frank Herbert');
   -- Consent first, as an owner gives it. reading.enrich is registered as
   -- records-sending, so without this the job is refused GRK1E before anything
   -- is spent — which is the governance layer working, and is why it is here
   -- rather than being worked around.
   insert into public.ai_workspace_features (workspace_id, feature, consent_at, consent_by)
     values ('$WS','reading.enrich', now(), '$JAMIE')
     on conflict (workspace_id, feature) do update set consent_at = now();
   do \$\$
   declare j uuid; c uuid;
   begin
     j := public.ai_begin_job('reading.enrich','$WS','batch');
     c := public.ai_begin_call(j);
     insert into public.ai_proposals (call_id, workspace_id, feature, target_table, target_id, proposed)
       values (c,'$WS','reading.enrich','rl_library','cccccccc-0000-4000-8000-000000000001',
               '{\"fields\":{\"genre\":\"Science Fiction\"}}');
     if not exists (
       select 1 from public.ai_proposals
       where target_table='rl_library' and target_id='cccccccc-0000-4000-8000-000000000001')
       then raise exception 'the proposal did not record its table'; end if;
   end \$\$;" "$as_jamie"
check "accepting one writes to the library" ok \
  "insert into public.rl_library (id, workspace_id, title, author)
     values ('cccccccc-0000-4000-8000-000000000002','$WS','Dune','Frank Herbert');
   update public.rl_library set genre='Science Fiction', pages=912
     where id='cccccccc-0000-4000-8000-000000000002';
   do \$\$ begin if (select genre from public.rl_library where id='cccccccc-0000-4000-8000-000000000002')
     <> 'Science Fiction' then raise exception 'the write did not land'; end if; end \$\$;" "$as_jamie"
# The vocabulary is the reader's, not one table's: a genre used on an unread
# import is as much part of how they file things as one on a 2019 reading.
check "the vocabulary spans both tables" ok \
  "insert into public.rl_library (workspace_id, title, author, genre)
     values ('$WS','Only In The Library','Nobody','Weird Fiction');
   insert into public.rl_books (workspace_id, year_id, library_id, order_read, title, genre)
     values ('$WS','$YEAR',(select id from public.rl_library where title='Only In The Library'),
             60,'x','Only In The List');
   do \$\$ begin
     if not exists (select 1 from public.rl_library where genre='Weird Fiction')
       then raise exception 'library genre missing'; end if;
     if not exists (select 1 from public.rl_books where genre='Only In The List')
       then raise exception 'reading genre missing'; end if;
   end \$\$;" "$as_jamie"

echo "── looking a book up"
# The cap, in both directions, because the cigar version of this failed in the
# direction nobody checked. Written as a correlated subquery inside the policy
# on the table it counts, it is 42P17 — infinite recursion — and the symptom is
# not a leaky cap but a table that refuses *every* insert, so no lookup could
# ever be cached. It was asserted to work in three places before anybody ran it.
check "a lookup can be cached at all" ok \
  "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('second place|cusk r','Second Place','Rachel Cusk','$WS','$JAMIE');" "$as_jamie"
# Persisted outside check(), which rolls back — Rob has to be able to see a row
# that outlives the transaction that made it, which is the whole point of the
# cache being shared rather than per-project.
$PSQL -c "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
          values ('shared|row','Shared','Someone','$WS','$JAMIE') on conflict do nothing;" >/dev/null
check "and the cache is readable by anyone signed in" ok \
  "do \$\$ begin if not exists (select 1 from public.rl_book_reference where key='shared|row')
     then raise exception 'a signed-in reader cannot see the shared cache'; end if; end \$\$;" "$as_rob"
check "the cap refuses the fifty-first in a day" 42501 \
  "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     select 'bulk-' || g, 'Book ' || g, 'Someone', '$WS', '$JAMIE'
     from generate_series(1, 50) g;
   insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('one too many','Too Many','Someone','$WS','$JAMIE');" "$as_jamie"
check "yesterday's lookups do not count against today" ok \
  "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by, created_at)
     select 'old-' || g, 'Book ' || g, 'Someone', '$WS', '$JAMIE', now() - interval '2 days'
     from generate_series(1, 60) g;
   insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('today is fine','Fine','Someone','$WS','$JAMIE');" "$as_jamie"
check "a lookup cannot be attributed to somebody else" 42501 \
  "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('not mine','Not Mine','Someone','$WS','$ROB');" "$as_jamie"
check "a viewer cannot spend on a project they only read" 42501 \
  "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('theirs','Theirs','Someone','$WS','$ROB');" "$as_rob"
# Insert-only is what makes a shared table safe to share.
# Refused at the grant, not merely filtered by a policy: no UPDATE or DELETE was
# ever granted on this table, so the answer is a hard 42501 rather than a
# statement that quietly matches nothing. Stronger than a policy, and the reason
# a shared cache is safe to share — one member cannot rewrite what another
# member's lookup found, only add alongside it.
check "nobody can rewrite what another lookup found" 42501 \
  "update public.rl_book_reference set title='Rewritten' where key='shared|row';" "$as_jamie"
check "and nobody can delete one" 42501 \
  "delete from public.rl_book_reference where key='shared|row';" "$as_jamie"
# There is no column for a model to put an invented ISBN in, but the columns
# that do exist are bounded, because a plausible wrong number is the failure.
check "an impossible year is refused" 23514 \
  "insert into public.rl_book_reference (key, title, author, year_published, workspace_id, looked_up_by)
     values ('bad year','Book','Someone', 20210, '$WS','$JAMIE');" "$as_jamie"
check "an impossible page count is refused" 23514 \
  "insert into public.rl_book_reference (key, title, author, pages, workspace_id, looked_up_by)
     values ('bad pages','Book','Someone', 99999, '$WS','$JAMIE');" "$as_jamie"
check "the same book is cached once" 23505 \
  "insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('same|book','Book','Someone','$WS','$JAMIE');
   insert into public.rl_book_reference (key, title, author, workspace_id, looked_up_by)
     values ('same|book','Book','Someone','$WS','$JAMIE');" "$as_jamie"
check "the feature is registered and needs no consent" ok \
  "do \$\$ begin
     if not exists (select 1 from public.ai_features where key='reading.lookup' and enabled)
       then raise exception 'reading.lookup is not registered'; end if;
     if (select sends_records from public.ai_features where key='reading.lookup')
       then raise exception 'a lookup should send nothing stored'; end if;
   end \$\$;"

echo "── publishers"
# Found on production, not here: rl_library had the column and nothing to fill
# it, so every entry looked "thin" to reading.enrich — which selects on
# publisher_normalised = '' — and the page offered to spend money re-filling 260
# books that already had a genre and a page count. 260 thin became 26 once the
# trigger was attached.
check "the library normalises a publisher on write" ok \
  "insert into public.rl_library (workspace_id, title, author, publisher)
     values ('$WS','Normalised','Someone','  Gollancz ');
   do \$\$ begin if (select publisher_normalised from public.rl_library where title='Normalised') <> 'Gollancz'
     then raise exception 'publisher_normalised is [%]',
       (select publisher_normalised from public.rl_library where title='Normalised'); end if; end \$\$;" "$as_jamie"
check "and re-normalises when the publisher is corrected" ok \
  "insert into public.rl_library (id, workspace_id, title, author, publisher)
     values ('dddddddd-0000-4000-8000-000000000001','$WS','Normalised','Someone','Wrong Press');
   update public.rl_library set publisher='Gollancz' where id='dddddddd-0000-4000-8000-000000000001';
   do \$\$ begin if (select publisher_normalised from public.rl_library where id='dddddddd-0000-4000-8000-000000000001') <> 'Gollancz'
     then raise exception 'not re-normalised'; end if; end \$\$;" "$as_jamie"
# The predicate the enrich route actually uses, so a book that is filled in does
# not read as thin. This is the assertion that would have caught it.
check "a filled-in book does not count as thin" ok \
  "insert into public.rl_library (workspace_id, title, author, publisher, genre, pages)
     values ('$WS','Complete','Someone','Gollancz','Science Fiction',300);
   do \$\$ begin if exists (
       select 1 from public.rl_library
       where title='Complete'
         and (genre = '' or publisher_normalised = '' or pages is null))
     then raise exception 'a complete book still reads as thin to reading.enrich'; end if; end \$\$;" "$as_jamie"

echo ""
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]

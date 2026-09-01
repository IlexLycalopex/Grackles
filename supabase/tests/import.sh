#!/usr/bin/env bash
# The import: staging, the apply, and what it is allowed to touch.
#
# The parser and the verdicts are tested in src/lib/library-import.test.ts,
# which is where they live. This is about what the database does with what the
# parser decided — and in particular that the apply either lands whole or does
# not land at all.
. "$(dirname "$0")/harness.sh"

$PSQL -c "insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
          insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;" >/dev/null

WS=$($PSQL -c "select id from public.workspaces where app='reading-list' limit 1")
JAMIE_ID="$JAMIE"

# A library with one book already in it, and a batch to act on. Outside check()
# because check() rolls back.
$PSQL -c "insert into public.rl_library (id, workspace_id, title, author, ownership)
          values ('aaaaaaaa-0000-4000-8000-000000000001','$WS','Piranesi','Susanna Clarke','none')
          on conflict do nothing;" >/dev/null

new_batch() {
  $PSQL -c "insert into public.rl_import_batches (workspace_id, filename, content_hash, rows_total, read_default, uploaded_by)
            values ('$WS','shelf.csv','$1',0,${2:-false},'$JAMIE_ID') returning id"
}

echo "── staging"
check "a batch and its rows go in" ok \
  "insert into public.rl_import_batches (workspace_id, filename, content_hash, uploaded_by)
     values ('$WS','a.csv','hash-a','$JAMIE_ID');
   insert into public.rl_import_rows (batch_id, workspace_id, position, title, author, verdict, decision)
     values ((select id from public.rl_import_batches where content_hash='hash-a'),'$WS',1,'Dune','Frank Herbert','new','add');" "$as_jamie"
check "the same file twice is one batch" 23505 \
  "insert into public.rl_import_batches (workspace_id, filename, content_hash, uploaded_by)
     values ('$WS','a.csv','hash-dup','$JAMIE_ID');
   insert into public.rl_import_batches (workspace_id, filename, content_hash, uploaded_by)
     values ('$WS','a-again.csv','hash-dup','$JAMIE_ID');" "$as_jamie"
check "a row cannot claim a verdict that does not exist" 23514 \
  "insert into public.rl_import_batches (workspace_id, filename, content_hash, uploaded_by)
     values ('$WS','a.csv','hash-b','$JAMIE_ID');
   insert into public.rl_import_rows (batch_id, workspace_id, position, title, verdict)
     values ((select id from public.rl_import_batches where content_hash='hash-b'),'$WS',1,'Dune','sort of');" "$as_jamie"
check "every column of the upload is kept, recognised or not" ok \
  "insert into public.rl_import_batches (workspace_id, filename, content_hash, uploaded_by)
     values ('$WS','a.csv','hash-c','$JAMIE_ID');
   insert into public.rl_import_rows (batch_id, workspace_id, position, title, raw)
     values ((select id from public.rl_import_batches where content_hash='hash-c'),'$WS',1,'Dune',
             '{\"title\":\"Dune\",\"shelf location\":\"Study top\"}');
   do \$\$ begin if (select raw->>'shelf location' from public.rl_import_rows where title='Dune')
     <> 'Study top' then raise exception 'an unmapped column was dropped'; end if; end \$\$;" "$as_jamie"

echo "── the apply"
B1=$(new_batch "apply-1")
$PSQL -c "insert into public.rl_import_rows (batch_id, workspace_id, position, title, author, verdict, decision, pages, genre)
          values ('$B1','$WS',1,'Dune','Frank Herbert','new','add',912,'Science Fiction');" >/dev/null
check "an added row becomes a book" ok \
  "select public.rl_apply_import('$B1');
   do \$\$ begin if not exists (select 1 from public.rl_library where title='Dune' and pages=912)
     then raise exception 'the book was not written'; end if;
     if (select status from public.rl_import_batches where id='$B1') <> 'applied'
     then raise exception 'the batch was not marked applied'; end if;
     if (select library_id from public.rl_import_rows where batch_id='$B1') is null
     then raise exception 'the row does not record what it made'; end if; end \$\$;" "$as_jamie"
check "an added row is marked as having come from a photograph" ok \
  "select public.rl_apply_import('$B1');
   do \$\$ begin if (select source from public.rl_library where title='Dune') <> 'import'
     then raise exception 'source not recorded'; end if;
     if (select source_batch_id from public.rl_library where title='Dune') is null
     then raise exception 'batch not recorded'; end if; end \$\$;" "$as_jamie"
check "an import cannot be applied twice" GRK31 \
  "select public.rl_apply_import('$B1');
   select public.rl_apply_import('$B1');" "$as_jamie"

echo "── confirming, which is what most rows do"
B2=$(new_batch "apply-2")
$PSQL -c "insert into public.rl_import_rows
            (batch_id, workspace_id, position, title, author, verdict, decision, match_library_id, source_photo, genre)
          values ('$B2','$WS',1,'Piranesi','Susanna Clarke','known','confirm',
                  'aaaaaaaa-0000-4000-8000-000000000001','shelf-3.jpg','Nonsense');" >/dev/null
check "a confirmed row makes the book owned" ok \
  "select public.rl_apply_import('$B2');
   do \$\$ begin if (select ownership from public.rl_library where id='aaaaaaaa-0000-4000-8000-000000000001') <> 'owned'
     then raise exception 'ownership not confirmed'; end if; end \$\$;" "$as_jamie"
check "and attaches the photograph it came off" ok \
  "select public.rl_apply_import('$B2');
   do \$\$ begin if (select source_photo from public.rl_library where id='aaaaaaaa-0000-4000-8000-000000000001') <> 'shelf-3.jpg'
     then raise exception 'photo not attached'; end if; end \$\$;" "$as_jamie"
# The line between "this is on the bookcase" and "this is what the book is".
check "and touches nothing else the person has edited" ok \
  "select public.rl_apply_import('$B2');
   do \$\$ begin if (select genre from public.rl_library where id='aaaaaaaa-0000-4000-8000-000000000001') <> ''
     then raise exception 'a confirmation overwrote the genre'; end if; end \$\$;" "$as_jamie"
check "confirming does not mint a second book" ok \
  "select public.rl_apply_import('$B2');
   do \$\$ begin if (select count(*) from public.rl_library where title='Piranesi') <> 1
     then raise exception 'a duplicate was created'; end if; end \$\$;" "$as_jamie"

echo "── read state on the way in"
B3=$(new_batch "apply-3" true)
$PSQL -c "insert into public.rl_import_rows (batch_id, workspace_id, position, title, author, verdict, decision, read_decision)
          values ('$B3','$WS',1,'Middlemarch','George Eliot','new','add',null),
                 ('$B3','$WS',2,'Ulysses','James Joyce','new','add',false);" >/dev/null
check "the batch default reaches a row that did not say" ok \
  "select public.rl_apply_import('$B3');
   do \$\$ begin if not (select read from public.rl_library where title='Middlemarch')
     then raise exception 'the batch default was not applied'; end if; end \$\$;" "$as_jamie"
check "a row that did say beats the default" ok \
  "select public.rl_apply_import('$B3');
   do \$\$ begin if (select read from public.rl_library where title='Ulysses')
     then raise exception 'the row was overruled by the default'; end if; end \$\$;" "$as_jamie"
# The rule that keeps the reading list honest: a book marked read on the way in
# gets an override, never a fabricated reading in a year it was not read in.
check "no reading is invented for a book marked read" ok \
  "select public.rl_apply_import('$B3');
   do \$\$ begin if (select times_read from public.rl_library where title='Middlemarch') <> 0
     then raise exception 'a reading was invented'; end if;
     if (select read_override from public.rl_library where title='Middlemarch') is not true
     then raise exception 'no override was set'; end if;
     if exists (select 1 from public.rl_books where title='Middlemarch')
     then raise exception 'a row was added to the reading list'; end if; end \$\$;" "$as_jamie"

echo "── all or nothing"
B4=$(new_batch "apply-4")
$PSQL -c "insert into public.rl_import_rows (batch_id, workspace_id, position, title, author, verdict, decision)
          values ('$B4','$WS',1,'Solaris','Stanisław Lem','new','add'),
                 ('$B4','$WS',2,'Piranesi','Susanna Clarke','new','add');" >/dev/null
# The second row collides with a book that already exists — which is what a
# disagreement between the two folds looks like from here.
check "a colliding row rolls the whole import back" 23505 \
  "select public.rl_apply_import('$B4');" "$as_jamie"
check "and nothing from it survives" ok \
  "do \$\$ begin
     begin
       perform public.rl_apply_import('$B4');
     exception when unique_violation then null;   -- the block is the rollback
     end;
   end \$\$;
   do \$\$ begin if exists (select 1 from public.rl_library where title='Solaris')
     then raise exception 'half an import landed'; end if;
     if (select status from public.rl_import_batches where id='$B4') <> 'review'
     then raise exception 'the batch was marked applied anyway'; end if; end \$\$;" "$as_jamie"

echo "── skipping"
B5=$(new_batch "apply-5")
$PSQL -c "insert into public.rl_import_rows (batch_id, workspace_id, position, title, author, verdict, decision)
          values ('$B5','$WS',1,'Nothing Doing','Nobody','duplicate_in_batch','skip');" >/dev/null
check "a skipped row writes nothing but is kept" ok \
  "select public.rl_apply_import('$B5');
   do \$\$ begin if exists (select 1 from public.rl_library where title='Nothing Doing')
     then raise exception 'a skipped row was written'; end if;
     if not exists (select 1 from public.rl_import_rows where batch_id='$B5')
     then raise exception 'the row was thrown away'; end if;
     if (select rows_accepted from public.rl_import_batches where id='$B5') <> 0
     then raise exception 'a skipped row was counted'; end if; end \$\$;" "$as_jamie"

echo "── access"
check "a stranger cannot upload into someone else's project" 42501 \
  "insert into public.rl_import_batches (workspace_id, filename, content_hash, uploaded_by)
     values ('$WS','theirs.csv','hash-rob','$ROB');" "$as_rob"
check "a stranger cannot read a batch" ok \
  "do \$\$ begin if exists (select 1 from public.rl_import_batches where workspace_id='$WS')
     then raise exception 'a stranger can read the staging table'; end if; end \$\$;" "$as_rob"
check "a stranger cannot apply one" ok \
  "do \$\$ begin
     begin perform public.rl_apply_import('$B1');
       raise exception 'a stranger applied an import';
     exception when sqlstate 'GRK30' then null;
     end; end \$\$;" "$as_rob"

echo ""
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]

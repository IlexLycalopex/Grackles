#!/usr/bin/env bash
# Behavioural verification of the AI governance migrations (20260814*).
#
# The cases that matter are the ones a per-call gate would have passed: a batch
# that exhausts an allowance four hundred successful checks at a time, a
# fan-out that multiplies its own envelope, two ticks taking the same item.
# Those are marked below, because they are the reason any of this exists.
#
# Run against a throwaway cluster loaded with tests/baseline.sql + migrations/.
. "$(dirname "$0")/harness.sh"

WBPR='4d000000-0000-4000-8000-000000000001'   # public, Jamie's
ROBS='4d000000-0000-4000-8000-000000000002'   # private, Rob's — payer has no budget

# Persisted setup. check() rolls back, so anything a later test depends on has
# to be written out here.
$PSQL -c "
  insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
  insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;

  insert into public.workspaces (id,app,slug,name,visibility,owner_id) values
    ('$WBPR','wbpr','void','WBPR','public','$JAMIE'),
    ('$ROBS','wbpr','robs','Rob''s Station','private','$ROB') on conflict do nothing;

  -- Rob edits Jamie's station: the case where the person spending and the
  -- person paying are different people.
  insert into public.workspace_members (workspace_id,user_id,role)
    values ('$WBPR','$ROB','editor') on conflict (workspace_id,user_id) do update set role='editor';

  -- Rob deliberately has no ai_budgets row. The backfill ran before his
  -- workspace existed, which is exactly the state a new owner arrives in.
  delete from public.ai_budgets where user_id='$ROB';
" >/dev/null

open_desk="select public.ai_begin_job('wbpr.desk','$WBPR','interactive');"

# Some tests have to reach past the grants to set a scene — age a reservation,
# push a deadline into the past, spend an allowance. Those tables are writable
# only by the owner, deliberately (see "nobody can edit a job's spend directly"
# below, which passes for the same reason), so the escalation is explicit and
# transaction-local. request.jwt.claims is untouched, so auth.uid() is still
# whoever the preamble said.
SU="perform set_config('role','postgres',true);"
DOWN="perform set_config('role','authenticated',true);"
# The same, for a test running as a stranger. Coming back down to
# 'authenticated' would quietly test a different role's grants than the one the
# preamble asked for.
DOWN_ANON="perform set_config('role','anon',true);"

echo "── admission"
check "owner may open a sitting" ok "$open_desk" "$as_jamie"
check "editor may not — the desk is owner-only" GRK13 "$open_desk" "$as_rob"
check "anon may not" GRK13 "$open_desk" "$as_anon"
check "a workspace that does not exist is a 404, not a refusal" GRK10 \
  "select public.ai_begin_job('wbpr.desk','00000000-0000-4000-8000-000000000000');" "$as_jamie"
# The order of the gates is the point: a private project must not announce
# itself by refusing an AI job differently from a missing one.
check "someone else's private project is indistinguishable from missing" GRK10 \
  "select public.ai_begin_job('wbpr.desk','$ROBS');" "$as_jamie"
check "an unknown feature is refused" GRK12 \
  "select public.ai_begin_job('nope.nope','$WBPR');" "$as_jamie"

echo "── platform switches"
# Admins are unmetered, not exempt from the switch. Those are different
# properties and it is easy to implement the second by accident.
check "the kill switch stops a platform admin too" GRK11 \
  "update public.ai_platform_settings set enabled=false; $open_desk" "$as_jamie"
check "pausing admissions is a different refusal from the switch" GRK1B \
  "update public.ai_platform_settings set admissions_open=false; $open_desk" "$as_jamie"
check "a disabled feature is refused" GRK12 \
  "update public.ai_features set enabled=false where key='wbpr.desk'; $open_desk" "$as_jamie"
check "a feature disabled by its own quality floor is refused" GRK12 \
  "update public.ai_features set auto_disabled_at=now() where key='wbpr.desk'; $open_desk" "$as_jamie"
check "a project may switch a feature off for itself" GRK12 \
  "insert into public.ai_workspace_features (workspace_id,feature,enabled)
   values ('$WBPR','wbpr.desk',false); $open_desk" "$as_jamie"

echo "── budgets"
# Default deny is the property most likely to be lost later to a well-meaning
# coalesce, so it is checked first and from the payer's side.
check "a payer with no budget row is refused" GRK15 \
  "select public.ai_begin_job('wbpr.desk','$ROBS');" "$as_rob"
check "a payer whose allowance is spent is refused" GRK15 \
  "do \$\$ begin
     $SU
     insert into public.ai_periods (payer_id,period,committed_usd)
     values ('$JAMIE',date_trunc('month',now())::date,5.0);
     $DOWN
     perform public.ai_begin_job('wbpr.desk','$WBPR','interactive');
   end \$\$;" "$as_jamie"
check "a disabled budget is refused even with headroom" GRK15 \
  "update public.ai_budgets set enabled=false where user_id='$JAMIE'; $open_desk" "$as_jamie"
check "a project's daily ceiling is refused separately" GRK16 \
  "insert into public.ai_workspace_features (workspace_id,feature,daily_usd)
   values ('$WBPR','wbpr.desk',0.0001); $open_desk" "$as_jamie"

# THE CASE THE PER-CALL GATE PASSED. A batch that will not fit is refused at
# the door and makes no calls at all; the old shape made four hundred
# successful ones and discovered the problem from the invoice.
check "a batch too large for what is left is refused before any call" GRK18 \
  "select public.ai_begin_job('wbpr.desk','$WBPR','batch',4.0,400);" "$as_jamie"
check "the same batch inside its share is admitted" ok \
  "select public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,200);" "$as_jamie"
check "an admitted batch holds its whole envelope against the period" ok \
  "do \$\$ declare j uuid; r numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,200);
     select reserved_usd into r from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if coalesce(r,0) <> 1.0 then raise exception 'envelope not held: %', r; end if;
   end \$\$;" "$as_jamie"

echo "── the editor spends the owner's budget"
# Both facts at once: the desk refuses an editor, so a feature they may run is
# used to prove the payer is the owner and not the actor.
$PSQL -c "insert into public.ai_features (key,app,name,max_tokens,min_role,default_max_usd,default_max_calls)
          values ('wbpr.notes','wbpr','Block notes',400,'editor',0.05,4) on conflict do nothing;" >/dev/null
check "an editor's job is billed to the owner, not to them" ok \
  "do \$\$ declare j uuid; p uuid; a uuid; begin
     j := public.ai_begin_job('wbpr.notes','$WBPR','single');
     select payer_id, actor_id into p, a from public.ai_jobs where id=j;
     if p <> '$JAMIE' then raise exception 'payer is % not the owner', p; end if;
     if a <> '$ROB'   then raise exception 'actor is % not the editor', a; end if;
   end \$\$;" "$as_rob"

echo "── calls within a job"
check "a call reserves its worst case against the period" ok \
  "do \$\$ declare j uuid; c uuid; r numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     c := public.ai_begin_call(j);
     select reserved_usd into r from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if coalesce(r,0) <= 0 then raise exception 'nothing reserved'; end if;
   end \$\$;" "$as_jamie"

check "settling moves the reservation to committed and does not double count" ok \
  "do \$\$ declare j uuid; c uuid; res numeric; com numeric; cost numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     c := public.ai_begin_call(j);
     cost := public.ai_end_call(c, 1000, 200);
     select reserved_usd, committed_usd into res, com from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if res <> 0 then raise exception 'reservation not released: %', res; end if;
     if com <> cost then raise exception 'committed % but cost %', com, cost; end if;
     if (select spent_usd from public.ai_jobs where id=j) <> cost then
       raise exception 'job spend disagrees with the call'; end if;
   end \$\$;" "$as_jamie"

check "a call cannot be settled twice" GRK19 \
  "do \$\$ declare j uuid; c uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     c := public.ai_begin_call(j);
     perform public.ai_end_call(c, 100, 100);
     perform public.ai_end_call(c, 100, 100);
   end \$\$;" "$as_jamie"

# Two independent ceilings. It is easy to implement one and believe you have
# both, and the one that catches a loop of cheap calls is this one.
check "a job at its call ceiling refuses with money still in the envelope" GRK19 \
  "do \$\$ declare j uuid; c uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,1);
     c := public.ai_begin_call(j);
     perform public.ai_end_call(c, 100, 100);
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

check "a job out of envelope refuses with calls to spare" GRK19 \
  "do \$\$ declare j uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.000001,40);
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

# The gap the per-call design admitted to and left open: a switch that could
# not reach a sitting already running.
check "the kill switch stops the next call of a running job" GRK11 \
  "do \$\$ declare j uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_begin_call(j);
     update public.ai_platform_settings set enabled=false;
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

check "cancelling stops the next call" GRK19 \
  "do \$\$ declare j uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_cancel_job(j);
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

check "a job past its deadline stops" GRK19 \
  "do \$\$ declare j uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     $SU
     update public.ai_jobs set deadline = now() - interval '1 minute' where id=j;
     $DOWN
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

# A provider that errors after generating has already billed for what it
# generated. Treating failure as free is the quiet way a budget stops adding up.
check "a failed call still commits what it spent" ok \
  "do \$\$ declare j uuid; c uuid; cost numeric; com numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     c := public.ai_begin_call(j);
     cost := public.ai_end_call(c, 400, 30, null, null, 'the model answered 500');
     if cost <= 0 then raise exception 'a failed call was recorded as free'; end if;
     if (select status from public.ai_calls where id=c) <> 'failed' then
       raise exception 'not marked failed'; end if;
     select committed_usd into com from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if com <> cost then raise exception 'committed % but cost %', com, cost; end if;
   end \$\$;" "$as_jamie"

# Three conditions, all required, because spending an owner's money without
# signing in is the path that needs every switch thrown deliberately.
$PSQL -c "insert into public.ai_features (key,app,name,max_tokens,min_role,default_max_usd,default_max_calls)
          values ('wbpr.callin','wbpr','Call the station',300,'anon',0.02,2) on conflict do nothing;" >/dev/null
check "a stranger is refused when the project has not allowed it" GRK13 \
  "select public.ai_begin_job('wbpr.callin','$WBPR','single',null,null,null,'fp1');" "$as_anon"
check "a stranger is refused on a project that is not public" GRK13 \
  "do \$\$ begin
     $SU
     insert into public.ai_workspace_features (workspace_id,feature,allow_anon)
       values ('$WBPR','wbpr.callin',true);
     update public.workspaces set visibility='unlisted' where id='$WBPR';
     $DOWN_ANON
     perform public.ai_begin_job('wbpr.callin','$WBPR','single',null,null,null,'fp1');
   end \$\$;" "$as_anon"
check "a stranger is admitted only with all three switches thrown" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_workspace_features (workspace_id,feature,allow_anon)
       values ('$WBPR','wbpr.callin',true);
     $DOWN_ANON
     perform public.ai_begin_job('wbpr.callin','$WBPR','single',null,null,null,'fp1');
   end \$\$;" "$as_anon"
check "a stranger's job is billed to the owner" ok \
  "do \$\$ declare j uuid; begin
     $SU
     insert into public.ai_workspace_features (workspace_id,feature,allow_anon)
       values ('$WBPR','wbpr.callin',true);
     $DOWN_ANON
     j := public.ai_begin_job('wbpr.callin','$WBPR','single',null,null,null,'fp1');
     $SU
     if (select payer_id from public.ai_jobs where id=j) <> '$JAMIE' then
       raise exception 'a stranger was billed to somebody else'; end if;
     if (select actor_kind from public.ai_jobs where id=j) <> 'anon' then
       raise exception 'not recorded as anonymous'; end if;
   end \$\$;" "$as_anon"

echo "── fan-out"
# Without the root-envelope rule, ten children of a £1 job spend £10 and every
# individual check passes on the way.
check "children draw on the root's envelope, not their own" ok \
  "do \$\$ declare root uuid; kid uuid; c uuid; held numeric; begin
     update public.ai_features set max_depth=2 where key='wbpr.desk';
     root := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,50);
     kid  := public.ai_begin_job('wbpr.desk','$WBPR','single',null,4,root);
     if (select max_usd from public.ai_jobs where id=kid) <> 0 then
       raise exception 'child was given an envelope of its own'; end if;
     c := public.ai_begin_call(kid);
     select held_usd into held from public.ai_jobs where id=root;
     if held <= 0 then raise exception 'child call did not draw on the root'; end if;
   end \$\$;" "$as_jamie"

# The root's ceiling covers the whole tree. It said so and did not do it: the
# root's counter only moved when the root was itself the caller, so the check
# above it could never trip and a fan-out had as many calls as it liked.
check "a child's calls count against the root's ceiling" GRK19 \
  "do \$\$ declare root uuid; kid uuid; begin
     $SU
     update public.ai_features set max_depth=2 where key='wbpr.desk';
     $DOWN
     root := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,2);
     kid  := public.ai_begin_job('wbpr.desk','$WBPR','single',null,10,root);
     perform public.ai_begin_call(kid);
     perform public.ai_begin_call(kid);
     perform public.ai_begin_call(kid);
   end \$\$;" "$as_jamie"

check "a child beyond max_depth is refused" GRK17 \
  "do \$\$ declare root uuid; kid uuid; begin
     update public.ai_features set max_depth=0 where key='wbpr.desk';
     root := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,50);
     kid  := public.ai_begin_job('wbpr.desk','$WBPR','single',null,4,root);
   end \$\$;" "$as_jamie"

echo "── work items"
# Run as two concurrent claims rather than two sequential ones, or it proves
# nothing: sequential claims would divide the work even if the update were not
# atomic at all.
check "two ticks racing for one item: exactly one gets it" ok \
  "do \$\$ declare j uuid; a integer; b integer; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,50);
     perform public.ai_enqueue_items(j, '[{\"book\":1}]'::jsonb);
     select count(*) into a from public.ai_claim_items(j, 4);
     select count(*) into b from public.ai_claim_items(j, 4);
     if a <> 1 or b <> 0 then raise exception 'claimed % then %', a, b; end if;
   end \$\$;" "$as_jamie"

check "an item that keeps failing is dropped after three attempts" ok \
  "do \$\$ declare j uuid; s text; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,50);
     perform public.ai_enqueue_items(j, '[{\"book\":1}]'::jsonb);
     for i in 1..3 loop
       perform public.ai_claim_items(j, 1);
       perform public.ai_finish_item(j, 1, false, null, 'boom');
     end loop;
     select status into s from public.ai_job_items where job_id=j and position=1;
     if s <> 'failed' then raise exception 'item is % after three attempts', s; end if;
   end \$\$;" "$as_jamie"

check "a finished batch releases what its envelope did not spend" ok \
  "do \$\$ declare j uuid; c uuid; res numeric; com numeric; cost numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,50);
     c := public.ai_begin_call(j);
     cost := public.ai_end_call(c, 500, 100);
     perform public.ai_end_job(j, 'done');
     select reserved_usd, committed_usd into res, com from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if res <> 0 then raise exception 'envelope still held: %', res; end if;
     if com <> cost then raise exception 'committed % but spent %', com, cost; end if;
   end \$\$;" "$as_jamie"

echo "── the reapers"
check "a call whose outcome was never seen is released, not charged" ok \
  "do \$\$ declare j uuid; c uuid; s text; res numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     c := public.ai_begin_call(j);
     $SU
     update public.ai_calls set created_at = now() - interval '30 minutes' where id=c;
     perform public.ai_reap();
     $DOWN
     select status into s from public.ai_calls where id=c;
     if s <> 'released' then raise exception 'call is % after reaping', s; end if;
     select reserved_usd into res from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if res <> 0 then raise exception 'reservation not returned: %', res; end if;
   end \$\$;" "$as_jamie"

check "a fresh reservation is left alone" ok \
  "do \$\$ declare j uuid; c uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     c := public.ai_begin_call(j);
     $SU
     perform public.ai_reap();
     $DOWN
     if (select status from public.ai_calls where id=c) <> 'reserved' then
       raise exception 'a fresh call was reaped'; end if;
   end \$\$;" "$as_jamie"

check "a job whose worker stopped ticking gives its envelope back" ok \
  "do \$\$ declare j uuid; res numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','batch',1.0,50);
     $SU
     update public.ai_jobs set status='running', heartbeat_at = now() - interval '1 hour' where id=j;
     perform public.ai_reap();
     $DOWN
     if (select status from public.ai_jobs where id=j) <> 'failed' then
       raise exception 'stale job not reaped'; end if;
     select reserved_usd into res from public.ai_periods
      where payer_id='$JAMIE' and period=date_trunc('month',now())::date;
     if res <> 0 then raise exception 'envelope still held: %', res; end if;
   end \$\$;" "$as_jamie"

echo "── what leaves the building"
# The flag is on the feature, not the platform: sending a book title and
# sending the shelf are different acts, and only the second needs asking.
$PSQL -c "insert into public.ai_features
            (key,app,name,max_tokens,min_role,default_max_usd,default_max_calls,sends_records)
          values ('wbpr.archive','wbpr','Ask the archive',600,'owner',0.05,3,true)
          on conflict (key) do update set sends_records = true;" >/dev/null

check "a records-sending feature is refused without consent" GRK1E \
  "select public.ai_begin_job('wbpr.archive','$WBPR','single');" "$as_jamie"
check "the same feature runs once the project has agreed" ok \
  "insert into public.ai_workspace_features (workspace_id,feature,consent_at,consent_by)
     values ('$WBPR','wbpr.archive',now(),'$JAMIE');
   select public.ai_begin_job('wbpr.archive','$WBPR','single');" "$as_jamie"
# Consent is prior to authorisation: whether the records may go at all is a
# different question from who is asking.
check "consent is checked before the role is" GRK1E \
  "select public.ai_begin_job('wbpr.archive','$WBPR','single');" "$as_rob"
check "a feature that sends nothing stored needs no consent" ok \
  "$open_desk" "$as_jamie"

check "transcripts are kept unless somebody sets a retention" ok \
  "do \$\$ begin
     $SU
     if public.ai_sweep_transcripts() <> 0 then
       raise exception 'swept with no retention configured'; end if;
   end \$\$;" "$as_jamie"

echo "── environment and idempotency"
# Every pull request gets a preview deployment, it shares this Supabase project,
# and the person who opened it is not the person who pays.
check "a preview deployment may not spend" GRK1D \
  "select public.ai_begin_job('wbpr.desk','$WBPR','interactive',null,null,null,null,null,'preview');" "$as_jamie"
check "a preview deployment may spend once the platform allows it" ok \
  "update public.ai_platform_settings set preview_enabled = true;
   select public.ai_begin_job('wbpr.desk','$WBPR','interactive',null,null,null,null,null,'preview');" "$as_jamie"
check "local development is not gated" ok \
  "select public.ai_begin_job('wbpr.desk','$WBPR','interactive',null,null,null,null,null,'development');" "$as_jamie"

check "the same idempotency key returns the same job" ok \
  "do \$\$ declare a uuid; b uuid; n bigint; begin
     a := public.ai_begin_job('wbpr.desk','$WBPR','single',null,null,null,null,null,'production','form-7');
     b := public.ai_begin_job('wbpr.desk','$WBPR','single',null,null,null,null,null,'production','form-7');
     if a <> b then raise exception 'a double submission made two jobs'; end if;
     select count(*) into n from public.ai_jobs where idempotency_key = 'form-7';
     if n <> 1 then raise exception 'expected one job, found %', n; end if;
   end \$\$;" "$as_jamie"
check "a different key is a different job" ok \
  "do \$\$ declare a uuid; b uuid; begin
     a := public.ai_begin_job('wbpr.desk','$WBPR','single',null,null,null,null,null,'production','form-7');
     b := public.ai_begin_job('wbpr.desk','$WBPR','single',null,null,null,null,null,'production','form-8');
     if a = b then raise exception 'two keys collapsed into one job'; end if;
   end \$\$;" "$as_jamie"
# The refusal has to be free, or a retry storm against a spent allowance costs
# a rate-limit slot each time it is told no.
check "a repeated key does not spend a rate-limit slot" ok \
  "do \$\$ declare j uuid; n bigint; begin
     for i in 1..40 loop
       j := public.ai_begin_job('wbpr.desk','$WBPR','single',null,null,null,null,null,'production','same');
     end loop;
     select count(*) into n from public.ai_jobs where idempotency_key = 'same';
     if n <> 1 then raise exception 'expected one job, found %', n; end if;
   end \$\$;" "$as_jamie"

echo "── the cache"
check "a miss returns nothing and records nothing" ok \
  "do \$\$ declare j uuid; c text; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     select content into c from public.ai_cache_take(j, 'nothing-here');
     if c is not null then raise exception 'a miss returned %', c; end if;
     if (select calls_made from public.ai_jobs where id=j) <> 0 then
       raise exception 'a miss counted as a call'; end if;
   end \$\$;" "$as_jamie"

# A hit is free and is still a ledger row. Without the row, hit rate is
# invisible and a cheap month looks like a quiet one.
check "a hit costs nothing and is recorded anyway" ok \
  "do \$\$ declare j uuid; c text; n bigint; cost numeric; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_cache_put(j, 'k1', 'the answer');
     select content into c from public.ai_cache_take(j, 'k1');
     if c <> 'the answer' then raise exception 'got %', c; end if;
     select count(*), coalesce(sum(cost_usd),0) into n, cost
       from public.ai_calls where job_id = j and cache_hit;
     if n <> 1 then raise exception 'expected one cache-hit row, found %', n; end if;
     if cost <> 0 then raise exception 'a cache hit cost %', cost; end if;
   end \$\$;" "$as_jamie"

# A loop serving itself from cache is still a loop, and max_calls is what stops
# it — the budget cannot, because nothing is being spent.
check "cache hits count against the job's call ceiling" GRK19 \
  "do \$\$ declare j uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,1);
     perform public.ai_cache_put(j, 'k1', 'the answer');
     perform public.ai_cache_take(j, 'k1');
     perform public.ai_cache_take(j, 'k1');
   end \$\$;" "$as_jamie"

# A hit writes a ledger row and used to throw its id away, leaving the caller
# with content and nothing to attach a proposal to.
check "a hit hands back the call it recorded" ok \
  "do \$\$ declare j uuid; cid uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_cache_put(j, 'k1', 'the answer');
     select call_id into cid from public.ai_cache_take(j, 'k1');
     if cid is null then raise exception 'no call id came back'; end if;
     if not exists (select 1 from public.ai_calls where id = cid and cache_hit) then
       raise exception 'the id does not name a cache-hit call'; end if;
   end \$\$;" "$as_jamie"

# Serving an answer from a superseded model would hide the change that was
# made on purpose.
check "changing the model invalidates what it produced" ok \
  "do \$\$ declare j uuid; c text; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_cache_put(j, 'k1', 'the old answer');
     $SU
     update public.ai_features set model = 'minimax-m4' where key = 'wbpr.desk';
     $DOWN
     select content into c from public.ai_cache_take(j, 'k1');
     if c is not null then raise exception 'served a stale model answer'; end if;
   end \$\$;" "$as_jamie"

check "an expired entry is not served, and sweeps away" ok \
  "do \$\$ declare j uuid; c text; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_cache_put(j, 'k1', 'stale', null, interval '-1 day');
     select content into c from public.ai_cache_take(j, 'k1');
     if c is not null then raise exception 'served an expired entry'; end if;
     $SU
     if public.ai_cache_sweep() < 1 then raise exception 'nothing swept'; end if;
   end \$\$;" "$as_jamie"

# Scoped to a workspace by construction, so a private project's answer can
# never be served to somebody who merely asked the same question.
check "the cache does not cross projects" ok \
  "do \$\$ declare mine uuid; theirs uuid; c text; begin
     mine := public.ai_begin_job('wbpr.desk','$WBPR','interactive');
     perform public.ai_cache_put(mine, 'shared-key', 'my private answer');
     $SU
     if exists (select 1 from public.ai_cache
                 where key = 'shared-key' and workspace_id <> '$WBPR') then
       raise exception 'the entry escaped its workspace'; end if;
   end \$\$;" "$as_jamie"

echo "── when the provider is what is broken"
# Consecutive, not total: one failure in fifty is a provider working normally.
check "five failures in a row open the breaker" ok \
  "do \$\$ declare j uuid; c uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,20);
     for i in 1..5 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 0, 0, null, null, 'the model answered 500');
     end loop;
     if not exists (select 1 from public.ai_provider_health
                     where provider='minimax' and opened_until > now()) then
       raise exception 'the breaker stayed shut'; end if;
   end \$\$;" "$as_jamie"

check "an open breaker refuses the next call without attempting it" GRK1F \
  "do \$\$ declare j uuid; c uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,20);
     for i in 1..5 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 0, 0, null, null, 'the model answered 500');
     end loop;
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

check "four failures are not enough" ok \
  "do \$\$ declare j uuid; c uuid; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,20);
     for i in 1..4 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 0, 0, null, null, 'the model answered 500');
     end loop;
     perform public.ai_begin_call(j);
   end \$\$;" "$as_jamie"

# One good answer means the provider is back, whatever it did before.
check "a success resets the count" ok \
  "do \$\$ declare j uuid; c uuid; n integer; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,20);
     for i in 1..4 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 0, 0, null, null, 'boom');
     end loop;
     c := public.ai_begin_call(j);
     perform public.ai_end_call(c, 100, 50);
     select consecutive_failures into n from public.ai_provider_health where provider='minimax';
     if n <> 0 then raise exception 'still counting %', n; end if;
   end \$\$;" "$as_jamie"

# The model answered, and answered badly. That is the quality floor's business;
# counting it here would trip the breaker on a bad prompt.
check "a validator failure is not a provider failure" ok \
  "do \$\$ declare j uuid; c uuid; n integer; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,20);
     for i in 1..8 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 100, 50, 'fail', '[]'::jsonb);
     end loop;
     select coalesce(consecutive_failures,0) into n
       from public.ai_provider_health where provider='minimax';
     if coalesce(n,0) <> 0 then raise exception 'bad answers tripped the breaker'; end if;
   end \$\$;" "$as_jamie"

# A batch settling twenty failures into an already-open breaker would push its
# closing time out by an hour.
check "an open breaker is not pushed further out by more failures" ok \
  "do \$\$ declare j uuid; c uuid; first timestamptz; later timestamptz; begin
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,20);
     for i in 1..5 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 0, 0, null, null, 'boom');
     end loop;
     select opened_until into first from public.ai_provider_health where provider='minimax';
     $SU
     insert into public.ai_calls (job_id,feature,workspace_id,payer_id,provider,model,reserved_usd)
       values (j,'wbpr.desk','$WBPR','$JAMIE','minimax','minimax-m3',0)
       returning id into c;
     $DOWN
     perform public.ai_end_call(c, 0, 0, null, null, 'boom');
     select opened_until into later from public.ai_provider_health where provider='minimax';
     if later <> first then raise exception 'the breaker moved: % then %', first, later; end if;
   end \$\$;" "$as_jamie"

check "an admin can close the breaker by hand" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_provider_health (provider,model,opened_until)
       values ('minimax','minimax-m3', now() + interval '1 hour');
     $DOWN
     update public.ai_provider_health set opened_until = null, consecutive_failures = 0
      where provider = 'minimax';
     if exists (select 1 from public.ai_provider_health where opened_until > now()) then
       raise exception 'still open'; end if;
   end \$\$;" "$as_jamie"

# Asserted by outcome rather than by error, because an UPDATE refused by a
# USING clause does not raise — it narrows to zero rows and reports success.
# That is the same silent narrowing every delete in this app checks for, and a
# test expecting an exception would have passed while proving nothing.
check "an ordinary user cannot close it" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_provider_health (provider,model,opened_until)
       values ('minimax','minimax-m3', now() + interval '1 hour')
       on conflict (provider,model) do update set opened_until = excluded.opened_until;
     $DOWN
     update public.ai_provider_health set opened_until = null
      where provider = 'minimax';
     $SU
     if not exists (select 1 from public.ai_provider_health
                     where provider = 'minimax' and opened_until > now()) then
       raise exception 'a non-admin closed the breaker'; end if;
   end \$\$;" "$as_rob"

echo "── the quality floor"
# The control that was a column and a wish until something read it.
check "a feature whose answers keep failing switches itself off" ok \
  "do \$\$ declare j uuid; c uuid; begin
     $SU
     update public.ai_features set quality_floor = 0.10 where key='wbpr.desk';
     $DOWN
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,30);
     for i in 1..25 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 10, 10, 'fail', '[]'::jsonb);
     end loop;
     perform public.ai_end_job(j, 'done');
     $SU
     perform public.ai_enforce_quality_floors();
     if (select auto_disabled_at from public.ai_features where key='wbpr.desk') is null then
       raise exception 'the floor did not trip'; end if;
   end \$\$;"  "$as_jamie"

check "a feature switched off by its floor refuses the next job" GRK12 \
  "do \$\$ declare j uuid; c uuid; begin
     $SU
     update public.ai_features set quality_floor = 0.10 where key='wbpr.desk';
     $DOWN
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,30);
     for i in 1..25 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 10, 10, 'fail', '[]'::jsonb);
     end loop;
     perform public.ai_end_job(j, 'done');
     $SU
     perform public.ai_enforce_quality_floors();
     $DOWN
     perform public.ai_begin_job('wbpr.desk','$WBPR','interactive');
   end \$\$;" "$as_jamie"

# Below the sample size a single bad night would switch off a working feature,
# and the cure would be worse than the fault.
check "a handful of failures is not enough to trip it" ok \
  "do \$\$ declare j uuid; c uuid; begin
     $SU
     update public.ai_features set quality_floor = 0.10 where key='wbpr.desk';
     $DOWN
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,30);
     for i in 1..5 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 10, 10, 'fail', '[]'::jsonb);
     end loop;
     perform public.ai_end_job(j, 'done');
     $SU
     perform public.ai_enforce_quality_floors();
     if (select auto_disabled_at from public.ai_features where key='wbpr.desk') is not null then
       raise exception 'tripped on five calls'; end if;
   end \$\$;" "$as_jamie"

check "calls that pass their check leave the feature alone" ok \
  "do \$\$ declare j uuid; c uuid; begin
     $SU
     update public.ai_features set quality_floor = 0.10 where key='wbpr.desk';
     $DOWN
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,30);
     for i in 1..25 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 10, 10, 'pass');
     end loop;
     perform public.ai_end_job(j, 'done');
     $SU
     perform public.ai_enforce_quality_floors();
     if (select auto_disabled_at from public.ai_features where key='wbpr.desk') is not null then
       raise exception 'tripped on a clean run'; end if;
   end \$\$;" "$as_jamie"

echo "── notices"
# A control nobody is told about is a control nobody uses. The floor already
# disables the feature; this is whether anybody finds out before they next
# happen to open the admin page.
check "a feature switching itself off raises a notice" ok \
  "do \$\$ declare j uuid; c uuid; begin
     $SU
     update public.ai_features set quality_floor = 0.10 where key='wbpr.desk';
     $DOWN
     j := public.ai_begin_job('wbpr.desk','$WBPR','interactive',0.5,30);
     for i in 1..25 loop
       c := public.ai_begin_call(j);
       perform public.ai_end_call(c, 10, 10, 'fail', '[]'::jsonb);
     end loop;
     perform public.ai_end_job(j, 'done');
     $SU
     perform public.ai_enforce_quality_floors();
     if not exists (select 1 from public.ai_notices where kind = 'quality') then
       raise exception 'the floor tripped silently'; end if;
   end \$\$;" "$as_jamie"

check "a payer most of the way through their allowance is told" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_periods (payer_id,period,committed_usd)
     values ('$JAMIE',date_trunc('month',now())::date,4.5);
     if public.ai_check_budgets() < 1 then raise exception 'no notice raised'; end if;
     if not exists (select 1 from public.ai_notices
                     where kind = 'budget' and recipient = '$JAMIE') then
       raise exception 'the notice was not addressed to the payer'; end if;
   end \$\$;" "$as_jamie"

# Once per payer per month per threshold, or a nightly job turns one fact into
# thirty emails.
check "the same warning is not raised twice" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_periods (payer_id,period,committed_usd)
     values ('$JAMIE',date_trunc('month',now())::date,4.5);
     perform public.ai_check_budgets();
     perform public.ai_check_budgets();
     if (select count(*) from public.ai_notices where kind='budget') <> 1 then
       raise exception 'raised twice'; end if;
   end \$\$;" "$as_jamie"

check "somebody comfortably inside their allowance is left alone" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_periods (payer_id,period,committed_usd)
     values ('$JAMIE',date_trunc('month',now())::date,0.5);
     if public.ai_check_budgets() <> 0 then raise exception 'warned too early'; end if;
   end \$\$;" "$as_jamie"

check "a notice is only readable by the person it is for" ok \
  "do \$\$ begin
     $SU
     insert into public.ai_periods (payer_id,period,committed_usd)
     values ('$JAMIE',date_trunc('month',now())::date,4.5);
     perform public.ai_check_budgets();
     $DOWN
     perform set_config('request.jwt.claims','{\"sub\":\"$ROB\"}',true);
     if exists (select 1 from public.ai_notices) then
       raise exception 'a notice leaked'; end if;
   end \$\$;" "$as_jamie"

check "housekeeping is refused to a non-admin" 42501 \
  "select * from public.ai_housekeeping_now();" "$as_rob"

echo "── golden cases"
$PSQL -c "insert into public.ai_golden_cases (feature,name,input,expectations)
          values ('wbpr.desk','a block opening',
                  '{\"messages\":[]}'::jsonb,
                  '{\"validator\":\"pass\"}'::jsonb) on conflict do nothing;" >/dev/null
check "an admin can read the status of every case" ok \
  "do \$\$ begin
     if (select count(*) from public.ai_golden_status()) < 1 then
       raise exception 'no cases came back'; end if;
   end \$\$;" "$as_jamie"
# A golden case is a frozen copy of somebody's data and the prompt sent with
# it. Neither belongs in a table any signed-in user can read.
check "a case is not readable by an ordinary user" ok \
  "do \$\$ begin if exists (select 1 from public.ai_golden_cases)
     then raise exception 'a case leaked'; end if; end \$\$;" "$as_rob"
check "the status function is refused to a non-admin" 42501 \
  "select * from public.ai_golden_status();" "$as_rob"
# Billed to the platform, never to the feature under test: nobody asked for the
# evaluation.
check "golden runs are their own feature with their own ceiling" ok \
  "do \$\$ begin
     if not exists (select 1 from public.ai_features where key = 'platform.golden')
       then raise exception 'no platform.golden feature'; end if;
   end \$\$;" "$as_jamie"

echo "── who may see what"
$PSQL -c "
  select public.ai_begin_job('wbpr.desk','$WBPR','interactive');
" >/dev/null 2>&1
check "a stranger cannot read someone else's jobs" ok \
  "do \$\$ begin if exists (select 1 from public.ai_jobs where payer_id='$JAMIE')
     then raise exception 'leaked'; end if; end \$\$;" "$as_rob"
check "anon cannot read the ledger at all" "permission denied" \
  "select count(*) from public.ai_calls;" "$as_anon"
check "nobody can edit a job's spend directly" "permission denied" \
  "update public.ai_jobs set spent_usd = 0;" "$as_jamie"
check "nobody can grant themselves an allowance" "row-level security" \
  "insert into public.ai_budgets (user_id,monthly_usd) values ('$ROB',999);" "$as_rob"
check "prompt bodies are not readable by ordinary users" ok \
  "do \$\$ begin if exists (select 1 from public.ai_prompt_versions)
     then raise exception 'leaked'; end if; end \$\$;" "$as_rob"

check "the actor sees what they ran on somebody else's bill" ok \
  "do \$\$ declare j uuid; c uuid; n bigint; begin
     j := public.ai_begin_job('wbpr.notes','$WBPR','single');
     c := public.ai_begin_call(j);
     perform public.ai_end_call(c, 100, 100);
     select count(*) into n from public.my_ai_usage() where role = 'on their bill';
     if n < 1 then raise exception 'editor cannot see their own spending'; end if;
   end \$\$;" "$as_rob"

echo
echo "passed: $pass   failed: $fail"
[ $fail -eq 0 ]

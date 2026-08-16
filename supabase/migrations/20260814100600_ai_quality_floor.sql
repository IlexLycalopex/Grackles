-- The quality floor, with something that reads it.
--
-- `ai_features.quality_floor` and `auto_disabled_at` have existed since the
-- registry migration and nothing has ever looked at them, which made the
-- "features switch themselves off" control a column and a wish. This is the
-- part that acts.
--
-- A dashboard nobody acts on is not a control. The counterpart of a budget
-- refusal is a feature that stops offering itself when its own answers stop
-- being any good, thrown automatically and with the reason recorded.

create function public.ai_enforce_quality_floors()
returns table (feature text, sampled bigint, failed bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f      record;
  v_total  bigint;
  v_failed bigint;
begin
  for v_f in
    select key, quality_floor from public.ai_features
     where quality_floor is not null
       and enabled
       and auto_disabled_at is null
  loop
    -- The most recent fifty checked calls, not the whole history. A feature
    -- that was bad in March and has been fixed since should not be held down
    -- by March, and an average over everything takes longer to recover than it
    -- took to fall.
    select count(*), count(*) filter (where c.validator_status = 'fail')
      into v_total, v_failed
      from (
        select validator_status from public.ai_calls
         where ai_calls.feature = v_f.key and validator_status is not null
         order by created_at desc
         limit 50
      ) c;

    -- Twenty is the smallest sample worth acting on. Below it a single bad
    -- night would switch off a feature that is working, and the cure would be
    -- worse than the fault.
    if v_total >= 20 and (v_failed::numeric / v_total) > v_f.quality_floor then
      update public.ai_features
         set auto_disabled_at = now()
       where key = v_f.key;

      feature := v_f.key;
      sampled := v_total;
      failed  := v_failed;
      return next;
    end if;
  end loop;
end $$;

-- Folded into the reaper so there is one thing for cron to call. They run on
-- the same cadence and for the same reason: both are the system noticing
-- something without waiting for a person to look.
create or replace function public.ai_reap() returns table (calls integer, jobs integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call record; v_job record; v_calls integer := 0; v_jobs integer := 0;
begin
  for v_call in
    select c.*, r.class as root_class, r.id as root_id
      from public.ai_calls c
      join public.ai_jobs j on j.id = c.job_id
      join public.ai_jobs r on r.id = j.root_job_id
     where c.status = 'reserved'
       and c.created_at < now() - interval '15 minutes'
     for update of c
  loop
    update public.ai_calls
       set status = 'released', settled_at = now(), error = 'never settled'
     where id = v_call.id;

    update public.ai_jobs
       set held_usd = greatest(0, held_usd - v_call.reserved_usd)
     where id = v_call.root_id;

    if v_call.root_class in ('single', 'interactive') then
      perform app.ai_period_move(v_call.payer_id, -v_call.reserved_usd, 0, v_call.created_at);
    end if;

    v_calls := v_calls + 1;
  end loop;

  for v_job in
    select * from public.ai_jobs
     where status in ('queued', 'running')
       and coalesce(heartbeat_at, started_at, created_at) < now() - interval '10 minutes'
     for update
  loop
    perform public.ai_end_job(v_job.id, 'failed', 'heartbeat lost');
    v_jobs := v_jobs + 1;
  end loop;

  perform public.ai_enforce_quality_floors();

  return query select v_calls, v_jobs;
end $$;

revoke all on function public.ai_enforce_quality_floors() from public;
grant execute on function public.ai_enforce_quality_floors() to service_role;
revoke all on function public.ai_reap() from public;
grant execute on function public.ai_reap() to service_role;

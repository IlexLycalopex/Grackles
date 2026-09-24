-- The AI housekeeping functions, executable by the service role and nobody
-- else — which is what their migrations always said.
--
-- Found by the advisors on the read-back of 20260924140000. Each of these was
-- created with `revoke all ... from public` and `grant ... to service_role`,
-- and on production each was still executable by `anon` and `authenticated`:
-- Supabase's default privileges grant EXECUTE to both roles *by name* when a
-- function is created, and a revoke from PUBLIC does not touch a grant made to
-- a role directly. The same thing 20260917130000 and 20260924130100 found.
--
-- What that exposed, to anybody with the publishable key: reading the pending
-- budget notices and marking them sent (so they never went out), and running
-- the sweeps early — transcripts deleted and cache cleared ahead of schedule.
--
-- Nothing in the app calls these. Cron runs them as the owner, and the admin
-- "run it now" button goes through ai_housekeeping_now(), which is SECURITY
-- DEFINER and checks for a platform admin, so it keeps working.
--
-- ai_budget_for_new_profile() is a trigger function. Calling it directly only
-- errors, but it is on the same list for the same reason, and a trigger fires
-- whatever the caller's EXECUTE says.

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ai_reap()',
    'public.ai_housekeeping()',
    'public.ai_pending_notices()',
    'public.ai_notice_sent(uuid, text)',
    'public.ai_sweep_transcripts()',
    'public.ai_cache_sweep()',
    'public.ai_check_budgets()',
    'public.ai_enforce_quality_floors()',
    'public.ai_budget_for_new_profile()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  -- Restated rather than assumed. The trigger function has no caller to grant.
  foreach f in array array[
    'public.ai_reap()',
    'public.ai_housekeeping()',
    'public.ai_pending_notices()',
    'public.ai_notice_sent(uuid, text)',
    'public.ai_sweep_transcripts()',
    'public.ai_cache_sweep()',
    'public.ai_check_budgets()',
    'public.ai_enforce_quality_floors()'
  ] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

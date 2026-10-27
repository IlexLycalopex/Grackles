-- The admin console's functions, and the signed-in-only AI functions, taken
-- away from `anon`.
--
-- Each one already refuses somebody who is not a platform admin (or, for
-- my_ai_usage, somebody not signed in), so nothing was exposed. They were
-- executable by `anon` only because Supabase's default privileges grant to it
-- by name, which a revoke from PUBLIC does not reach — the same cause as
-- 20260917130000, 20260924130100 and 20260924150000. Revoking means a signed-out
-- caller is refused by the grant rather than by the function body, and the
-- advisors stop listing them.
--
-- Deliberately left alone, because signed-out callers are part of their design:
-- invite_email_for_token() is how /invite/<token> learns who an invitation is
-- for before sign-in, and the AI job lifecycle functions serve anonymous jobs
-- (actor_kind 'anon'), each checking the job itself.

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.admin_invites()',
    'public.admin_members(uuid)',
    'public.admin_overview()',
    'public.admin_people()',
    'public.admin_projects()',
    'public.admin_remove_member(uuid, uuid)',
    'public.admin_revoke_invite(uuid)',
    'public.admin_set_grant(uuid, app_slug, integer)',
    'public.admin_set_member_role(uuid, uuid, member_role)',
    'public.admin_set_platform_admin(uuid, boolean)',
    'public.admin_set_visibility(uuid, visibility)',
    'public.ai_admin_queue()',
    'public.ai_admin_spend(date)',
    'public.ai_curate_desk_case(uuid, text)',
    'public.ai_golden_status()',
    'public.ai_housekeeping_now()',
    'public.ai_reconciliation(integer)',
    'public.ai_set_budget(uuid, numeric, boolean)',
    'public.my_ai_usage(date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

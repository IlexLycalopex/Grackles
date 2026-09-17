-- One revoke, found by reading state back off production.
--
-- `remember_workspace_slug()` went on with EXECUTE held by PUBLIC, because
-- Supabase's default privileges on `public` grant it on every new function and
-- 20260917120000 revoked nothing. Every other trigger function on the project —
-- handle_new_workspace, handle_new_user, guard_last_owner,
-- set_publisher_normalised, ai_budget_for_new_profile — has it withheld, and
-- this was the only one that did not.
--
-- Nothing was exposed. A plpgsql trigger function invoked directly raises
-- immediately, so calling it buys nothing, and it is SECURITY DEFINER, which
-- is exactly the kind of function that should not be callable by anyone who
-- has no use for it. This is the same class of finding as
-- 20260807150000_cigar_reference_grants and 20260828120500 — the third and
-- fourth times a GRANT was assumed to withhold what it did not name — and, as
-- supabase/README.md says, revoke-shaped facts are invisible to the local
-- suite because tests/baseline.sql does not reproduce ALTER DEFAULT PRIVILEGES.
-- It can be checked on production or not at all.

revoke all on function public.remember_workspace_slug() from public, anon, authenticated;

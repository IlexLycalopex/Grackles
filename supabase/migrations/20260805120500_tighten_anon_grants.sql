-- Defence in depth: stop `anon` holding write privileges it never uses.
--
-- Supabase's default privileges granted anon full DML (INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER) on every table in public. Nothing is currently
-- exposed by this — every write policy resolves to false without an
-- auth.uid() — but it means RLS is the only barrier, and one permissive policy
-- would turn into anonymous writes.
--
-- Independent of the invite/creation work; safe to apply on its own.

revoke all on all tables in schema public from anon;

-- Anonymous visitors read public and unlisted workspaces and their contents.
-- Everything else (profiles, membership, invites, entitlements) is already
-- invisible to anon by policy; withdrawing SELECT makes that structural.
grant select on
  public.workspaces,
  public.cl_cigars,
  public.rl_books,
  public.rl_years,
  public.rl_publisher_aliases,
  public.lp_contributors,
  public.lp_seasons,
  public.lp_season_contributors,
  public.lp_selections
to anon;

-- Future tables should not inherit write access either. Supabase also sets
-- default privileges for supabase_admin; if tables get created by that role,
-- repeat this with `for role supabase_admin`.
alter default privileges for role postgres in schema public
  revoke all on tables from anon;

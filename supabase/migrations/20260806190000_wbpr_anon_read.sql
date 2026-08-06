-- Let anonymous visitors read WBPR.
--
-- A policy is not a privilege. RLS decides which rows a role may see; the
-- GRANT decides whether it may touch the table at all, and it is checked
-- first. The wbpr tables were created with policies and no grant to `anon`,
-- which is refused at the privilege check before any policy is consulted.
--
-- `authenticated` and `service_role` already had theirs from Supabase's
-- default privileges for the schema. `anon` does not appear in those defaults,
-- which is why every other readable table — cl_cigars, rl_books, lp_seasons —
-- carries an explicit grant, and why these needed one too.
--
-- This is not what makes the archive public. workspaces_read still requires
-- the workspace be public or unlisted, and wbpr_broadcasts_read still requires
-- app.can_read(workspace_id). Without the grant those policies never got the
-- chance to say yes: the page came back empty rather than refused, because a
-- failed select returns no rows and the archive reads that as a quiet night.
--
-- SELECT only. Writing stays with `authenticated`, where the policies expect
-- an auth.uid() to check against.

grant select on public.wbpr_broadcasts to anon;
grant select on public.wbpr_blocks     to anon;
grant select on public.wbpr_prompts    to anon;
grant select on public.wbpr_tracks     to anon;
grant select on public.wbpr_phenomena  to anon;

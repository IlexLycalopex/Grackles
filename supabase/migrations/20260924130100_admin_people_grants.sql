-- Withdraws the EXECUTE that Supabase's default privileges hand `anon` on every
-- new function in `public`. Found by reading 20260924130000 back off
-- production: `revoke ... from public` does not touch it, because the grant to
-- anon is explicit rather than inherited — the same thing 20260917130000 found.
--
-- Nothing was exposed; both functions raise 42501 for anyone who is not a
-- platform admin. This is so anon holds nothing it has no use for, which is
-- the rule 20260805120500 set.
--
-- The eleven admin_ functions from 20260814101800 carry the same grant and are
-- left as they are here: that is a change to shipped functions, and belongs in
-- a migration of its own.
revoke execute on function public.admin_person_projects(uuid) from anon;
revoke execute on function public.admin_add_member(uuid, uuid, member_role) from anon;

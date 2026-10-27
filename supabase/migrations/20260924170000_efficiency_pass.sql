-- The performance advisors, acted on where it matters, plus a limit on the one
-- storage bucket.
--
-- 1. Thirteen policies called auth.uid() (and app.is_platform_admin()) bare,
--    which Postgres re-evaluates for every row it considers. Wrapped in a
--    sub-select they are evaluated once per statement. What each policy allows
--    is unchanged: ALTER POLICY keeps its command and roles, and the
--    expressions below are the ones production held, word for word, with only
--    the wrapping added.
--
-- 2. Foreign keys with no index on the child side, on the paths that delete:
--    removing a project, a library entry or an account has to find every row
--    that points at it, and without an index that is a scan of the whole child
--    table per parent row. The advisors list 45; the ones here are those a
--    delete or a join in the app actually walks. The rest are audit columns
--    (granted_by, decided_by and the like) that nothing looks up by.
--
-- 3. `cigar-photos` had no size or type limit. Nothing in the app uploads to
--    it (a photo is a link), and it is empty, so this changes nothing today; it
--    means the first thing that does upload cannot put a 5 GB file or an HTML
--    page there.

-- ── 1. Policies ─────────────────────────────────────────────────────────────

alter policy ai_budgets_read on public.ai_budgets
  using ((user_id = (select auth.uid())) or (select app.is_platform_admin()));

alter policy ai_calls_read on public.ai_calls
  using ((payer_id = (select auth.uid())) or (actor_id = (select auth.uid()))
         or (select app.is_platform_admin()));

alter policy ai_jobs_read on public.ai_jobs
  using ((payer_id = (select auth.uid())) or (actor_id = (select auth.uid()))
         or (select app.is_platform_admin()));

alter policy ai_jobs_cancel on public.ai_jobs
  using ((payer_id = (select auth.uid())) or (actor_id = (select auth.uid()))
         or (select app.is_platform_admin()))
  with check ((payer_id = (select auth.uid())) or (actor_id = (select auth.uid()))
              or (select app.is_platform_admin()));

alter policy ai_notices_read on public.ai_notices
  using ((recipient = (select auth.uid())) or (select app.is_platform_admin()));

alter policy ai_periods_read on public.ai_periods
  using ((payer_id = (select auth.uid())) or (select app.is_platform_admin()));

alter policy app_grants_read on public.app_grants
  using (user_id = (select auth.uid()));

alter policy profiles_read on public.profiles
  using ((id = (select auth.uid())) or app.shares_workspace_with(id));

alter policy profiles_update_self on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy invites_manage on public.workspace_invites
  using ((select app.is_platform_admin())
         or ((workspace_id is not null) and app.is_owner(workspace_id)))
  with check ((invited_by = (select auth.uid()))
              and ((select app.is_platform_admin())
                   or ((workspace_id is not null) and app.is_owner(workspace_id)
                       and (cardinality(grant_apps) = 0))));

alter policy invites_read on public.workspace_invites
  using ((select app.is_platform_admin())
         or ((workspace_id is not null) and app.is_owner(workspace_id))
         or (email = ((select auth.jwt()) ->> 'email')::extensions.citext));

alter policy members_read on public.workspace_members
  using ((user_id = (select auth.uid())) or (app.workspace_role(workspace_id) is not null));

alter policy workspaces_insert on public.workspaces
  with check ((owner_id = (select auth.uid())) and app.can_create(app));

-- ── 2. Indexes on the delete paths ──────────────────────────────────────────

-- A project's rows, when the project is deleted.
create index if not exists rl_import_rows_workspace_idx      on public.rl_import_rows (workspace_id);
create index if not exists wbpr_agent_messages_workspace_idx on public.wbpr_agent_messages (workspace_id);
create index if not exists wbpr_blocks_workspace_idx         on public.wbpr_blocks (workspace_id);
create index if not exists wbpr_prompts_workspace_idx        on public.wbpr_prompts (workspace_id);

-- A library entry or an import, when it is deleted or merged.
create index if not exists rl_import_rows_match_library_idx on public.rl_import_rows (match_library_id);
create index if not exists rl_import_rows_library_idx       on public.rl_import_rows (library_id);
create index if not exists rl_library_source_batch_idx      on public.rl_library (source_batch_id);
create index if not exists rl_library_reference_idx         on public.rl_library (reference_id);
create index if not exists cl_cigars_reference_idx          on public.cl_cigars (reference_id);

-- An account, when it is deleted; and the owner's own projects, which
-- lib/grants.ts counts on every dashboard load.
create index if not exists workspaces_owner_idx      on public.workspaces (owner_id);
create index if not exists bl_games_user_idx         on public.bl_games (user_id);
create index if not exists lp_contributors_user_idx  on public.lp_contributors (user_id);

-- The rest of the walks: a puzzle's games, a contributor's seasons, a
-- broadcast's sittings, and a job's children.
create index if not exists bl_games_puzzle_idx                  on public.bl_games (puzzle_id);
create index if not exists lp_season_contributors_contributor_idx on public.lp_season_contributors (contributor_id);
create index if not exists wbpr_agent_sessions_broadcast_idx    on public.wbpr_agent_sessions (broadcast_id);
create index if not exists ai_jobs_parent_idx                   on public.ai_jobs (parent_job_id);
create index if not exists ai_jobs_root_idx                     on public.ai_jobs (root_job_id);

-- ── 3. The photo bucket ─────────────────────────────────────────────────────

-- Guarded because the local test cluster has no storage schema.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets
       set file_size_limit    = 10 * 1024 * 1024,
           allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/avif']
     where id = 'cigar-photos';
  end if;
end $$;

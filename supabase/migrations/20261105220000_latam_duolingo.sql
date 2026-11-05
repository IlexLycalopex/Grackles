-- LatAm: Duolingo, counted from the public profile.
--
-- Duolingo's daily history (xp_summaries) now needs a signed-in session; the
-- public profile does not, and it carries each course's lifetime XP and the
-- streak. So the sync (supabase/functions/latam-duolingo-sync) reads the
-- profile every hour and keeps a snapshot, and a day's Duolingo is the growth
-- in the Spanish course's XP between snapshots taken on that day, London
-- time. Minutes are estimated at three XP a minute, which is about what a
-- standard lesson earns, and the entry says so.
--
-- What this cannot do is the past: the first snapshot is a starting line, not
-- a day of practice. The lifetime figures are shown beside the totals instead.
-- An hour between snapshots means XP earned in the hour before midnight can
-- land on the next day; for a weekly total that is noise.

alter table public.lx_settings
  add column duolingo_username text,
  add constraint lx_settings_duolingo check (duolingo_username ~ '^[A-Za-z0-9_.-]{1,40}$');

grant update (duolingo_username) on public.lx_settings to authenticated;

alter table public.lx_activities drop constraint lx_activities_type;
alter table public.lx_activities add constraint lx_activities_type check (type in (
  'lesson', 'film', 'series', 'reading', 'article', 'music', 'mate',
  'conversation', 'note', 'practice', 'fishing', 'duolingo'));

create table public.lx_duolingo_snapshots (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  taken_at     timestamptz not null default now(),
  day          date not null,
  username     text not null,
  course_xp    bigint not null,
  total_xp     bigint not null,
  streak       integer not null
);

create index lx_duolingo_snapshots_idx on public.lx_duolingo_snapshots (workspace_id, taken_at desc);

-- One row per run of any LatAm sync, so a broken one shows on the front page.
create table public.lx_sync_runs (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source       text not null check (source in ('duolingo', 'strava')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  message      text not null default ''
);

create index lx_sync_runs_idx on public.lx_sync_runs (workspace_id, source, started_at desc);

-- Called by the sync with the service role. Records the snapshot and rewrites
-- that day's Duolingo entry from every snapshot of the day, so a rerun, or two
-- runs an hour apart, give the same answer. A username change starts a new
-- line: XP is only compared within one account.
create function public.lx_duolingo_ingest(
  p_workspace uuid, p_username text, p_course_xp bigint, p_total_xp bigint, p_streak integer
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day     date := (now() at time zone 'Europe/London')::date;
  v_xp      bigint;
  v_minutes integer;
begin
  insert into public.lx_duolingo_snapshots (workspace_id, day, username, course_xp, total_xp, streak)
  values (p_workspace, v_day, p_username, p_course_xp, p_total_xp, p_streak);

  select coalesce(sum(greatest(gain, 0)), 0) into v_xp
    from (select day, course_xp - lag(course_xp) over (order by taken_at) as gain
            from public.lx_duolingo_snapshots
           where workspace_id = p_workspace and lower(username) = lower(p_username)) s
   where day = v_day and gain is not null;

  if v_xp > 0 then
    v_minutes := least(600, round(v_xp / 3.0))::integer;
    insert into public.lx_activities (workspace_id, occurred_on, type, title, minutes, notes, tags,
                                      source, source_ref)
    values (p_workspace, v_day, 'duolingo', 'Spanish · ' || v_xp || ' XP', v_minutes,
            'Minutes estimated from XP, at three a minute', '{spanish}', 'duolingo', v_day::text)
    on conflict (workspace_id, source, source_ref) do update
      set title = excluded.title, minutes = excluded.minutes;
  end if;

  return jsonb_build_object('day', v_day, 'xp_today', v_xp);
end
$$;

revoke all on public.lx_duolingo_snapshots, public.lx_sync_runs from anon, authenticated;
grant select on public.lx_duolingo_snapshots, public.lx_sync_runs to anon, authenticated;
grant select, insert, update, delete on public.lx_duolingo_snapshots, public.lx_sync_runs to service_role;

revoke all on function public.lx_duolingo_ingest(uuid, text, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.lx_duolingo_ingest(uuid, text, bigint, bigint, integer) to service_role;

alter table public.lx_duolingo_snapshots enable row level security;
alter table public.lx_sync_runs          enable row level security;

create policy lx_duolingo_snapshots_read on public.lx_duolingo_snapshots for select using (app.can_read(workspace_id));
create policy lx_sync_runs_read          on public.lx_sync_runs          for select using (app.can_read(workspace_id));

-- JPOD — the podcast log. The seventh app moves in.
--
-- What it records is listening, and the only honest source of that is Pocket
-- Casts. Nothing here is typed in by hand except tags: shows, episodes and the
-- time spent on them arrive through one function, jp_ingest(), called by the
-- one-off history import and by the daily sync alike, so the two can never
-- disagree about what a row means.
--
-- Four things about the shape, before the tables:
--
-- 1. An episode is a state, a play is a fact. Pocket Casts keeps one position
--    and one status per episode and nothing else — no dates, no sessions. So
--    jp_episodes holds the latest state as Pocket Casts reported it, and
--    jp_plays holds the time it added: each sync compares what it is told with
--    what has already been counted and writes the difference, dated the day it
--    was seen. That is what makes "minutes this week" a sum rather than a guess.
--
-- 2. Undated is a value, not a gap. The app's own export carries a real last-
--    played time for most listens, and nothing at all for the 2,500 episodes
--    marked played in bulk when the library was set up in October 2019. Those
--    are kept, as `baseline` episodes whose play has a null `played_on`: they
--    count towards a show's total and towards nothing that has a date.
--
-- 3. Tags come from three places and are never stored merged. `jp_shows.tags`
--    and `jp_episodes.tags` are set by a person; `jp_episodes.auto_tags` is
--    written by the keyword rules in jp_tag_rules and rewritten whenever a rule
--    changes. jp_listen_log is where they meet. Keeping them apart is what lets
--    a rule be deleted without deleting what somebody tagged by hand.
--
-- 4. The sync writes as the service role. There is no insert policy on any of
--    these tables for anybody: a viewer reads, an editor tags and writes rules,
--    and listening arrives from Pocket Casts or not at all.

-- ── Rules the constraints call ──────────────────────────────────────
-- A tag is a short lowercase word or hyphenated phrase — `argentina`,
-- `spanish`, `latin-america` — because it ends up in a URL (?tag=) and is
-- compared by equality everywhere else. Twenty to a row is far more than any
-- real use and small enough that a runaway rule cannot bloat a row.
create function app.jp_tags_ok(t text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select cardinality(t) <= 20
     and coalesce((select bool_and(x ~ '^[a-z0-9][a-z0-9-]{0,39}$') from unnest(t) x), true)
$$;

-- A rule's pattern is a regular expression, and one that does not compile
-- would raise inside the trigger that applies it — on every later episode
-- insert, from the sync, with nobody watching. Refused at the door instead.
create function app.jp_regex_ok(p text) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  perform '' ~* p;
  return true;
exception when invalid_regular_expression then
  return false;
end
$$;

-- ── Shows ───────────────────────────────────────────────────────────
create table public.jp_shows (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Pocket Casts' own id for the podcast. The key everything is matched on,
  -- because titles change and two shows can share one.
  pc_uuid      text not null,
  title        text not null,
  author       text not null default '',
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint jp_shows_title check (char_length(btrim(title)) between 1 and 300),
  constraint jp_shows_tags  check (app.jp_tags_ok(tags)),
  unique (workspace_id, pc_uuid)
);

-- ── Episodes ────────────────────────────────────────────────────────
create table public.jp_episodes (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  show_id          uuid not null references public.jp_shows(id) on delete cascade,
  pc_uuid          text not null,
  title            text not null,
  published_at     timestamptz,
  duration_s       integer not null default 0,
  -- The latest state Pocket Casts reported, verbatim.
  status           text not null default 'unplayed',
  position_s       integer not null default 0,
  -- How much of this episode jp_plays already holds. Never sent; only
  -- jp_ingest() moves it, and only upwards.
  counted_s        integer not null default 0,
  -- When it was last listened to, where that is known. Null for the bulk
  -- baseline, and for nothing else.
  last_listened_at timestamptz,
  baseline         boolean not null default false,
  tags             text[] not null default '{}',
  auto_tags        text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint jp_episodes_status   check (status in ('unplayed', 'in_progress', 'played')),
  constraint jp_episodes_title    check (char_length(btrim(title)) between 1 and 500),
  constraint jp_episodes_seconds  check (duration_s >= 0 and position_s >= 0 and counted_s >= 0),
  constraint jp_episodes_tags     check (app.jp_tags_ok(tags) and app.jp_tags_ok(auto_tags)),
  unique (workspace_id, pc_uuid)
);

create index jp_episodes_show_idx on public.jp_episodes (show_id);
create index jp_episodes_recent_idx on public.jp_episodes (workspace_id, last_listened_at desc nulls last);

-- ── Time spent ──────────────────────────────────────────────────────
create table public.jp_plays (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  episode_id   uuid not null references public.jp_episodes(id) on delete cascade,
  -- The day the time was added, in London. Null only for the baseline.
  played_on    date,
  seconds      integer not null,
  source       text not null,
  created_at   timestamptz not null default now(),

  constraint jp_plays_seconds check (seconds > 0),
  constraint jp_plays_source  check (source in ('import', 'sync'))
);

create index jp_plays_day_idx on public.jp_plays (workspace_id, played_on);
create index jp_plays_episode_idx on public.jp_plays (episode_id);

-- ── Keyword rules ───────────────────────────────────────────────────
-- "Anything mentioning Patagonia is argentina." Matched case-insensitively as a
-- regular expression against the episode title and its show's title.
create table public.jp_tag_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tag          text not null,
  pattern      text not null,
  created_at   timestamptz not null default now(),

  constraint jp_tag_rules_tag     check (app.jp_tags_ok(array[tag])),
  constraint jp_tag_rules_pattern check (char_length(pattern) between 1 and 200 and app.jp_regex_ok(pattern)),
  unique (workspace_id, tag, pattern)
);

-- ── Sync runs ───────────────────────────────────────────────────────
-- One row per run, written by the sync function, so the app can say when it
-- last heard from Pocket Casts and what went wrong if it did not.
create table public.jp_sync_runs (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  fetched      integer not null default 0,
  new_episodes integer not null default 0,
  credited_s   integer not null default 0,
  message      text not null default ''
);

create index jp_sync_runs_recent_idx on public.jp_sync_runs (workspace_id, started_at desc);

create trigger touch_jp_shows before update on public.jp_shows
  for each row execute function public.touch_updated_at();
create trigger touch_jp_episodes before update on public.jp_episodes
  for each row execute function public.touch_updated_at();

-- ── Applying the rules ──────────────────────────────────────────────
-- The tags every rule in a workspace gives a piece of text. Definer, because
-- the trigger below runs as whoever wrote the episode — the sync, as the
-- service role — and the rules are the workspace's, not theirs.
create function app.jp_rule_tags(ws uuid, txt text) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct r.tag order by r.tag), '{}')
  from public.jp_tag_rules r
  where r.workspace_id = ws and txt ~* r.pattern
$$;

create function app.jp_episode_auto_tags() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.auto_tags := app.jp_rule_tags(
    new.workspace_id,
    new.title || ' ' || coalesce((select s.title from public.jp_shows s where s.id = new.show_id), '')
  );
  return new;
end
$$;

create trigger jp_episodes_auto_tags before insert or update of title, show_id on public.jp_episodes
  for each row execute function app.jp_episode_auto_tags();

-- Rewrite every episode's auto_tags in a workspace. Runs after any change to
-- its rules, so a rule added today applies to five years of history at once,
-- and a rule deleted takes its tag back off everything it put it on.
create function app.jp_retag(ws uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.jp_episodes e
     set auto_tags = app.jp_rule_tags(e.workspace_id, e.title || ' ' || s.title)
    from public.jp_shows s
   where s.id = e.show_id and e.workspace_id = ws
     and e.auto_tags is distinct from app.jp_rule_tags(e.workspace_id, e.title || ' ' || s.title)
$$;

create function app.jp_tag_rules_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.jp_retag(coalesce(new.workspace_id, old.workspace_id));
  return null;
end
$$;

create trigger jp_tag_rules_changed after insert or update or delete on public.jp_tag_rules
  for each row execute function app.jp_tag_rules_changed();

-- A show's title is part of what its episodes are matched against, so a
-- renamed show is re-matched too.
create function app.jp_show_renamed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.jp_episodes e
     set auto_tags = app.jp_rule_tags(e.workspace_id, e.title || ' ' || new.title)
   where e.show_id = new.id;
  return null;
end
$$;

create trigger jp_shows_renamed after update of title on public.jp_shows
  for each row when (old.title is distinct from new.title)
  execute function app.jp_show_renamed();

-- ── The one way listening gets in ───────────────────────────────────
-- p_rows is a JSON array of episodes as a source reported them:
--
--   { show_uuid, show_title, show_author, uuid, title, published_at,
--     duration_s, position_s, status, listened_at?, baseline? }
--
-- `status` is already one of this table's three values: mapping Pocket Casts'
-- numbers onto them is the caller's job, done once in
-- supabase/functions/_shared/pocketcasts.ts, because the web API and the
-- Android database number them differently.
--
-- What an episode is worth is its duration once played, and its position
-- until then. Whatever that comes to beyond `counted_s` is new time, and is
-- written to jp_plays:
--
--   'import'  dated by the row's own listened_at (null for the baseline)
--   'sync'    dated today in London, because Pocket Casts does not say when
--
-- Time only ever goes up. A position that moves backwards — a relisten, a
-- scrub — changes the state shown and credits nothing, because the time it
-- represents was already counted the first time through.
--
-- Callable by the service role only. Not a definer function: the service role
-- bypasses RLS already, and nobody else should be able to reach it.
create function public.jp_ingest(p_workspace uuid, p_rows jsonb, p_source text)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  r          jsonb;
  v_show     uuid;
  v_ep       public.jp_episodes;
  v_new      boolean;
  v_status   text;
  v_duration integer;
  v_position integer;
  v_target   integer;
  v_listened timestamptz;
  v_today    date := (now() at time zone 'Europe/London')::date;
  n_rows     integer := 0;
  n_new      integer := 0;
  n_credited bigint  := 0;
begin
  if p_source not in ('import', 'sync') then
    raise exception 'unknown source %', p_source using errcode = 'GRK40';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'rows must be a JSON array' using errcode = 'GRK41';
  end if;
  if not exists (select 1 from public.workspaces w where w.id = p_workspace and w.app = 'podcasts') then
    raise exception 'no JPOD project %', p_workspace using errcode = 'GRK42';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    n_rows := n_rows + 1;

    v_status := coalesce(r->>'status', 'unplayed');
    if v_status not in ('unplayed', 'in_progress', 'played') then
      raise exception 'row %: unknown status %', n_rows, v_status using errcode = 'GRK43';
    end if;
    v_duration := greatest(0, coalesce((r->>'duration_s')::numeric, 0))::integer;
    v_position := greatest(0, coalesce((r->>'position_s')::numeric, 0))::integer;
    v_listened := nullif(r->>'listened_at', '')::timestamptz;

    insert into public.jp_shows as s (workspace_id, pc_uuid, title, author)
    values (p_workspace, r->>'show_uuid', coalesce(nullif(btrim(r->>'show_title'), ''), 'Unknown show'),
            coalesce(r->>'show_author', ''))
    on conflict (workspace_id, pc_uuid) do update
      set title  = excluded.title,
          author = case when excluded.author <> '' then excluded.author else s.author end
      where s.title is distinct from excluded.title
         or (excluded.author <> '' and s.author is distinct from excluded.author)
    returning id into v_show;

    if v_show is null then
      select id into v_show from public.jp_shows
       where workspace_id = p_workspace and pc_uuid = r->>'show_uuid';
    end if;

    select * into v_ep from public.jp_episodes
     where workspace_id = p_workspace and pc_uuid = r->>'uuid'
     for update;
    v_new := not found;

    if v_new then
      insert into public.jp_episodes (workspace_id, show_id, pc_uuid, title, published_at, duration_s,
                                      status, position_s, last_listened_at, baseline)
      values (p_workspace, v_show, r->>'uuid', coalesce(nullif(btrim(r->>'title'), ''), 'Untitled episode'),
              nullif(r->>'published_at', '')::timestamptz, v_duration, v_status, v_position,
              v_listened, coalesce((r->>'baseline')::boolean, false))
      returning * into v_ep;
      n_new := n_new + 1;
    end if;

    v_target := case when v_status = 'played' then greatest(v_duration, v_position) else v_position end;

    if v_target > v_ep.counted_s then
      insert into public.jp_plays (workspace_id, episode_id, played_on, seconds, source)
      values (p_workspace, v_ep.id,
              case when p_source = 'sync' then v_today
                   else (v_listened at time zone 'Europe/London')::date end,
              v_target - v_ep.counted_s, p_source);
      n_credited := n_credited + (v_target - v_ep.counted_s);
    end if;

    update public.jp_episodes
       set title            = coalesce(nullif(btrim(r->>'title'), ''), title),
           show_id          = v_show,
           published_at     = coalesce(nullif(r->>'published_at', '')::timestamptz, published_at),
           duration_s       = case when v_duration > 0 then v_duration else duration_s end,
           status           = v_status,
           position_s       = v_position,
           counted_s        = greatest(counted_s, v_target),
           last_listened_at = case
             when p_source = 'import' then coalesce(v_listened, last_listened_at)
             when v_target > counted_s or status is distinct from v_status then now()
             else last_listened_at end
     where id = v_ep.id;
  end loop;

  return jsonb_build_object('rows', n_rows, 'new_episodes', n_new, 'credited_s', n_credited);
end
$$;

-- ── Reading it back ─────────────────────────────────────────────────
-- An episode as the pages show it: its show, and the three sources of tags
-- folded into one. security_invoker, so it sees exactly what the tables'
-- policies let the caller see.
create view public.jp_listen_log with (security_invoker = true) as
select e.id, e.workspace_id, e.show_id, s.title as show_title, e.title, e.published_at,
       e.duration_s, e.status, e.position_s, e.counted_s, e.last_listened_at, e.baseline,
       e.tags, e.auto_tags, s.tags as show_tags,
       array(select distinct t from unnest(e.tags || e.auto_tags || s.tags) t order by t) as all_tags
  from public.jp_episodes e
  join public.jp_shows s on s.id = e.show_id;

-- Time by month, optionally for one tag. Undated time has no month and is left
-- out; the show totals below are where it counts.
create function public.jp_monthly(p_workspace uuid, p_tag text default null)
returns table (month date, seconds bigint, episodes bigint)
language sql stable set search_path = public, pg_temp as $$
  select date_trunc('month', p.played_on)::date, sum(p.seconds)::bigint, count(distinct p.episode_id)
    from public.jp_plays p
    join public.jp_listen_log l on l.id = p.episode_id
   where p.workspace_id = p_workspace
     and p.played_on is not null
     and (p_tag is null or p_tag = any (l.all_tags))
   group by 1
   order by 1
$$;

-- Time added since a day, optionally for one tag: "this week", "this year".
create function public.jp_seconds_since(p_workspace uuid, p_from date, p_tag text default null)
returns bigint
language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(p.seconds), 0)::bigint
    from public.jp_plays p
    join public.jp_listen_log l on l.id = p.episode_id
   where p.workspace_id = p_workspace
     and p.played_on >= p_from
     and (p_tag is null or p_tag = any (l.all_tags))
$$;

-- Every show with what was listened to of it, baseline included. Given a tag,
-- only the episodes carrying it count, so one Videla series does not bring the
-- whole of Real Dictators into the Argentina totals.
create function public.jp_show_summary(p_workspace uuid, p_tag text default null)
returns table (show_id uuid, title text, author text, tags text[], episodes bigint,
               seconds bigint, last_listened_at timestamptz)
language sql stable set search_path = public, pg_temp as $$
  select s.id, s.title, s.author, s.tags,
         count(l.id) filter (where l.counted_s > 0),
         coalesce(sum(l.counted_s), 0)::bigint,
         max(l.last_listened_at)
    from public.jp_shows s
    left join public.jp_listen_log l
      on l.show_id = s.id and (p_tag is null or p_tag = any (l.all_tags))
   where s.workspace_id = p_workspace
   group by s.id
  having p_tag is null or count(l.id) > 0
$$;

-- Every tag in use, and how much listening carries it.
create function public.jp_tag_summary(p_workspace uuid)
returns table (tag text, episodes bigint, seconds bigint)
language sql stable set search_path = public, pg_temp as $$
  select t, count(*), sum(l.counted_s)::bigint
    from public.jp_listen_log l, unnest(l.all_tags) t
   where l.workspace_id = p_workspace and l.counted_s > 0
   group by t
   order by 3 desc, 1
$$;

-- ── Privileges ──────────────────────────────────────────────────────
-- Supabase's default privileges grant `authenticated` everything on a new
-- table and EXECUTE to PUBLIC on a new function, so withholding takes a
-- revoke: 20260807150000, 20260828120500 and 20260917130000 are the three
-- times that was learnt.
revoke all on public.jp_shows, public.jp_episodes, public.jp_plays,
              public.jp_tag_rules, public.jp_sync_runs, public.jp_listen_log
  from anon, authenticated;

grant select on public.jp_shows, public.jp_episodes, public.jp_plays,
                public.jp_tag_rules, public.jp_sync_runs, public.jp_listen_log
  to anon, authenticated;

-- The sync writes as the service role. Supabase's default privileges already
-- give it this on production; said here so the file states what the function
-- needs rather than leaning on a default nobody can see from the repo.
grant select, insert, update, delete on public.jp_shows, public.jp_episodes, public.jp_plays,
                                        public.jp_tag_rules, public.jp_sync_runs to service_role;
grant select on public.jp_listen_log to service_role;
grant usage on sequence public.jp_plays_id_seq, public.jp_sync_runs_id_seq to service_role;

-- Editors set tags, and nothing else on a show or an episode.
grant update (tags) on public.jp_shows, public.jp_episodes to authenticated;
grant insert, delete on public.jp_tag_rules to authenticated;

revoke all on function public.jp_ingest(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.jp_ingest(uuid, jsonb, text) to service_role;

revoke all on function public.jp_monthly(uuid, text), public.jp_show_summary(uuid, text),
                       public.jp_tag_summary(uuid), public.jp_seconds_since(uuid, date, text) from public;
grant execute on function public.jp_monthly(uuid, text), public.jp_show_summary(uuid, text),
                          public.jp_tag_summary(uuid), public.jp_seconds_since(uuid, date, text)
  to anon, authenticated;

revoke all on function app.jp_tags_ok(text[]), app.jp_regex_ok(text), app.jp_rule_tags(uuid, text),
                       app.jp_retag(uuid), app.jp_episode_auto_tags(), app.jp_tag_rules_changed(),
                       app.jp_show_renamed() from public;
-- The two the check constraints call run as whoever writes the row.
grant execute on function app.jp_tags_ok(text[]), app.jp_regex_ok(text) to anon, authenticated, service_role;

-- ── Row-level security ──────────────────────────────────────────────
alter table public.jp_shows     enable row level security;
alter table public.jp_episodes  enable row level security;
alter table public.jp_plays     enable row level security;
alter table public.jp_tag_rules enable row level security;
alter table public.jp_sync_runs enable row level security;

create policy jp_shows_read on public.jp_shows for select using (app.can_read(workspace_id));
create policy jp_shows_tag  on public.jp_shows for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));

create policy jp_episodes_read on public.jp_episodes for select using (app.can_read(workspace_id));
create policy jp_episodes_tag  on public.jp_episodes for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));

create policy jp_plays_read on public.jp_plays for select using (app.can_read(workspace_id));

create policy jp_tag_rules_read   on public.jp_tag_rules for select using (app.can_read(workspace_id));
create policy jp_tag_rules_insert on public.jp_tag_rules for insert with check (app.can_write(workspace_id));
create policy jp_tag_rules_delete on public.jp_tag_rules for delete using (app.can_write(workspace_id));

create policy jp_sync_runs_read on public.jp_sync_runs for select using (app.can_read(workspace_id));

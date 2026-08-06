-- WBPR — Void 1680 AM. The fourth app moves in.
--
-- A broadcast is a night on air: four blocks, each with three drawn cards, a
-- playlist, and possibly a caller. Phenomena observed during the night are
-- logged against the broadcast rather than against a standing catalogue —
-- the catalogue is what you get by reading the log newest-first, which is how
-- the site this replaces already worked. A phenomenon's current status is the
-- status the most recent broadcast gave it, and that is a property of the
-- observations rather than a row somebody has to remember to update.
--
-- Shapes are checked rather than enumerated as Postgres types. veil_status and
-- caller_type are vocabulary that will grow — the King in Yellow does not sign
-- off on a migration first — and a CHECK is a one-line change where ALTER TYPE
-- ADD VALUE cannot be used in the same transaction that uses it.
--
-- Every child table carries workspace_id alongside its parent, the way
-- lp_selections does. It is denormalised on purpose: RLS then reads
-- app.can_read(workspace_id) on every table without a join, and a join inside
-- a policy is a join on every row of every query.

-- ── The broadcast ────────────────────────────────────────────────────
create table public.wbpr_broadcasts (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,

  -- The session number is the identity: "Session 9", "Oso Sur Broadcast 009".
  -- The slug is derived from it and is the URL.
  session                integer not null,
  slug                   text not null,

  station                text not null default 'WBPR',
  call_sign              text not null default 'Oso Sur',
  location               text not null default '',
  lat                    numeric,
  lon                    numeric,

  -- In-fiction date: these are 1974-75. Times are text, not `time`, because
  -- they are clock faces read off a console — "23:47" — and a broadcast runs
  -- past midnight, so end_time is routinely earlier than start_time.
  date                   date not null,
  start_time             text not null default '',
  end_time               text not null default '',
  duration_minutes       integer,

  atmospheric_conditions text not null default '',
  veil_status            text not null default 'Stable',
  veil_intensity         integer,
  dawn_colour            text not null default '',
  veil_at_close          text not null default '',

  -- Oso Sur's own account of the night, first person. The one part of a
  -- broadcast that is not a field on a form.
  personal_notes         text not null default '',

  tags                   text[] not null default '{}',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint wbpr_broadcasts_session_positive check (session > 0),
  constraint wbpr_broadcasts_veil_intensity_range
    check (veil_intensity is null or veil_intensity between 1 and 10),
  constraint wbpr_broadcasts_slug_shape check (slug ~ '^[a-z0-9-]+$'),
  unique (workspace_id, session),
  unique (workspace_id, slug)
);

-- ── Blocks ───────────────────────────────────────────────────────────
create table public.wbpr_blocks (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references public.workspaces(id) on delete cascade,
  broadcast_id               uuid not null references public.wbpr_broadcasts(id) on delete cascade,

  position                   integer not null,
  time_label                 text not null default '',

  -- 'none' is a real answer, not a missing one: rolling 1-3 means the night
  -- stayed quiet, and a quiet block is worth recording.
  caller_type                text not null default 'none',
  caller_card                text not null default '',
  caller_card_meaning        text not null default '',
  caller_location            text not null default '',
  caller_lat                 numeric,
  caller_lon                 numeric,
  caller_location_confidence text not null default 'unknown',

  -- The phenomenon key this block touched, if any. Deliberately not a foreign
  -- key: a block can name something the first time it is ever seen, and that
  -- is precisely the night it has no catalogue entry yet.
  phenomenon_ref             text not null default '',

  -- What happened. The caller, the frost, the silence.
  notes                      text not null default '',

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint wbpr_blocks_position_positive check (position > 0),
  constraint wbpr_blocks_caller_type check (
    caller_type in ('none', 'standard', 'phenomenon', 'emergency')
  ),
  constraint wbpr_blocks_location_confidence check (
    caller_location_confidence in ('precise', 'approximate', 'accent-only', 'unknown')
  ),
  -- A block with no caller has nothing to say about one. Enforced because the
  -- card and its meaning are what the archive is read for, and a stale card
  -- left behind after the roll changed reads as a call that never happened.
  constraint wbpr_blocks_caller_fields check (
    caller_type <> 'none'
    or (caller_card = '' and caller_card_meaning = '' and caller_location = '')
  ),
  unique (broadcast_id, position)
);

-- ── The three cards drawn for a block ────────────────────────────────
create table public.wbpr_prompts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  block_id     uuid not null references public.wbpr_blocks(id) on delete cascade,
  position     integer not null,
  card         text not null,
  tone         text not null default '',
  created_at   timestamptz not null default now(),
  constraint wbpr_prompts_position_positive check (position > 0),
  unique (block_id, position)
);

-- ── What was played ──────────────────────────────────────────────────
create table public.wbpr_tracks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  block_id     uuid not null references public.wbpr_blocks(id) on delete cascade,
  position     integer not null,
  title        text not null,
  artist       text not null default '',
  url          text not null default '',
  source       text not null default '',
  notes        text not null default '',
  created_at   timestamptz not null default now(),
  constraint wbpr_tracks_position_positive check (position > 0),
  constraint wbpr_tracks_url_shape check (url = '' or url ~ '^https?://'),
  unique (block_id, position)
);

-- ── The phenomena log ────────────────────────────────────────────────
create table public.wbpr_phenomena (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  broadcast_id uuid not null references public.wbpr_broadcasts(id) on delete cascade,

  -- Stable across broadcasts; what joins one night's sighting to the next.
  key          text not null,
  name         text not null,
  status       text not null default 'Active',
  confidence   text not null default 'Unconfirmed',
  locations    text[] not null default '{}',
  lat          numeric,
  lon          numeric,
  notes        text not null default '',
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint wbpr_phenomena_key_shape check (key ~ '^[a-z0-9-]+$'),
  constraint wbpr_phenomena_status check (
    status in ('New', 'Active', 'Stable', 'Escalating', 'Resolved', 'Dormant')
  ),
  constraint wbpr_phenomena_confidence check (
    confidence in ('Unconfirmed', 'Likely', 'Confirmed')
  ),
  -- One entry per phenomenon per night. Two sightings of the same thing in one
  -- broadcast is one observation with fuller notes.
  unique (broadcast_id, key)
);

-- ── Indexes for the reads the app actually makes ─────────────────────
create index wbpr_broadcasts_workspace_session_idx
  on public.wbpr_broadcasts (workspace_id, session desc);
create index wbpr_blocks_broadcast_idx on public.wbpr_blocks (broadcast_id, position);
create index wbpr_prompts_block_idx    on public.wbpr_prompts (block_id, position);
create index wbpr_tracks_block_idx     on public.wbpr_tracks (block_id, position);
-- The soundtrack index groups every track ever played by artist.
create index wbpr_tracks_artist_idx    on public.wbpr_tracks (workspace_id, artist);
-- The phenomena index reads the log newest-first to find a current status.
create index wbpr_phenomena_key_idx    on public.wbpr_phenomena (workspace_id, key);

-- ── Row-level security ───────────────────────────────────────────────
-- Identical on all five tables, and identical to the other three apps: the
-- workspace decides, and every table carries the workspace.
alter table public.wbpr_broadcasts enable row level security;
alter table public.wbpr_blocks     enable row level security;
alter table public.wbpr_prompts    enable row level security;
alter table public.wbpr_tracks     enable row level security;
alter table public.wbpr_phenomena  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wbpr_broadcasts','wbpr_blocks','wbpr_prompts','wbpr_tracks','wbpr_phenomena']
  loop
    execute format('create policy %1$s_read on public.%1$I for select using (app.can_read(workspace_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (app.can_write(workspace_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id))', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (app.can_write(workspace_id))', t);
  end loop;
end $$;

create trigger touch_wbpr_broadcasts before update on public.wbpr_broadcasts
  for each row execute function public.touch_updated_at();
create trigger touch_wbpr_blocks before update on public.wbpr_blocks
  for each row execute function public.touch_updated_at();
create trigger touch_wbpr_phenomena before update on public.wbpr_phenomena
  for each row execute function public.touch_updated_at();

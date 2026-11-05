-- LatAm — the eighth app. What Jamie does to learn Argentina, captured from a
-- phone in ten seconds and checked on arrival.
--
-- docs/latam.md is the argument; the Claude Doc "LatAm Project: Architecture
-- and Manual Capture" the longer version. Three things about the shape:
--
-- 1. LatAm owns only what has no other home. Podcasts are JPOD's, books are the
--    Reading List's. lx_activities holds lessons, films, reading time,
--    articles, mate and notes, and lx_settings says which JPOD and Reading
--    List projects the hub reads beside it.
--
-- 2. A phone is not a signed-in browser. HTTP Shortcuts on Android sends one
--    POST with a bearer token, so capture cannot go through RLS as a user.
--    lx_capture() is the door instead: a definer function that takes the
--    token, finds whose it is, checks they can still write to the project,
--    and only then inserts. The token is stored as a SHA-256 digest and shown
--    once, so the table holds nothing that would let anyone capture.
--
-- 3. Reading is checked, never refused. A reading entry is matched against
--    the linked Reading List — books in progress first, then the library —
--    by trigram similarity. A good match links the entry; a doubtful one is
--    saved with its candidates and lands on the To check list. The phone's
--    toast says which, so a wrong match is never silent.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ── Which projects the hub reads ────────────────────────────────────
create table public.lx_settings (
  workspace_id         uuid primary key references public.workspaces(id) on delete cascade,
  reading_workspace_id uuid references public.workspaces(id) on delete set null,
  jpod_workspace_id    uuid references public.workspaces(id) on delete set null,
  -- Added to every phone capture, and the tag the hub totals by.
  focus_tag            text not null default 'argentina',
  updated_at           timestamptz not null default now(),

  constraint lx_settings_focus check (app.jp_tags_ok(array[focus_tag]))
);

create trigger touch_lx_settings before update on public.lx_settings
  for each row execute function public.touch_updated_at();

-- ── Phone tokens ────────────────────────────────────────────────────
create table public.lx_capture_tokens (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  label        text not null,
  token_hash   bytea not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,

  constraint lx_capture_tokens_label check (char_length(btrim(label)) between 1 and 60)
);

-- ── What was done ───────────────────────────────────────────────────
create table public.lx_activities (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  occurred_on  date not null,
  type         text not null,
  title        text not null default '',
  minutes      integer not null default 0,
  link         text not null default '',
  notes        text not null default '',
  tags         text[] not null default '{}',
  -- Where it came from, and its own id there: a phone entry's uuid, a
  -- Duolingo day, a Strava activity. A retried request is one row.
  source       text not null,
  source_ref   text not null,
  token_id     uuid references public.lx_capture_tokens(id) on delete set null,
  -- The book a reading entry was matched to, when it was.
  library_id   uuid references public.rl_library(id) on delete set null,
  check_state  text not null default 'ok',
  check_note   text not null default '',
  -- Up to three {id, title, author, score} when a match was doubtful.
  candidates   jsonb not null default '[]',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint lx_activities_type check (type in (
    'lesson', 'film', 'series', 'reading', 'article', 'music', 'mate',
    'conversation', 'note', 'practice', 'fishing')),
  constraint lx_activities_minutes check (minutes between 0 and 600),
  constraint lx_activities_title   check (char_length(title) <= 300),
  constraint lx_activities_link    check (link = '' or (link ~ '^https?://' and char_length(link) <= 2000)),
  constraint lx_activities_notes   check (char_length(notes) <= 2000),
  constraint lx_activities_tags    check (app.jp_tags_ok(tags)),
  constraint lx_activities_source  check (source in ('phone', 'web', 'duolingo', 'strava')),
  constraint lx_activities_state   check (check_state in ('ok', 'to_check')),
  unique (workspace_id, source, source_ref)
);

create index lx_activities_day_idx on public.lx_activities (workspace_id, occurred_on desc);
create index lx_activities_check_idx on public.lx_activities (workspace_id) where check_state = 'to_check';
create index lx_activities_token_idx on public.lx_activities (token_id, created_at);

create trigger touch_lx_activities before update on public.lx_activities
  for each row execute function public.touch_updated_at();

-- ── Helpers ─────────────────────────────────────────────────────────
-- "4h 20m", "45m" — the toast's only formatting, kept beside the function
-- that writes it.
create function app.lx_duration(minutes bigint) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when minutes < 60 then minutes || 'm'
    when minutes % 60 = 0 then (minutes / 60) || 'h'
    else (minutes / 60) || 'h ' || (minutes % 60) || 'm'
  end
$$;

-- The best library entries for a title, in one Reading List project, books in
-- progress first. Lower case on both sides; pg_trgm's similarity copes with
-- the rest — an article dropped, a subtitle left off, a typo on a phone.
create function app.lx_book_candidates(p_reading uuid, p_title text)
returns table (id uuid, title text, author text, reading boolean, score real)
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select l.id, l.title, l.author, l.reading,
         extensions.similarity(lower(l.title), lower(p_title))
    from public.rl_library l
   where l.workspace_id = p_reading
     and extensions.similarity(lower(l.title), lower(p_title)) >= 0.2
   -- A book in progress wins when it is a good match; otherwise the best
   -- match wins, so a weak hit on the current book never hides a strong one
   -- elsewhere in the library.
   order by (l.reading and extensions.similarity(lower(l.title), lower(p_title)) >= 0.6) desc, 5 desc
   limit 5
$$;

-- ── Tokens ──────────────────────────────────────────────────────────
-- Returns the token once. Only its digest is kept.
create function public.lx_token_create(p_workspace uuid, p_label text)
returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  me    uuid := auth.uid();
  token text;
begin
  if me is null or not app.can_write(p_workspace) then
    raise exception 'only an editor can create a capture token' using errcode = 'GRK50';
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace and app = 'latam') then
    raise exception 'not a LatAm project' using errcode = 'GRK51';
  end if;
  token := 'lx_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.lx_capture_tokens (workspace_id, user_id, label, token_hash)
  values (p_workspace, me, coalesce(nullif(btrim(p_label), ''), 'Phone'), extensions.digest(token, 'sha256'));
  return token;
end
$$;

create function public.lx_token_revoke(p_token uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ws uuid;
begin
  select workspace_id into ws from public.lx_capture_tokens where id = p_token;
  if ws is null or not app.can_write(ws) then
    raise exception 'no such token' using errcode = 'GRK50';
  end if;
  update public.lx_capture_tokens set revoked_at = coalesce(revoked_at, now()) where id = p_token;
  return true;
end
$$;

-- ── The door ────────────────────────────────────────────────────────
-- p_entry, as the capture endpoint sends it:
--
--   { id, type, title?, minutes?, link?, notes?, tags?, occurred_on?,
--     page?: { kind: 'article' | 'book', title, words } }
--
-- `page` is what the endpoint read from a shared link; it is the endpoint's
-- job because fetching a page is not something a database should do.
--
-- Returns { ok, duplicate, state, message, id }. `message` is written for a
-- toast: one line, the thing logged first.
create function public.lx_capture(p_token text, p_entry jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  t          public.lx_capture_tokens;
  s          public.lx_settings;
  v_type     text := lower(coalesce(p_entry->>'type', ''));
  v_title    text := btrim(coalesce(p_entry->>'title', ''));
  v_minutes  integer;
  v_link     text := btrim(coalesce(p_entry->>'link', ''));
  v_notes    text := btrim(coalesce(p_entry->>'notes', ''));
  v_ref      text := btrim(coalesce(p_entry->>'id', ''));
  v_day      date;
  v_tags     text[] := '{}';
  v_page     jsonb := p_entry->'page';
  v_state    text := 'ok';
  v_note     text := '';
  v_cands    jsonb := '[]';
  v_library  uuid;
  v_match    text := '';
  b_id       uuid;
  b_title    text;
  b_reading  boolean;
  b_score    real;
  v_est      integer;
  v_id       uuid;
  v_focus    bigint;
  v_tag      text;
begin
  -- Who is this?
  select * into t from public.lx_capture_tokens
   where token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') and revoked_at is null;
  if not found then
    raise exception 'token not recognised' using errcode = 'GRK52';
  end if;
  -- A token outlives nothing it was made for: someone who has lost write
  -- access to the project cannot keep capturing into it from a phone.
  if not exists (select 1 from public.workspace_members m
                  where m.workspace_id = t.workspace_id and m.user_id = t.user_id
                    and m.role in ('owner', 'editor')) then
    raise exception 'this token''s owner can no longer write to the project' using errcode = 'GRK52';
  end if;
  if (select count(*) from public.lx_activities a
       where a.token_id = t.id and a.created_at > now() - interval '1 hour') >= 120 then
    raise exception 'too many entries in the last hour' using errcode = 'GRK53';
  end if;

  update public.lx_capture_tokens set last_used_at = now() where id = t.id;
  select * into s from public.lx_settings where workspace_id = t.workspace_id;

  -- What is it?
  if v_type not in ('lesson', 'film', 'series', 'reading', 'article', 'music', 'mate',
                    'conversation', 'note', 'practice', 'fishing') then
    raise exception 'unknown type "%"', v_type using errcode = 'GRK54';
  end if;
  if v_ref = '' or char_length(v_ref) > 100 then
    raise exception 'every entry needs its own id' using errcode = 'GRK54';
  end if;
  begin
    v_minutes := coalesce(nullif(btrim(p_entry->>'minutes'), ''), '0')::numeric::integer;
  exception when others then
    raise exception 'minutes must be a number' using errcode = 'GRK54';
  end;
  if v_minutes < 0 or v_minutes > 300 then
    raise exception 'minutes must be between 0 and 300' using errcode = 'GRK54';
  end if;
  if v_minutes = 0 and v_type not in ('mate', 'note') then
    raise exception 'how many minutes?' using errcode = 'GRK54';
  end if;
  begin
    v_day := coalesce(nullif(p_entry->>'occurred_on', '')::date, (now() at time zone 'Europe/London')::date);
  exception when others then
    raise exception 'occurred_on must be a date' using errcode = 'GRK54';
  end;
  if v_day > (now() at time zone 'Europe/London')::date + 1 then
    raise exception 'that date is in the future' using errcode = 'GRK54';
  end if;

  -- A retried request is the same entry, not a second one.
  if exists (select 1 from public.lx_activities
              where workspace_id = t.workspace_id and source = 'phone' and source_ref = v_ref) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'message', 'Already logged');
  end if;

  -- Tags: what was sent, the type's own, and the project's focus.
  if p_entry ? 'tags' and btrim(coalesce(p_entry->>'tags', '')) <> '' then
    foreach v_tag in array string_to_array(p_entry->>'tags', ',') loop
      v_tag := regexp_replace(lower(btrim(v_tag)), '\s+', '-', 'g');
      if v_tag <> '' and not v_tag = any (v_tags) then v_tags := array_append(v_tags, v_tag); end if;
    end loop;
  end if;
  if v_type in ('lesson', 'conversation') and not 'spanish' = any (v_tags) then v_tags := array_append(v_tags, 'spanish'); end if;
  if v_type = 'fishing' and not 'fishing' = any (v_tags) then v_tags := array_append(v_tags, 'fishing'); end if;
  if s.focus_tag is not null and not s.focus_tag = any (v_tags) then v_tags := array_append(v_tags, s.focus_tag); end if;
  if not app.jp_tags_ok(v_tags) then
    raise exception 'tags are lower-case words or hyphenated phrases' using errcode = 'GRK54';
  end if;

  -- A shared page decides what was read.
  if v_page is not null and jsonb_typeof(v_page) = 'object' then
    if v_page->>'kind' = 'article' then
      if v_type = 'reading' then v_type := 'article'; end if;
      if v_title = '' then v_title := left(coalesce(v_page->>'title', ''), 300); end if;
      v_est := ceil(coalesce((v_page->>'words')::numeric, 0) / 200.0)::integer;
      if v_est > 0 and v_minutes > v_est * 3 + 5 then
        v_state := 'to_check';
        v_note := format('Logged %s for a page of about %s', app.lx_duration(v_minutes), app.lx_duration(v_est));
      end if;
    elsif v_page->>'kind' = 'book' and v_title = '' then
      v_title := left(coalesce(v_page->>'title', ''), 300);
    end if;
  end if;

  -- Reading is matched against the linked Reading List.
  if v_type = 'reading' then
    if v_title = '' then
      raise exception 'what are you reading?' using errcode = 'GRK54';
    end if;
    if s.reading_workspace_id is null then
      v_state := 'to_check';
      v_note := 'No Reading List is linked to this project yet';
    elsif not exists (select 1 from public.workspace_members m
                       where m.workspace_id = s.reading_workspace_id and m.user_id = t.user_id) then
      v_state := 'to_check';
      v_note := 'The linked Reading List is not one you belong to';
    else
      select c.id, c.title, c.reading, c.score into b_id, b_title, b_reading, b_score
        from app.lx_book_candidates(s.reading_workspace_id, v_title) c limit 1;
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'author', c.author,
                                                   'score', round(c.score::numeric, 2))), '[]')
        into v_cands
        from (select * from app.lx_book_candidates(s.reading_workspace_id, v_title) limit 3) c;

      if b_id is not null and b_score >= 0.6 then
        v_library := b_id;
        v_title := b_title;
        v_cands := '[]';
        v_match := case when b_reading then '' else ' (not marked as being read)' end;
      elsif b_id is not null and b_score >= 0.35 then
        v_state := 'to_check';
        v_note := 'Not sure which book this is';
      else
        v_state := 'to_check';
        v_note := 'Not found on the Reading List';
        v_cands := '[]';
      end if;
    end if;
  end if;

  insert into public.lx_activities (workspace_id, occurred_on, type, title, minutes, link, notes, tags,
                                    source, source_ref, token_id, library_id, check_state, check_note,
                                    candidates, created_by)
  values (t.workspace_id, v_day, v_type, v_title, v_minutes, v_link, v_notes, v_tags,
          'phone', v_ref, t.id, v_library, v_state, v_note, v_cands, t.user_id)
  returning id into v_id;

  -- This week's total for the focus tag, phone captures only: the hub adds
  -- JPOD's share, the toast stays quick.
  select coalesce(sum(minutes), 0) into v_focus
    from public.lx_activities
   where workspace_id = t.workspace_id
     and occurred_on >= date_trunc('week', (now() at time zone 'Europe/London'))::date
     and s.focus_tag = any (tags);

  return jsonb_build_object(
    'ok', true, 'duplicate', false, 'id', v_id, 'state', v_state,
    'message',
      case when v_minutes > 0 then 'Logged ' || app.lx_duration(v_minutes) || ' ' else 'Logged ' end
      || replace(v_type, '_', ' ')
      || case when v_title <> '' then ': ' || v_title else '' end
      || v_match
      || case when v_state = 'to_check' then ' · to check: ' || v_note else '' end
      || case when s.focus_tag is not null then ' · ' || initcap(replace(s.focus_tag, '-', ' '))
                                              || ' this week ' || app.lx_duration(v_focus) else '' end
  );
end
$$;

-- ── Privileges ──────────────────────────────────────────────────────
revoke all on public.lx_settings, public.lx_capture_tokens, public.lx_activities from anon, authenticated;

grant select on public.lx_settings, public.lx_activities to anon, authenticated;
grant insert, update (reading_workspace_id, jpod_workspace_id, focus_tag) on public.lx_settings to authenticated;
-- The To check list is resolved by hand: an editor corrects what was logged.
grant update (occurred_on, type, title, minutes, notes, tags, library_id, check_state, check_note, candidates),
      delete on public.lx_activities to authenticated;
-- Never the digest.
grant select (id, workspace_id, user_id, label, created_at, last_used_at, revoked_at)
  on public.lx_capture_tokens to authenticated;

grant select, insert, update, delete on public.lx_settings, public.lx_capture_tokens, public.lx_activities
  to service_role;

revoke all on function public.lx_capture(text, jsonb), public.lx_token_create(uuid, text),
                       public.lx_token_revoke(uuid) from public, anon, authenticated;
-- Anon on purpose: the phone has a token, not a session. The function is the check.
grant execute on function public.lx_capture(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.lx_token_create(uuid, text), public.lx_token_revoke(uuid) to authenticated;

revoke all on function app.lx_duration(bigint), app.lx_book_candidates(uuid, text) from public;
grant execute on function app.lx_duration(bigint) to anon, authenticated, service_role;

-- ── Row-level security ──────────────────────────────────────────────
alter table public.lx_settings       enable row level security;
alter table public.lx_capture_tokens enable row level security;
alter table public.lx_activities     enable row level security;

create policy lx_settings_read   on public.lx_settings for select using (app.can_read(workspace_id));
create policy lx_settings_insert on public.lx_settings for insert with check (app.can_write(workspace_id));
create policy lx_settings_update on public.lx_settings for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));

-- Tokens are an editor's business, not a viewer's.
create policy lx_tokens_read on public.lx_capture_tokens for select using (app.can_write(workspace_id));

create policy lx_activities_read   on public.lx_activities for select using (app.can_read(workspace_id));
create policy lx_activities_update on public.lx_activities for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lx_activities_delete on public.lx_activities for delete using (app.can_write(workspace_id));

-- The library.
--
-- The Reading List has only ever known about readings. A row in rl_books is a
-- year, a position and a set of dates, which is the right shape for a log and
-- the wrong one for the several hundred books somebody owns and has not read
-- yet: those have no year, no position and no dates, and that absence is
-- exactly what makes them the interesting ones.
--
-- So a second table, one row per book, and rl_books.library_id pointing at it.
-- The invariant the whole design rests on is that **every book exists here,
-- always, and readings are drawn from it** — which is why library_id becomes
-- NOT NULL, in the backfill migration that follows this one rather than here,
-- because it cannot be declared on a table whose every row violates it.
--
-- Three triggers carry the load and each is doing something a form cannot be
-- trusted with:
--
--   * rl_library_key      — identity. The fold, computed here rather than sent,
--                           so a title corrected by hand updates the key.
--   * rl_library_read     — read state, derived from the readings, plus a
--                           nullable override for the books read before this
--                           app existed.
--   * rl_books_mirror     — title and author copied down onto the reading, so
--                           identity is single-valued.
--
-- See docs/reading-library-plan.md for the argument behind each.

-- ── the fold ────────────────────────────────────────────────────────────────

-- Accents, without an extension.
--
-- The TypeScript half does this with NFD and a combining-mark strip. Postgres
-- has unaccent(), which would be the obvious answer and is not used here for
-- two reasons: it is an extension this project does not install, and it is
-- STABLE rather than IMMUTABLE because it depends on a dictionary file — so
-- reaching for it would settle for a trigger what could otherwise one day be an
-- index. translate() is deterministic and needs nothing.
--
-- The map is not hand-written. It is generated from JavaScript's own NFD — every
-- code point from U+00C0 to U+024F that decomposes to a single ASCII letter, and
-- only those — so it agrees with lib/library.ts by construction rather than by
-- somebody having read two long strings side by side. The first attempt was
-- hand-written, and it silently turned Susanna into Cusanna, because a pair of
-- plain ASCII letters had crept into the left-hand string and translate() maps
-- position by position. That is the whole argument for generating it.
--
-- What the map leaves out is as deliberate as what it contains. ø, ł, đ, þ, ß
-- and æ do not decompose, so the TypeScript fold strips them entirely — and so
-- must this, by not listing them. A character neither side knows becomes a
-- space on both, which is a missed match rather than a wrong one.
create or replace function app.rl_fold(value text) returns text
language sql immutable
set search_path to 'public', 'pg_temp'
as $$
  select trim(regexp_replace(
    translate(lower(coalesce(value, '')), 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳ', 'aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddeeeeeeeeeegggggggghhiiiiiiiiijjkkllllllnnnnnnoooooorrrrrrssssssssttttuuuuuuuuuuuuwwyyyzzzzzzoouuaaiioouuuuuuuuuuaaaaggkkoooojggnnaaaaaaeeeeiiiioooorrrruuuusstthhaaeeooooooooyy'),
    '[^a-z0-9]+', ' ', 'g'
  ))
$$;

-- The volume number, taken out of a title that carries it.
--
-- This is the single most consequential function in the migration. cleanTitle()
-- in lib/book-lookup.ts strips exactly these markers and throws them away, on
-- purpose, because neither catalogue indexes a graphic novel under its volume
-- number. Doing that here would fold every volume of a series onto one row and
-- silently delete a run of books from the library. The number comes out of the
-- title and goes back into the key.
--
-- Only unambiguous markers, and the patterns are the same three the TypeScript
-- half uses, in the same order. "Part 1" and "The Book of Three" are titles.
create or replace function app.rl_title_volume(title text)
returns table (stem text, idx integer)
language plpgsql immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  m text[];
begin
  m := regexp_match(coalesce(title, ''), '\m(?:vol|volume)s?\.?\s*(\d{1,3})\M', 'i');
  if m is not null then
    stem := regexp_replace(title, '\m(?:vol|volume)s?\.?\s*\d{1,3}\M', ' ', 'i');
    idx  := m[1]::integer;
    return next; return;
  end if;

  m := regexp_match(coalesce(title, ''), '(?:^|[[:space:],])#\s*(\d{1,3})\M');
  if m is not null then
    stem := regexp_replace(title, '(^|[[:space:],])#\s*\d{1,3}\M', ' ');
    idx  := m[1]::integer;
    return next; return;
  end if;

  m := regexp_match(coalesce(title, ''), '[,:]?\s*\mbook\s+(\d{1,3})\s*$', 'i');
  if m is not null then
    stem := regexp_replace(title, '[,:]?\s*\mbook\s+\d{1,3}\s*$', ' ', 'i');
    idx  := m[1]::integer;
    return next; return;
  end if;

  stem := coalesce(title, '');
  idx  := null;
  return next;
end;
$$;

-- The edition qualifier a shop puts on a title: "(Penguin Classics)",
-- "[Remastered]", "- Revised Edition". The same two rules as stripEdition() in
-- lib/title-match.ts. The pressing is not the book.
create or replace function app.rl_strip_edition(title text) returns text
language sql immutable
set search_path to 'public', 'pg_temp'
as $$
  select trim(regexp_replace(
    regexp_replace(coalesce(title, ''), '\s*[\(\[][^\)\]]*[\)\]]\s*$', '', 'g'),
    '\s+-\s+[^-]*\m(remaster(ed)?|edition|version|reissue|anniversary)\M.*$', '', 'i'
  ))
$$;

-- The author, reduced to surname and first initial.
--
-- Surname alone would put two authors of one surname together; the whole name
-- would split "Ursula K. Le Guin" from "Ursula Le Guin". The initial is the
-- middle course, and it is what makes "S. Clarke" and "Susanna Clarke" one
-- person, which is the case a spine actually produces.
--
-- Mirrors authorKey() in lib/title-match.ts. The two are pinned against
-- supabase/tests/fixtures/work-keys.json by both test suites.
create or replace function app.rl_author_key(author text) returns text
language plpgsql immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  sole      text;
  comma_at  integer;
  before_c  text;
  after_c   text;
  surname   text;
  given     text;
  parts     text[];
  n         integer;
  first_i   integer;
  particles text[] := array['de','del','della','di','da','dos','das','du',
                            'van','von','der','den','ter','ten',
                            'la','le','los','las','bin','ibn','al','st','saint'];
  suffixes  text[] := array['jr','sr','ii','iii','iv','phd','md'];
begin
  -- A joint credit matches nothing as written; the first name is the one both
  -- sides will have. Same rule as firstAuthor() before a catalogue search.
  sole := regexp_replace(coalesce(author, ''), '(;|&|\mand\M|\mwith\M).*$', '', 'i');
  sole := regexp_replace(sole, '\([^)]*\)', '', 'g');
  sole := regexp_replace(sole, '\m(translated|illustrated|edited)\s+by\M.*$', '', 'i');
  sole := regexp_replace(sole, '\met\s+al\.?', '', 'i');
  sole := trim(sole);
  if sole = '' then return ''; end if;

  -- A comma means the name is reversed — unless what follows it is only a
  -- suffix, because "Beatty, Jr." is not a surname of Jr.
  comma_at := position(',' in sole);
  if comma_at > 1 then
    before_c := trim(substring(sole from 1 for comma_at - 1));
    after_c  := trim(substring(sole from comma_at + 1));
    if after_c <> '' and not (replace(app.rl_fold(after_c), ' ', '') = any (suffixes)) then
      return trim(app.rl_fold(before_c) ||
                  case when app.rl_fold(after_c) = '' then ''
                       else ' ' || left(app.rl_fold(after_c), 1) end);
    end if;
    sole := before_c;
  end if;

  parts := string_to_array(app.rl_fold(sole), ' ');
  n := array_length(parts, 1);
  if n is null then return ''; end if;

  while n > 1 and parts[n] = any (suffixes) loop
    n := n - 1;
  end loop;

  -- Walk back over particles so "Le Guin" and "van der Rohe" stay whole.
  first_i := n;
  while first_i > 1 and parts[first_i - 1] = any (particles) loop
    first_i := first_i - 1;
  end loop;

  surname := array_to_string(parts[first_i : n], ' ');
  given   := case when first_i > 1 then array_to_string(parts[1 : first_i - 1], ' ') else '' end;

  if surname = '' then return ''; end if;
  return trim(surname || case when given = '' then '' else ' ' || left(given, 1) end);
end;
$$;

-- Identity, as one string.
--
-- The series index is taken from the column when the row has one and from the
-- title otherwise, which is what makes "Chew Vol 9" and a row saying Chew with
-- index 9 the same book.
--
-- The leading article is deliberately *kept*: "The Trial" and "Trial" stay two
-- keys. That is the wrong way round for tidiness and the right way round for
-- safety — a missed merge is a visible duplicate on the library page, a wrong
-- merge is a book that has quietly become a different book. The near-miss is
-- caught by the ambiguity check on the import instead, where a person decides.
create or replace function app.rl_work_key(
  title text,
  author text,
  series_index numeric default null
) returns text
language sql immutable
set search_path to 'public', 'pg_temp'
as $$
  select app.rl_fold(app.rl_strip_edition(v.stem))
      || coalesce('#' || (coalesce(series_index, v.idx))::text, '')
      || '|'
      || app.rl_author_key(author)
  from app.rl_title_volume(title) v
$$;

-- ── the library ─────────────────────────────────────────────────────────────

create table public.rl_library (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,

  -- Set by trigger from title, author and series_index. Never sent by a form:
  -- a value the form is trusted to send is a value the form can forget to send,
  -- and this one is what one-row-per-book rests on.
  work_key       text not null,

  title          text not null check (title <> ''),
  author         text not null default '',
  series         text not null default '',
  series_index   numeric,

  format         text not null default 'print'
                 check (format in ('print', 'audio', 'graphic')),

  -- Where the physical copy stands, which stopped being the same question as
  -- "is it in the library" the moment every book had an entry. A book borrowed,
  -- read and returned is 'none'; one given away is 'released', and the two
  -- differ in a way that matters — a released book must not be rediscovered as
  -- new by next year's import.
  ownership      text not null default 'owned'
                 check (ownership in ('owned', 'wanted', 'released', 'none')),

  -- ── read state, all five maintained by app.rl_library_read_state() ──
  -- The effective answer: coalesce(read_override, times_read > 0).
  read           boolean not null default false,
  -- Null means follow the readings. True is how a book read in 2003 and never
  -- logged says so; false is how one with a stray finish date says so.
  read_override  boolean,
  reading        boolean not null default false,
  times_read     integer not null default 0,
  last_read_on   date,

  year_published integer,
  pages          integer check (pages is null or pages > 0),
  publisher      text not null default '',
  publisher_normalised text not null default '',
  genre          text not null default '',
  tags           text[] not null default '{}',
  isbn           text not null default '',
  cover_url      text not null default '',
  description    text not null default '',
  notes          text not null default '',
  link_openlibrary text not null default '',

  source         text not null default 'manual'
                 check (source in ('manual', 'import', 'lookup', 'log')),
  source_batch_id uuid,   -- FK added by the import migration, which owns that table
  -- Which photograph this came off. A label, not a file: photographs live
  -- outside this tool, and tracing a wrong row back to the picture that made it
  -- is worth one column.
  source_photo   text not null default '',
  confidence     text not null default 'high' check (confidence in ('high', 'low')),

  added_at       date not null default current_date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- The whole point. One row per book, enforced rather than promised.
  unique (workspace_id, work_key)
);

-- The primary question a mostly-read library is asked.
create index rl_library_unread_idx
  on public.rl_library (workspace_id, ownership) where not read;
create index rl_library_title_idx on public.rl_library (workspace_id, lower(title));
create index rl_library_author_idx on public.rl_library (workspace_id, lower(author));

create trigger rl_library_touch before update on public.rl_library
  for each row execute function public.touch_updated_at();

-- Identity, recomputed on every write that could change it.
create or replace function app.rl_library_key() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  new.work_key := app.rl_work_key(new.title, new.author, new.series_index);
  return new;
end;
$$;

create trigger rl_library_key_set
  before insert or update of title, author, series_index on public.rl_library
  for each row execute function app.rl_library_key();

-- ── the join ────────────────────────────────────────────────────────────────

-- `on delete restrict`, and it is the most important word in the migration.
-- Under the invariant a reading cannot exist without a library entry, so
-- `set null` is not available, and `cascade` would delete reading history to
-- tidy up a shelf. Restrict means a book that has been read cannot be deleted
-- at all — which is correct, and 'released' is the thing somebody actually
-- wanted when they reached for delete.
--
-- Nullable here. The backfill migration fills it and then sets it NOT NULL.
alter table public.rl_books
  add column library_id uuid references public.rl_library (id) on delete restrict;

create index rl_books_library_idx on public.rl_books (library_id);

-- ── read state ──────────────────────────────────────────────────────────────

-- What the readings say about one entry.
--
-- A finish date is what makes a book read. That is already this app's own
-- definition and not a new invention: records/book.ts refuses a book marked
-- `reading` that also carries a finish date, on exactly that ground. A reading
-- with no finish date does not count — abandoned, still going and
-- finished-but-undated all look the same from here, and the first two must not
-- be counted as read. The third is what the override is for.
create or replace function app.rl_recount(p_entry uuid) returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_entry is null then return; end if;

  update public.rl_library l
  set times_read   = c.finished,
      last_read_on = c.last_on,
      reading      = c.in_progress,
      read         = coalesce(l.read_override, c.finished > 0)
  from (
    select count(*) filter (where b.date_finished is not null)      as finished,
           max(b.date_finished)                                     as last_on,
           coalesce(bool_or(b.reading), false)                      as in_progress
    from public.rl_books b
    where b.library_id = p_entry
  ) c
  where l.id = p_entry;
end;
$$;

-- The reading side of it.
--
-- Both OLD and NEW entries are recounted on an update, and that is the case
-- worth being careful about: a reading moved from one entry to another leaves
-- the entry it came from still claiming it. Recounting only NEW is the obvious
-- implementation and the symptom is a book that stays read after the only
-- reading of it was moved away — quiet, wrong, and invisible until somebody
-- notices the unread shelf is short.
create or replace function app.rl_books_read_state() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform app.rl_recount(old.library_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if tg_op = 'INSERT' or new.library_id is distinct from old.library_id then
      perform app.rl_recount(new.library_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger rl_books_read_state_sync
  after insert or delete or update of library_id, date_finished, reading
  on public.rl_books
  for each row execute function app.rl_books_read_state();

-- The override side of it. Setting read_override has to move `read` in the same
-- statement, or the column somebody filters on disagrees with the switch they
-- just pressed until something else touches the row.
create or replace function app.rl_library_read_state() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  new.read := coalesce(new.read_override, new.times_read > 0);
  return new;
end;
$$;

create trigger rl_library_read_set
  before insert or update of read_override on public.rl_library
  for each row execute function app.rl_library_read_state();

-- ── the mirror ──────────────────────────────────────────────────────────────

-- Title and author are copied down onto every reading of a book.
--
-- A deliberate exception to the rule that a reading keeps its own particulars.
-- Identity has to be single-valued or the fold means nothing: an entry saying
-- "The Left Hand of Darkness" whose 2019 reading says "Left Hand of Darkness"
-- would group, sort and search as two books on every page that reads the log.
--
-- Everything that is genuinely a fact about the *reading* rather than the book
-- — format, dates, position, pages, publisher, ISBN, notes — stays the log's
-- own and is never touched here. The 2019 reading goes on saying it was a
-- battered Penguin paperback after the copy on the shelf becomes a hardback.
create or replace function app.rl_books_mirror() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  entry public.rl_library%rowtype;
begin
  if new.library_id is null then return new; end if;
  select * into entry from public.rl_library where id = new.library_id;
  if not found then return new; end if;

  new.title  := entry.title;
  new.author := entry.author;
  return new;
end;
$$;

create trigger rl_books_mirror_set
  before insert or update of library_id on public.rl_books
  for each row execute function app.rl_books_mirror();

-- And the other direction: renaming a book renames it on its readings too.
create or replace function app.rl_library_mirror_down() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  update public.rl_books
  set title = new.title, author = new.author
  where library_id = new.id
    and (title is distinct from new.title or author is distinct from new.author);
  return null;
end;
$$;

create trigger rl_library_mirror_sync
  after update of title, author on public.rl_library
  for each row execute function app.rl_library_mirror_down();

-- ── access ──────────────────────────────────────────────────────────────────

alter table public.rl_library enable row level security;

create policy rl_library_read   on public.rl_library
  for select using (app.can_read(workspace_id));
create policy rl_library_insert on public.rl_library
  for insert with check (app.can_write(workspace_id));
create policy rl_library_update on public.rl_library
  for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy rl_library_delete on public.rl_library
  for delete using (app.can_write(workspace_id));

grant select, insert, update, delete on public.rl_library to authenticated;
grant select on public.rl_library to anon;

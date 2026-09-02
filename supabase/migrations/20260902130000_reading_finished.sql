-- What makes a reading finished.
--
-- The library migration answered this with `date_finished is not null`, and
-- said so in the plan: abandoned, still going and finished-but-undated look the
-- same from a log row, so none of them counts and the override is what settles
-- the third. Eight years of reading list say that was the wrong way round.
-- Whole years were logged as a list of books read with no dates at all — 2025
-- has forty-eight readings and not one date — and the app answered by calling
-- every one of them unfinished, on a page whose whole purpose is to say what
-- has been read. The override is not an answer at that volume: it was set by
-- hand on a hundred and eleven books in two days, which is the shape of a
-- person working around a bug.
--
-- So the definition moves off the date and onto the states a reading is
-- actually in:
--
--   coming up   — chosen, not started
--   reading     — under way
--   abandoned   — given up on
--   otherwise   — finished
--
-- `date_finished` goes back to being what it looks like: *when* a book was
-- finished, recorded where it is known and absent where it is not. It no longer
-- decides *whether*, and a year logged without dates stops being a year of
-- unfinished books.
--
-- `abandoned` is new, and it is the reason this is safe. Without it the
-- definition above would quietly promote every book somebody gave up on to
-- read, because a missing finish date was the only way the log could say so.
-- With it the state is written down rather than inferred from an absence, which
-- is the whole fault being fixed here.

-- ── the state a reading is in ───────────────────────────────────────────────

alter table public.rl_books
  add column abandoned boolean not null default false;

-- The three exclusive states, enforced rather than trusted to the form. A book
-- given up on is not also being read, not also coming up, and has no finish
-- date — if it has one it was finished, whatever the checkbox says.
alter table public.rl_books
  add constraint rl_books_abandoned_alone
  check (not abandoned or (not reading and not coming_up and date_finished is null));

-- One definition, in one place, because it is now asked in four.
--
-- Shipped without a `set search_path` and pinned an hour later by
-- 20260902130100, which is where the reasoning for both is written down.
create or replace function app.rl_reading_finished(
  p_reading boolean, p_coming_up boolean, p_abandoned boolean
) returns boolean
language sql immutable parallel safe
as $$
  select not (coalesce(p_reading, false)
           or coalesce(p_coming_up, false)
           or coalesce(p_abandoned, false));
$$;

comment on function app.rl_reading_finished(boolean, boolean, boolean) is
  'A reading is finished unless it is coming up, under way, or given up on. The finish date records when, not whether.';

-- ── the recount ─────────────────────────────────────────────────────────────

-- Same shape as before; only the question it asks of each reading has changed.
-- `last_read_on` still comes from the dates, so a book whose readings carry no
-- date is read a known number of times on an unknown day — which is honest, and
-- is what the reading list actually knows.
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
    select count(*) filter (
             where app.rl_reading_finished(b.reading, b.coming_up, b.abandoned)
           ) as finished,
           max(b.date_finished) filter (
             where app.rl_reading_finished(b.reading, b.coming_up, b.abandoned)
           ) as last_on,
           coalesce(bool_or(b.reading), false) as in_progress
    from public.rl_books b
    where b.library_id = p_entry
  ) c
  where l.id = p_entry;
end;
$$;

-- The watched columns have to follow the definition. `coming_up` and
-- `abandoned` now decide the count, and a trigger that does not watch them is a
-- book that stays unread after the flag saying so was cleared — the same class
-- of quiet wrongness the original trigger's OLD/NEW care was written to avoid.
drop trigger if exists rl_books_read_state_sync on public.rl_books;
create trigger rl_books_read_state_sync
  after insert or delete or update of library_id, date_finished, reading, coming_up, abandoned
  on public.rl_books
  for each row execute function app.rl_books_read_state();

-- The pre-backfill report reads the same fold, so it moves with it.
create or replace function app.rl_backfill_report(p_workspace uuid default null)
returns table (
  measure text,
  value   bigint,
  detail  text
)
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  with books as (
    select b.*, app.rl_work_key(b.title, b.author) as wk
    from public.rl_books b
    where p_workspace is null or b.workspace_id = p_workspace
  ),
  works as (
    select workspace_id, wk,
           count(*) as readings,
           count(*) filter (
             where app.rl_reading_finished(reading, coming_up, abandoned)
           ) as finished,
           min(title) as a_title,
           count(distinct title) as spellings
    from books group by workspace_id, wk
  )
  select 'readings', count(*)::bigint,
         'rows in rl_books that will be linked' from books
  union all
  select 'books', count(*)::bigint,
         'entries rl_library will hold afterwards' from works
  union all
  select 'collapsed', coalesce(sum(readings - 1), 0)::bigint,
         'readings that share a book with another — re-reads, and duplicates'
    from works where readings > 1
  union all
  select 'read', count(*)::bigint,
         'books the readings alone will mark as read' from works where finished > 0
  union all
  select 'unread', count(*)::bigint,
         'books with no finished reading — given up on, in progress, or coming up'
    from works where finished = 0
  union all
  select 'spelled two ways', count(*)::bigint,
         'books whose readings do not all spell the title the same way'
    from works where spellings > 1
  union all
  select 'no author', count(*)::bigint,
         'books folding on a blank author — these never auto-match on title'
    from works where wk like '%|'
$$;

-- ── what the old definition left behind ─────────────────────────────────────

do $repair$
declare
  recounted integer;
  released  integer;
begin
  -- 1. Every entry, against the new definition. Nothing else can do this: the
  --    trigger fires on writes to rl_books and no reading is being written.
  perform app.rl_recount(id) from public.rl_library;
  get diagnostics recounted = row_count;

  -- 2. The hand-set overrides that were only ever standing in for this bug.
  --
  --    Only where the readings now say read on their own, so `read` does not
  --    move for any book: what changes is who is answering. An override is a
  --    claim about a book with no reading to derive from — "I read this before
  --    the list existed" — and one left on a book the list can now account for
  --    would keep it read after its last reading was deleted, and would go on
  --    saying "(set by hand)" on a page whose readings say it plainly.
  --
  --    An override of false is left exactly where it is. That one is a person
  --    disagreeing with the log, which is the feature working.
  update public.rl_library
  set read_override = null
  where read_override is true
    and times_read > 0;
  get diagnostics released = row_count;

  raise notice 'read state: % entries recounted, % redundant overrides cleared',
    recounted, released;
end;
$repair$;

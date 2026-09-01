-- Turning the reading list into a library.
--
-- The invariant is that every book exists in rl_library and readings are drawn
-- from it. `library_id not null` cannot be declared on a table whose every row
-- violates it, so this is the migration that makes it true and then says so.
--
-- It is also, on its own, the step that answers the read/unread question for
-- everything already recorded: folding the log into works and letting the read
-- trigger run gives `read`, `times_read` and `last_read_on` across the whole
-- reading history, at no cost and with no model involved.
--
-- Read app.rl_backfill_report() before running this. It is the same fold
-- against the same rows, and it writes nothing.
--
-- What this deliberately does NOT do is merge near-duplicates. The backfill is
-- the first moment the entire reading history is visible as one set of works
-- rather than a run of years, and therefore the first moment a genuine
-- duplicate in the log — the same book entered twice with a subtitle on one of
-- them — can be seen at all. Those are merges for a person to confirm, on a
-- screen, once. Doing the irreversible thing inside a migration, at the moment
-- with the least information about it, is how a library loses a book.

-- ── the backfill ────────────────────────────────────────────────────────────

do $backfill$
declare
  minted integer;
  linked integer;
  orphans integer;
begin
  -- 1. One entry per distinct work, taking the fullest value of each field
  --    across the readings that share it. `max()` over a nullif is "the first
  --    non-empty one, deterministically" — not the best value, but a present
  --    one, and enrichment is what improves it afterwards.
  --
  --    ownership starts at 'owned' because it is true of most of a personal
  --    reading list and because the first bookcase import confirms or
  --    contradicts it row by row. The ones it never confirms are findable
  --    afterwards: source = 'log' and source_photo = ''.
  -- Folded once, in a CTE, rather than in the group-by and again in the link
  -- below: the fold is the expensive part and the two halves must agree about
  -- it row for row.
  with folded as (
    select b.*, app.rl_work_key(b.title, b.author) as wk
    from public.rl_books b
    where b.library_id is null
  ),
  -- Tags are their own step because array_agg refuses to accumulate arrays of
  -- different lengths. Unnesting and re-aggregating takes the *union* across
  -- the readings, which is the right answer anyway: two readings of one book
  -- may have been tagged differently and the book has honestly earned both.
  tagged as (
    select f.workspace_id, f.wk,
           coalesce(array_agg(distinct t.tag) filter (where t.tag is not null), '{}') as tags
    from folded f
    left join lateral unnest(f.tags) as t(tag) on true
    group by f.workspace_id, f.wk
  ),
  works as (
    select
      f.workspace_id,
      f.wk,
      -- The earliest reading supplies the title, the author and the format.
      --
      -- The ordering is spelled out at length because the obvious version of it
      -- is wrong in a way that does not show up until it matters. Ordering by
      -- created_at alone ties for every reading imported in the same statement
      -- — which is all of them, for a list that arrived as one migration — and
      -- the tie then falls to a random uuid. That makes the backfill
      -- non-deterministic: run against the same list twice, "Bolaño" and
      -- "Bolano" each win about half the time, and a rerun silently rewrites
      -- somebody's library. The dates are the meaningful order, order_read
      -- breaks a tie within a year, and the id is there only so that no tie
      -- remains.
      (array_agg(f.title order by
        f.date_started nulls last, f.date_finished nulls last, f.order_read, f.id))[1] as title,
      -- A blank author sorts last first, so a reading that recorded one beats a
      -- reading that did not, whichever came first.
      (array_agg(f.author order by
        (f.author = ''), f.date_started nulls last, f.date_finished nulls last, f.order_read, f.id))[1] as author,
      (array_agg(f.format order by
        f.date_started nulls last, f.date_finished nulls last, f.order_read, f.id))[1] as format,
      max(f.year_published) as year_published,
      max(f.pages) as pages,
      coalesce(max(nullif(f.publisher, '')), '') as publisher,
      coalesce(max(nullif(f.genre, '')), '') as genre,
      coalesce(max(nullif(f.isbn, '')), '') as isbn,
      coalesce(max(nullif(f.cover_url, '')), '') as cover_url,
      coalesce(max(nullif(f.description, '')), '') as description,
      coalesce(max(nullif(f.link_openlibrary, '')), '') as link_openlibrary,
      coalesce(min(f.date_started), min(f.date_finished), current_date) as added_at
    from folded f
    group by f.workspace_id, f.wk
  )
  insert into public.rl_library (
    workspace_id, title, author, series_index, format,
    year_published, pages, publisher, genre, tags, isbn,
    cover_url, description, link_openlibrary,
    source, ownership, added_at
  )
  select
    w.workspace_id, w.title, w.author,
    (app.rl_title_volume(w.title)).idx,
    w.format,
    w.year_published, w.pages, w.publisher, w.genre, t.tags, w.isbn,
    w.cover_url, w.description, w.link_openlibrary,
    'log', 'owned', w.added_at
  from works w
  join tagged t on t.workspace_id = w.workspace_id and t.wk = w.wk
  -- An entry may already exist if this runs twice, or if somebody added one by
  -- hand between the migrations. Either way the reading joins it rather than
  -- minting a second.
  on conflict (workspace_id, work_key) do nothing;

  get diagnostics minted = row_count;

  -- 2. Every reading finds its entry by the same fold that made it.
  update public.rl_books b
  set library_id = l.id
  from public.rl_library l
  where b.library_id is null
    and l.workspace_id = b.workspace_id
    and l.work_key = app.rl_work_key(b.title, b.author);

  get diagnostics linked = row_count;

  -- 3. The read trigger fires on library_id, so step 2 has already filled in
  --    times_read, last_read_on, reading and read for every entry it touched.
  --    Recounted here anyway: a reading that was already linked before this
  --    migration ran would otherwise be counted by nothing.
  perform app.rl_recount(id) from public.rl_library;

  select count(*) into orphans from public.rl_books where library_id is null;
  if orphans > 0 then
    raise exception 'backfill left % readings with no book — refusing to set the constraint', orphans;
  end if;

  raise notice 'library backfill: % books minted, % readings linked', minted, linked;
end;
$backfill$;

-- 4. And only now. Until this line a bug in the fold is a row to fix; after it,
--    it is a migration that will not apply.
alter table public.rl_books alter column library_id set not null;

-- The invariant, restated where the database can hold it: there is no path that
-- creates a reading without a book.
comment on column public.rl_books.library_id is
  'The book this is a reading of. Every reading has one — see rl_library.';

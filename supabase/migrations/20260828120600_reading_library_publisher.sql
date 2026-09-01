-- The library normalises its publishers, the same way the reading list does.
--
-- `20260828120000` gave rl_library a publisher_normalised column and nothing to
-- fill it, so 241 entries carried a publisher and none carried the normalised
-- form. Two things were wrong as a result, and the second is the expensive one:
--
--   * imprints of one house would not group on the library page, which is the
--     whole reason the column exists on rl_books;
--   * `reading.enrich` selects "thin" rows as genre = '' OR publisher_normalised
--     = '' OR pages is null — so every entry in the library looked thin, and the
--     page offered to spend money filling in 260 books that mostly already had
--     a genre and a page count. Applying this took that count from 260 to 26.
--
-- Only visible against real data. The local suite has publishers on two fixture
-- rows and nothing that counts thin ones, so it had nothing to notice.
--
-- public.set_publisher_normalised() is production's own trigger function,
-- already attached to rl_books. It reads new.publisher and writes
-- new.publisher_normalised without naming a table, so it attaches here
-- unchanged rather than being reimplemented — one rule, one place.

create trigger rl_library_normalise_publisher
  before insert or update of publisher on public.rl_library
  for each row execute function public.set_publisher_normalised();

-- And the rows the backfill already wrote. `where publisher <> ''` so this
-- touches only what it can answer for, and the trigger does the work.
update public.rl_library set publisher = publisher where publisher <> '';

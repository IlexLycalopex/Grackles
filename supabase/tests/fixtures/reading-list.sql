-- A reading list with the awkward cases in it, for testing the backfill.
--
-- Deliberately not tidy. Every row here is a shape a real imported reading list
-- actually contains, and several of them are the ones the fold has to get
-- right or quietly lose a book:
--
--   * a re-read across two years — one book, two readings;
--   * one book whose two readings spell the author differently;
--   * one book whose two readings spell the *title* differently, which the fold
--     is designed NOT to merge (the leading article is kept) and which should
--     therefore surface as a near-duplicate for a person;
--   * two volumes of one series, which must stay two books;
--   * a book with no author at all, off a spine that had no room;
--   * an accented author, spelled both ways;
--   * a book abandoned, and a book still being read — neither of which is read;
--   * a book on next year's plan, which is coming_up and unread.

insert into public.rl_years (workspace_id, year, status) values
  (:'ws', 2019, 'complete'),
  (:'ws', 2023, 'complete'),
  (:'ws', 2024, 'active'),
  (:'ws', 2025, 'planning')
on conflict do nothing;

insert into public.rl_books
  (workspace_id, year_id, order_read, title, author, pages, date_started, date_finished,
   format, year_published, genre, publisher, isbn, tags, reading, coming_up)
values
  -- a re-read: one book, two readings, five years apart
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   1, 'Piranesi', 'Susanna Clarke', 272, '2019-03-01', '2019-03-14', 'print', 2020, 'Fantasy', 'Bloomsbury', '9781526622426', '{fantasy}', false, false),
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2024),
   1, 'Piranesi', 'Susanna Clarke', 272, '2024-01-02', '2024-01-09', 'audio', 2020, '', '', '', '{reread}', false, false),

  -- one book, two spellings of the author — these must fold together
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   2, 'The Dispossessed', 'Ursula K. Le Guin', 341, '2019-04-01', '2019-04-20', 'print', 1974, 'Science Fiction', 'Gollancz', '', '{utopia}', false, false),
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2023),
   1, 'The Dispossessed', 'Le Guin, Ursula K.', null, '2023-06-01', '2023-06-11', 'print', null, '', '', '', '{}', false, false),

  -- one book, two spellings of the *title*. The fold keeps the leading article,
  -- so these stay two entries and show up as a near-duplicate to confirm.
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   3, 'The Left Hand of Darkness', 'Ursula K. Le Guin', 304, '2019-05-01', '2019-05-19', 'print', 1969, 'Science Fiction', 'Ace', '', '{}', false, false),
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2023),
   2, 'Left Hand of Darkness', 'Ursula Le Guin', null, '2023-07-01', '2023-07-14', 'print', null, '', '', '', '{}', false, false),

  -- two volumes of one series: two books, never one
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   4, 'Chew Vol 3 Just Desserts', 'John Layman', 128, '2019-06-01', '2019-06-02', 'graphic', 2010, 'Comics', 'Image', '', '{}', false, false),
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   5, 'Chew Vol 9 Chicken Tenders', 'John Layman', 128, '2019-06-03', '2019-06-04', 'graphic', 2014, 'Comics', 'Image', '', '{}', false, false),

  -- an accented author, spelled both ways — one book
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   6, '2666', 'Roberto Bolaño', 898, '2019-07-01', '2019-09-30', 'print', 2004, 'Fiction', 'Picador', '', '{chunkster}', false, false),
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2023),
   3, '2666', 'Roberto Bolano', null, '2023-08-01', null, 'print', null, '', '', '', '{}', false, false),

  -- no author at all, off a spine with no room for one
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2019),
   7, 'Beowulf', '', 224, '2019-10-01', '2019-10-05', 'print', null, '', '', '', '{}', false, false),

  -- abandoned: started, never finished, not currently being read
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2023),
   4, 'Infinite Jest', 'David Foster Wallace', 1079, '2023-01-01', null, 'print', 1996, '', '', '', '{abandoned}', false, false),

  -- being read right now
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2024),
   2, 'The Fifth Season', 'N. K. Jemisin', 468, '2024-08-01', null, 'print', 2015, '', '', '', '{}', true, false),

  -- chosen for next year, not read
  (:'ws', (select id from public.rl_years where workspace_id=:'ws' and year=2025),
   1, 'Middlemarch', 'George Eliot', 880, null, null, 'print', 1872, '', '', '', '{}', false, true);

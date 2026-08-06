-- A subtitle has a length, now that one can be typed.
--
-- description has been writable only by whoever wrote the migration that set
-- it, so nothing has ever needed to bound it. The settings page now offers a
-- box, and the value lands in a card on the dashboard and — on the Listening
-- Party, where a season has not supplied its own — in the page's meta
-- description. Both have a size beyond which they stop working: the card grows
-- until it drags the grid row with it, and a meta description is truncated by
-- the search engine anyway.
--
-- 200 is roughly two lines on a card and about what Google will show. The
-- longest one in the table is 58 characters, so nothing existing is near it.
--
-- Here as well as in the form on purpose. The form checks it so the answer is
-- a sentence rather than a Postgres error; this is what actually guarantees
-- it, including against a hand-posted body.

alter table public.workspaces
  add constraint workspaces_description_length
  check (char_length(description) <= 200);

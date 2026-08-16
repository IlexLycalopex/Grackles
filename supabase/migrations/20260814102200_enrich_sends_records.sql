-- The consent gate applied to nothing.
--
-- `sends_records` was added in 20260814101200 to mark the features that put a
-- project's own records in front of a model, and `ai_begin_job` refuses one
-- (GRK1E) until an owner has agreed. `reading.enrich` was registered in
-- 20260814100900 — three migrations earlier — so it took the column's default
-- of false and has been exempt from the gate since the gate existed.
--
-- It is the feature the gate was described by. An enrichment turn sends the
-- book's title, author and publisher, and then the reader's entire vocabulary:
-- every genre, publisher and tag they use, so the model can place the book
-- inside it rather than inventing a fifth spelling of "Science Fiction". That
-- is the shelf, which is exactly the thing the column was introduced to
-- distinguish from a phrase somebody typed into a box.
--
-- Nothing else is misclassified, and the difference is worth stating because it
-- is the line the column draws:
--
--   * `cigars.lookup` sends the query and nothing else — "partagas serie d" —
--     and gets back what that cigar is. The lounge is not described to it.
--   * `platform.search` sends the question and a static description of the
--     columns. It never sees a row; the app runs the plan and RLS decides.
--   * `wbpr.desk` and `wbpr.writeup` send the sitting the person is in the
--     middle of, which is theirs, live, and not yet a record.
--
-- The effect of this migration is that enrichment refuses until a Reading List's
-- owner ticks the box on its settings page. That is the intended behaviour and
-- the reason the box is there; the alternative is a consent mechanism that
-- nothing consents to.

update public.ai_features
   set sends_records = true
 where key = 'reading.enrich';

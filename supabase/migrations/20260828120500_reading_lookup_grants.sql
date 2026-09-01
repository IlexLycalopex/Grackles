-- Insert-only, at the grant level as well as the policy level.
--
-- `20260828120400` said `grant select, insert … to authenticated` and left it
-- there, on the assumption that naming two privileges withheld the rest. It
-- does not. Supabase's default privileges on the `public` schema already hand
-- `authenticated` the full set on every new table, so that GRANT was additive
-- on top of DELETE, UPDATE, TRUNCATE and REFERENCES which were there before it
-- ran.
--
-- This is `20260807150000_cigar_reference_grants` happening a second time, to
-- the same design, for the same reason — and it is worth recording *why the
-- tests did not catch it*. The local cluster the suites run against is built
-- from tests/baseline.sql, which creates the roles but not Supabase's ALTER
-- DEFAULT PRIVILEGES. So `revoke`-shaped facts are exactly the class of thing
-- that suite cannot see: locally the table was insert-only because nothing had
-- granted more, and on production it was not. It was found by reading the
-- grants back off production after applying, which is now the last step of
-- applying anything.
--
-- Nothing was exposed: rl_book_reference has no update policy and no delete
-- policy, so both resolve to false and a tampering UPDATE silently touches zero
-- rows. But that makes RLS the sole barrier, which is the finding
-- `20260805120500_tighten_anon_grants` was written about. A table described in
-- its own comments as insert-only should be insert-only twice.

revoke update, delete, truncate, references on public.rl_book_reference from authenticated;

-- `anon` never held anything here, and is named anyway: a revoke of something
-- not held is free, and the next person reading this should not have to check.
revoke all on public.rl_book_reference from anon;

-- The library and the staging tables are deliberately different: they carry
-- ordinary CRUD because a person edits their own books and their own import
-- decisions. But `anon` has no business in any of them, and the staging tables
-- are working material rather than a publication — a half-corrected machine
-- transcription of somebody's bookcase, including the rows that were wrong.
revoke all on public.rl_import_batches from anon;
revoke all on public.rl_import_rows from anon;

-- rl_library keeps its anon SELECT: a public reading list may show the books it
-- is a list of, exactly as rl_books already does. Everything else goes.
revoke insert, update, delete, truncate, references on public.rl_library from anon;

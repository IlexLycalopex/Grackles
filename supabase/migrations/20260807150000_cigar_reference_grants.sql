-- Insert-only, at the grant level as well as the policy level.
--
-- `20260807120000` said `grant select, insert … to authenticated` and left it
-- there, on the assumption that naming two privileges withheld the rest. It
-- does not. Supabase's default privileges on the `public` schema already hand
-- `authenticated` the full set on every new table, so that GRANT was additive
-- on top of DELETE, UPDATE, TRUNCATE and REFERENCES which were there before it
-- ran.
--
-- Nothing was exposed: `cl_cigar_reference` has no update policy and no delete
-- policy, so both resolve to false and a tampering UPDATE silently touches zero
-- rows. But that makes RLS the sole barrier, which is the exact finding
-- `20260805120500_tighten_anon_grants` was written about — "nothing was
-- exposed, but RLS was the only thing standing there." A table described in its
-- own comments as insert-only should be insert-only twice.

revoke update, delete, truncate, references on public.cl_cigar_reference from authenticated;

-- `anon` never held anything here: 20260805120500 withdrew its blanket DML and
-- the default privileges that would have re-granted it were altered then. It is
-- named anyway, because a revoke of something not held is free and the next
-- person reading this should not have to go and check.
revoke all on public.cl_cigar_reference from anon;

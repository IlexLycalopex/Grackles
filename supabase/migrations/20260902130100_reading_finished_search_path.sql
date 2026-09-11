-- The lint the local suite cannot produce.
--
-- `app.rl_reading_finished()` shipped an hour ago without a `set search_path`,
-- on the reasoning that a function touching no object has nothing to be
-- confused about and that leaving it inlinable keeps the recount a plain
-- aggregate. Reading the advisors back off production after applying — which is
-- the last step of applying anything here — it is the only
-- `function_search_path_mutable` warning on the project. Every other function
-- pins it, `20260814102000_search_path` went round and did that deliberately,
-- and one exception with a good story is still the row somebody has to read
-- past every time they check.
--
-- The reasoning was sound and the cost of dropping it is nil: the recount runs
-- over one library entry's readings, so an uninlined call per row is nothing
-- measurable. A rule with no exceptions is worth more than an aggregate plan.
create or replace function app.rl_reading_finished(
  p_reading boolean, p_coming_up boolean, p_abandoned boolean
) returns boolean
language sql immutable parallel safe
set search_path to 'pg_catalog', 'pg_temp'
as $$
  select not (coalesce(p_reading, false)
           or coalesce(p_coming_up, false)
           or coalesce(p_abandoned, false));
$$;

-- A reading year can exist before it starts.
--
-- `rl_years.status` was 'active' or 'complete': a year is being read, or it is
-- finished. Next year's list is neither. Written as 'active' it would be a
-- second year in progress, and every page that asks "which year is this list
-- on?" would have two answers and take the newer one — so the books being read
-- now would file themselves under a year that has not begun.
--
-- 'planning' is that third state. It is what a year is created as when it is
-- created ahead of time, and it is what the app skips over when it needs the
-- year currently under way.
--
-- Nothing is backfilled. Every existing row is 'active' or 'complete' and stays
-- as it was; this only widens what a row is allowed to say.

alter table public.rl_years drop constraint rl_years_status_check;

alter table public.rl_years
  add constraint rl_years_status_check
  check (status in ('planning', 'active', 'complete'));

-- The default stays 'active'. create_workspace seeds the calendar year on a new
-- reading list, and that year has started by definition.

-- JPOD, the podcast log, joins the app enum.
--
-- On its own for the reason 20260813110000 gives: ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and every migration here runs
-- --single-transaction.
--
-- The stored value is 'podcasts' rather than the working name. JPOD is what
-- the app is called for now; the enum is storage and should not have to change
-- when the name does. `name` in src/lib/apps.ts is the one place to rename it.
alter type public.app_slug add value if not exists 'podcasts';

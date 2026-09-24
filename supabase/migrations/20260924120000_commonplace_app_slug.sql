-- Commonplace joins the app enum.
--
-- On its own for the reason 20260813110000 gives: ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and every migration here runs
-- --single-transaction.
alter type public.app_slug add value if not exists 'commonplace';

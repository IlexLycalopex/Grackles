-- LatAm, the language-and-place project, joins the app enum.
--
-- On its own for the reason 20260813110000 gives: ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it.
alter type public.app_slug add value if not exists 'latam';

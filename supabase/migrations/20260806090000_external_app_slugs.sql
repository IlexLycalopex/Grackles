-- The five sites that have not moved in yet become app types of their own.
--
-- The launcher used to carry a hardcoded list of eight links. It now renders
-- whatever the signed-in visitor is a member of, which means every site has to
-- exist as a workspace before it can appear there — including the ones still
-- served from GitHub Pages.
--
-- They get their own enum values rather than a shared 'external' one because
-- the value is what the row is keyed on for the rest of its life. Scoundrel
-- moving into this repo should clear a column, not re-key the workspace and
-- every membership hanging off it.
--
-- Separate migration from the rows that use these values: ALTER TYPE ... ADD
-- VALUE is allowed inside a transaction, but the value cannot be *used* until
-- that transaction commits, and every migration is one transaction.

alter type public.app_slug add value if not exists 'atelier-obscura';
alter type public.app_slug add value if not exists 'lanternwood';
alter type public.app_slug add value if not exists 'spelltome';
alter type public.app_slug add value if not exists 'scoundrel';
alter type public.app_slug add value if not exists 'wbpr';

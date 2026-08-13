-- Blackletter joins the app enum.
--
-- Separate from the schema migration because ALTER TYPE ... ADD VALUE cannot be
-- used in the same transaction that uses the new value, and every migration here
-- runs --single-transaction. Splitting it is not tidiness; it is the only way
-- both this and a workspace using it can go out.
--
-- `if not exists` for the same reason 20260806090000 has it: this file is
-- re-runnable, and an enum value cannot be dropped if it were not.
alter type public.app_slug add value if not exists 'blackletter';

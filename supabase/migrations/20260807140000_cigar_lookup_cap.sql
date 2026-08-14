-- The daily lookup cap, which did not work.
--
-- `20260807120000` put the cap directly in the insert policy as a correlated
-- subquery counting `cl_cigar_reference` — the table the policy is *on*.
-- Postgres answers that with 42P17, infinite recursion: evaluating the WITH
-- CHECK requires reading the table, reading the table invokes its policies, and
-- round it goes. The effect was not a cap that leaked. It was a table that
-- rejected every insert, so no lookup could ever have been cached.
--
-- It was asserted to work in three places before anyone ran it. The lesson is
-- narrow and worth keeping: a policy that reads its own table needs a
-- SECURITY DEFINER function, because that is what steps outside RLS long enough
-- to answer the question.
--
-- Which is the pattern every other policy in this schema already uses.
-- `app.can_write()` and its siblings are all SECURITY DEFINER, STABLE, with
-- search_path pinned — this is simply the ninth of them, and the cap stops
-- being a special case.

create function app.cigar_lookups_today(ws uuid) returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.cl_cigar_reference
  where workspace_id = ws
    and created_at > now() - interval '1 day'
$$;

-- Not granted to anon, and `app` is not an exposed schema, so this is reachable
-- only from the policy below — it is not an RPC anybody can call.
revoke all on function app.cigar_lookups_today(uuid) from public;
grant execute on function app.cigar_lookups_today(uuid) to authenticated;

drop policy cl_cigar_reference_insert on public.cl_cigar_reference;

-- Otherwise unchanged: attributed to yourself, charged to a workspace you can
-- write to, and inside the day's allowance.
create policy cl_cigar_reference_insert on public.cl_cigar_reference
  for insert with check (
    looked_up_by = (select auth.uid())
    and workspace_id is not null
    and app.can_write(workspace_id)
    and app.cigar_lookups_today(workspace_id) < 50
  );

-- An allowance for everybody who has an account, and for everybody who gets one.
--
-- The original backfill gave a budget row to `distinct owner_id from workspaces`,
-- which was right when the only AI feature was the desk and the desk is billed
-- to the project's owner. `platform.search` broke that assumption: it is billed
-- to the person asking, and most people asking do not own anything.
--
-- Without a row, `app.ai_remaining` returns zero and the search refuses with
-- GRK15 — "this month's AI allowance is spent" — to somebody who has never
-- spent anything. Two of the three accounts on the site were in that state.
--
-- Granting to everyone is safe here because of a decision taken elsewhere:
-- `login.astro` sets `shouldCreateUser: false`, so an account exists only
-- because somebody was invited. The invitation is the gate on who may spend,
-- and it is upstream of this. Adding a second gate behind it would not protect
-- anything — it would just mean every invited person's first search fails.
--
-- `monthly_usd` is null rather than a figure, which is the important part. Null
-- takes `ai_platform_settings.default_monthly_usd`, so the ceiling for everyone
-- who has not been given a specific number is one row to change. Writing $5
-- here would freeze today's default into three rows and every future one.

insert into public.ai_budgets (user_id, monthly_usd, enabled)
select p.id, null::numeric, true
from public.profiles p
on conflict (user_id) do nothing;

/**
 * The same rule, going forwards.
 *
 * A backfill alone decays: the next person invited arrives with no row and
 * their first search refuses, which is the same paper cut discovered again in
 * six months with less context. This is on `profiles` rather than `auth.users`
 * because profiles is the table this repository owns — `handle_new_user` lives
 * in the original core migrations and is not reproduced here, and a trigger
 * hung off somebody else's trigger is a dependency nobody can see.
 *
 * It grants a *ceiling*, not credit. Nobody is given anything to spend; they
 * are given a limit above which they will be refused, which is what everyone
 * else already had. An admin who wants somebody at zero sets their figure to
 * zero or unticks them in `/admin` — both survive this, because the insert
 * only fires for a profile that has no row at all.
 */
create function public.ai_budget_for_new_profile() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ai_budgets (user_id, monthly_usd, enabled)
  values (new.id, null, true)
  on conflict (user_id) do nothing;
  return new;
end $$;

create trigger ai_budget_on_new_profile
  after insert on public.profiles
  for each row execute function public.ai_budget_for_new_profile();

revoke all on function public.ai_budget_for_new_profile() from public;

-- Who may spend, how much, and where the running total lives.
--
-- ai_budgets is the app_grants analogue and deliberately the same shape: a
-- per-person entitlement with a quota, handed out by a platform admin,
-- defaulting to nothing. Anyone who has read the creation-grants migration
-- should recognise this one without being told.
--
-- No row means no AI. That is the property most likely to be lost later to a
-- well-meaning coalesce, so tests/test.sh checks it first.

create table public.ai_budgets (
  user_id      uuid primary key references public.profiles(id) on delete cascade,

  -- Null means "use ai_platform_settings.default_monthly_usd", which is a
  -- different statement from zero: zero is an explicit none, and being able to
  -- say that about somebody without deleting the row keeps granted_by.
  monthly_usd  numeric(10,4) check (monthly_usd >= 0),

  enabled      boolean not null default true,
  granted_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The running total, one row per payer per month. The budget check happens on
-- every call and must not scan the ledger to answer.
--
-- reserved_usd is what is in flight; committed_usd is what has settled. The
-- check is against their sum, so two concurrent calls cannot both fit into the
-- last penny.
create table public.ai_periods (
  payer_id      uuid not null references public.profiles(id) on delete cascade,
  period        date not null,
  reserved_usd  numeric(12,6) not null default 0 check (reserved_usd >= 0),
  committed_usd numeric(12,6) not null default 0 check (committed_usd >= 0),
  primary key (payer_id, period)
);

-- Per-workspace, per-feature switches. An absent row means the feature's own
-- default applies, which is what keeps enabling a new feature from needing a
-- backfill across every workspace that exists.
create table public.ai_workspace_features (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feature      text not null references public.ai_features(key) on delete cascade,

  enabled      boolean not null default true,

  -- The owner's own ceiling, under the platform's.
  daily_usd    numeric(10,4) check (daily_usd >= 0),

  -- Strangers, and unattended work. Both off unless deliberately turned on,
  -- and allow_anon is additionally meaningless unless the workspace is public
  -- — checked at admission rather than assumed here.
  allow_anon      boolean not null default false,
  allow_scheduled boolean not null default false,

  updated_at   timestamptz not null default now(),
  primary key (workspace_id, feature)
);

alter table public.ai_budgets            enable row level security;
alter table public.ai_periods            enable row level security;
alter table public.ai_workspace_features enable row level security;

revoke all on public.ai_budgets            from anon, authenticated;
revoke all on public.ai_periods            from anon, authenticated;
revoke all on public.ai_workspace_features from anon, authenticated;

-- Entitlements are readable by their owner and by an admin, and writable by
-- neither: they are written by service_role or by the admin RPC. An
-- entitlement a user can edit is not an entitlement.
grant select on public.ai_budgets to authenticated;
create policy ai_budgets_read on public.ai_budgets
  for select using (user_id = auth.uid() or app.is_platform_admin());

grant insert, update, delete on public.ai_budgets to authenticated;
create policy ai_budgets_write on public.ai_budgets
  for all using (app.is_platform_admin()) with check (app.is_platform_admin());

-- The counters are read-only to everyone. They move through the call
-- functions, which are SECURITY DEFINER, or they do not move.
grant select on public.ai_periods to authenticated;
create policy ai_periods_read on public.ai_periods
  for select using (payer_id = auth.uid() or app.is_platform_admin());

-- A project's own switches belong to its owner, like everything else on the
-- settings page. Not can_write: an editor may correct the log, but turning on
-- something that spends money is the owner's decision because it is the
-- owner's bill.
grant select, insert, update, delete on public.ai_workspace_features to authenticated;
create policy ai_workspace_features_read on public.ai_workspace_features
  for select using (app.is_owner(workspace_id) or app.is_platform_admin());
create policy ai_workspace_features_write on public.ai_workspace_features
  for all using (app.is_owner(workspace_id) or app.is_platform_admin())
  with check (app.is_owner(workspace_id) or app.is_platform_admin());

create trigger touch_ai_budgets before update on public.ai_budgets
  for each row execute function public.touch_updated_at();
create trigger touch_ai_workspace_features before update on public.ai_workspace_features
  for each row execute function public.touch_updated_at();

-- Backfill, on the same principle as the creation-grants migration: everyone
-- who already owns a workspace keeps working. Without this the desk stops the
-- day phase 1 lands, which would be a governance layer taking the site down to
-- prove it was installed.
insert into public.ai_budgets (user_id, monthly_usd, enabled)
select distinct w.owner_id, null::numeric, true
from public.workspaces w
on conflict (user_id) do nothing;

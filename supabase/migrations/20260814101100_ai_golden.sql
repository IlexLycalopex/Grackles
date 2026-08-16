-- Golden cases.
--
-- A small, deliberately curated set of frozen inputs, replayed against any
-- prompt or model change before it ships. The expectation is that the *rules*
-- hold — prose that matched last month word for word would be the bug.
--
-- It is also the only defence against a model changing underneath us.
-- `minimax-m3` is a name, not a fixed artefact: providers revise weights behind
-- a stable identifier without announcing it, and nothing else in this design
-- would notice. A golden run on a schedule would.
--
-- Curated rather than kept wholesale, which is what resolves the retention
-- tension: keeping every prompt forever in case an evaluation wants one is the
-- wrong trade; keeping a few dozen deliberately, with the owner's agreement, is
-- the same capability at a fraction of the exposure.

create table public.ai_golden_cases (
  id           uuid primary key default gen_random_uuid(),
  feature      text not null references public.ai_features(key) on delete cascade,
  name         text not null,

  -- Everything needed to send the turn again: the messages, and whatever the
  -- feature's validator needs to judge the answer. Self-contained on purpose —
  -- a case that reaches back into live data is a case whose meaning changes
  -- when somebody edits a book.
  input        jsonb not null,

  -- What must hold. Not what must be said.
  expectations jsonb not null,

  curated_from uuid references public.ai_calls(id) on delete set null,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

create index ai_golden_cases_feature_idx on public.ai_golden_cases (feature);

create table public.ai_golden_runs (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.ai_golden_cases(id) on delete cascade,
  job_id     uuid references public.ai_jobs(id) on delete set null,
  call_id    uuid references public.ai_calls(id) on delete set null,

  passed     boolean not null,
  -- Which expectations failed, and how. The point of a golden run is the
  -- difference from the last one, so the detail has to survive.
  findings   jsonb not null default '[]'::jsonb,

  -- What produced it, so a change can be attributed rather than guessed at.
  model          text not null default '',
  prompt_version integer references public.ai_prompt_versions(id),

  created_at timestamptz not null default now()
);

create index ai_golden_runs_case_idx on public.ai_golden_runs (case_id, created_at desc);

alter table public.ai_golden_cases enable row level security;
alter table public.ai_golden_runs  enable row level security;

revoke all on public.ai_golden_cases from anon, authenticated;
revoke all on public.ai_golden_runs  from anon, authenticated;

-- Admin-only, both ways. A golden case carries a frozen copy of somebody's
-- data and the prompt that was sent with it; neither belongs in a table any
-- signed-in user can read.
grant select, insert, update, delete on public.ai_golden_cases to authenticated;
grant select, insert on public.ai_golden_runs to authenticated;

create policy ai_golden_cases_admin on public.ai_golden_cases
  for all using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy ai_golden_runs_read on public.ai_golden_runs
  for select using (app.is_platform_admin());
create policy ai_golden_runs_insert on public.ai_golden_runs
  for insert with check (app.is_platform_admin());

/**
 * The feature the golden runs bill to.
 *
 * Its own row rather than borrowing the feature being tested, for the same
 * reason a judge is billed to the platform: nobody asked for the evaluation,
 * and charging a project's owner for the platform checking its own model would
 * be indefensible on a report they can read.
 *
 * Owner-only and disabled by default — it is turned on when somebody actually
 * schedules the runs.
 */
insert into public.ai_features
  (key, app, name, enabled, max_tokens, min_role, default_max_usd, default_max_calls,
   prompt_allowance_tokens)
values
  ('platform.golden', 'wbpr', 'Golden runs', true, 800, 'owner', 0.200000, 60, 4000);

/**
 * The most recent run per case, which is the only one anybody looks at.
 *
 * Written as a function rather than a view because the interesting comparison
 * is with the run before it, and a lateral join reads better here than a window
 * function nobody will want to modify later.
 */
create function public.ai_golden_status()
returns table (
  case_id     uuid,
  feature     text,
  name        text,
  passed      boolean,
  findings    jsonb,
  model       text,
  ran_at      timestamptz,
  previously  boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select c.id, c.feature, c.name,
         latest.passed, latest.findings, latest.model, latest.created_at,
         prior.passed
    from public.ai_golden_cases c
    left join lateral (
      select r.passed, r.findings, r.model, r.created_at
        from public.ai_golden_runs r
       where r.case_id = c.id
       order by r.created_at desc
       limit 1
    ) latest on true
    left join lateral (
      select r.passed
        from public.ai_golden_runs r
       where r.case_id = c.id
       order by r.created_at desc
       offset 1 limit 1
    ) prior on true
   order by c.feature, c.name;
end $$;

revoke all on function public.ai_golden_status() from public;
grant execute on function public.ai_golden_status() to authenticated;

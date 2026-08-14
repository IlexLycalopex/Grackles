-- WBPR joins the governance layer.
--
-- A sitting at the desk was already a job in everything but name: it has a
-- lifecycle, an owner, a running/logged/abandoned status and an implicit
-- ceiling of four blocks. What it did not have was an envelope, a way to be
-- stopped, or a place its spend could be added up with anything else.
--
-- The transcript and the night's state stay in wbpr_agent_sessions. That is
-- WBPR's own business and does not belong in a platform table.

alter table public.wbpr_agent_sessions
  add column ai_job_id uuid references public.ai_jobs(id) on delete set null;

create index wbpr_agent_sessions_job_idx
  on public.wbpr_agent_sessions (ai_job_id) where ai_job_id is not null;

-- The three counters keep being written for now, alongside the ledger.
--
-- The spec says they become a view over ai_calls, and they will — but not on
-- the same day the ledger starts recording. Dual-writing is what makes the two
-- comparable: a full night through both, and any disagreement is visible
-- before the columns anyone actually reads are taken away. Removing them first
-- would mean discovering a discrepancy with nothing left to compare against.
comment on column public.wbpr_agent_sessions.prompt_tokens is
  'Dual-written with ai_calls during phase 0. Becomes a view over the sitting''s job once the two have agreed for a full night.';

-- Every existing sitting predates the ledger, so ai_job_id stays null on all of
-- them. That is the honest state: those sittings have totals but no per-call
-- detail, and inventing calls to fill a join would put a granularity into the
-- archive that was never recorded.

-- Turn the desk on for every WBPR project that exists, at the feature's own
-- defaults. Without this the first sitting after these migrations lands on an
-- absent row — which is permissive by design, so this is documentation as much
-- as configuration: it is where an owner's daily ceiling would go.
insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, f.key, true
from public.workspaces w
cross join (values ('wbpr.desk'), ('wbpr.writeup')) as f(key)
where w.app = 'wbpr'
on conflict (workspace_id, feature) do nothing;

-- Running a broadcast with the model.
--
-- Two tables: the sitting, and what was said in it. A sitting is one night at
-- the desk — it opens empty, accumulates four blocks' worth of conversation,
-- and ends by writing a broadcast. Keeping the transcript means a refresh, a
-- flat battery or a closed tab does not lose the night, which is the whole
-- reason it is in the database rather than in a component's state.
--
-- Token counts are columns rather than something inferred from the transcript
-- afterwards. "Protect token usage" is only a real property if somebody can
-- see what was spent, and the provider returns exact figures per call that a
-- word count would only approximate.
--
-- The gate is owner-only, and it is here as well as in the page. A page check
-- decides what to render; this decides what the database will accept, and the
-- second is the one that holds when somebody posts to the endpoint directly.

create table public.wbpr_agent_sessions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,

  -- Set once the sitting has been written up. Null while it is still running,
  -- and on a sitting that was abandoned — which is a normal way to end.
  broadcast_id     uuid references public.wbpr_broadcasts(id) on delete set null,

  status           text not null default 'running',

  -- What the model has been told about the night, so a resumed sitting does
  -- not have to re-derive it from the transcript.
  block            integer not null default 0,
  state            jsonb not null default '{}'::jsonb,

  prompt_tokens    integer not null default 0,
  completion_tokens integer not null default 0,
  calls            integer not null default 0,

  created_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint wbpr_agent_sessions_status check (status in ('running', 'logged', 'abandoned')),
  constraint wbpr_agent_sessions_block check (block between 0 and 4)
);

create table public.wbpr_agent_messages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id   uuid not null references public.wbpr_agent_sessions(id) on delete cascade,
  position     integer not null,
  role         text not null,
  content      text not null,
  created_at   timestamptz not null default now(),

  constraint wbpr_agent_messages_role check (role in ('user', 'assistant')),
  unique (session_id, position)
);

create index wbpr_agent_sessions_workspace_idx
  on public.wbpr_agent_sessions (workspace_id, created_at desc);
create index wbpr_agent_messages_session_idx
  on public.wbpr_agent_messages (session_id, position);

alter table public.wbpr_agent_sessions enable row level security;
alter table public.wbpr_agent_messages enable row level security;

-- Owner-only, on both tables, for every verb. app.is_owner() is the same
-- helper the settings page runs on. Deliberately not app.can_write(): an
-- editor may correct the log, but spending tokens is the owner's decision
-- because it is the owner's bill.
do $$
declare t text;
begin
  foreach t in array array['wbpr_agent_sessions','wbpr_agent_messages']
  loop
    execute format('create policy %1$s_read on public.%1$I for select using (app.is_owner(workspace_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (app.is_owner(workspace_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update using (app.is_owner(workspace_id)) with check (app.is_owner(workspace_id))', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (app.is_owner(workspace_id))', t);
  end loop;
end $$;

-- Not granted to anon. A transcript is not part of the public archive, and
-- unlike the broadcast tables there is no reading of this that a visitor wants.
grant select, insert, update, delete on public.wbpr_agent_sessions to authenticated;
grant select, insert, update, delete on public.wbpr_agent_messages to authenticated;

create trigger touch_wbpr_agent_sessions before update on public.wbpr_agent_sessions
  for each row execute function public.touch_updated_at();

-- Making a golden case out of a night that actually happened.
--
-- The suite was built and left empty, and an empty suite passes. Writing cases
-- by hand was never going to happen: the input is a whole transcript, and
-- nobody is going to paste one into a form.
--
-- The desk is the right place to curate from, and not only because its
-- transcript is already in the database. Its rules — never name a track, never
-- invent a card — are the ones that hold purely because the model complies, so
-- they are the ones most worth freezing an example of.
--
-- Nothing new is retained by this. The transcript is already stored, and the
-- system prompt is already in ai_prompt_versions because every call registers
-- the body it sent. Curating copies what exists into a place that will not be
-- swept, which is exactly the deliberate-keeping the retention argument asked
-- for.

create function public.ai_curate_desk_case(p_session uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sitting  record;
  v_last     integer;
  v_messages jsonb;
  v_system   text;
  v_call     uuid;
  v_id       uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  select * into v_sitting from public.wbpr_agent_sessions where id = p_session;
  if not found then
    raise exception 'no such sitting' using errcode = 'GRK10';
  end if;

  -- Up to and including the last thing we asked, and not the answer. The point
  -- of a case is to ask the question again; keeping the old reply in the
  -- messages would be handing the model its own homework.
  select max(position) into v_last
    from public.wbpr_agent_messages
   where session_id = p_session and role = 'user';

  if v_last is null then
    raise exception 'that sitting has nothing to replay' using errcode = 'GRK10';
  end if;

  select jsonb_agg(jsonb_build_object('role', role, 'content', content) order by position)
    into v_messages
    from public.wbpr_agent_messages
   where session_id = p_session and position <= v_last;

  -- What was actually sent, from the version register rather than from code:
  -- if the two ever disagree, the row is right, and a case frozen against a
  -- prompt nobody sent would be testing fiction.
  select body into v_system
    from public.ai_prompt_versions
   where feature = 'wbpr.desk' and active
   limit 1;

  -- The most recent call of that sitting's job, so the case records what it
  -- was curated from. Null is fine — an older sitting predates the ledger.
  select c.id into v_call
    from public.ai_calls c
   where c.job_id = v_sitting.ai_job_id
   order by c.created_at desc
   limit 1;

  insert into public.ai_golden_cases (feature, name, input, expectations, curated_from, created_by)
  values (
    'wbpr.desk',
    p_name,
    jsonb_build_object(
      'messages', coalesce(v_messages, '[]'::jsonb),
      'system', coalesce(v_system, ''),
      -- Everything the validator needs, frozen. A case that read live state
      -- would change meaning the next time somebody ran a broadcast, which is
      -- the opposite of what a golden case is for.
      'context', jsonb_build_object('state', v_sitting.state, 'said', '')
    ),
    -- The rules held when this was recorded, so the expectation is that they
    -- keep holding. Not that the prose comes back the same — identical prose
    -- would mean the model had stopped being one.
    '{"validator": "pass"}'::jsonb,
    v_call,
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.ai_curate_desk_case(uuid, text) from public;
grant execute on function public.ai_curate_desk_case(uuid, text) to authenticated;

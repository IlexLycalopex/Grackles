-- The first batch feature: filling in a book's details.
--
-- Facts come from OpenLibrary and judgement comes from the model, which is the
-- deck argument applied to a catalogue. It is never asked for a page count,
-- because it would supply one.
--
-- This is also the first feature whose prompt is *short*, and that turns out to
-- matter. The platform's flat 12,000-token prompt allowance was sized for the
-- desk, where a four-block transcript really can reach eight thousand. An
-- enrichment turn is about nine hundred tokens, so reserving twelve thousand
-- against every one of four hundred books would hold roughly four times what
-- the batch could possibly spend — and the envelope check would refuse jobs
-- that fit comfortably.
--
-- A worst case that is wildly pessimistic is not a safe worst case; it is a
-- limit in the wrong place.

alter table public.ai_features
  add column prompt_allowance_tokens integer
    check (prompt_allowance_tokens is null or prompt_allowance_tokens > 0);

comment on column public.ai_features.prompt_allowance_tokens is
  'The worst case for this feature''s prompt side. Null falls back to the platform default, which is sized for the longest thing on the site.';

create or replace function app.ai_worst_case(p_feature text)
returns numeric
language plpgsql stable as $$
declare
  v_f record; v_p record; v_allowance integer;
begin
  select * into v_f from public.ai_features where key = p_feature;
  if not found then
    raise exception 'no such feature: %', p_feature using errcode = 'GRK12';
  end if;

  select * into v_p from app.ai_price(v_f.provider, v_f.model);
  if not found then
    raise exception 'no allowed price for %/%', v_f.provider, v_f.model
      using errcode = 'GRK1C';
  end if;

  -- The feature's own allowance where it has one, the platform's otherwise.
  select coalesce(v_f.prompt_allowance_tokens, s.prompt_allowance_tokens)
    into v_allowance
    from public.ai_platform_settings s;

  return (v_f.max_tokens::numeric * v_p.completion_usd / 1000000)
       + (v_allowance::numeric    * v_p.prompt_usd     / 1000000);
end $$;

-- The desk keeps the platform default: its transcript really does grow, and
-- this is the one feature the flat allowance was sized for.
insert into public.ai_features
  (key, app, name, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens, quality_floor)
values
  ('reading.enrich', 'reading-list', 'Fill in a book''s details',
   400, 'editor', 'minimax', 'minimax-m3',
   -- Enough for a year of reading at the worst case, and inside half of a
   -- default month's allowance so the share rule does not refuse it.
   0.600000, 500, 2000, 0.15);

-- On for every Reading List that exists, at the feature's own defaults.
insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, 'reading.enrich', true
from public.workspaces w
where w.app = 'reading-list'
on conflict (workspace_id, feature) do nothing;

-- Four functions that do not pin their search_path, three of them new here and
-- one of them a regression this branch introduced.
--
-- `touch_updated_at` is the regression, and it is the instructive one. The
-- registry migration opens with `create or replace function
-- touch_updated_at()` so that the harness has one — the baseline was missing
-- it, which is what made every migration after 20260806170000 untestable. But
-- production already had one, hardened with a pinned path, and `create or
-- replace` does not merge attributes: it replaces the whole definition. So a
-- line written to make a *test* database work silently un-hardened the real
-- one. That is the shape of the mistake worth naming — the danger was not in
-- the function, it was in a statement whose purpose was somewhere else
-- entirely.
--
-- The other three are new and simply missed the convention every other
-- function in this schema follows. None is SECURITY DEFINER, so each runs as
-- its caller and the exposure is small: an attacker who can already set their
-- own search_path could shadow an operator or a cast these bodies resolve.
-- Small is not the same as absent, and the fix costs a line each.
--
-- `ai_price` and `ai_worst_case` are also called from inside SECURITY DEFINER
-- functions, which pin the path for the duration of the call — so in the path
-- that matters they were already covered. This makes them safe on their own
-- terms rather than safe because of who happens to call them, which is the
-- only version of that property that survives a refactor.

create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function app.ai_role_rank(r text) returns integer
language sql immutable
set search_path = public, pg_temp
as $$
  select case r
    when 'owner'  then 3
    when 'editor' then 2
    when 'viewer' then 1
    else 0
  end
$$;

create or replace function app.ai_price(p_provider text, p_model text)
returns table (prompt_usd numeric, completion_usd numeric)
language sql stable
set search_path = public, pg_temp
as $$
  select prompt_usd_per_mtok, completion_usd_per_mtok
  from public.ai_models
  where provider = p_provider and model = p_model
    and allowed and effective_from <= now()
  order by effective_from desc
  limit 1
$$;

create or replace function app.ai_worst_case(p_feature text)
returns numeric
language plpgsql stable
set search_path = public, pg_temp
as $$
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

  select coalesce(v_f.prompt_allowance_tokens, s.prompt_allowance_tokens)
    into v_allowance
    from public.ai_platform_settings s;

  return (v_f.max_tokens::numeric * v_p.completion_usd / 1000000)
       + (v_allowance::numeric    * v_p.prompt_usd     / 1000000);
end $$;

-- Checking the ledger against the bill.
--
-- Everything reported anywhere in this layer is derived from ai_calls, and
-- ai_calls is filled in by the same code that spends the money. That makes it
-- self-attested: it can be internally consistent and wrong, and nothing built
-- so far would tell the difference.
--
-- The provider's own figure is the only independent number available. Entered
-- by hand rather than pulled from an API, because a monthly statement is a
-- monthly job and an integration that has to be maintained for twelve numbers a
-- year is worse than typing them — and because a reconciliation nobody looks at
-- is not a reconciliation.
--
-- Variance is expected to be small and non-zero. Released reservations are the
-- honest cause: a call whose outcome we never saw is recorded at zero here and
-- may well have been billed, which is a trade this design made deliberately and
-- should now be able to measure.

create table public.ai_statements (
  provider     text not null,
  period       date not null,

  -- What the provider says the month cost.
  provider_usd numeric(12,4) not null check (provider_usd >= 0),

  -- What actually left the bank, if it is known. The payer is in the UK and the
  -- bill is in dollars, so this is the only place a real exchange rate ever
  -- appears — everything else is an indicative conversion and says so.
  charged_gbp  numeric(12,4) check (charged_gbp >= 0),

  note         text not null default '',
  entered_by   uuid references public.profiles(id) on delete set null,
  entered_at   timestamptz not null default now(),

  primary key (provider, period)
);

alter table public.ai_statements enable row level security;
revoke all on public.ai_statements from anon, authenticated;

grant select, insert, update, delete on public.ai_statements to authenticated;
create policy ai_statements_admin on public.ai_statements
  for all using (app.is_platform_admin()) with check (app.is_platform_admin());

-- An indicative rate for display. Null means show dollars only, which is the
-- default and the honest state until somebody puts a number here.
alter table public.ai_platform_settings
  add column usd_to_gbp numeric(8,5) check (usd_to_gbp is null or usd_to_gbp > 0);

comment on column public.ai_platform_settings.usd_to_gbp is
  'Indicative only, for showing a familiar number beside the real one. The rate that actually applied to a month lives on that month''s ai_statements row.';

/**
 * What the ledger says a month cost, against what the provider says.
 *
 * Released reservations are reported separately rather than folded in, because
 * they are the specific thing most likely to explain a gap: a call whose
 * outcome was never seen is recorded at zero and may still have been billed.
 */
create function public.ai_reconciliation(p_months integer default 6)
returns table (
  provider      text,
  period        date,
  ledger_usd    numeric,
  provider_usd  numeric,
  variance_usd  numeric,
  released      bigint,
  charged_gbp   numeric,
  note          text
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  with months as (
    select c.provider as prov,
           date_trunc('month', c.created_at)::date as per,
           sum(coalesce(c.cost_usd, 0)) as spent,
           count(*) filter (where c.status = 'released') as lost
      from public.ai_calls c
     where c.created_at >= date_trunc('month', now()) - make_interval(months => greatest(0, p_months))
     group by 1, 2
  )
  select m.prov, m.per,
         round(m.spent, 4),
         s.provider_usd,
         -- Null rather than zero where no statement has been entered: "not
         -- checked" and "checked and matched" are different states and a page
         -- that shows both as 0.00 cannot say which this is.
         case when s.provider_usd is null then null
              else round(s.provider_usd - m.spent, 4) end,
         m.lost,
         s.charged_gbp,
         coalesce(s.note, '')
    from months m
    left join public.ai_statements s on s.provider = m.prov and s.period = m.per
   order by m.per desc, m.prov;
end $$;

revoke all on function public.ai_reconciliation(integer) from public;
grant execute on function public.ai_reconciliation(integer) to authenticated;

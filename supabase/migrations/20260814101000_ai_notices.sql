-- Telling somebody.
--
-- Everything built so far is a control that acts, and every one of them
-- reports into a page. Nobody reads a page they have no reason to open, so a
-- feature that switched itself off at two in the morning stays off until
-- somebody happens to look — which makes it, at that point, an outage with a
-- dashboard rather than a control.
--
-- Notices are rows rather than emails because Postgres should not be making
-- network calls in the middle of a transaction that is settling money. The
-- sweep endpoint drains them, and `sent_at` is what stops the same fact being
-- sent twice.

create table public.ai_notices (
  id         uuid primary key default gen_random_uuid(),

  kind       text not null
             check (kind in ('budget', 'quality', 'anomaly')),

  -- Who needs to know. Null means the platform admins, which is right for a
  -- feature disabling itself: that is nobody's project in particular.
  recipient  uuid references public.profiles(id) on delete cascade,

  subject    text not null,
  body       text not null,

  -- What the notice is about, so the same fact is not reported twice. A budget
  -- warning is one per payer per month per threshold; a feature tripping is one
  -- per feature per trip.
  dedupe_key text not null unique,

  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  error      text
);

create index ai_notices_unsent_idx on public.ai_notices (created_at) where sent_at is null;

alter table public.ai_notices enable row level security;
revoke all on public.ai_notices from anon, authenticated;

-- Readable by the person it is for, and by an admin. Written by the functions
-- below and drained by service_role; nothing here is user-writable.
grant select on public.ai_notices to authenticated;
create policy ai_notices_read on public.ai_notices
  for select using (recipient = auth.uid() or app.is_platform_admin());

/**
 * Payers who have crossed a threshold of their allowance this month.
 *
 * Eighty per cent, because that is far enough through to be worth knowing and
 * early enough to do something about. Once per payer per month per threshold:
 * the dedupe key carries the period, so next month says it again and this
 * month does not.
 */
create function public.ai_check_budgets() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row   record;
  v_count integer := 0;
  v_period date := date_trunc('month', now())::date;
  v_default numeric;
begin
  select default_monthly_usd into v_default from public.ai_platform_settings;

  for v_row in
    select p.payer_id,
           p.committed_usd + p.reserved_usd as used,
           coalesce(b.monthly_usd, v_default) as allowance
      from public.ai_periods p
      join public.ai_budgets b on b.user_id = p.payer_id
     where p.period = v_period
       and b.enabled
       and coalesce(b.monthly_usd, v_default) > 0
       and (p.committed_usd + p.reserved_usd) >= coalesce(b.monthly_usd, v_default) * 0.8
  loop
    insert into public.ai_notices (kind, recipient, subject, body, dedupe_key)
    values (
      'budget',
      v_row.payer_id,
      'Your AI allowance is most of the way through',
      format(
        'You have used $%s of your $%s allowance for %s. Anything that would take you past it will be refused rather than charged. There is a breakdown at /settings/ai.',
        round(v_row.used, 4), round(v_row.allowance, 2), to_char(v_period, 'FMMonth YYYY')
      ),
      format('budget:%s:%s:80', v_row.payer_id, v_period)
    )
    on conflict (dedupe_key) do nothing;

    if found then v_count := v_count + 1; end if;
  end loop;

  return v_count;
end $$;

-- The quality floor gains a notice. Nothing else about it changes: it still
-- disables the feature itself, which is the part that matters — this only
-- means somebody finds out before they next open the admin page.
create or replace function public.ai_enforce_quality_floors()
returns table (feature text, sampled bigint, failed bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f      record;
  v_total  bigint;
  v_failed bigint;
begin
  for v_f in
    select key, quality_floor from public.ai_features
     where quality_floor is not null
       and enabled
       and auto_disabled_at is null
  loop
    select count(*), count(*) filter (where c.validator_status = 'fail')
      into v_total, v_failed
      from (
        select validator_status from public.ai_calls
         where ai_calls.feature = v_f.key and validator_status is not null
         order by created_at desc
         limit 50
      ) c;

    if v_total >= 20 and (v_failed::numeric / v_total) > v_f.quality_floor then
      update public.ai_features
         set auto_disabled_at = now()
       where key = v_f.key;

      insert into public.ai_notices (kind, recipient, subject, body, dedupe_key)
      values (
        'quality',
        null,
        format('%s switched itself off', v_f.key),
        format(
          '%s of the last %s checked calls failed their validator, which is past the %s floor. The feature is disabled and will stay disabled until somebody re-enables it. Check the prompt before you do — a rollback is more often the fix than a re-enable.',
          v_failed, v_total, v_f.quality_floor
        ),
        format('quality:%s:%s', v_f.key, now()::date)
      )
      on conflict (dedupe_key) do nothing;

      feature := v_f.key;
      sampled := v_total;
      failed  := v_failed;
      return next;
    end if;
  end loop;
end $$;

/**
 * What is waiting to be sent, and marking it sent.
 *
 * Returned with the recipient's address resolved, because the sweep endpoint
 * runs as service_role and should not be joining to auth.users itself.
 */
create function public.ai_pending_notices()
returns table (id uuid, kind text, email text, subject text, body text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  select n.id, n.kind, coalesce(p.email::text, ''), n.subject, n.body
    from public.ai_notices n
    left join public.profiles p on p.id = n.recipient
   where n.sent_at is null
   order by n.created_at
   limit 50;
end $$;

create function public.ai_notice_sent(p_id uuid, p_error text default null)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.ai_notices set sent_at = now(), error = p_error where id = p_id;
$$;

/**
 * Everything cron calls, in one place.
 *
 * Reaping, sweeping the cache, checking the floors and checking the budgets are
 * four things on the same cadence for the same reason: each is the system
 * noticing something without waiting for a person to look. One function so
 * there is one thing to schedule and one thing to forget to schedule.
 */
create function public.ai_housekeeping()
returns table (calls_released integer, jobs_reaped integer, cache_swept integer, notices integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reap record;
begin
  select * into v_reap from public.ai_reap();
  calls_released := v_reap.calls;
  jobs_reaped    := v_reap.jobs;
  cache_swept    := public.ai_cache_sweep();
  notices        := public.ai_check_budgets();
  return next;
end $$;

/**
 * The same housekeeping, for a platform admin at a keyboard.
 *
 * `ai_housekeeping()` is service_role's, because cron has no session and
 * app.is_platform_admin() is false without one. That leaves an admin unable to
 * run the thing they administer, which matters more than it sounds: until a
 * cron job exists, this is the only way a stale reservation is ever released.
 *
 * SECURITY DEFINER, so it runs as the owner and can reach a function granted
 * only to service_role — the check above it is what decides who may.
 */
create function public.ai_housekeeping_now()
returns table (calls_released integer, jobs_reaped integer, cache_swept integer, notices integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
  return query select * from public.ai_housekeeping();
end $$;

revoke all on function public.ai_housekeeping_now() from public;
grant execute on function public.ai_housekeeping_now() to authenticated;

revoke all on function public.ai_check_budgets() from public;
revoke all on function public.ai_pending_notices() from public;
revoke all on function public.ai_notice_sent(uuid, text) from public;
revoke all on function public.ai_housekeeping() from public;
revoke all on function public.ai_enforce_quality_floors() from public;
grant execute on function public.ai_check_budgets() to service_role;
grant execute on function public.ai_pending_notices() to service_role;
grant execute on function public.ai_notice_sent(uuid, text) to service_role;
grant execute on function public.ai_housekeeping() to service_role;
grant execute on function public.ai_enforce_quality_floors() to service_role;

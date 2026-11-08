-- Lecturas: rating an article means it has been read.
--
-- lx_reader_read(workspace, article, rating) records the rating, marks the
-- article read (read_at), and logs its estimated reading time as an article
-- in the study log, once: rating it again changes the rating, not the
-- minutes. Read articles leave the list for the page's archive.
-- lx_reader_unread puts one back and removes the minutes it logged.
--
-- The estimate is the page's own: words at 120 a minute, at least one. If
-- the article already reached the log another way (read in Instapaper and
-- synced back), it is not counted twice.

alter table public.lx_reader_marks
  add column read_at timestamptz,
  add column activity_id uuid references public.lx_activities(id) on delete set null;

create index lx_reader_marks_read_idx on public.lx_reader_marks (workspace_id, read_at desc) where read_at is not null;

alter table public.lx_activities drop constraint lx_activities_source;
alter table public.lx_activities add constraint lx_activities_source
  check (source in ('phone', 'web', 'duolingo', 'strava', 'instapaper', 'lecturas'));

-- Logs one read article in the study log, once, and links the mark to it.
-- Internal: the public function below checks who is asking.
create function app.lx_reader_log(p_workspace uuid, p_article uuid, p_by uuid, p_day date)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a     public.lx_reader_articles;
  v_tag text;
  v_act uuid;
begin
  select * into a from public.lx_reader_articles where id = p_article;
  if not found then return false; end if;
  if exists (select 1 from public.lx_reader_marks where workspace_id = p_workspace and article_id = p_article and activity_id is not null)
     or exists (select 1 from public.lx_activities where workspace_id = p_workspace and link = a.url) then
    return false;
  end if;
  select nullif(focus_tag, '') into v_tag from public.lx_settings where workspace_id = p_workspace;
  insert into public.lx_activities (workspace_id, occurred_on, type, title, minutes, link, notes, tags, source, source_ref, created_by)
  values (
    p_workspace, p_day, 'article', left(a.title, 300),
    least(greatest(1, round(coalesce(a.words, 0) / 120.0))::integer, 600),
    case when a.url ~ '^https?://' then left(a.url, 2000) else '' end,
    left(format('Lecturas, %s, %s', a.level, a.source), 2000),
    array[coalesce(v_tag, 'argentina'), 'spanish', 'lecturas'],
    'lecturas', p_article::text, p_by)
  on conflict (workspace_id, source, source_ref) do update set updated_at = now()
  returning id into v_act;
  update public.lx_reader_marks set activity_id = v_act where workspace_id = p_workspace and article_id = p_article;
  return true;
end
$$;

revoke all on function app.lx_reader_log(uuid, uuid, uuid, date) from public, anon, authenticated;

create function public.lx_reader_read(p_workspace uuid, p_article uuid, p_rating text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_words integer;
  v_logged boolean;
begin
  if not app.can_write(p_workspace) or not exists (select 1 from public.workspaces where id = p_workspace and app = 'latam') then
    raise exception 'not allowed' using errcode = 'GRK50';
  end if;
  if p_rating is null or p_rating not in ('easy', 'right', 'hard') then
    raise exception 'unknown rating' using errcode = 'GRK40';
  end if;
  select words into v_words from public.lx_reader_articles where id = p_article;
  if not found then
    raise exception 'no such article' using errcode = 'GRK44';
  end if;

  insert into public.lx_reader_marks (workspace_id, article_id, rating, read_at, created_by, updated_at)
  values (p_workspace, p_article, p_rating, now(), auth.uid(), now())
  on conflict (workspace_id, article_id)
  do update set rating = excluded.rating, read_at = coalesce(lx_reader_marks.read_at, now()), updated_at = now();

  v_logged := app.lx_reader_log(p_workspace, p_article, auth.uid(), (now() at time zone 'Europe/London')::date);
  return jsonb_build_object('minutes', greatest(1, round(coalesce(v_words, 0) / 120.0))::integer, 'logged', v_logged);
end
$$;

create function public.lx_reader_unread(p_workspace uuid, p_article uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_act uuid;
begin
  if not app.can_write(p_workspace) or not exists (select 1 from public.workspaces where id = p_workspace and app = 'latam') then
    raise exception 'not allowed' using errcode = 'GRK50';
  end if;
  select activity_id into v_act from public.lx_reader_marks where workspace_id = p_workspace and article_id = p_article;
  update public.lx_reader_marks set rating = null, read_at = null, activity_id = null, updated_at = now()
   where workspace_id = p_workspace and article_id = p_article;
  delete from public.lx_activities where id = v_act and workspace_id = p_workspace and source = 'lecturas';
end
$$;

revoke all on function public.lx_reader_read(uuid, uuid, text), public.lx_reader_unread(uuid, uuid) from public, anon;
grant execute on function public.lx_reader_read(uuid, uuid, text), public.lx_reader_unread(uuid, uuid) to authenticated;

-- Articles rated before this counted as read too: marked read on the day
-- they were rated, and logged on that day.
do $$
declare
  m record;
begin
  for m in select * from public.lx_reader_marks where rating is not null and read_at is null loop
    update public.lx_reader_marks set read_at = m.updated_at where workspace_id = m.workspace_id and article_id = m.article_id;
    perform app.lx_reader_log(m.workspace_id, m.article_id, m.created_by, (m.updated_at at time zone 'Europe/London')::date);
  end loop;
end
$$;

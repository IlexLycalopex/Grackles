-- Lecturas: pictures, and feeds of the reader's own.
--
-- image_url is the article's own lead picture, as its page announces it to
-- link previews (og:image) or as its feed carries it. It is shown from the
-- publisher's server, as any link preview is; nothing is copied here.
--
-- lx_reader_feeds are feeds a LatAm editor adds on the Lecturas page: an RSS
-- or Atom address, the topic its articles start under, and a name to show.
-- latam-reader-fetch reads them beside its built-in list, under the same
-- rules (safe headlines only, graded, never the text kept), and records how
-- each one went so a broken feed says so. The articles themselves join the
-- shared list like any other.
--
-- lx_reader_fetch_now() rings the fetch at once, for an editor who has just
-- added a feed and does not want to wait for 05:41. Once in ten minutes, so a
-- button cannot become a way to hammer other people's servers.

alter table public.lx_reader_articles
  add column image_url text check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 1000)),
  add column feed_id uuid;

create table public.lx_reader_feeds (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  url          text not null check (url ~ '^https?://' and char_length(url) <= 1000),
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  topic        text not null check (topic in ('travel', 'mountains', 'fishing', 'books', 'culture', 'drink', 'food')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_run_at  timestamptz,
  last_ok      boolean,
  last_message text not null default '',
  unique (workspace_id, url)
);

alter table public.lx_reader_articles
  add constraint lx_reader_articles_feed foreign key (feed_id) references public.lx_reader_feeds(id) on delete set null;

-- When the fetch was last rung by hand, so the button can be rationed.
create table public.lx_reader_fetch_requests (
  id           bigint generated always as identity primary key,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now()
);

create function public.lx_reader_fetch_now()
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_last timestamptz;
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
     where m.user_id = auth.uid() and w.app = 'latam' and m.role in ('owner', 'editor')) then
    raise exception 'only a LatAm editor can fetch articles' using errcode = 'GRK50';
  end if;
  select max(requested_at) into v_last from public.lx_reader_fetch_requests;
  if v_last > now() - interval '10 minutes' then
    raise exception 'fetched % minutes ago; try again in a few minutes',
      ceil(extract(epoch from now() - v_last) / 60) using errcode = 'GRK53';
  end if;
  insert into public.lx_reader_fetch_requests (requested_by) values (auth.uid());
  perform net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'latam_reader_fetch_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jpod_sync_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000);
  return 'started';
end
$$;

revoke all on public.lx_reader_feeds, public.lx_reader_fetch_requests from anon, authenticated;
grant select, insert, delete on public.lx_reader_feeds to authenticated;
grant update (name, topic) on public.lx_reader_feeds to authenticated;
grant select, insert, update, delete on public.lx_reader_feeds, public.lx_reader_fetch_requests to service_role;

revoke all on function public.lx_reader_fetch_now() from public, anon;
grant execute on function public.lx_reader_fetch_now() to authenticated;

alter table public.lx_reader_feeds          enable row level security;
alter table public.lx_reader_fetch_requests enable row level security;

create policy lx_reader_feeds_read   on public.lx_reader_feeds for select using (app.can_read(workspace_id));
create policy lx_reader_feeds_insert on public.lx_reader_feeds for insert
  with check (app.can_write(workspace_id) and created_by = auth.uid());
create policy lx_reader_feeds_update on public.lx_reader_feeds for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lx_reader_feeds_delete on public.lx_reader_feeds for delete using (app.can_write(workspace_id));

-- Lecturas: Spanish articles from Argentine sources, graded for a learner.
--
-- latam-reader-fetch (an Edge Function, nightly) reads a fixed list of news
-- feeds, keeps titles that are on one of the reader's topics and not grim,
-- fetches each article and grades it: readability (INFLESZ) and how many of
-- its words are among the commonest 1,000 / 2,000 / 5,000 Spanish forms. The
-- level is computed from those; no model decides it. Only the measurements,
-- the title and the link are kept, never the article's text.
--
-- A glossary is the model's part (`latam.glossary`): asked from the reading
-- page, one call, ten words from the article with their meaning and a
-- two-line English summary. Each word must appear in the article or it is
-- dropped. The articles are public and shared by every LatAm project; what a
-- reader thought of one (too easy, about right, too hard) is the project's.

create table public.lx_reader_articles (
  id           uuid primary key default gen_random_uuid(),
  url          text not null unique check (url ~ '^https?://' and char_length(url) <= 2000),
  source       text not null,
  topic        text not null,
  title        text not null check (char_length(title) between 1 and 300),
  published_at timestamptz,
  fetched_at   timestamptz not null default now(),
  words        integer not null default 0,
  inflesz      numeric(5,1),
  cov1k        numeric(4,3),
  cov2k        numeric(4,3),
  cov5k        numeric(4,3),
  -- Null when the page could not be read: kept so it is not fetched again.
  level        text check (level in ('A2', 'B1', 'B2', 'C1')),
  summary_en   text not null default '',
  glossary     jsonb not null default '[]',
  enriched_at  timestamptz,
  ai_call_id   uuid,

  constraint lx_reader_topic check (topic in ('travel', 'mountains', 'fishing', 'books', 'culture', 'drink', 'food'))
);

create index lx_reader_articles_list_idx on public.lx_reader_articles (level, topic, fetched_at desc) where level is not null;

create table public.lx_reader_marks (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  article_id   uuid not null references public.lx_reader_articles(id) on delete cascade,
  rating       text check (rating in ('easy', 'right', 'hard')),
  sent_at      timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, article_id)
);

-- The model's glossary, written by whoever asked for it. A definer function
-- because the articles are shared: an editor of any LatAm project may enrich
-- one, and nothing else about the row is theirs to change.
create function public.lx_reader_enrich(p_article uuid, p_summary text, p_glossary jsonb, p_call uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
     where m.user_id = auth.uid() and w.app = 'latam' and m.role in ('owner', 'editor')) then
    raise exception 'only a LatAm editor can add a glossary' using errcode = 'GRK50';
  end if;
  if jsonb_typeof(p_glossary) <> 'array' or jsonb_array_length(p_glossary) > 15 then
    raise exception 'a glossary is a short list' using errcode = 'GRK54';
  end if;
  update public.lx_reader_articles
     set summary_en = left(coalesce(p_summary, ''), 600), glossary = p_glossary, enriched_at = now(), ai_call_id = p_call
   where id = p_article;
end
$$;

insert into public.ai_features
  (key, app, name, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens, sends_records)
values
  ('latam.glossary', 'latam', 'Glossary for an article', 900, 'editor', 'minimax', 'minimax-m3',
   0.010000, 1, 2500, false)
on conflict (key) do nothing;

insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, 'latam.glossary', true from public.workspaces w where w.app = 'latam'
on conflict (workspace_id, feature) do nothing;

revoke all on public.lx_reader_articles, public.lx_reader_marks from anon, authenticated;
grant select on public.lx_reader_articles to authenticated;
-- Whole-row update rather than column grants: the page saves a mark as an
-- upsert, and an upsert's DO UPDATE names every column it was given. The
-- policies keep it to the project's editors.
grant select, insert, update, delete on public.lx_reader_marks to authenticated;
grant select, insert, update, delete on public.lx_reader_articles, public.lx_reader_marks to service_role;

revoke all on function public.lx_reader_enrich(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.lx_reader_enrich(uuid, text, jsonb, uuid) to authenticated, service_role;

alter table public.lx_reader_articles enable row level security;
alter table public.lx_reader_marks    enable row level security;

create policy lx_reader_articles_read on public.lx_reader_articles for select to authenticated using (true);

create policy lx_reader_marks_read   on public.lx_reader_marks for select using (app.can_read(workspace_id));
create policy lx_reader_marks_insert on public.lx_reader_marks for insert with check (app.can_write(workspace_id));
create policy lx_reader_marks_update on public.lx_reader_marks for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lx_reader_marks_delete on public.lx_reader_marks for delete using (app.can_write(workspace_id));

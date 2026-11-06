-- LatAm deep dives: grounded in Wikipedia, and honest about what was dropped.
--
-- The first live dive (Gaiman) wrote 1885 for the Welsh landing (1865),
-- invented a company, drifted into Chinese mid-phrase, and had all six books
-- dropped with no record of what they were. So the app now fetches the place's
-- Wikipedia article and the model writes from it; the article's address is
-- kept beside the dive, and so are the proposals no catalogue could find.
--
-- The prompt now carries up to 7,000 characters of article, about 2,000
-- tokens, so the feature's prompt allowance rises to match.

alter table public.lx_research
  add column rejected   jsonb not null default '[]',
  add column source_url text  not null default '';

update public.ai_features set prompt_allowance_tokens = 4500 where key = 'latam.research';

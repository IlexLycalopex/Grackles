-- Every stored link that is rendered as an href, held to http(s).
--
-- Found by the sweep of 27 Oct 2026. cl_cigars.photo_path, wbpr_tracks.url
-- and workspaces.external_url have always carried a `*_shape` check; the
-- reading list and Listening Party links never did, and their forms accepted
-- any text. An editor can write these tables directly through the API, so a
-- form check alone was never the guard: a `javascript:` "link" saved by one
-- editor would run in whoever clicked it next, signed in as them, on a page a
-- public project shows to anybody.
--
-- One stored value already failed the rule, harmlessly: a Spotify link pasted
-- from the Android app as `intent://album/<id>#Intent;…`, which no desktop
-- browser opens. It is rewritten to the web address it stands for, the same
-- rewrite the form now applies on save.
--
-- `~*` rather than `~`, so HTTPS:// passes here as it passes the form.

update public.lp_selections
   set link_spotify = 'https://open.spotify.com/'
                      || (regexp_match(link_spotify, '^intent://(album|track|artist|playlist)/([A-Za-z0-9]+)'))[1]
                      || '/'
                      || (regexp_match(link_spotify, '^intent://(album|track|artist|playlist)/([A-Za-z0-9]+)'))[2]
 where link_spotify ~ '^intent://(album|track|artist|playlist)/[A-Za-z0-9]+';

do $$
declare
  t text;
  c text;
begin
  for t, c in
    select * from (values
      ('lp_selections', 'link_wikipedia'),
      ('lp_selections', 'link_spotify'),
      ('lp_selections', 'link_youtube'),
      ('lp_selections', 'artwork_url'),
      ('rl_books', 'cover_url'),
      ('rl_books', 'link_openlibrary'),
      ('rl_books', 'link_wikipedia'),
      ('rl_library', 'cover_url'),
      ('rl_library', 'link_openlibrary'),
      ('rl_book_reference', 'cover_url'),
      ('rl_book_reference', 'link_openlibrary'),
      ('profiles', 'avatar_url')
    ) as v(t, c)
  loop
    -- Guarded so the local test cluster, which may not carry every column,
    -- applies the rest.
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = t and column_name = c) then
      execute format(
        'alter table public.%I add constraint %I check (%I = %L or %I ~* %L)',
        t, t || '_' || c || '_shape', c, '', c, '^https?://'
      );
    end if;
  end loop;
end $$;

-- Where a project lives, for the ones that do not live here yet.
--
-- An empty string means "this project is served by this app, at
-- /{path}/{slug}". A URL means it is still somewhere else and the link should
-- go there instead. That makes migrating a site a one-column update rather
-- than a new row: the workspace, its members and its address survive the move.
--
-- Deliberately not a check that ties the URL to the app. A hosted app is
-- allowed to point outward for a while — that is exactly the state these five
-- are in, and the state Listening Party would be in if it had to be rolled
-- back to GitHub Pages for a day.

alter table public.workspaces
  add column external_url text not null default '';

alter table public.workspaces
  add constraint workspaces_external_url_shape
  check (external_url = '' or external_url ~ '^https?://');

-- The five sites the launcher used to link to by hand. Owned by whoever owns
-- the projects that are already here, looked up rather than hardcoded so this
-- does not carry a uuid that means nothing in six months.
--
-- No descriptions: the column defaults to empty, and a made-up sentence about
-- what each site is would be worse than none. They can be written from the
-- settings page.
with proprietor as (
  select owner_id as id
  from public.workspaces
  where app = 'listening-party'
  order by created_at
  limit 1
)
insert into public.workspaces (app, slug, name, visibility, owner_id, external_url)
select site.app::public.app_slug,
       'jamie',
       site.name,
       'public'::public.visibility,
       proprietor.id,
       site.url
from proprietor,
     (values
       ('atelier-obscura', 'Atelier Obscura', 'https://ilexlycalopex.github.io/Atelier-Obscura/'),
       ('lanternwood',     'Lanternwood',     'https://ilexlycalopex.github.io/Lanternwood-Adventures/'),
       ('spelltome',       'Spelltome',       'http://www.lycalopex.co.uk/'),
       ('scoundrel',       'Scoundrel',       'https://ilexlycalopex.github.io/scoundrel/'),
       ('wbpr',            'WBPR 1680 AM',    'https://ilexlycalopex.github.io/WBPR/')
     ) as site(app, name, url)
on conflict (app, slug) do nothing;

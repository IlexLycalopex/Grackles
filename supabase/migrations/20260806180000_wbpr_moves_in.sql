-- WBPR moves in.
--
-- This is the whole migration, and it is the point of the external_url column:
-- the workspace keeps its id, its members, its slug and its address, and stops
-- being a link to GitHub Pages the moment the column is cleared. Nothing about
-- the row changes except where it points.
--
-- The app registry flips `hosted` in the same commit. The two have to move
-- together — a cleared external_url with no routes behind it is a 404, and
-- routes with the column still set are routes nothing links to.

update public.workspaces
   set external_url = ''
 where app = 'wbpr'
   and external_url <> '';

-- A photo is a URL, now that one can be typed.
--
-- photo_path predates the move off markdown, where the value was either an
-- absolute URL or a bare path resolved against the site root. Nothing has ever
-- written it — all ten entries carry '' — and the form that now does takes a
-- URL pasted by hand, because there is no upload and a half-path nobody can
-- resolve is worse than an empty field.
--
-- Same shape as workspaces_external_url_shape, for the same reason: '' is the
-- stored value for "none" and anything else has to be fetchable. A Supabase
-- storage public URL is absolute too, so this does not stand in the way of
-- uploading later — it rules out only the bare-path form, which no longer
-- resolves to anything.

alter table public.cl_cigars
  add constraint cl_cigars_photo_path_shape
  check (photo_path = '' or photo_path ~ '^https?://');

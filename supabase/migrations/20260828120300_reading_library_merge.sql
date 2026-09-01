-- Merging two entries that turn out to be one book.
--
-- The unique index means this can only ever be a manual correction of a
-- near-match — two rows the fold kept apart on purpose, like "The Trial" and
-- "Trial" — never a bulk cleanup. It is the button on the other end of
-- app.rl_near_duplicates().
--
-- A function rather than four statements in a route, for the same reason
-- rl_apply_import is one: half a merge leaves a book with some of its readings
-- and a duplicate with the rest, which is worse than either row on its own.

create or replace function public.rl_merge_library(p_keep uuid, p_drop uuid)
returns jsonb
language plpgsql security invoker
set search_path to 'public', 'pg_temp'
as $$
declare
  keep public.rl_library%rowtype;
  drop_row public.rl_library%rowtype;
  moved integer;
begin
  select * into keep from public.rl_library where id = p_keep;
  if not found then raise exception 'no such book' using errcode = 'GRK32'; end if;
  select * into drop_row from public.rl_library where id = p_drop;
  if not found then raise exception 'no such book' using errcode = 'GRK32'; end if;

  if keep.id = drop_row.id then
    raise exception 'those are the same book' using errcode = 'GRK33';
  end if;
  if keep.workspace_id <> drop_row.workspace_id then
    raise exception 'those books are in different projects' using errcode = 'GRK33';
  end if;
  if not app.can_write(keep.workspace_id) then
    raise exception 'not allowed to change this project' using errcode = '42501';
  end if;

  -- Every reading moves first, so the delete below has nothing pointing at it.
  -- The read-state trigger recounts both entries as this runs, which is the
  -- case it was written for.
  update public.rl_books set library_id = p_keep where library_id = p_drop;
  get diagnostics moved = row_count;

  -- Field by field, the survivor wins ties and a blank never beats a value.
  -- Not "the newer row" or "the fuller row" wholesale: the two entries are
  -- usually one good record and one thin one from an import, and taking the
  -- thin one's non-empty fields is exactly what makes the merge worth doing.
  update public.rl_library l
  set author         = coalesce(nullif(l.author, ''), drop_row.author),
      series         = coalesce(nullif(l.series, ''), drop_row.series),
      series_index   = coalesce(l.series_index, drop_row.series_index),
      year_published = coalesce(l.year_published, drop_row.year_published),
      pages          = coalesce(l.pages, drop_row.pages),
      publisher      = coalesce(nullif(l.publisher, ''), drop_row.publisher),
      genre          = coalesce(nullif(l.genre, ''), drop_row.genre),
      isbn           = coalesce(nullif(l.isbn, ''), drop_row.isbn),
      cover_url      = coalesce(nullif(l.cover_url, ''), drop_row.cover_url),
      description    = coalesce(nullif(l.description, ''), drop_row.description),
      notes          = case
                         when l.notes = '' then drop_row.notes
                         when drop_row.notes = '' or drop_row.notes = l.notes then l.notes
                         -- Two people's notes about one book are both worth
                         -- keeping; there is no version of picking one that is
                         -- not a deletion.
                         else l.notes || E'\n\n' || drop_row.notes
                       end,
      link_openlibrary = coalesce(nullif(l.link_openlibrary, ''), drop_row.link_openlibrary),
      source_photo   = coalesce(nullif(l.source_photo, ''), drop_row.source_photo),
      tags           = (select coalesce(array_agg(distinct t), '{}')
                        from unnest(l.tags || drop_row.tags) t),
      -- The longest-standing claim on the book.
      added_at       = least(l.added_at, drop_row.added_at),
      -- An override on either side survives, because it is somebody's stated
      -- knowledge and the other row's silence is not a contradiction of it.
      read_override  = coalesce(l.read_override, drop_row.read_override),
      -- Ownership takes the more present of the two: a book on the shelf and
      -- the same book recorded as never owned is a book on the shelf.
      ownership      = case
                         when 'owned' in (l.ownership, drop_row.ownership) then 'owned'
                         when 'wanted' in (l.ownership, drop_row.ownership) then 'wanted'
                         when 'released' in (l.ownership, drop_row.ownership) then 'released'
                         else 'none'
                       end
  where l.id = p_keep;

  -- Anything staged that pointed at the loser now points at the survivor, so an
  -- old import review does not develop a hole in it.
  update public.rl_import_rows set match_library_id = p_keep where match_library_id = p_drop;
  update public.rl_import_rows set library_id = p_keep where library_id = p_drop;

  delete from public.rl_library where id = p_drop;

  -- Once more at the end. The per-row trigger has been firing throughout, but
  -- the survivor's counts are only final after the last reading has moved.
  perform app.rl_recount(p_keep);

  return jsonb_build_object('moved', moved, 'kept', p_keep);
end;
$$;

revoke all on function public.rl_merge_library(uuid, uuid) from public;
grant execute on function public.rl_merge_library(uuid, uuid) to authenticated;

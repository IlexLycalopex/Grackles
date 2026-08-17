-- The wishlist: cigars you want, in the same table as the ones you have.
--
-- A wishlist is a third state of the same object rather than a second kind of
-- object. The thing being recorded is a cigar — brand, vitola, wrapper, size,
-- the reference row a lookup filled it from — and every one of those columns
-- already exists on `cl_cigars`. A `cl_wishlist` table would have been that
-- column list a second time, plus a second set of policies, plus a copy step
-- on the one operation the feature exists for: moving an entry out of it.
--
-- Held against that, the argument for a separate table is that a wishlist row
-- is not a cigar you own, and `cl_cigars` is read in a dozen places that assume
-- it is. That is real, and it is answered by `status` rather than by a table:
-- every one of those readers already filters on status, because the log and the
-- humidor are the same table and always have been. A third value is a third
-- filter, and the filters were there to be extended.
--
-- What this buys is the whole point of the feature. "Move it to the humidor" is
-- an UPDATE of one column on one row — the entry keeps its id, its URL, its
-- photo, its notes and the lookup it was filled from, because nothing was ever
-- copied anywhere. "Smoke it" is the function below, unchanged in shape.

-- ── The third status ────────────────────────────────────────────────
--
-- The constraint enumerating the statuses is dropped by search rather than by
-- name. It was written as an inline column check in a migration that predates
-- this repository, so its name is whatever Postgres generated for it, and
-- naming `cl_cigars_status_check` here would be a guess that fails on a
-- database where it came out otherwise.
--
-- The search is on `conkey` — the columns a constraint actually references —
-- rather than on the text of its definition. `cl_cigars` carries four other
-- checks that mention `status` (`cl_smoked_needs_date` and its three
-- neighbours), and a definition search for the word would have dropped all of
-- them, silently, leaving the table with fewer rules than it started with. The
-- enumeration is the only check that reads *nothing but* `status`, which makes
-- the column list an exact identification rather than a guess about wording.
do $$
declare
  status_col smallint;
  con        text;
begin
  select attnum into strict status_col
    from pg_attribute
   where attrelid = 'public.cl_cigars'::regclass and attname = 'status';

  for con in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.cl_cigars'::regclass
       and c.contype  = 'c'
       and c.conkey   = array[status_col]
  loop
    execute format('alter table public.cl_cigars drop constraint %I', con);
  end loop;
end $$;

alter table public.cl_cigars
  add constraint cl_cigars_status_check
  check (status in ('humidor', 'smoked', 'wishlist'));

comment on constraint cl_cigars_status_check on public.cl_cigars is
  'humidor: resting. smoked: in the log. wishlist: wanted rather than owned, '
  'so it carries neither date_acquired nor date_smoked.';

-- ── The date rules, restated for three statuses ─────────────────────
--
-- `cl_humidor_has_no_date` was written when 'not smoked' and 'in the humidor'
-- were the same sentence. They are not any more, and the risk is not
-- theoretical in either direction: depending on how the original was phrased, a
-- wishlist row either slips past it and may carry a smoked date, or is rejected
-- outright. Both are restated here so the rule is the one this app enforces,
-- whatever the original said.
--
-- The names are kept exactly. `describeWriteError` maps constraint names to
-- sentences, so renaming one turns a plain sentence back into a raw dump.
alter table public.cl_cigars drop constraint if exists cl_smoked_needs_date;
alter table public.cl_cigars add constraint cl_smoked_needs_date
  check (status <> 'smoked' or date_smoked is not null);

alter table public.cl_cigars drop constraint if exists cl_humidor_has_no_date;
alter table public.cl_cigars add constraint cl_humidor_has_no_date
  check (status = 'smoked' or date_smoked is null);

-- And the new half of the same idea. A cigar with a date acquired is one you
-- have; having it is what the humidor *is*. A wishlist row carrying that date
-- is a move somebody half-made, and the app says so before this fires — this is
-- what makes it true rather than merely checked.
alter table public.cl_cigars drop constraint if exists cl_wishlist_not_acquired;
alter table public.cl_cigars add constraint cl_wishlist_not_acquired
  check (status <> 'wishlist' or date_acquired is null);

-- ── Smoking one you had only wished for ─────────────────────────────
--
-- `smoke_from_humidor` refused anything whose status was not 'humidor', with
-- the message "that cigar has already been smoked" — which was true of the only
-- other status there was. It is no longer the only other one, and a wishlist
-- entry is a legitimate source: somebody wanted a cigar, got hold of it, and
-- smoked it the same evening. Making them add it to the humidor first so they
-- can immediately take it out again is bookkeeping this app exists to end.
--
-- Two things stay exactly as they were, deliberately:
--
--   * A 'smoked' source is still refused, and still with the same message. That
--     is the case the guard was written for and it is unchanged.
--   * The stack path still leaves the remainder in the source's own status. A
--     wishlist entry for three that has one smoked off it leaves two on the
--     wishlist, which is what the row said and remains true — you wanted three
--     and have had one.
--
-- The column list on the insert is unchanged and is the thing to keep in step
-- with the table; see `20260809120000_smoke_carries_photo` for what it costs
-- when it falls behind. `date_acquired` copies across as before and is simply
-- null when the source was a wish, which is honest: nothing records the moment
-- a cigar was acquired if it never was.
create or replace function public.smoke_from_humidor(
  p_cigar_id      uuid,
  p_slug          text,
  p_date_smoked   date,
  p_smoked_at     text    default '',
  p_pairing       text    default '',
  p_note          text    default '',
  p_rating        numeric default null,
  p_tasting_notes text    default ''
) returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  src    public.cl_cigars%rowtype;
  new_id uuid;
begin
  select * into src from public.cl_cigars where id = p_cigar_id for update;

  if not found then
    raise exception 'that cigar is not in this humidor' using errcode = 'no_data_found';
  end if;
  if src.status not in ('humidor', 'wishlist') then
    raise exception 'that cigar has already been smoked' using errcode = 'check_violation';
  end if;

  if src.quantity > 1 then
    -- One comes off the stack: the log entry is a new row, so everything that
    -- describes the cigar rather than this particular smoke has to be copied
    -- across. The source keeps its status, whichever of the two it was.
    insert into public.cl_cigars (
      workspace_id, slug, status, quantity, name, brand, vitola, wrapper,
      length_text, ring_gauge, country, strength, bought_at, smoked_at,
      date_acquired, date_smoked, price_text, price_gbp, price_approximate,
      rating, pairing, note, tasting_notes, photo_path, reference_id
    ) values (
      src.workspace_id, p_slug, 'smoked', 1, src.name, src.brand, src.vitola,
      src.wrapper, src.length_text, src.ring_gauge, src.country, src.strength,
      src.bought_at, coalesce(p_smoked_at, ''), src.date_acquired, p_date_smoked,
      src.price_text, src.price_gbp, src.price_approximate,
      p_rating, coalesce(p_pairing, ''), coalesce(p_note, ''),
      coalesce(p_tasting_notes, ''), src.photo_path, src.reference_id
    )
    returning id into new_id;

    update public.cl_cigars set quantity = quantity - 1 where id = src.id;
  else
    -- The last one: the source row becomes the log entry. Columns not named
    -- here keep what they had, which is why this path never lost the photo.
    update public.cl_cigars
       set status        = 'smoked',
           quantity      = 1,
           date_smoked   = p_date_smoked,
           smoked_at     = coalesce(p_smoked_at, ''),
           rating        = p_rating,
           pairing       = coalesce(p_pairing, ''),
           note          = coalesce(p_note, ''),
           tasting_notes = coalesce(p_tasting_notes, '')
     where id = src.id
    returning id into new_id;
  end if;

  return new_id;
end;
$function$;

-- Smoking one off a stack loses the photo.
--
-- `smoke_from_humidor` has two paths. When the last one goes, it converts the
-- humidor row in place — every column it does not name is left alone, so the
-- photo survives without anyone having to think about it. When one comes off a
-- stack of several, it inserts a *new* row for the log and decrements the
-- original, and that insert names its columns explicitly. Two were missing from
-- the list: `photo_path` and `reference_id`.
--
-- A named-column insert takes the default for anything omitted, and both
-- default to empty. So the log entry came out with no image and no link back to
-- the reference row it had been filled from, while the entry still in the
-- humidor kept both. The bug is invisible until a stack is broken into, which
-- is why it survived: the single-cigar path is the one that gets exercised
-- first, and it is the path that cannot have this fault.
--
-- The fix is the two column names. It is worth noting *why* the omission was
-- easy to make and stays easy: this insert has to be kept in step with the
-- table by hand, and adding a column to `cl_cigars` does not fail anything
-- here. Anything added later needs adding to this list too, unless it is
-- genuinely per-entry rather than per-cigar.

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
  if src.status <> 'humidor' then
    raise exception 'that cigar has already been smoked' using errcode = 'check_violation';
  end if;

  if src.quantity > 1 then
    -- One comes off the stack: the log entry is a new row, so everything that
    -- describes the cigar rather than this particular smoke has to be copied
    -- across. `photo_path` and `reference_id` are the two that were not.
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
    -- The last one: the humidor row becomes the log entry. Columns not named
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

-- Repair what the old version wrote.
--
-- A smoked entry with no photo, sitting next to a humidor entry for the same
-- cigar that has one, is the signature of this bug — the photo is a property of
-- the cigar, not of the occasion, so the two rows should never disagree. The
-- match is on workspace, brand and name, which is what "the same cigar" means
-- here, and `having count(distinct …) = 1` declines to guess when the siblings
-- disagree about which image is right.
--
-- Deliberately narrow in two ways. It only fills entries that are *empty*, so
-- nothing a person set by hand is overwritten. And it does not touch
-- `reference_id`: no row in production carries one yet, and inheriting a
-- reference is a stronger claim than inheriting a picture — it says this entry
-- was filled from that lookup, which for a row written before the fix is not
-- something this backfill can know.
with sibling as (
  select s.id as smoked_id, min(h.photo_path) as photo_path
    from public.cl_cigars s
    join public.cl_cigars h
      on  h.workspace_id = s.workspace_id
      and h.brand        = s.brand
      and h.name         = s.name
      and h.id          <> s.id
      and h.photo_path  <> ''
   where s.status     = 'smoked'
     and s.photo_path = ''
   group by s.id
  having count(distinct h.photo_path) = 1
)
update public.cl_cigars c
   set photo_path = sibling.photo_path
  from sibling
 where c.id = sibling.smoked_id;

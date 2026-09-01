-- Importing a bookcase.
--
-- Photographs go through OCR somewhere else and come back as a file. This is
-- where that file lands, and it lands in staging rather than in the library,
-- for the reason the enrich route already gives about batches: *a year
-- half-enriched is worse than one never started*. An import that half-lands
-- leaves somebody working out which half, across several hundred books, with
-- no record of what the file said.
--
-- So: two tables and one function. The file is parsed and judged in the
-- application, written here as rows with a verdict apiece, shown to a person,
-- and applied in a single statement that either lands or does not.

create table public.rl_import_batches (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  filename      text not null default '',

  -- The same file twice is the same batch. A person on a phone will
  -- double-submit this form, and the second submission should find the first
  -- rather than open a second review of the same shelf — the same reasoning as
  -- the idempotency key on the enrich route.
  content_hash  text not null check (content_hash <> ''),

  rows_total    integer not null default 0,
  rows_accepted integer not null default 0,

  -- What an undecided row means in this batch. The photographs know what is on
  -- the bookcase; they do not know what has been read, and for a library that
  -- is mostly read that is the larger fact. One switch at the top of the review
  -- rather than several hundred decisions.
  read_default  boolean not null default false,

  status        text not null default 'review'
                check (status in ('review', 'applied', 'abandoned')),
  uploaded_by   uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  applied_at    timestamptz,

  unique (workspace_id, content_hash)
);

create table public.rl_import_rows (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references public.rl_import_batches (id) on delete cascade,
  -- Denormalised from the batch so every policy on this table is one predicate
  -- rather than a join, and so a row can never end up in a batch belonging to
  -- another project.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  position     integer not null,

  -- Every column of the upload, under the names the file used, including the
  -- ones this app has no home for. The file came from photographs that may not
  -- be taken again; dropping a column because the parser did not recognise its
  -- name is the one unrecoverable mistake available in this design.
  raw          jsonb not null default '{}',

  title        text not null default '',
  author       text not null default '',
  work_key     text not null default '',

  verdict      text not null default 'new'
               check (verdict in ('new', 'duplicate_in_batch', 'known', 'ambiguous', 'unreadable')),
  match_library_id uuid references public.rl_library (id) on delete set null,

  decision     text not null default 'skip' check (decision in ('add', 'confirm', 'skip')),
  -- Null takes the batch's read_default.
  read_decision boolean,

  -- The values an 'add' will carry across, already parsed. Kept as columns
  -- rather than re-read from `raw` at apply time so that what a person saw on
  -- the review screen is exactly what gets written.
  series       text not null default '',
  series_index numeric,
  year_published integer,
  pages        integer,
  publisher    text not null default '',
  isbn         text not null default '',
  genre        text not null default '',
  tags         text[] not null default '{}',
  format       text not null default 'print' check (format in ('print', 'audio', 'graphic')),
  source_photo text not null default '',
  notes        text not null default '',

  -- Filled in by the apply, so the batch remains a full account of what the
  -- file said *and* what was done about it.
  library_id   uuid references public.rl_library (id) on delete set null,
  created_at   timestamptz not null default now(),

  unique (batch_id, position)
);

create index rl_import_rows_batch_idx on public.rl_import_rows (batch_id, position);
create index rl_import_rows_verdict_idx on public.rl_import_rows (batch_id, verdict);

-- Deferred from the library migration, which could not reference a table that
-- did not exist yet.
alter table public.rl_library
  add constraint rl_library_source_batch_fkey
  foreign key (source_batch_id) references public.rl_import_batches (id) on delete set null;

-- ── applying ────────────────────────────────────────────────────────────────

-- One statement, because a partially applied import is the state with no good
-- next action.
--
-- If the unique index refuses a row — the TypeScript fold and the SQL fold
-- disagreeing, which is the one way that happens — the whole thing rolls back
-- and the caller is told which row. That is the drift detector working, and it
-- is better than an import that silently dropped a book.
create or replace function public.rl_apply_import(p_batch uuid)
returns jsonb
language plpgsql security invoker
set search_path to 'public', 'pg_temp'
as $$
declare
  b public.rl_import_batches%rowtype;
  added    integer := 0;
  confirmed integer := 0;
  r record;
  new_id uuid;
begin
  select * into b from public.rl_import_batches where id = p_batch;
  if not found then
    raise exception 'no such import' using errcode = 'GRK30';
  end if;
  -- RLS decides whether this caller may write; this is the courtesy check that
  -- turns a silent no-op into a sentence.
  if not app.can_write(b.workspace_id) then
    raise exception 'not allowed to apply an import here' using errcode = '42501';
  end if;
  if b.status <> 'review' then
    raise exception 'that import has already been dealt with' using errcode = 'GRK31';
  end if;

  for r in
    select * from public.rl_import_rows
    where batch_id = p_batch and decision in ('add', 'confirm')
    order by position
  loop
    if r.decision = 'add' then
      insert into public.rl_library (
        workspace_id, title, author, series, series_index, format,
        year_published, pages, publisher, genre, tags, isbn, notes,
        ownership, source, source_batch_id, source_photo,
        -- A row the file or the batch says is read gets an override, never an
        -- invented reading. There is no year for one, no dates and no
        -- position; fabricating them would file hundreds of books into years
        -- they were not read in and break every count on the site.
        read_override
      )
      values (
        b.workspace_id, r.title, r.author, r.series, r.series_index, r.format,
        r.year_published, r.pages, r.publisher, r.genre, r.tags, r.isbn, r.notes,
        'owned', 'import', b.id, r.source_photo,
        case when coalesce(r.read_decision, b.read_default) then true else null end
      )
      returning id into new_id;

      update public.rl_import_rows set library_id = new_id where id = r.id;
      added := added + 1;

    elsif r.decision = 'confirm' and r.match_library_id is not null then
      -- A photograph is evidence of ownership and of nothing else. It does not
      -- touch the title, the genre, the read state, or anything a person has
      -- edited — an import is allowed to say *this is on the bookcase*, and
      -- that is all.
      update public.rl_library
      set ownership = 'owned',
          source_photo = case when source_photo = '' then r.source_photo else source_photo end
      where id = r.match_library_id;

      update public.rl_import_rows set library_id = r.match_library_id where id = r.id;
      confirmed := confirmed + 1;
    end if;
  end loop;

  update public.rl_import_batches
  set status = 'applied', applied_at = now(), rows_accepted = added + confirmed
  where id = p_batch;

  return jsonb_build_object('added', added, 'confirmed', confirmed);
end;
$$;

revoke all on function public.rl_apply_import(uuid) from public;
grant execute on function public.rl_apply_import(uuid) to authenticated;

-- ── access ──────────────────────────────────────────────────────────────────

alter table public.rl_import_batches enable row level security;
alter table public.rl_import_rows enable row level security;

-- Read is can_write rather than can_read, deliberately. A public reading list
-- shows what somebody has read; the staging table shows a half-corrected
-- machine transcription of their bookcase, including the rows that were wrong.
-- That is working material, not a publication.
create policy rl_import_batches_read on public.rl_import_batches
  for select using (app.can_write(workspace_id));
create policy rl_import_batches_insert on public.rl_import_batches
  for insert with check (app.can_write(workspace_id) and uploaded_by = (select auth.uid()));
create policy rl_import_batches_update on public.rl_import_batches
  for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy rl_import_batches_delete on public.rl_import_batches
  for delete using (app.can_write(workspace_id));

create policy rl_import_rows_read on public.rl_import_rows
  for select using (app.can_write(workspace_id));
create policy rl_import_rows_insert on public.rl_import_rows
  for insert with check (app.can_write(workspace_id));
create policy rl_import_rows_update on public.rl_import_rows
  for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy rl_import_rows_delete on public.rl_import_rows
  for delete using (app.can_write(workspace_id));

grant select, insert, update, delete on public.rl_import_batches to authenticated;
grant select, insert, update, delete on public.rl_import_rows to authenticated;

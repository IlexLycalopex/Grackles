import { keyOf, looksLikeSameBook, workKey, type Identifiable } from './library.ts';

/**
 * Reading a file of books off a bookcase.
 *
 * Extraction happens somewhere else — photographs go through OCR and come back
 * as a file — so this module starts at the moment that file is uploaded and
 * stops at a set of rows with a verdict on each. Nothing here writes: the
 * review screen shows what it found, and `rl_apply_import()` does the writing
 * in one statement.
 *
 * Two rules shape the whole file.
 *
 * **Nothing the extraction found is thrown away.** Every column of the upload
 * survives into `raw`, including ones this app has no home for. The file came
 * from photographs that may not be taken again, and dropping a column because
 * the parser did not recognise its name is the one unrecoverable mistake
 * available in this design. An unmapped column is shown on the review screen so
 * that an extraction which produced something useful under an unexpected name
 * costs one alias rather than a second afternoon with a camera.
 *
 * **The parser is forgiving because the thing producing the file is a model in
 * another tool**, and it will not produce the same headers twice. Delimiters
 * and shape are sniffed rather than configured; only `title` is required.
 */

// ── what a row can say ──────────────────────────────────────────────

export const IMPORT_FIELDS = [
  'title', 'author', 'series', 'series_index', 'year_published', 'pages',
  'publisher', 'isbn', 'genre', 'tags', 'format', 'read', 'source_photo', 'notes',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * Header aliases, matched on the folded form so "Page Count", "page-count" and
 * "page_count" are one name.
 *
 * The list is a guess at a file nobody has made yet, which is why adding to it
 * is designed to be the cheapest possible fix: the unmapped columns are on the
 * review screen, so the first real export tells you exactly what to add here.
 */
const ALIASES: Record<string, ImportField> = {
  title: 'title', name: 'title', book: 'title', booktitle: 'title',
  author: 'author', authors: 'author', by: 'author', writer: 'author', creator: 'author',
  series: 'series', seriesname: 'series',
  seriesindex: 'series_index', volume: 'series_index', vol: 'series_index',
  booknumber: 'series_index', number: 'series_index',
  yearpublished: 'year_published', year: 'year_published', published: 'year_published',
  firstpublished: 'year_published', publicationyear: 'year_published', date: 'year_published',
  pages: 'pages', pagecount: 'pages', length: 'pages', numberofpages: 'pages',
  publisher: 'publisher', imprint: 'publisher',
  isbn: 'isbn', isbn13: 'isbn', isbn10: 'isbn', barcode: 'isbn',
  genre: 'genre', category: 'genre', subject: 'genre',
  tags: 'tags', keywords: 'tags', shelves: 'tags', subjects: 'tags',
  format: 'format', binding: 'format', type: 'format', mediatype: 'format',
  read: 'read', hasread: 'read', finished: 'read', status: 'read',
  sourcephoto: 'source_photo', photo: 'source_photo', image: 'source_photo',
  shelf: 'source_photo', file: 'source_photo', filename: 'source_photo',
  notes: 'notes', note: 'notes', comment: 'notes', comments: 'notes',
};

/** A header, reduced to what an alias is looked up by. */
const foldHeader = (header: string): string =>
  header.toLowerCase().replace(/[^a-z0-9]/g, '');

export const fieldFor = (header: string): ImportField | null =>
  ALIASES[foldHeader(header)] ?? null;

// ── reading the file ────────────────────────────────────────────────

/** The most rows one upload may carry. Past this it is a paste that times out. */
export const MOST_ROWS = 2000;

export interface RawRow {
  /** Every column of the upload, under the names the file used. */
  raw: Record<string, string>;
  /** The columns this app recognised. */
  mapped: Partial<Record<ImportField, string>>;
}

export type ParseResult =
  | { ok: true; rows: RawRow[]; unmapped: string[] }
  | { ok: false; error: string };

/**
 * One row of a delimited line, respecting quotes.
 *
 * Written rather than depended on. A CSV parser is a package, and the whole of
 * what this needs is quotes, doubled quotes inside them, and a delimiter — the
 * same argument `lib/email.ts` makes for not taking an SDK to send one POST.
 * What it does not do is multi-line quoted fields, and that is a deliberate
 * limit rather than an oversight: a book title with a newline in it is a
 * mis-extraction, and treating it as data would swallow the rest of the shelf.
 */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field.trim());
  return out;
}

/**
 * Which delimiter the file uses, decided by the header line.
 *
 * Counted outside quotes, because a header is allowed to contain a comma inside
 * one. Tab first when it wins outright: a tab in a book title is far less
 * likely than a comma, so a file that has both is a TSV.
 */
function sniffDelimiter(header: string): string {
  const count = (d: string) => splitLine(header, d).length;
  const tabs = count('\t');
  const commas = count(',');
  const semis = count(';');
  if (tabs > 1 && tabs >= commas) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * A file, into rows.
 *
 * CSV, TSV, a JSON array of objects, or JSONL. The shape is sniffed rather than
 * declared, because whoever is uploading this has just spent an afternoon
 * photographing shelves and should not also have to know what their extraction
 * tool chose to emit.
 */
export function parseUpload(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'That file is empty.' };

  const rows = trimmed.startsWith('[') || trimmed.startsWith('{')
    ? parseJson(trimmed)
    : parseDelimited(trimmed);

  if (!rows.ok) return rows;
  if (!rows.rows.length) return { ok: false, error: 'That file has no rows in it.' };
  if (rows.rows.length > MOST_ROWS) {
    return {
      ok: false,
      error: `That file has ${rows.rows.length} rows and the most one import may carry is ${MOST_ROWS}. Split it and upload the halves.`,
    };
  }
  return rows;
}

function parseJson(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSONL: one object per line, which a model asked for JSON often produces.
    const rows: unknown[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); }
      catch { return { ok: false, error: 'That looks like JSON but could not be read.' }; }
    }
    parsed = rows;
  }

  // A wrapper object with the list inside it — `{ "books": [...] }` — which is
  // the other thing a model reliably does when asked for a JSON array.
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    const inner = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
    if (inner) parsed = inner;
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'That JSON is not a list of books.' };
  }

  const rows: RawRow[] = [];
  const unmapped = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw: Record<string, string> = {};
    const mapped: Partial<Record<ImportField, string>> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      const text = value === null || value === undefined ? ''
        : Array.isArray(value) ? value.join(', ')
        : typeof value === 'object' ? JSON.stringify(value)
        : String(value);
      raw[key] = text;
      const field = fieldFor(key);
      // First alias wins. A file carrying both "isbn" and "isbn13" should not
      // have the second silently overwrite the first with a blank.
      if (field && mapped[field] === undefined && text.trim()) mapped[field] = text.trim();
      else if (!field) unmapped.add(key);
    }
    rows.push({ raw, mapped });
  }
  return { ok: true, rows, unmapped: [...unmapped] };
}

function parseDelimited(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { ok: false, error: 'That file has a header and no rows.' };

  const delimiter = sniffDelimiter(lines[0]!);
  const headers = splitLine(lines[0]!, delimiter);
  if (!headers.some(h => fieldFor(h) === 'title')) {
    return {
      ok: false,
      error: 'No column in that file looks like a title. The first line has to be a header row.',
    };
  }

  const unmapped = new Set<string>();
  for (const h of headers) if (h && !fieldFor(h)) unmapped.add(h);

  const rows: RawRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitLine(line, delimiter);
    const raw: Record<string, string> = {};
    const mapped: Partial<Record<ImportField, string>> = {};
    headers.forEach((header, i) => {
      const value = (cells[i] ?? '').trim();
      if (header) raw[header] = value;
      const field = fieldFor(header);
      if (field && mapped[field] === undefined && value) mapped[field] = value;
    });
    rows.push({ raw, mapped });
  }
  return { ok: true, rows, unmapped: [...unmapped] };
}

// ── what a row means ────────────────────────────────────────────────

export const VERDICTS = [
  'new', 'duplicate_in_batch', 'known', 'ambiguous', 'unreadable',
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const DECISIONS = ['add', 'confirm', 'skip'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface Judged {
  position: number;
  raw: Record<string, string>;
  title: string;
  author: string;
  work_key: string;
  verdict: Verdict;
  match_library_id: string | null;
  decision: Decision;
  /** Null takes the batch default. */
  read_decision: boolean | null;
  values: {
    series: string;
    series_index: number | null;
    year_published: number | null;
    pages: number | null;
    publisher: string;
    isbn: string;
    genre: string;
    tags: string[];
    format: string;
    source_photo: string;
    notes: string;
  };
}

/** An entry already in the library, as judging needs to see it. */
export interface ExistingEntry extends Identifiable {
  id: string;
  work_key: string;
}

const FORMATS = new Set(['print', 'audio', 'graphic']);

/** "hardback", "paperback", "ebook" all read as print; only audio and graphic differ. */
function readFormat(value: string | undefined): string {
  const v = (value ?? '').toLowerCase();
  if (!v) return 'print';
  if (FORMATS.has(v)) return v;
  if (/audio|audible|spoken|cd\b/.test(v)) return 'audio';
  if (/graphic|comic|manga|trade paperback vol/.test(v)) return 'graphic';
  return 'print';
}

/**
 * Whether a row says it has been read.
 *
 * Null rather than false when the file did not say, because "did not say" and
 * "said no" are different and only the first should fall through to the batch
 * default. A file that carries a `read` column has an opinion worth keeping.
 */
function readFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (['true', 'yes', 'y', '1', 'read', 'finished', 'complete', 'completed'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'unread', 'to-read', 'to read', 'want to read', 'tbr'].includes(v)) return false;
  return null;
}

const toInt = (value: string | undefined): number | null => {
  if (!value) return null;
  const n = Number.parseInt(value.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * Every row, with a verdict and a default decision.
 *
 * The order the verdicts are tested in is the order they are listed: a row with
 * no title is unreadable whatever else it matches, and a row already in this
 * file is a duplicate before it is anything else.
 */
export function judge(rows: RawRow[], existing: ExistingEntry[]): Judged[] {
  const byKey = new Map(existing.map(e => [e.work_key, e]));
  const seen = new Map<string, number>();
  const out: Judged[] = [];

  rows.forEach((row, i) => {
    const title = (row.mapped.title ?? '').trim();
    const author = (row.mapped.author ?? '').trim();
    const seriesIndex = toInt(row.mapped.series_index);
    const key = title ? workKey(title, author, seriesIndex) : '';

    let verdict: Verdict = 'new';
    let match: string | null = null;

    if (!title) {
      verdict = 'unreadable';
    } else if (seen.has(key)) {
      // The second copy on the shelf, or the same spine photographed twice.
      verdict = 'duplicate_in_batch';
    } else if (byKey.has(key)) {
      verdict = 'known';
      match = byKey.get(key)!.id;
    } else {
      // Only now, because a near-miss against something already known is worth
      // less than the exact match it did not have.
      const near = existing.find(e =>
        looksLikeSameBook({ title, author, series_index: seriesIndex }, e)
      );
      if (near) {
        verdict = 'ambiguous';
        match = near.id;
      }
    }

    if (title && verdict !== 'duplicate_in_batch') seen.set(key, i);

    out.push({
      position: i + 1,
      raw: row.raw,
      title,
      author,
      work_key: key,
      verdict,
      match_library_id: match,
      decision: defaultDecision(verdict),
      read_decision: readFlag(row.mapped.read),
      values: {
        series: row.mapped.series ?? '',
        series_index: seriesIndex,
        year_published: toInt(row.mapped.year_published),
        pages: toInt(row.mapped.pages),
        publisher: row.mapped.publisher ?? '',
        isbn: (row.mapped.isbn ?? '').replace(/[^0-9Xx]/g, ''),
        genre: row.mapped.genre ?? '',
        tags: (row.mapped.tags ?? '').split(/[,;|]/).map(t => t.trim()).filter(Boolean),
        format: readFormat(row.mapped.format),
        source_photo: row.mapped.source_photo ?? '',
        notes: row.mapped.notes ?? '',
      },
    });
  });

  return out;
}

/**
 * What a row does unless somebody says otherwise.
 *
 * `known` confirms rather than skips, and that is the whole difference between
 * this import and a naive one. After the backfill every book ever read has an
 * entry, so a first import of a mostly-read bookcase matches almost everything
 * — and each match is evidence of *ownership*, which is a fact the library did
 * not have. Skipping them would throw away most of what the photographs are
 * for.
 *
 * `ambiguous` has no default. It is the only verdict that requires a person,
 * and pre-selecting either answer for them would make the pile invisible.
 */
function defaultDecision(verdict: Verdict): Decision {
  switch (verdict) {
    case 'new': return 'add';
    case 'known': return 'confirm';
    case 'ambiguous': return 'skip';
    case 'duplicate_in_batch': return 'skip';
    case 'unreadable': return 'skip';
  }
}

/** A short account of a batch, for the top of the review screen. */
export function summarise(rows: Judged[]): Record<Verdict, number> {
  const counts = Object.fromEntries(VERDICTS.map(v => [v, 0])) as Record<Verdict, number>;
  for (const row of rows) counts[row.verdict]++;
  return counts;
}

/** A stable identity for a file, so the same upload twice is one batch. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export { keyOf };

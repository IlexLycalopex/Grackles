/**
 * Asking the site a question.
 *
 * The design is one sentence long: **the model says how to look, and the app
 * looks.** A question goes out with a description of the columns; a plan comes
 * back — a table, some comparisons, an ordering — and the app runs it through
 * the caller's own Supabase client, so RLS decides what comes back exactly as
 * it does on every other page. Nothing is generated as SQL and nothing is
 * interpolated into a query string.
 *
 * Three properties follow from that, and each is the reason for a decision
 * further down:
 *
 * **No row ever reaches the model.** The question and this file's static
 * vocabulary are the whole of what is sent. That is why `platform.search` is
 * registered with `sends_records = false` and needs no project's consent — and
 * it is why the results are rendered rather than narrated. A second call
 * summarising the rows would be a nicer paragraph and a worse feature: it would
 * put every project behind a consent gate, double the cost, and introduce the
 * one thing this design otherwise has none of, which is a model asserting
 * something about your records that you then have to check.
 *
 * **Authorisation is not this file's job and must not become it.** The plan
 * never carries a workspace. It cannot ask for a project, cannot widen to one,
 * and cannot name a person. Whatever it asks for is filtered by the policies
 * already on the table, so the worst a wrong plan can do is show you your own
 * rows in a strange order.
 *
 * **A plan is a pure function of the question.** Same words, same vocabulary,
 * same plan — so it is cached, and asking twice costs once.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppSlug, Database } from '../database.types';

type Client = SupabaseClient<Database>;

/** What a column is, which decides what may be asked of it. */
export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'enum';

export interface Field {
  column: string;
  type: FieldType;
  /** For an enum, the only values that mean anything. */
  values?: readonly string[];
  /** Told to the model. Short: this is paid for by the token, once per search. */
  what: string;
}

export interface Source {
  /** What the model names in a plan. */
  key: string;
  app: AppSlug;
  table: string;
  /** Plural, for a sentence: "4 books". */
  label: string;
  /** What this table holds, in one line, for the model. */
  what: string;
  /** The column that titles a result. */
  title: string;
  /** Beneath the title, where there is one. */
  subtitle?: string;
  fields: Field[];
  /** Where a row lives, given the project's slug. */
  href: (row: Record<string, unknown>, slug: string) => string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What can be searched, and it is deliberately not everything.
 *
 * A column earns its place here by being something a person would put in a
 * sentence. Ids, slugs, sort orders, cover URLs and timestamps-of-last-edit are
 * all things the app needs and nobody asks about, and every one of them listed
 * would be a token spent on every search forever.
 *
 * Blackletter is absent for a different reason: a game is a word, six guesses
 * and a result, and "which games did I lose" is a scoreboard rather than a
 * search. It has one, and it is free.
 *
 * `books` and `library` are both here and are not a duplication: one is the
 * readings — a year, a position, the dates it took — and the other is the books
 * themselves, most of which have never been read. "What did I read in 2019" and
 * "what do I own and have not read" are different questions against different
 * tables, and collapsing them would make the second unanswerable.
 */
export const SOURCES: Source[] = [
  {
    key: 'books',
    app: 'reading-list',
    table: 'rl_books',
    label: 'readings',
    what: 'Readings: books read, being read, or lined up to read, each in a particular year. For books somebody owns rather than has read, use library.',
    title: 'title',
    subtitle: 'author',
    fields: [
      { column: 'title', type: 'text', what: 'The book\'s title.' },
      { column: 'author', type: 'text', what: 'Who wrote it.' },
      { column: 'genre', type: 'text', what: 'Genre, in the reader\'s own vocabulary.' },
      { column: 'publisher_normalised', type: 'text', what: 'Publisher, normalised.' },
      { column: 'pages', type: 'number', what: 'Page count.' },
      { column: 'year_published', type: 'number', what: 'Year first published.' },
      { column: 'format', type: 'text', what: 'Paperback, hardback, ebook, audiobook.' },
      { column: 'date_started', type: 'date', what: 'When reading began.' },
      { column: 'date_finished', type: 'date', what: 'When it was finished. Null means unfinished — abandoned or still going.' },
      { column: 'reading', type: 'boolean', what: 'True while it is the book currently being read.' },
      { column: 'coming_up', type: 'boolean', what: 'True when it is on the to-read list rather than read.' },
      { column: 'isbn', type: 'text', what: 'ISBN.' },
      { column: 'description', type: 'text', what: 'The blurb.' },
      { column: 'notes', type: 'text', what: 'The reader\'s own notes.' },
    ],
    href: (row, slug) => `/reading/${slug}/book/${row.id}`,
  },
  {
    key: 'library',
    app: 'reading-list',
    table: 'rl_library',
    label: 'books',
    what: 'Every book owned, wanted or once owned — read or not.',
    title: 'title',
    subtitle: 'author',
    fields: [
      { column: 'title', type: 'text', what: 'The book\'s title.' },
      { column: 'author', type: 'text', what: 'Who wrote it.' },
      { column: 'series', type: 'text', what: 'The series it belongs to.' },
      { column: 'genre', type: 'text', what: 'Genre, in the reader\'s own vocabulary.' },
      { column: 'publisher_normalised', type: 'text', what: 'Publisher, normalised.' },
      { column: 'pages', type: 'number', what: 'Page count.' },
      { column: 'year_published', type: 'number', what: 'Year first published.' },
      // The reason this source is worth having, and the reason `read` is a
      // maintained column rather than a join computed at query time: "which
      // unread science fiction do I own" is one filter here and would otherwise
      // not be expressible at all.
      { column: 'read', type: 'boolean', what: 'True when it has been read. Books read before this list existed are marked by hand.' },
      { column: 'reading', type: 'boolean', what: 'True while it is being read right now.' },
      { column: 'times_read', type: 'number', what: 'How many times it has been finished. 0 means never.' },
      { column: 'last_read_on', type: 'date', what: 'When it was last finished. Null means never, or long enough ago that it was not recorded.' },
      { column: 'ownership', type: 'enum', values: ['owned', 'wanted', 'released', 'none'], what: 'Whether it is on the shelf, wanted, gone, or was never owned.' },
      { column: 'format', type: 'text', what: 'print, audio or graphic.' },
      { column: 'added_at', type: 'date', what: 'When it joined the library.' },
      { column: 'isbn', type: 'text', what: 'ISBN.' },
      { column: 'notes', type: 'text', what: 'The reader\'s own notes.' },
    ],
    href: (row, slug) => `/reading/${slug}/library/${row.id}`,
  },
  {
    key: 'cigars',
    app: 'cigar-lounge',
    table: 'cl_cigars',
    label: 'cigars',
    what: 'Cigars in the humidor or already smoked.',
    title: 'name',
    subtitle: 'brand',
    fields: [
      { column: 'name', type: 'text', what: 'What is on the band.' },
      { column: 'brand', type: 'text', what: 'The marque.' },
      { column: 'vitola', type: 'text', what: 'The shape — Robusto, Corona, Toro.' },
      { column: 'wrapper', type: 'text', what: 'Wrapper leaf or origin.' },
      { column: 'country', type: 'text', what: 'Country of origin.' },
      { column: 'status', type: 'enum', values: ['humidor', 'smoked'], what: 'Whether it is still in the humidor or has been smoked.' },
      { column: 'strength', type: 'enum', values: ['mild', 'medium', 'full'], what: 'Strength.' },
      { column: 'rating', type: 'number', what: 'The smoker\'s own score out of 10.' },
      { column: 'price_gbp', type: 'number', what: 'Price paid, in pounds.' },
      { column: 'ring_gauge', type: 'number', what: 'Ring gauge, in sixty-fourths of an inch.' },
      { column: 'quantity', type: 'number', what: 'How many are held.' },
      { column: 'date_acquired', type: 'date', what: 'When it was bought.' },
      { column: 'date_smoked', type: 'date', what: 'When it was smoked. Null means it has not been.' },
      { column: 'tasting_notes', type: 'text', what: 'Tasting notes.' },
      { column: 'pairing', type: 'text', what: 'What it was drunk with.' },
      { column: 'note', type: 'text', what: 'Any other note.' },
    ],
    href: (row, slug) => `/cigars/${slug}/cigar/${row.slug}`,
  },
  {
    key: 'albums',
    app: 'listening-party',
    table: 'lp_selections',
    label: 'albums',
    what: 'Albums picked, one a week.',
    title: 'album',
    subtitle: 'artist',
    fields: [
      { column: 'album', type: 'text', what: 'The album.' },
      { column: 'artist', type: 'text', what: 'The artist.' },
      { column: 'week', type: 'number', what: 'Which week of the season.' },
      { column: 'year_slot', type: 'number', what: 'The year the pick belongs to.' },
      { column: 'status', type: 'text', what: 'Where the pick has got to — upcoming, completed.' },
      { column: 'notes', type: 'text', what: 'What the person who picked it said about it.' },
    ],
    href: (row, slug) => `/lp/${slug}/pick/${row.id}`,
  },
  {
    key: 'broadcasts',
    app: 'wbpr',
    table: 'wbpr_broadcasts',
    label: 'broadcasts',
    what: 'Nights on air at the lookout station.',
    title: 'location',
    subtitle: 'date',
    fields: [
      { column: 'session', type: 'number', what: 'Session number, counting up from the first night.' },
      { column: 'date', type: 'date', what: 'The night it went out.' },
      { column: 'location', type: 'text', what: 'Where the station was.' },
      { column: 'atmospheric_conditions', type: 'text', what: 'The weather and the air that night.' },
      { column: 'veil_status', type: 'text', what: 'How the veil stood — Thin, Thick, Torn.' },
      { column: 'veil_intensity', type: 'number', what: 'How strongly, 1 to 10.' },
      { column: 'dawn_colour', type: 'text', what: 'The colour of the sky at close.' },
      { column: 'duration_minutes', type: 'number', what: 'How long the broadcast ran.' },
      { column: 'personal_notes', type: 'text', what: 'The DJ\'s own notes on the night.' },
    ],
    href: (row, slug) => `/wbpr/${slug}/broadcast/${row.id}`,
  },
];

const BY_KEY = new Map(SOURCES.map(s => [s.key, s]));

/** Which comparisons make sense for which kind of column. */
const OPS: Record<FieldType, readonly string[]> = {
  text: ['eq', 'neq', 'contains', 'is_null', 'not_null'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'],
  boolean: ['eq'],
  enum: ['eq', 'neq', 'is_null', 'not_null'],
};

export type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_null' | 'not_null';

export interface Condition {
  column: string;
  op: Op;
  value?: string | number | boolean | null;
}

export interface Plan {
  source: string;
  filters: Condition[];
  order?: { column: string; direction: 'asc' | 'desc' };
  limit: number;
}

/** The most a search may return. Beyond this it is a page, not an answer. */
export const MOST = 50;

/** The most conditions one question may turn into. */
const MOST_FILTERS = 6;

export type Checked =
  | { ok: true; plan: Plan; source: Source }
  | { ok: false; reason: string };

/**
 * The plan, checked against what exists.
 *
 * Every failure here is a refusal rather than a repair. A plan naming a column
 * that does not exist has misunderstood the question, and quietly dropping the
 * condition would answer a *different* question without saying so — which is
 * worse than saying no, because the results look right.
 */
export function checkPlan(raw: unknown): Checked {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'no plan' };
  const p = raw as Record<string, unknown>;

  const source = BY_KEY.get(String(p.source ?? ''));
  if (!source) return { ok: false, reason: `no such thing to search: ${String(p.source)}` };

  const fields = new Map(source.fields.map(f => [f.column, f]));

  // Absent means "no conditions", which is a real answer to "what have I read".
  // Present but not a list means the plan is malformed, and the two must not
  // collapse: treating a broken `filters` as an empty one turns a plan nobody
  // can read into a search for *everything*, which is the widest possible query
  // arrived at by accident.
  if (p.filters !== undefined && p.filters !== null && !Array.isArray(p.filters)) {
    return { ok: false, reason: 'the conditions were not a list' };
  }
  const rawFilters = Array.isArray(p.filters) ? p.filters : [];
  if (rawFilters.length > MOST_FILTERS) {
    return { ok: false, reason: 'too many conditions' };
  }

  const filters: Condition[] = [];
  for (const item of rawFilters) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'a condition was not an object' };
    const c = item as Record<string, unknown>;

    const field = fields.get(String(c.column ?? ''));
    if (!field) return { ok: false, reason: `${source.label} have no ${String(c.column)}` };

    const op = String(c.op ?? '') as Op;
    if (!OPS[field.type].includes(op)) {
      return { ok: false, reason: `cannot ask "${op}" of ${field.column}` };
    }

    if (op === 'is_null' || op === 'not_null') {
      filters.push({ column: field.column, op });
      continue;
    }

    const value = coerce(field, c.value);
    if (value === undefined) {
      return { ok: false, reason: `${JSON.stringify(c.value)} is not a ${field.type} ${field.column} can be compared to` };
    }
    filters.push({ column: field.column, op, value });
  }

  let order: Plan['order'];
  if (p.order && typeof p.order === 'object') {
    const o = p.order as Record<string, unknown>;
    const col = String(o.column ?? '');
    if (!fields.has(col)) return { ok: false, reason: `cannot order by ${col}` };
    order = { column: col, direction: o.direction === 'asc' ? 'asc' : 'desc' };
  }

  const asked = Number(p.limit);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(1, Math.trunc(asked)), MOST) : 20;

  return { ok: true, plan: { source: source.key, filters, order, limit }, source };
}

/**
 * A value the column can actually be compared to, or undefined.
 *
 * `undefined` rather than a coerced fallback, because there is no safe default:
 * turning an unparseable date into today would answer a question nobody asked.
 */
function coerce(field: Field, value: unknown): string | number | boolean | undefined {
  switch (field.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    case 'date': {
      const s = String(value ?? '');
      return ISO_DATE.test(s) ? s : undefined;
    }
    case 'enum': {
      const s = String(value ?? '');
      return field.values?.includes(s) ? s : undefined;
    }
    case 'text': {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      const s = String(value).trim();
      return s ? s.slice(0, 200) : undefined;
    }
  }
}

/**
 * The vocabulary, as the model is told it.
 *
 * Built from the same array the validator checks against, so the two cannot
 * drift into disagreeing — a model told about a column that is not in the
 * allowlist would produce plans that are refused for using exactly what it was
 * offered.
 */
export function vocabulary(): string {
  return SOURCES.map(s => {
    const fields = s.fields
      .map(f => {
        const kind = f.type === 'enum' ? `enum(${f.values!.join('|')})` : f.type;
        return `    ${f.column} ${kind} — ${f.what}`;
      })
      .join('\n');
    return `  ${s.key} — ${s.what}\n${fields}`;
  }).join('\n\n');
}

export const SEARCH_SYSTEM = `You turn a question about somebody's own records into a search plan. You answer with JSON and nothing else — no prose, no code fence, no explanation.

{
  "source": "books",
  "filters": [
    { "column": "date_finished", "op": "is_null" },
    { "column": "year_published", "op": "gte", "value": 1990 }
  ],
  "order": { "column": "date_started", "direction": "desc" },
  "limit": 20
}

WHAT CAN BE SEARCHED.

${vocabulary()}

RULES.

"source" is exactly one of the names above. Pick the one the question is about. If the question could mean two of them, pick the likelier and do not try to answer both.

"op" is one of: eq, neq, gt, gte, lt, lte, contains, is_null, not_null. "contains" is for text only and matches part of a value. "is_null" and "not_null" take no value — use them for "unfinished", "never smoked", "not yet rated". Text is matched case-insensitively.

Dates are "YYYY-MM-DD". A question about a year becomes two conditions, gte January the first and lte December the thirty-first — there is no year function.

Only the columns listed above exist. If the question needs one that is not there, get as close as the listed columns allow rather than inventing a name: a plan naming a column that does not exist is refused outright and the person gets nothing.

Do not filter by project, person, or owner. You cannot see whose records these are and you do not need to — the app only ever searches what the person asking is already allowed to read.

"limit" is at most ${MOST}. Use a small one for a question that wants a specific answer and a larger one for a question that wants a list.

Ask for as little as the question needs. A question with no conditions in it — "what have I read" — is a plan with an empty filters list, and that is a correct answer, not a failure.`;

/** The words a plan depends on, so the same question is not paid for twice. */
export function cacheKeyFor(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** One row, as a result card reads it. */
export interface Hit {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  project: string;
  app: AppSlug;
  /** The columns the question actually asked about, to show why this matched. */
  matched: { label: string; value: string }[];
}

/**
 * Run a checked plan.
 *
 * Through the caller's client and no other, which is the whole authorisation
 * story: `workspaces!inner` makes every row carry the project it belongs to,
 * and `workspaces_read` decides which of those projects the caller can see. A
 * row in somebody else's private lounge is not filtered out here — it never
 * arrives.
 */
export async function runPlan(
  supabase: Client,
  plan: Plan,
  source: Source
): Promise<{ hits: Hit[]; error?: string }> {
  const asked = new Set(plan.filters.map(f => f.column));
  const columns = new Set<string>(['id', source.title]);
  if (source.subtitle) columns.add(source.subtitle);
  // `slug` titles the URL for a cigar; harmless everywhere else and cheaper to
  // ask for always than to special-case.
  columns.add('slug');
  for (const c of asked) columns.add(c);
  if (plan.order) columns.add(plan.order.column);

  let query = supabase
    .from(source.table as 'rl_books')
    .select(`${[...columns].join(', ')}, workspaces!inner(name, slug, app)`)
    .limit(plan.limit);

  for (const f of plan.filters) {
    switch (f.op) {
      case 'eq':       query = query.eq(f.column, f.value as never); break;
      case 'neq':      query = query.neq(f.column, f.value as never); break;
      case 'gt':       query = query.gt(f.column, f.value as never); break;
      case 'gte':      query = query.gte(f.column, f.value as never); break;
      case 'lt':       query = query.lt(f.column, f.value as never); break;
      case 'lte':      query = query.lte(f.column, f.value as never); break;
      // The value is passed as a parameter rather than spliced into a filter
      // string, so a question containing a comma or a bracket is a question and
      // not a change of meaning.
      case 'contains': query = query.ilike(f.column, `%${f.value}%`); break;
      case 'is_null':  query = query.is(f.column, null); break;
      case 'not_null': query = query.not(f.column, 'is', null); break;
    }
  }

  if (plan.order) {
    query = query.order(plan.order.column, { ascending: plan.order.direction === 'asc' });
  }

  const { data, error } = await query;
  if (error) {
    console.error('search: could not run plan', { table: source.table, error });
    return { hits: [], error: 'That search could not be run.' };
  }

  const labels = new Map(source.fields.map(f => [f.column, f.what]));

  const hits = (data ?? []).map(raw => {
    const row = raw as unknown as Record<string, unknown>;
    const ws = (row.workspaces ?? {}) as { name?: string; slug?: string; app?: AppSlug };
    return {
      id: String(row.id),
      title: String(row[source.title] ?? '—'),
      subtitle: source.subtitle ? String(row[source.subtitle] ?? '') : '',
      href: source.href(row, String(ws.slug ?? '')),
      project: String(ws.name ?? ''),
      app: (ws.app ?? source.app) as AppSlug,
      matched: [...asked]
        .filter(c => c !== source.title && c !== source.subtitle)
        .map(c => ({ label: labels.get(c)?.replace(/\.$/, '') ?? c, value: show(row[c]) }))
        .filter(m => m.value !== ''),
    };
  });

  return { hits };
}

const show = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const s = String(value).trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

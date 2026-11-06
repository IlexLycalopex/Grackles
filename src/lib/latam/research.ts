/**
 * A deep dive on a place: what to know, notice and read before and while
 * being there.
 *
 * The rule is the reading lookup's: **the app decides facts, the model
 * supplies prose.** The model writes the briefing and proposes things to read,
 * watch and look up. Then the app checks each proposal against something that
 * knows: a book must be one OpenLibrary finds under that title and author, a
 * film or an article must be a page on English Wikipedia. Whatever fails the
 * check is dropped and counted, never shown with a caveat. A plausible book
 * that does not exist costs the reader an afternoon in a bookshop.
 *
 * The briefing itself cannot be checked that way, so the page labels it as
 * the model's.
 */

import { parseJsonObject } from '../json.ts';
import { lookupBook, readDoc, type Edition } from '../ai/openlibrary.ts';
import { looselyEqual, normalise } from '../title-match.ts';

export interface PlaceForResearch {
  name: string;
  kind: string;
  province: string;
  regionName: string;
}

export interface Brief {
  overview: string;
  history: string;
  culture: string;
  notice: string[];
  words: { es: string; en: string }[];
  fishing: string;
}

export interface Proposal {
  kind: 'book' | 'film' | 'article';
  title: string;
  creator: string;
  /** The English Wikipedia title the model gave, for a film or article. */
  wiki: string;
  why: string;
}

export interface Suggestion {
  kind: 'book' | 'film' | 'article';
  title: string;
  creator: string;
  url: string;
  why: string;
}

/** A proposal no catalogue could find, kept so the page can say what it was. */
export interface Rejected {
  kind: string;
  title: string;
  creator: string;
}

export interface Research {
  brief: Brief;
  proposals: Proposal[];
}

export const RESEARCH_SYSTEM = `You prepare a reader for a place in Argentina: what it is, how it came to be, what to notice there, and what to read and watch to understand it. The reader is an English speaker learning Argentine Spanish, interested in history, politics, literature, wine and fly fishing.

Answer with JSON and nothing else: no prose outside it, no code fence.

{
  "overview": "Two short paragraphs: what the place is and why it matters.",
  "history": "Two or three short paragraphs: the history that explains it, with dates where you are sure of them.",
  "culture": "One or two short paragraphs: people, food, music, language, festivals.",
  "notice": ["Up to eight things to look out for or do there, one sentence each."],
  "words": [{ "es": "a local word or phrase", "en": "what it means and when it is used" }],
  "fishing": "One paragraph on the fishing, or an empty string if there is none worth mentioning.",
  "books": [{ "title": "Exact published title", "author": "Author's name", "why": "One sentence on why it helps here." }],
  "films": [{ "title": "Title", "wiki": "Its exact English Wikipedia article title", "why": "One sentence." }],
  "articles": [{ "wiki": "An exact English Wikipedia article title", "why": "One sentence." }]
}

RULES.

You may be given SOURCE: the place's English Wikipedia article. Base the overview, history and culture on it. Do not state a date, name, number or institution that is not in SOURCE unless you are certain of it; leave it out instead. A short, correct briefing is the goal.

Write in English only, apart from the Spanish in "words" and proper names. Use the Latin alphabet only: never Chinese, Cyrillic or any other script.

British English, plain and specific. Up to eight books, five films, six articles, ten words.

Only real, published books and real films. Never invent a title to fill a list; three right answers are better than eight with one made up. Prefer books available in English; include a Spanish original when it is the key text. Every proposal is checked against a catalogue and anything that is not found is thrown away.

Never give an ISBN, a price, opening hours, a phone number, a rating, a prize or a quotation. Where you are unsure of a date or figure, leave it out rather than guess.

"words" are real Spanish words and phrases a visitor would actually hear in that place or region, including lunfardo or regional usage where it applies. Each "es" is a complete word or phrase, never a fragment. Leave the list short rather than pad it.`;

export function buildResearchTurn(place: PlaceForResearch, source = ''): string {
  const where = [place.province, place.regionName].filter(Boolean).join(', ');
  const head = `Place: ${place.name} (${place.kind}${where ? `, ${where}` : ''}, Argentina).`;
  return source ? `${head}\n\nSOURCE (English Wikipedia):\n${source}` : head;
}

/**
 * Anything that is not Latin script, punctuation, digits or accents. The first
 * live dive returned "el背后的 Welsh heritage": a model drifting mid-token
 * into another language. Spanish needs nothing outside Latin; neither does
 * English.
 */
const FOREIGN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/gu;
// Latin letters no Spanish or English word uses (Č, Ł, Ş...), which the same
// drift produced as "ČhepecČke".
const ODD_LATIN = /[ČčĆćŁłŞşŠšŽžĐđŘřĚěŮůŃńŚśŹźŻż]/g;

export const hasForeign = (s: string) => /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(s) || /[ČčĆćŁłŞşŠšŽžĐđŘřĚěŮůŃńŚśŹźŻż]/.test(s);

/** The text with foreign script removed and the spacing it leaves tidied. */
export const clean = (s: string) =>
  s.replace(FOREIGN, '').replace(ODD_LATIN, '').replace(/ {2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();

const text = (v: unknown, max: number) => (typeof v === 'string' ? clean(v).slice(0, max) : '');
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** The model's answer, bounded and typed, or null when it is not usable. */
export function readResearch(content: string): Research | null {
  const raw = parseJsonObject<Record<string, unknown>>(content);
  if (!raw) return null;
  const brief: Brief = {
    overview: text(raw.overview, 2000),
    history: text(raw.history, 3000),
    culture: text(raw.culture, 2000),
    notice: list(raw.notice).map(n => text(n, 300)).filter(Boolean).slice(0, 8),
    // A word with any foreign script in it is dropped whole, not cleaned: a
    // phrase with a hole in it teaches the wrong Spanish. So is a fragment
    // ending in a preposition or a comma, and one the model itself disowns.
    words: list(raw.words)
      .map(w => w as Record<string, unknown>)
      .filter(w => typeof w?.es === 'string' && typeof w?.en === 'string' && !hasForeign(w.es as string) && !hasForeign(w.en as string))
      .map(w => ({ es: text(w.es, 80), en: text(w.en, 200) }))
      .filter(w => w.es && w.en && !/(,|\b(de|del|la|el|en|a|y|con))$/i.test(w.es) && !/not a natural/i.test(w.en))
      .slice(0, 10),
    fishing: text(raw.fishing, 1500),
  };
  if (!brief.overview) return null;

  const proposals: Proposal[] = [
    ...list(raw.books).slice(0, 8).map(b => {
      const r = (b ?? {}) as Record<string, unknown>;
      return { kind: 'book' as const, title: text(r.title, 300), creator: text(r.author, 200), wiki: '', why: text(r.why, 400) };
    }),
    ...list(raw.films).slice(0, 5).map(f => {
      const r = (f ?? {}) as Record<string, unknown>;
      return { kind: 'film' as const, title: text(r.title, 300), creator: '', wiki: text(r.wiki, 300), why: text(r.why, 400) };
    }),
    ...list(raw.articles).slice(0, 6).map(a => {
      const r = (a ?? {}) as Record<string, unknown>;
      return { kind: 'article' as const, title: text(r.wiki, 300), creator: '', wiki: text(r.wiki, 300), why: text(r.why, 400) };
    }),
  ].filter(p => p.title);

  return { brief, proposals };
}

/** Fields the prompt forbids, if the model supplied them anyway. */
export function forbiddenFields(content: string): string[] {
  return ['isbn', 'price', 'rating'].filter(f => new RegExp(`"${f}"\\s*:`, 'i').test(content));
}

/** The author's surname, which is what catalogues agree on. */
const surname = (author: string) => normalise(author).split(' ').filter(Boolean).pop() ?? '';

/**
 * The edition OpenLibrary agrees is this title by this author, if any. The
 * title must match; the author need only share a surname, because "E. Lucas
 * Bridges" and "Lucas Bridges" are one man and a catalogue writes him either way.
 */
export function matchingEdition(candidates: Edition[], title: string, author: string): Edition | null {
  const t = normalise(title);
  const last = surname(author);
  return (
    candidates.find(
      c => looselyEqual(normalise(c.title), t) && (!last || normalise(c.author).split(' ').includes(last))
    ) ?? null
  );
}

/** "Zama (film)" and "Zama" are one title; "Neil Gaiman" and "Gaiman" are not. */
const bare = (title: string) => normalise(title.replace(/\s*\([^)]*\)\s*$/, ''));

interface WikiPage {
  title: string;
  description: string;
  url: string;
}

const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

async function wikiPage(title: string, fetcher: typeof fetch): Promise<WikiPage | null> {
  if (!title) return null;
  try {
    const res = await fetcher(WIKI + encodeURIComponent(title.replace(/ /g, '_')), {
      headers: { Accept: 'application/json', 'User-Agent': 'Grackles/1.0 (https://grackles.co.uk)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const page = (await res.json()) as {
      type?: string;
      title?: string;
      description?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    if (page.type !== 'standard' || !page.content_urls?.desktop?.page) return null;
    // Wikipedia follows redirects. "Welsh immigration to Argentina" landing on
    // "Welsh settlement in Argentina" is the same subject; "Gaiman" landing on
    // Neil Gaiman is not. A page reached under another title is kept only if
    // it is plainly about Argentina.
    const sameTitle = looselyEqual(bare(page.title ?? ''), bare(title));
    const aboutHere = /argentin|patagoni/i.test(`${page.description ?? ''} ${page.extract ?? ''}`);
    if (!sameTitle && !aboutHere) return null;
    return { title: page.title ?? title, description: page.description ?? '', url: page.content_urls.desktop.page };
  } catch {
    return null;
  }
}

/**
 * Keeps the proposals something outside the model can vouch for.
 *
 * A book needs an OpenLibrary edition matching title and author, and takes its
 * link from there. A film needs a Wikipedia page describing it as a film; an
 * article needs any ordinary Wikipedia page (not a disambiguation page).
 */
export async function verify(
  proposals: Proposal[],
  fetcher: typeof fetch = fetch,
  findBook: typeof lookupBook = lookupBook
): Promise<{ kept: Suggestion[]; dropped: number; rejected: Rejected[] }> {
  const checked = await Promise.all(
    proposals.map(async (p): Promise<Suggestion | null> => {
      if (p.kind === 'book') {
        let found = await findBook(p.title, p.creator);
        let edition = found.ok ? matchingEdition(found.candidates, p.title, p.creator) : null;
        // A catalogue that files the author differently finds nothing by name;
        // the title alone, checked against the surname, often does.
        if (!edition && p.creator) {
          found = await findBook(p.title, '');
          edition = found.ok ? matchingEdition(found.candidates, p.title, p.creator) : null;
        }
        return edition
          ? { kind: 'book', title: edition.title, creator: edition.author || p.creator, url: edition.link_openlibrary, why: p.why }
          : null;
      }
      const page = await wikiPage(p.wiki || p.title, fetcher);
      if (!page) return null;
      if (p.kind === 'film' && !/\bfilm\b/i.test(page.description)) return null;
      return { kind: p.kind, title: p.kind === 'film' ? p.title : page.title, creator: '', url: page.url, why: p.why };
    })
  );
  const rejected: Rejected[] = proposals
    .filter((_, i) => !checked[i])
    .map(p => ({ kind: p.kind, title: p.title, creator: p.creator }));
  const seen = new Set<string>();
  const kept = checked.filter((s): s is Suggestion => {
    if (!s) return false;
    const key = `${s.kind}|${normalise(s.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { kept, dropped: proposals.length - kept.length, rejected };
}

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

/**
 * The place's English Wikipedia article as plain text, for the model to work
 * from. Found by search rather than by title, because "Gaiman" the title is
 * Neil Gaiman. The page must mention Argentina, which is what stops a search
 * for Trevelin landing on a Cornish surname.
 */
export async function placeSource(
  name: string,
  province: string,
  fetcher: typeof fetch = fetch,
  maxChars = 7000
): Promise<{ title: string; url: string; text: string } | null> {
  const get = async (params: Record<string, string>) => {
    const res = await fetcher(`${WIKI_API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Grackles/1.0 (https://grackles.co.uk)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
    return res.json();
  };
  try {
    // Search first, then fetch one article: Wikipedia returns a whole
    // article's text for only one page per request, so asking for three at
    // once gave text for whichever it chose, not the best match.
    const found = (await get({
      action: 'query',
      list: 'search',
      srsearch: [name, province, 'Argentina'].filter(Boolean).join(' '),
      srlimit: '5',
      srprop: '',
    })) as { query?: { search?: { title: string }[] } };
    const first = normalise(name).split(' ')[0] ?? '';
    const titles = (found.query?.search ?? []).map(r => r.title).filter(t => normalise(t).includes(first));

    for (const title of titles.slice(0, 2)) {
      const page = (await get({
        action: 'query',
        prop: 'extracts|info',
        inprop: 'url',
        explaintext: '1',
        redirects: '1',
        titles: title,
      })) as { query?: { pages?: { title: string; extract?: string; fullurl?: string }[] } };
      const p = page.query?.pages?.[0];
      if (!p?.extract || !/argentin/i.test(p.extract)) continue;
      const body = p.extract
        .split(/\n==+\s*(See also|References|External links|Notes|Further reading|Bibliography)\s*==+/)[0]!
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { title: p.title, url: p.fullurl ?? '', text: body.slice(0, maxChars) };
    }
    console.warn('lx research: no Wikipedia article', { name, province, titles });
    return null;
  } catch (e) {
    console.warn('lx research: Wikipedia failed', { name, error: String(e).slice(0, 200) });
    return null;
  }
}

const OL_SEARCH = 'https://openlibrary.org/search.json';

/**
 * Books the catalogue itself files under the place, found without the model.
 *
 * The model's book suggestions are mostly titles it half-remembers, and for a
 * small town most of them are not real. OpenLibrary searched for the place
 * does better: whatever it returns exists. A result is kept only if the place's
 * name is in its title or subject headings.
 */
export async function catalogueBooks(
  name: string,
  context: string,
  fetcher: typeof fetch = fetch,
  limit = 4
): Promise<Suggestion[]> {
  const first = normalise(name).split(' ')[0] ?? '';
  if (!first) return [];
  const params = new URLSearchParams({
    q: [name, context].filter(Boolean).join(' '),
    limit: '12',
    fields: 'key,title,author_name,first_publish_year,subject',
  });
  try {
    const res = await fetcher(`${OL_SEARCH}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Grackles/0.1 (https://grackles.co.uk)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const docs = ((await res.json()) as { docs?: Record<string, unknown>[] }).docs ?? [];
    return docs
      .map(readDoc)
      .filter(e => e.title && e.author && !hasForeign(e.title))
      .filter(e => [e.title, ...e.subjects].some(t => normalise(t).split(' ').includes(first)))
      .slice(0, limit)
      .map(e => ({
        kind: 'book' as const,
        title: e.title,
        creator: e.author,
        url: e.link_openlibrary,
        why: `Filed under ${name} in OpenLibrary${e.year_published ? `; first published ${e.year_published}` : ''}.`,
      }));
  } catch {
    return [];
  }
}

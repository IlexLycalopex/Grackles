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
import { lookupBook, type Edition } from '../ai/openlibrary.ts';
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

British English, plain and specific. Up to eight books, five films, six articles, ten words.

Only real, published books and real films. Never invent a title to fill a list; three right answers are better than eight with one made up. Prefer books available in English; include a Spanish original when it is the key text. Every proposal is checked against a catalogue and anything that is not found is thrown away.

Never give an ISBN, a price, opening hours, a phone number, a rating, a prize or a quotation. Where you are unsure of a date or figure, leave it out rather than guess.

"words" are words and phrases a visitor would actually hear in that place or region, including lunfardo or regional usage where it applies.`;

export function buildResearchTurn(place: PlaceForResearch): string {
  const where = [place.province, place.regionName].filter(Boolean).join(', ');
  return `Place: ${place.name} (${place.kind}${where ? `, ${where}` : ''}, Argentina).`;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
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
    words: list(raw.words)
      .map(w => ({ es: text((w as Record<string, unknown>)?.es, 80), en: text((w as Record<string, unknown>)?.en, 200) }))
      .filter(w => w.es && w.en)
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

/** The edition OpenLibrary agrees is this title by this author, if any. */
export function matchingEdition(candidates: Edition[], title: string, author: string): Edition | null {
  const t = normalise(title);
  const a = normalise(author);
  return (
    candidates.find(c => looselyEqual(normalise(c.title), t) && (!a || looselyEqual(normalise(c.author), a))) ?? null
  );
}

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
      content_urls?: { desktop?: { page?: string } };
    };
    if (page.type !== 'standard' || !page.content_urls?.desktop?.page) return null;
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
): Promise<{ kept: Suggestion[]; dropped: number }> {
  const checked = await Promise.all(
    proposals.map(async (p): Promise<Suggestion | null> => {
      if (p.kind === 'book') {
        const found = await findBook(p.title, p.creator);
        const edition = found.ok ? matchingEdition(found.candidates, p.title, p.creator) : null;
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
  const seen = new Set<string>();
  const kept = checked.filter((s): s is Suggestion => {
    if (!s) return false;
    const key = `${s.kind}|${normalise(s.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { kept, dropped: proposals.length - kept.length };
}

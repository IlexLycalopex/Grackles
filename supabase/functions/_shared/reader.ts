// Lecturas: Spanish articles from Argentine sources, graded for a learner.
//
// Shared by the latam-reader-fetch Edge Function (Deno) and the site (Node),
// so it uses only fetch and plain TypeScript.
//
// The level is measured, not guessed. Two things predict whether a learner can
// read a text: how many of its words are among the commonest few thousand
// (coverage), and how long its words and sentences are (the Szigriszt-Pazos
// readability index, INFLESZ, the Spanish adaptation of Flesch). Both are
// computed here from the text; no model is asked what level something is.

// The frequency list is passed in rather than imported: the site's tests use
// the copy in es-frequent.ts, and the Edge Function fetches the same list from
// its source at run time (FREQUENCY_SOURCE), which keeps a 40 KB table out of
// every deploy.
export const FREQUENCY_SOURCE =
  'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/es/es_50k.txt';

/** The commonest alphabetic forms from a FrequencyWords list, most common first. */
export function parseFrequencyList(text: string, limit = 5000): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const w = line.split(' ')[0]?.trim() ?? '';
    if (/^\p{L}+$/u.test(w)) out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

export type Rank = Map<string, number>;
export const rankFrom = (words: readonly string[]): Rank => new Map(words.map((w, i) => [w, i]));

// ── Sources ─────────────────────────────────────────────────────────

export const TOPICS = ['travel', 'mountains', 'fishing', 'books', 'culture', 'drink', 'food'] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS: Record<Topic, string> = {
  travel: 'Travel',
  mountains: 'Mountains and climbing',
  fishing: 'Fly fishing',
  books: 'Books',
  culture: 'Film and music',
  drink: 'Wine, beer and whisky',
  food: 'Food',
};

export interface Feed {
  url: string;
  source: string;
  /** The topic everything in this feed starts as; keywords can move it. */
  topic: Topic;
  /** Keep only items whose title matches, for broad feeds. */
  titleFilter?: RegExp;
}

const bing = (q: string) =>
  `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=es&cc=AR`;

// Each one checked on 6 November 2026 to answer with items.
export const FEEDS: Feed[] = [
  { url: 'https://www.clarin.com/rss/viajes/', source: 'Clarín', topic: 'travel' },
  { url: 'https://www.clarin.com/rss/cultura/', source: 'Clarín', topic: 'culture' },
  { url: 'https://www.clarin.com/rss/gourmet/', source: 'Clarín', topic: 'food' },
  { url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/turismo/?outputType=xml', source: 'La Nación', topic: 'travel' },
  { url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/cultura/?outputType=xml', source: 'La Nación', topic: 'culture' },
  { url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/turismo/', source: 'Infobae', topic: 'travel' },
  { url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/cultura/', source: 'Infobae', topic: 'culture' },
  {
    url: 'https://www.rionegro.com.ar/feed/',
    source: 'Río Negro',
    topic: 'travel',
    titleFilter: /turis|viaj|lago|cerro|montañ|pesca|trucha|parque|sender|vino|cerveza|libro|escrit/i,
  },
  { url: bing('pesca con mosca Patagonia'), source: 'Bing News', topic: 'fishing' },
  { url: bing('pesca de truchas Argentina'), source: 'Bing News', topic: 'fishing' },
  { url: bing('andinismo Argentina'), source: 'Bing News', topic: 'mountains' },
  { url: bing('escalada Patagonia'), source: 'Bing News', topic: 'mountains' },
  { url: bing('trekking Patagonia'), source: 'Bing News', topic: 'mountains' },
  { url: bing('vino argentino bodega'), source: 'Bing News', topic: 'drink' },
  { url: bing('cerveza artesanal Argentina'), source: 'Bing News', topic: 'drink' },
  { url: bing('whisky argentino'), source: 'Bing News', topic: 'drink' },
  { url: bing('libro escritor argentino'), source: 'Bing News', topic: 'books' },
];

// A topic's own words override the feed's: a Clarín travel piece about a
// winery is wine.
const TOPIC_WORDS: [Topic, RegExp][] = [
  ['fishing', /pesca con mosca|truchas?\b|pescador|mosquer/i],
  ['mountains', /andinis|escalad|alpinis|montañis|trekking|cumbre|aconcagua|fitz ?roy/i],
  ['drink', /\bvinos?\b|bodegas?\b|malbec|torront|cervez|whisk|destiler|sommelier/i],
  ['books', /\blibros?\b|novela|escritor|escritora|poes[ií]a|editorial/i],
  ['culture', /pel[ií]cula|cine\b|serie\b|m[uú]sic|disco\b|banda\b|teatro/i],
];

export function topicFor(feedTopic: Topic, title: string): Topic {
  for (const [topic, re] of TOPIC_WORDS) if (re.test(title)) return topic;
  return feedTopic;
}

// "Safe" means none of the subjects that make a learner's reading list grim:
// crime, death, disaster, politics, conflict. ("Escalada de tensión" came in
// through the climbing search on the first live run.) Judged on the title, where those always
// announce themselves; a false positive costs one article.
const UNSAFE =
  /asesin|homicid|crimen|criminal|muert|muri[óo]|fallec|v[ií]ctima|violen|abus|viola(ci|d)|narco|secuestr|robo|tiroteo|disparo|accidente|tragedia|choque|incendio|inundaci|terremoto|guerra|ataque|atentad|polic[ií]a|detenid|juicio|condena|preso|c[aá]rcel|milei|kirchner|macri|elecci|congreso|senado|diputad|gobierno|ministr|presidente|d[oó]lar|inflaci|impuesto|huelga|paro\b|protesta|piquete|c[aá]ncer|enfermedad|virus|hospital|tensi[oó]n|conflicto|desalojo|reclam|nazi|hitler|dictadur|holocaust|deportes?\b|f[uú]tbol|mundial\b/i;

export const isSafeTitle = (title: string) => !UNSAFE.test(title);

// ── RSS ─────────────────────────────────────────────────────────────

export interface FeedItem {
  url: string;
  title: string;
  published: string | null;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (e[0] !== '#') return map[e.toLowerCase()]!;
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    })
    .trim();

const tag = (item: string, name: string) => {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]!) : '';
};

/** Bing wraps each link in a click-tracker; the article is its url parameter. */
export function unwrapLink(link: string): string {
  try {
    const u = new URL(link);
    if (u.hostname.endsWith('bing.com') && u.searchParams.get('url')) return u.searchParams.get('url')!;
  } catch {
    // Not a URL; the caller drops it.
  }
  return link;
}

export function parseFeed(xml: string): FeedItem[] {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)]
    .map(m => {
      const item = m[0];
      const url = unwrapLink(tag(item, 'link'));
      const date = tag(item, 'pubDate');
      const parsed = date ? new Date(date) : null;
      return {
        url,
        title: tag(item, 'title').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 300),
        published: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      };
    })
    .filter(i => /^https?:\/\//.test(i.url) && i.title);
}

// ── Article text ────────────────────────────────────────────────────

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const unentity = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
    }
    return ENT[e.toLowerCase()] ?? m;
  });

/**
 * The body of a news article: its paragraphs, in order, without the menus,
 * captions and "read more" lines around them. Paragraphs under eight words
 * are dropped, which is what removes most of the furniture.
 */
export function articleText(html: string): string {
  const fromParagraphs = paragraphs(html);
  return fromParagraphs.length >= 400 ? fromParagraphs : arcText(html) || fromParagraphs;
}

function paragraphs(html: string): string {
  const scope = html.match(/<article[\s\S]*<\/article>/i)?.[0] ?? html;
  return [...scope.replace(/<(script|style|noscript|figure|aside|nav)[\s\S]*?<\/\1>/gi, ' ').matchAll(/<p[\s>][\s\S]*?<\/p>/gi)]
    .map(m => unentity(m[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(p => p.split(' ').length >= 8)
    .join('\n\n');
}

/**
 * Sites on the Arc publishing platform (La Nación among them) can send the
 * article as data for a script to render, with no paragraphs in the HTML.
 * The text elements are still in the page, as JSON strings.
 */
function arcText(html: string): string {
  const parts: string[] = [];
  // Either order (La Nación writes "content" before "type"), and either plain
  // JSON or JSON escaped inside a script string, where every quote is \".
  const q = '\\\\?"';
  const body = '(.*?)';
  const re = new RegExp(
    `${q}type${q}:${q}text${q},${q}content${q}:${q}${body}${q}[,}]|${q}content${q}:${q}${body}${q},${q}type${q}:${q}text${q}`,
    'g'
  );
  for (const m of html.matchAll(re)) {
    let inner = m[1] ?? m[2] ?? '';
    // One JSON unescape per level of nesting, at most two.
    for (let i = 0; i < 2 && /\\["\\/u]/.test(inner); i++) {
      try {
        inner = JSON.parse(`"${inner}"`) as string;
      } catch {
        break;
      }
    }
    const text = unentity(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.split(' ').length >= 8) parts.push(text);
  }
  return [...new Set(parts)].join('\n\n');
}

// ── Grading ─────────────────────────────────────────────────────────

/** Word tokens, lower-cased, with names (capitalised mid-sentence) left out. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?¿¡:;])\s+|\n+/)) {
    const words = sentence.match(/\p{L}+/gu) ?? [];
    words.forEach((w, i) => {
      if (i > 0 && /^\p{Lu}/u.test(w)) return; // a name, not vocabulary
      out.push(w.toLowerCase());
    });
  }
  return out;
}

const STRONG = 'aeoáéíóú';
const VOWEL = /[aeiouáéíóúü]/;

/** Syllables in a Spanish word: vowel groups, with hiatus between strong vowels. */
export function syllables(word: string): number {
  const w = word.toLowerCase();
  let count = 0;
  let prev = '';
  for (const ch of w) {
    if (VOWEL.test(ch)) {
      if (!prev || (STRONG.includes(ch) && STRONG.includes(prev))) count++;
      prev = ch;
    } else prev = '';
  }
  return Math.max(1, count);
}

export interface Grade {
  words: number;
  /** INFLESZ: 80+ very easy, 65–80 fairly easy, 55–65 normal, 40–55 fairly hard. */
  inflesz: number;
  /** Share of word tokens among the 1,000 / 2,000 / 5,000 commonest forms. */
  cov1k: number;
  cov2k: number;
  cov5k: number;
  level: 'A2' | 'B1' | 'B2' | 'C1';
}

export function grade(text: string, rank: Rank): Grade | null {
  const all = text.match(/\p{L}+/gu) ?? [];
  // Too short to judge, or a listing rather than an article.
  if (all.length < 150 || all.length > 4000) return null;
  // Paragraphs are a floor on sentences: a piece written without full stops
  // (one on the first live run) would otherwise be one 400-word sentence.
  const paras = text.split(/\n{2,}/).filter(p => p.trim()).length;
  const sentences = Math.max(1, paras, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syl = all.reduce((s, w) => s + syllables(w), 0);
  const inflesz = 206.835 - 62.3 * (syl / all.length) - all.length / sentences;

  const vocab = tokens(text);
  const within = (n: number) => vocab.filter(w => (rank.get(w) ?? Infinity) < n).length / Math.max(1, vocab.length);
  const cov1k = within(1000);
  const cov2k = within(2000);
  const cov5k = within(5000);

  // Coverage first, because a learner stalls on unknown words before long
  // sentences. The bands are set against Argentine press as it is: the first
  // live run of 45 articles had five-thousand-word coverage between 0.67 and
  // 0.86, so a band drawn for graded readers (0.93 and up) would call every
  // one of them C1. These are relative to native journalism, not to a
  // textbook; the reading page's "too easy / about right / too hard" marks
  // show where they sit for one reader.
  const level =
    cov5k >= 0.88 && inflesz >= 65 ? 'A2' : cov5k >= 0.82 && inflesz >= 50 ? 'B1' : cov5k >= 0.76 ? 'B2' : 'C1';

  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { words: all.length, inflesz: Math.round(inflesz * 10) / 10, cov1k: r(cov1k), cov2k: r(cov2k), cov5k: r(cov5k), level };
}

/** Minutes at a learner's pace: 120 words a minute. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 120));

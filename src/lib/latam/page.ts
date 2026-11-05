/**
 * What a shared link is, read from the page itself.
 *
 * The capture endpoint fetches a link that arrives with a reading entry and
 * hands lx_capture() three facts: whether it is an article or a book, its
 * title, and roughly how many words it holds. The database decides what to do
 * with them; this file only reads them, and never throws — a page it cannot
 * read is simply no page.
 */

export interface PageFacts {
  kind: 'article' | 'book';
  title: string;
  words: number;
}

/**
 * Sites whose pages are books, not things to be read in a sitting. A link to
 * one of these is matched against the Reading List by its title instead of
 * being timed as an article.
 */
const BOOK_HOSTS = [
  'goodreads.com',
  'openlibrary.org',
  'thestorygraph.com',
  'librarything.com',
  'books.google.com',
  'bookshop.org',
  'uk.bookshop.org',
  'penguin.co.uk',
  'penguinrandomhouse.com',
];

/**
 * Whether a URL may be fetched by the server. https or http to a named host,
 * nothing local and no bare IP address: the endpoint fetches what a phone
 * sends, and a server that fetches anything it is told is a way into the
 * network it sits on.
 */
export function isFetchable(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return null;
  }
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  return url;
}

export function isBookHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return BOOK_HOSTS.some(b => h === b || h.endsWith(`.${b}`));
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function meta(html: string, property: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
    'i'
  );
  const m = html.match(re);
  return decode((m?.[1] ?? m?.[2] ?? '').trim());
}

/** Words of running text, with scripts, styles and markup taken out. */
export function wordCount(html: string): number {
  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decode(body).split(/\s+/).filter(w => /\p{L}/u.test(w)).length;
}

export function readPage(url: URL, html: string): PageFacts {
  const title =
    meta(html, 'og:title') || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()) || url.hostname;
  const type = meta(html, 'og:type').toLowerCase();
  const kind = isBookHost(url.hostname) || type === 'book' || type === 'books.book' ? 'book' : 'article';
  return { kind, title: title.replace(/\s+/g, ' ').slice(0, 300), words: kind === 'article' ? wordCount(html) : 0 };
}

/**
 * Fetch and read a page, within a time and size budget. Any failure — a
 * timeout, a 404, a PDF, a page bigger than two megabytes — is null, and the
 * entry is saved without page facts.
 */
export async function fetchPage(raw: string, timeoutMs = 4000): Promise<PageFacts | null> {
  const url = isFetchable(raw);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'User-Agent': 'Grackles-LatAm/1.0 (+https://grackles.co.uk)', Accept: 'text/html' },
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null;
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > 2_000_000) return null;
    const html = (await res.text()).slice(0, 2_000_000);
    return readPage(new URL(res.url || url.href), html);
  } catch {
    return null;
  }
}

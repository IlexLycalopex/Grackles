// Instapaper's full API, and deciding what an article finished there counts as.
//
// Shared by the latam-instapaper-sync Edge Function (Deno) and its tests
// (Node), so it uses only what both have: fetch and WebCrypto.
//
// The full API is OAuth 1.0a with xAuth: a consumer key and secret that
// Instapaper issues on request, exchanged with the account's username and
// password for an access token. Every request is signed with HMAC-SHA1.
//
// What counts: an article read to at least nine tenths (archiving alone does
// not count; archiving is often clearing the queue) that is either in Spanish
// or about Argentina. Everything else in the account is ignored, so a reading
// habit that has nothing to do with this project never shows up in it.

export const API = 'https://www.instapaper.com/api/1';

export const READ_THRESHOLD = 0.9;
// Words a minute: English at an ordinary pace, Spanish at a learner's.
export const WPM = { en: 200, es: 120 } as const;

// ── OAuth 1.0a ──────────────────────────────────────────────────────

/** RFC 3986 percent-encoding, which encodeURIComponent nearly is. */
export const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface Credentials {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
}

/** The signature base string: method, URL and every parameter, sorted. */
export function baseString(method: string, url: string, params: Record<string, string>): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), pct(url), pct(pairs)].join('&');
}

async function hmacSha1(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sign(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: Credentials,
  nonce = crypto.randomUUID().replace(/-/g, ''),
  timestamp = Math.floor(Date.now() / 1000).toString()
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
    ...(creds.token ? { oauth_token: creds.token } : {}),
  };
  const key = `${pct(creds.consumerSecret)}&${pct(creds.tokenSecret ?? '')}`;
  oauth.oauth_signature = await hmacSha1(key, baseString(method, url, { ...params, ...oauth }));
  return (
    'OAuth ' +
    Object.entries(oauth)
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(', ')
  );
}

/** One signed POST to the API, form-encoded, as every endpoint takes. */
export async function call(
  path: string,
  params: Record<string, string>,
  creds: Credentials,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  const url = `${API}${path}`;
  return fetcher(url, {
    method: 'POST',
    headers: {
      Authorization: await sign('POST', url, params, creds),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
}

/** xAuth: the account's login exchanged for a token. */
export async function accessToken(
  creds: Credentials,
  username: string,
  password: string,
  fetcher: typeof fetch = fetch
): Promise<Credentials> {
  const res = await call(
    '/oauth/access_token',
    { x_auth_username: username, x_auth_password: password, x_auth_mode: 'client_auth' },
    creds,
    fetcher
  );
  if (!res.ok) throw new Error(`Instapaper sign-in answered ${res.status}`);
  const form = new URLSearchParams(await res.text());
  const token = form.get('oauth_token');
  const tokenSecret = form.get('oauth_token_secret');
  if (!token || !tokenSecret) throw new Error('Instapaper sign-in returned no token');
  return { ...creds, token, tokenSecret };
}

// ── Bookmarks ───────────────────────────────────────────────────────

export interface Bookmark {
  bookmark_id: number;
  url: string;
  title: string;
  progress: number;
  progress_timestamp: number;
  time: number;
}

/** The bookmarks in a list response, which also carries user and meta rows. */
export function readBookmarks(json: unknown): Bookmark[] {
  const rows = Array.isArray(json)
    ? json
    : Array.isArray((json as { bookmarks?: unknown[] })?.bookmarks)
      ? (json as { bookmarks: unknown[] }).bookmarks
      : [];
  return rows
    .filter(r => (r as { type?: string })?.type === 'bookmark')
    .map(r => {
      const b = r as Record<string, unknown>;
      return {
        bookmark_id: Number(b.bookmark_id),
        url: String(b.url ?? ''),
        title: String(b.title ?? ''),
        progress: Number(b.progress ?? 0),
        progress_timestamp: Number(b.progress_timestamp ?? 0),
        time: Number(b.time ?? 0),
      };
    })
    .filter(b => Number.isFinite(b.bookmark_id) && b.bookmark_id > 0);
}

export const isRead = (b: Bookmark) => b.progress >= READ_THRESHOLD;

// ── What an article is ──────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The words of an article's HTML: no tags, no scripts, entities decoded. */
export function textOf(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

const ES = new Set(['el', 'la', 'los', 'las', 'que', 'de', 'del', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'es', 'se', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'fue', 'este', 'ha', 'sí', 'porque', 'esta', 'son', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'también', 'me', 'hasta', 'hay', 'donde', 'desde', 'todo', 'nos', 'durante', 'uno', 'ni', 'contra', 'otros', 'ese', 'eso', 'ante', 'ellos', 'e', 'esto', 'mí', 'antes', 'algunos', 'qué', 'unos', 'yo', 'otro', 'otras', 'otra', 'él', 'tanto', 'esa', 'estos', 'mucho', 'quienes', 'nada', 'muchos', 'cual', 'poco', 'ella', 'estar', 'estas', 'algunas', 'algo', 'nosotros']);
const EN = new Set(['the', 'of', 'and', 'to', 'in', 'is', 'that', 'it', 'was', 'for', 'on', 'are', 'as', 'with', 'his', 'they', 'at', 'be', 'this', 'have', 'from', 'or', 'had', 'by', 'but', 'what', 'some', 'we', 'can', 'out', 'other', 'were', 'all', 'there', 'when', 'up', 'use', 'your', 'how', 'said', 'an', 'each', 'she', 'which', 'do', 'their', 'if', 'will', 'about', 'many', 'then', 'them', 'these', 'so', 'would', 'has', 'her', 'him', 'been', 'who', 'its', 'now', 'than', 'more', 'not', 'you', 'he', 'i']);

/**
 * Spanish or English, by which language's commonest words the text uses more.
 * Crude, and right for whole articles, where the margin is wide; "other" when
 * neither is clearly ahead.
 */
export function language(text: string): 'es' | 'en' | 'other' {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).slice(0, 3000);
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES.has(w)) es++;
    if (EN.has(w)) en++;
  }
  if (es + en < 20) return 'other';
  if (es > en * 1.5) return 'es';
  if (en > es * 1.5) return 'en';
  return 'other';
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

export interface PlaceName {
  slug: string;
  name: string;
}

/**
 * The tags an article earns: `spanish` for Spanish, the focus tag when it is
 * about Argentina, and the slug of every place it names. A place counts when
 * its name (accents ignored) appears as whole words; a region's long name is
 * matched on its first part ("Patagonia", not "Patagonia and the Andes").
 */
export function tagsFor(
  text: string,
  title: string,
  lang: 'es' | 'en' | 'other',
  places: PlaceName[],
  focus: string
): string[] {
  const hay = ` ${fold(`${title} ${text}`).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const tags = new Set<string>();
  if (lang === 'es') tags.add('spanish');
  if (/ argentin| patagoni| buenos aires /.test(hay)) tags.add(focus);
  for (const p of places) {
    const name = fold(p.name.split(/ and | \/ |,/)[0]!).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (name.length >= 4 && hay.includes(` ${name} `)) {
      tags.add(p.slug);
      tags.add(focus);
    }
  }
  return [...tags];
}

/** Estimated minutes for a read article, at a pace for its language. */
export const minutesFor = (words: number, lang: 'es' | 'en' | 'other') =>
  Math.min(300, Math.max(1, Math.round(words / (lang === 'es' ? WPM.es : WPM.en))));

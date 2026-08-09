import type { SelectionValues } from './records/selection';

/**
 * Finding a cover for a week's pick.
 *
 * This is the piece the migration dropped. In the old repo a pick was a YAML
 * entry, and a build step filled in `artwork_url` for any entry that had an
 * album and an artist but no image — iTunes first, the album's Wikipedia
 * article when iTunes had nothing. Every cover in the imported data came from
 * that step, which is why 32 of the 33 completed picks arrived with one and the
 * first pick added *here* did not: the form kept the field, the placeholder
 * kept promising it would be filled in automatically, and nothing was left to
 * do the filling. Deploying from a repo was never what made it work; a build
 * step running on every commit was, and there are no commits any more.
 *
 * So the lookup moves to the write. A pick is saved, and if it names an album
 * and an artist and carries no artwork, this asks — once, on the request that
 * saved it, before the row is written.
 *
 * Two rules keep that from being a bad trade:
 *
 * - **A lookup never fails a save.** Everything here returns `''` when it
 *   cannot answer, and the caller writes the row regardless. A cover is worth
 *   a second of somebody's save; it is not worth losing what they typed
 *   because Apple was slow.
 * - **A wrong cover is worse than none.** iTunes answers every query with
 *   *something*, so a result is only accepted when the album and the artist
 *   both look like what was asked for. An unmatched pick keeps its empty field,
 *   which is also how it gets asked again — clearing the field is the retry,
 *   exactly as it was in the YAML.
 */

/** Apple's public search endpoint. No key, no account, generous enough to use. */
const ITUNES_SEARCH = 'https://itunes.apple.com/search';

/**
 * The ceiling on how long a save waits for a cover.
 *
 * Both lookups can run in sequence, so the worst case is twice this. That is
 * the number to keep an eye on: it lands on a person watching a form, not on a
 * background job.
 */
const LOOKUP_TIMEOUT_MS = 4000;

/**
 * Wikimedia asks that API clients identify themselves and rate-limits the ones
 * that do not. Sent to Apple too — it costs nothing and makes the traffic
 * legible from the other end.
 */
const USER_AGENT = 'Grackles/1.0 (+https://grackles.co.uk)';

/**
 * Down to letters and digits, so punctuation and accents cannot decide a match.
 *
 * `NFD` splits an accented letter into a letter and a combining mark and the
 * range strips the mark, which is what makes *Björk* and *Bjork* the same
 * string. The ellipsis in "…Grace the Corner of Our Rooms…" goes the same way.
 */
function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Drops the qualifier a store puts on a title: "(Deluxe Edition)",
 * "[Remastered]", "- 2011 Remaster". The pressing is not the album, and a
 * catalogue rarely holds the one somebody typed.
 */
function stripEdition(title: string): string {
  return title
    .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/g, '')
    .replace(/\s+-\s+[^-]*\b(remaster(ed)?|edition|version|reissue|anniversary)\b.*$/i, '')
    .trim();
}

/**
 * Equal, or one a prefix of the other and not by a landslide.
 *
 * The prefix half is what accepts a catalogue's truncated title against a full
 * one. The length guard is what stops "live" matching "live at leeds" — a
 * prefix that throws away more than half the longer string is not the same
 * record, it is a different one that happens to start the same way.
 */
function looselyEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && shorter.length * 2 >= longer.length;
}

/** One JSON GET, with a timeout, that reports failure by returning null. */
async function getJson(url: string, context: string): Promise<any | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`${context} answered ${response.status}`);
      return null;
    }

    // iTunes serves its JSON as text/javascript, so this cannot go through
    // response.json()'s content-type expectations in every runtime — parsing
    // the text is the version that works on both.
    return JSON.parse(await response.text());
  } catch (cause) {
    // A timeout arrives here as an AbortError. Logged, not raised: the save
    // that called this is still going to happen.
    console.error(`${context} lookup failed`, cause);
    return null;
  }
}

interface ItunesAlbum {
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
}

/**
 * Apple's copy, at 600px.
 *
 * The API only ever returns a 100px thumbnail, but the URL is a path into a
 * resizing service and the size in it is a request rather than a fact. Every
 * mzstatic cover in the imported data is a 600x600bb built the same way.
 */
async function fromItunes(album: string, artist: string): Promise<string> {
  const url = new URL(ITUNES_SEARCH);
  url.searchParams.set('term', `${artist} ${stripEdition(album)}`);
  url.searchParams.set('entity', 'album');
  // Enough to get past a compilation or a tribute record sitting at the top;
  // few enough that a bad query cannot cost much to read.
  url.searchParams.set('limit', '10');

  const payload = await getJson(url.toString(), 'iTunes');
  const results: ItunesAlbum[] = Array.isArray(payload?.results) ? payload.results : [];

  const wantAlbum = normalise(stripEdition(album));
  const wantArtist = normalise(artist);

  for (const result of results) {
    const gotAlbum = normalise(stripEdition(result.collectionName ?? ''));
    const gotArtist = normalise(result.artistName ?? '');

    // The artist is allowed to contain what was typed, because a store credits
    // features and collaborations in the same field: "Madvillain" has to match
    // "Madvillain", but "DJ Shadow" should still match "DJ Shadow & Cut
    // Chemist". The album is held to the stricter test — that is the half
    // that decides whether this is the right record.
    const artistMatches =
      looselyEqual(gotArtist, wantArtist) ||
      gotArtist.includes(wantArtist) ||
      wantArtist.includes(gotArtist);

    if (!artistMatches || !looselyEqual(gotAlbum, wantAlbum)) continue;

    const artwork = result.artworkUrl100 ?? '';
    if (!artwork.startsWith('https://')) continue;

    return artwork.replace('100x100bb', '600x600bb');
  }

  return '';
}

/**
 * A Wikipedia article's lead image — which for an album article is the sleeve.
 *
 * Only reached when iTunes had nothing, which is roughly the shape of the
 * imported data: 28 covers from Apple, four from Wikimedia. It needs the link
 * to already be on the pick, and that is deliberate. Searching Wikipedia by
 * title would find *an* article for anything, and the article for the wrong
 * thing has a picture too.
 */
async function fromWikipedia(link: string): Promise<string> {
  let article: URL;
  try {
    article = new URL(link);
  } catch {
    return '';
  }

  // Any language edition, and nothing else. The stored link is typed into a
  // form, so this is the check that keeps a lookup from fetching whatever
  // address somebody pasted.
  if (article.protocol !== 'https:' || !/(^|\.)wikipedia\.org$/.test(article.hostname)) return '';

  const path = article.pathname.match(/^\/wiki\/(.+)$/);
  if (!path) return '';

  const api = new URL(`https://${article.hostname}/w/api.php`);
  api.searchParams.set('action', 'query');
  api.searchParams.set('format', 'json');
  api.searchParams.set('formatversion', '2');
  api.searchParams.set('prop', 'pageimages');
  api.searchParams.set('piprop', 'original');
  api.searchParams.set('titles', decodeURIComponent(path[1]!));
  api.searchParams.set('redirects', '1');

  const payload = await getJson(api.toString(), 'Wikipedia');
  const source = payload?.query?.pages?.[0]?.original?.source;

  return typeof source === 'string' && source.startsWith('https://') ? source : '';
}

/** A cover for one album, or `''` when nothing answered convincingly. */
export async function findArtwork(pick: {
  album: string;
  artist: string;
  wikipedia?: string;
}): Promise<string> {
  const itunes = await fromItunes(pick.album, pick.artist);
  if (itunes) return itunes;

  return pick.wikipedia ? await fromWikipedia(pick.wikipedia) : '';
}

/**
 * The row about to be written, with a cover if one was missing and one could be
 * found.
 *
 * Both pick routes call this on the parsed values rather than doing the lookup
 * themselves, so creating a pick and completing one behave identically — which
 * is the whole reason the parsing lives in `records/selection.ts` too. A pick
 * saved with the field already filled is returned untouched: what somebody
 * typed always wins over what a catalogue thinks.
 */
export async function fillArtwork(values: SelectionValues): Promise<SelectionValues> {
  if (values.artwork_url || !values.album || !values.artist) return values;

  const found = await findArtwork({
    album: values.album,
    artist: values.artist,
    wikipedia: values.link_wikipedia,
  });

  return found ? { ...values, artwork_url: found } : values;
}

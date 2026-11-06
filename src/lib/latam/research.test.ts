import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchTurn, clean, forbiddenFields, hasForeign, readResearch, verify, type Proposal } from './research.ts';
import type { Edition } from '../ai/openlibrary.ts';

const answer = (o: Record<string, unknown>) => JSON.stringify(o);

test('the turn names the place and nothing else', () => {
  assert.equal(
    buildResearchTurn({ name: 'Gaiman', kind: 'town', province: 'Chubut', regionName: 'Patagonia' }),
    'Place: Gaiman (town, Chubut, Patagonia, Argentina).'
  );
});

test('an answer is bounded and typed', () => {
  const r = readResearch(answer({
    overview: 'Welsh tea.',
    notice: ['a', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    words: [{ es: 'che', en: 'hey' }, { es: 'only half' }],
    books: [{ title: 'In Patagonia', author: 'Bruce Chatwin', why: 'Welsh chapters' }],
    films: [{ title: 'Zama', wiki: 'Zama (film)' }],
    articles: [{ wiki: 'Y Wladfa' }, { why: 'no title' }],
  }));
  assert.ok(r);
  assert.equal(r.brief.notice.length, 8);
  assert.deepEqual(r.brief.words, [{ es: 'che', en: 'hey' }]);
  assert.deepEqual(r.proposals.map(p => p.kind), ['book', 'film', 'article']);
});

test('no overview, no research', () => {
  assert.equal(readResearch(answer({ books: [] })), null);
  assert.equal(readResearch('not json'), null);
});

test('an ISBN volunteered is noticed', () => {
  assert.deepEqual(forbiddenFields('{"isbn": "978"}'), ['isbn']);
});

const edition = (title: string, author: string): Edition => ({
  title, author, key: '/works/X', year_published: 1977, pages: 200, publisher: null, isbn: null,
  cover_url: null, subjects: [], link_openlibrary: 'https://openlibrary.org/works/X',
});

const wiki = (pages: Record<string, { type?: string; description?: string }>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const title = decodeURIComponent(String(url).split('/summary/')[1]!).replace(/_/g, ' ');
    const page = pages[title];
    if (!page) return new Response('', { status: 404 });
    return Response.json({
      type: page.type ?? 'standard', title, description: page.description ?? '',
      content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } },
    });
  }) as typeof fetch;

test('only what a catalogue vouches for is kept', async () => {
  const proposals: Proposal[] = [
    { kind: 'book', title: 'In Patagonia', creator: 'Bruce Chatwin', wiki: '', why: 'w' },
    { kind: 'book', title: 'The Welsh Saddle', creator: 'Nobody', wiki: '', why: 'invented' },
    { kind: 'film', title: 'Zama', wiki: 'Zama (film)', creator: '', why: '' },
    { kind: 'film', title: 'Gaiman', wiki: 'Gaiman', creator: '', why: 'a town, not a film' },
    { kind: 'article', title: 'Y Wladfa', wiki: 'Y Wladfa', creator: '', why: '' },
    { kind: 'article', title: 'Mercury', wiki: 'Mercury', creator: '', why: 'disambiguation' },
  ];
  const findBook = async (title: string) =>
    title === 'In Patagonia'
      ? { ok: true as const, candidates: [edition('In Patagonia', 'Bruce Chatwin')] }
      : { ok: true as const, candidates: [edition('Something Else', 'Someone')] };
  const { kept, dropped } = await verify(
    proposals,
    wiki({
      'Zama (film)': { description: '2017 Argentine film by Lucrecia Martel' },
      Gaiman: { description: 'Town in Chubut' },
      'Neil Gaiman': { description: 'English author' },
      'Y Wladfa': { description: 'Welsh settlement in Argentina' },
      Mercury: { type: 'disambiguation' },
    }),
    findBook
  );
  assert.deepEqual(kept.map(k => `${k.kind}:${k.title}`), ['book:In Patagonia', 'film:Zama', 'article:Y Wladfa']);
  assert.equal(kept[0]!.url, 'https://openlibrary.org/works/X');
  assert.equal(dropped, 3);
});

test('a page Wikipedia redirected to another subject is not the one asked for', async () => {
  const redirecting = (async () =>
    Response.json({
      type: 'standard', title: 'Neil Gaiman', description: 'English author',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Neil_Gaiman' } },
    })) as unknown as typeof fetch;
  const { kept, rejected } = await verify(
    [{ kind: 'article', title: 'Gaiman', wiki: 'Gaiman', creator: '', why: 'the town' }],
    redirecting
  );
  assert.equal(kept.length, 0);
  assert.deepEqual(rejected, [{ kind: 'article', title: 'Gaiman', creator: '' }]);
});

test('a book filed under a shorter name is still found by its surname', async () => {
  const calls: string[] = [];
  const findBook = async (title: string, author: string) => {
    calls.push(author);
    return author
      ? { ok: true as const, candidates: [] }
      : { ok: true as const, candidates: [edition('Uttermost Part of the Earth', 'Lucas Bridges')] };
  };
  const { kept } = await verify(
    [{ kind: 'book', title: 'Uttermost Part of the Earth', creator: 'E. Lucas Bridges', wiki: '', why: '' }],
    fetch,
    findBook
  );
  assert.equal(kept.length, 1);
  assert.deepEqual(calls, ['E. Lucas Bridges', '']);
});

test('another script is noticed and removed', () => {
  assert.ok(hasForeign('el背后的 Welsh heritage'));
  assert.ok(hasForeign('ČhepecČke'));
  assert.ok(!hasForeign('Ñandú, café, pingüino — 1865'));
  assert.equal(clean('the背后的 town , here'), 'the town, here');
});

test('a word with foreign script, a fragment, or a disowned one is dropped whole', () => {
  const r = readResearch(answer({
    overview: 'x',
    words: [
      { es: 'el背后的 Welsh heritage', en: 'not a natural Spanish phrase' },
      { es: 'la torta de', en: 'Welsh cake' },
      { es: 'torta galesa', en: 'Welsh black cake' },
    ],
  }));
  assert.deepEqual(r?.brief.words, [{ es: 'torta galesa', en: 'Welsh black cake' }]);
});

// A tiny Wikipedia: titles resolve to pages (or are missing), and a search
// answers in the order given.
const wikipedia = (pages: Record<string, { title: string; extract: string }>, search: string[]) => {
  const asked: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.searchParams.get('list') === 'search') {
      asked.push('search');
      return Response.json({ query: { search: search.map(title => ({ title })) } });
    }
    const t = u.searchParams.get('titles')!;
    asked.push(t);
    const p = pages[t];
    return Response.json({
      query: { pages: [p ? { ...p, fullurl: `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, '_')}` } : { title: t, missing: true }] },
    });
  }) as typeof fetch;
  return { fetcher, asked };
};

test('the article titled after the place comes first, before any search', async () => {
  const city = { title: 'Buenos Aires', extract: 'Buenos Aires is the capital of Argentina.\n\n== References ==\nx' };
  const obelisk = { title: 'Obelisco de Buenos Aires', extract: 'The Obelisco is a monument in Buenos Aires, Argentina.' };
  const { fetcher, asked } = wikipedia({ 'Buenos Aires': city, 'Obelisco de Buenos Aires': obelisk }, ['Obelisco de Buenos Aires', 'Buenos Aires']);
  const { placeSource } = await import('./research.ts');
  const src = await placeSource('Buenos Aires', 'Ciudad de Buenos Aires', fetcher);
  assert.equal(src?.title, 'Buenos Aires');
  assert.equal(src?.text, 'Buenos Aires is the capital of Argentina.');
  assert.ok(!asked.includes('search'), 'no search was needed');
});

test('"Name, Province" is tried first; a bare title that redirects elsewhere is refused', async () => {
  const town = { title: 'Gaiman, Chubut', extract: 'Gaiman is a town in Chubut, Argentina, founded by Welsh settlers.' };
  const author = { title: 'Neil Gaiman', extract: 'Neil Gaiman is an English author. Argentina once.' };
  const { placeSource } = await import('./research.ts');
  const a = wikipedia({ 'Gaiman, Chubut': town, Gaiman: author }, []);
  assert.equal((await placeSource('Gaiman', 'Chubut', a.fetcher))?.title, 'Gaiman, Chubut');
  assert.deepEqual(a.asked, ['Gaiman, Chubut']);
  const b = wikipedia({ Gaiman: author }, ['Neil Gaiman']);
  assert.equal(await placeSource('Gaiman', 'Chubut', b.fetcher), null);
});

test('search results are ranked, the place before things in it, and lists are skipped', async () => {
  const list = { title: 'Trevelin (disambiguation)', extract: 'Trevelin may refer to: a town in Argentina; a surname.' };
  const town = { title: 'Trevelin', extract: 'Trevelin is a town in Chubut, Argentina.' };
  const museum = { title: 'Trevelin Museum', extract: 'A museum in Trevelin, Argentina.' };
  const { placeSource } = await import('./research.ts');
  const { fetcher } = wikipedia(
    { Trevelin: list, 'Trevelin Museum': museum, 'Trevelin (town)': town },
    ['Trevelin Museum', 'Trevelin (town)']
  );
  assert.equal((await placeSource('Trevelin', 'Chubut', fetcher))?.title, 'Trevelin');
});

test('a redirect to a page about Argentina is kept; one to another subject is not', async () => {
  const fetcher = (async (url: string | URL | Request) => {
    const asked = decodeURIComponent(String(url).split('/summary/')[1]!);
    const to = asked.includes('immigration')
      ? { title: 'Welsh settlement in Argentina', description: 'Welsh settlement in Patagonia, Argentina' }
      : { title: 'Neil Gaiman', description: 'English author' };
    return Response.json({ type: 'standard', ...to, content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/x' } } });
  }) as typeof fetch;
  const { kept } = await verify(
    [
      { kind: 'article', title: 'Welsh immigration to Argentina', wiki: 'Welsh immigration to Argentina', creator: '', why: '' },
      { kind: 'article', title: 'Gaiman', wiki: 'Gaiman', creator: '', why: '' },
    ],
    fetcher
  );
  assert.deepEqual(kept.map(k => k.title), ['Welsh settlement in Argentina']);
});

test('catalogue books are kept only when filed under the place', async () => {
  const { catalogueBooks } = await import('./research.ts');
  const fetcher = (async () =>
    Response.json({
      docs: [
        { key: '/works/A', title: 'Gaiman: a Welsh town', author_name: ['A. Author'], subject: [], edition_count: 3 },
        { key: '/works/B', title: 'Patagonia', author_name: ['B. Author'], subject: ['Gaiman (Chubut)'], edition_count: 2 },
        { key: '/works/C', title: 'Sandman', author_name: ['Neil Gaiman'], subject: ['Comics'], edition_count: 40 },
        { key: '/works/D', title: 'El yacimiento de Gaiman', author_name: ['D. Author'], subject: [], edition_count: 1 },
      ],
    })) as unknown as typeof fetch;
  const books = await catalogueBooks('Gaiman', 'Chubut', fetcher);
  assert.deepEqual(books.map(b => b.title), ['Gaiman: a Welsh town', 'Patagonia']);
});

test('a real film about somewhere else is not suggested', async () => {
  const fetcher = (async () =>
    Response.json({
      type: 'standard', title: 'Waiting for the Sea', description: '2012 film about the Aral Sea',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Waiting_for_the_Sea' } },
    })) as unknown as typeof fetch;
  const { kept } = await verify([{ kind: 'film', title: 'Waiting for the Sea', wiki: 'Waiting for the Sea', creator: '', why: '' }], fetcher);
  assert.equal(kept.length, 0);
});

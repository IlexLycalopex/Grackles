import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchTurn, forbiddenFields, readResearch, verify, type Proposal } from './research.ts';
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
      'Zama (film)': { description: '2017 film by Lucrecia Martel' },
      Gaiman: { description: 'Town in Chubut' },
      'Y Wladfa': { description: 'Welsh settlement in Argentina' },
      Mercury: { type: 'disambiguation' },
    }),
    findBook
  );
  assert.deepEqual(kept.map(k => `${k.kind}:${k.title}`), ['book:In Patagonia', 'film:Zama', 'article:Y Wladfa']);
  assert.equal(kept[0]!.url, 'https://openlibrary.org/works/X');
  assert.equal(dropped, 3);
});

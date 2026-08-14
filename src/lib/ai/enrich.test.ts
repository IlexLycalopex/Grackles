import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichCacheKey, mergeProposal, validateEnrichment, type EnrichContext } from './enrich';
import { readDoc, factsMatch, type Edition } from './openlibrary';

/**
 * The parts of enrichment that do not need a network or a model.
 *
 * Which is most of the parts that matter: what the app takes from OpenLibrary,
 * what it refuses to take from the model, and what it would actually write.
 *
 *     npm test
 */

const edition = (over: Partial<Edition> = {}): Edition => ({
  title: 'Piranesi',
  author: 'Susanna Clarke',
  key: '/works/OL20515099W',
  year_published: 2020,
  pages: 245,
  publisher: 'Bloomsbury',
  isbn: '9781526622426',
  cover_url: 'https://covers.openlibrary.org/b/id/10520000-L.jpg',
  subjects: ['Fantasy', 'Fiction'],
  link_openlibrary: 'https://openlibrary.org/works/OL20515099W',
  ...over,
});

const ctx: EnrichContext = {
  book: {
    id: 'b1',
    title: 'Piranesi',
    author: 'Susanna Clarke',
    publisher: 'Bloomsbury Publishing',
    genre: '',
    tags: ['owned'],
  },
  genres: ['Fantasy', 'Literary Fiction'],
  publishers: ['Bloomsbury'],
  tags: ['owned', 'reread'],
};

// ── What OpenLibrary said ───────────────────────────────────────────────────

test('a search result is read defensively', () => {
  // A third party's JSON with half the fields missing is the normal case, not
  // the exceptional one.
  const parsed = readDoc({ key: '/works/OL1W', title: 'A Book' });
  assert.equal(parsed.title, 'A Book');
  assert.equal(parsed.author, '');
  assert.equal(parsed.pages, null);
  assert.equal(parsed.year_published, null);
  assert.equal(parsed.isbn, null);
  assert.equal(parsed.cover_url, null);
  assert.deepEqual(parsed.subjects, []);
});

test('the thirteen-digit ISBN is preferred', () => {
  // It is the one a barcode carries and the one another catalogue matches on.
  const parsed = readDoc({ key: '/w/1', title: 'X', isbn: ['0140449132', '9780140449136'] });
  assert.equal(parsed.isbn, '9780140449136');
});

test('subjects are capped', () => {
  const many = Array.from({ length: 80 }, (_, i) => `subject ${i}`);
  assert.equal(readDoc({ key: '/w/1', title: 'X', subject: many }).subjects.length, 25);
});

// ── What the model is not allowed to do ─────────────────────────────────────

test('a restated fact is caught', () => {
  // The model is asked to choose an edition, not to describe one. A page count
  // that disagrees with the edition it picked is a page count it invented.
  assert.deepEqual(factsMatch(edition(), { pages: 250 }), ['pages']);
  assert.deepEqual(factsMatch(edition(), { isbn: '9780000000000' }), ['isbn']);
  assert.deepEqual(factsMatch(edition(), { pages: 245, year_published: 2020 }), []);
});

test('a proposal that restates a fact fails its check', () => {
  const answer = JSON.stringify({ match: 0, genre: 'Fantasy', pages: 999 });
  const result = validateEnrichment(answer, [edition()]);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.findings, [{ rule: 'restated-fact', detail: 'pages' }]);
});

test('a candidate that does not exist fails', () => {
  const result = validateEnrichment(JSON.stringify({ match: 4 }), [edition()]);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.findings, [{ rule: 'no-such-candidate', detail: '4' }]);
});

test('a sentence where a genre should be fails', () => {
  const answer = JSON.stringify({
    match: 0,
    genre: 'This is a wonderful book about a house and I think it belongs in several categories at once',
  });
  assert.equal(validateEnrichment(answer, [edition()]).status, 'fail');
});

test('unreadable output fails rather than throwing', () => {
  assert.equal(validateEnrichment('sorry, I could not do that', [edition()]).status, 'fail');
});

test('no match at all is a legal answer', () => {
  // Far better than a wrong one, and the prompt says so.
  const result = validateEnrichment(JSON.stringify({ match: null }), [edition()]);
  assert.equal(result.status, 'pass');
});

test('a clean answer passes, fence and all', () => {
  const answer = '```json\n{"match":0,"genre":"Fantasy","tags":["reread"]}\n```';
  assert.equal(validateEnrichment(answer, [edition()]).status, 'pass');
});

// ── What would actually be written ──────────────────────────────────────────

test('facts come from the edition and judgement from the model', () => {
  const fields = mergeProposal(
    { match: 0, genre: 'Fantasy', publisher_normalised: 'Bloomsbury', tags: ['reread'] },
    [edition()],
    ctx.book
  );

  assert.ok(fields);
  assert.equal(fields.pages, 245);
  assert.equal(fields.isbn, '9781526622426');
  assert.equal(fields.year_published, 2020);
  assert.equal(fields.genre, 'Fantasy');
  assert.equal(fields.publisher_normalised, 'Bloomsbury');
});

test('tags are merged with what is already there, not replaced', () => {
  // A proposal is an addition to a record somebody has been keeping, not a
  // correction of it.
  const fields = mergeProposal({ match: 0, tags: ['reread'] }, [edition()], ctx.book);
  assert.deepEqual(fields?.tags?.sort(), ['owned', 'reread']);
});

test('no match proposes nothing at all', () => {
  assert.equal(mergeProposal({ match: null }, [edition()], ctx.book), null);
});

test('a field OpenLibrary did not know is left alone', () => {
  // Absent, not null: writing null would erase whatever a person had typed.
  const fields = mergeProposal({ match: 0 }, [edition({ pages: null, isbn: null })], ctx.book);
  assert.ok(fields);
  assert.equal('pages' in fields, false);
  assert.equal('isbn' in fields, false);
  assert.equal(fields.year_published, 2020);
});

// ── The cache key ───────────────────────────────────────────────────────────

test('the same question gets the same key', () => {
  assert.equal(enrichCacheKey(ctx, [edition()]), enrichCacheKey(ctx, [edition()]));
});

test('a different vocabulary is a different question', () => {
  // The same title asked against a different set of genres has a different
  // right answer, and serving the first would pin the catalogue to whatever it
  // looked like the first time anybody pressed the button.
  const widened: EnrichContext = { ...ctx, genres: [...ctx.genres, 'Weird Fiction'] };
  assert.notEqual(enrichCacheKey(ctx, [edition()]), enrichCacheKey(widened, [edition()]));
});

test('different candidates are a different question', () => {
  const other = [edition({ key: '/works/OL999W' })];
  assert.notEqual(enrichCacheKey(ctx, [edition()]), enrichCacheKey(ctx, other));
});

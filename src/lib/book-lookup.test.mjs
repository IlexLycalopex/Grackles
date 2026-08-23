/**
 * The book lookup, against fixture responses with `fetch` stubbed.
 *
 *   node --experimental-strip-types src/lib/book-lookup.test.mjs
 *
 * Same arrangement as `artwork.test.mjs`, and for the same reason: what is
 * worth pinning is a set of heuristics, and heuristics rot silently. Most of
 * these cases are not inventions — they are the ones the old repo's
 * `scripts/fetch-metadata.js` had already learned about these two APIs, and
 * losing any of them again would look exactly like the feature working.
 *
 * The lookup is never exercised against the real endpoints. These fixtures are
 * the shape Open Library and Google Books return, not proof they still do.
 */
import assert from 'node:assert';

let calls = [];
let openLibrary = () => ({ docs: [] });
let googleBooks = () => ({ items: [] });

globalThis.fetch = async url => {
  const u = String(url);
  calls.push(u);
  const isOpenLibrary = u.includes('openlibrary.org');
  const body = (isOpenLibrary ? openLibrary : googleBooks)(u);
  if (body === null) return { ok: false, status: 503, text: async () => '' };
  if (body === undefined) throw new TypeError('fetch failed');
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const { lookupBook, fillFromLookup, fillCover } = await import('./book-lookup.ts');

const asked = host => calls.filter(u => u.includes(host));
const param = (u, k) => new URL(u).searchParams.get(k);
const form = o => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const filled = f => Object.fromEntries([...f.entries()].filter(([, v]) => v !== ''));

const SATSUMA = {
  key: '/works/OL27729261W',
  title: 'The Satsuma Complex',
  author_name: ['Bob Mortimer'],
  first_publish_year: 2022,
  number_of_pages_median: 320,
  publisher: ['Gallery Books'],
  subject: ['Fiction', 'Humorous fiction', 'Mystery'],
  isbn: ['1398508594', '9781398508590'],
  cover_i: 12583579,
};
const COVERLESS = { key: '/works/OL9W', title: 'Study Guide', author_name: ['Anon'] };
const GOOGLE = {
  volumeInfo: {
    title: 'Obscure Thing',
    authors: ['Someone'],
    publisher: 'Small Press',
    publishedDate: '2019-04-02',
    pageCount: 210,
    categories: ['History'],
    imageLinks: { thumbnail: 'http://books.google.com/books/content?id=abc' },
  },
};

const reset = () => {
  calls = [];
  openLibrary = () => ({ docs: [] });
  googleBooks = () => ({ items: [] });
};

// 1. The book that started this: everything blank, everything filled.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
let f = form({ title: 'The Satsuma Complex', author: 'Bob Mortimer' });
let said = await fillFromLookup(f);
assert.equal(f.get('cover_url'), 'https://covers.openlibrary.org/b/id/12583579-L.jpg');
assert.equal(f.get('isbn'), '9781398508590', 'the 13-digit ISBN is preferred');
assert.equal(f.get('genre'), 'Fiction, Humorous fiction', 'first two subjects');
assert.equal(f.get('pages'), '320');
assert.equal(f.get('year_published'), '2022');
assert.equal(f.get('link_openlibrary'), 'https://openlibrary.org/works/OL27729261W');
assert.equal(asked('googleapis').length, 0, 'Google is not troubled once a cover is found');
assert.ok(said.includes('median across editions'), 'the estimate is declared');

// 2. A result with a cover beats a result that merely came first. The old
//    script asked for more than one for exactly this reason.
reset();
openLibrary = () => ({ docs: [COVERLESS, SATSUMA] });
f = form({ title: 'The Satsuma Complex' });
await fillFromLookup(f);
assert.equal(f.get('cover_url'), 'https://covers.openlibrary.org/b/id/12583579-L.jpg');
assert.equal(param(asked('openlibrary')[0], 'limit'), '10');

// 3. A volume number is not in the index. This list is full of graphic novels.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
await fillFromLookup(form({ title: 'Chew Vol 9 Chicken Tenders', author: 'John Layman & Rob Guillory' }));
assert.equal(param(asked('openlibrary')[0], 'title'), 'Chew Chicken Tenders');
assert.equal(param(asked('openlibrary')[0], 'author'), 'John Layman', 'first author only');

reset();
openLibrary = () => ({ docs: [SATSUMA] });
await fillFromLookup(form({ title: 'The Massive Volume 4' }));
assert.equal(param(asked('openlibrary')[0], 'title'), 'The Massive', '"Volume" spelled out too');

// 4. Google Books is the fallback, and only when there is no cover.
reset();
openLibrary = () => ({ docs: [COVERLESS] });
googleBooks = () => ({ items: [GOOGLE] });
f = form({ title: 'Obscure Thing' });
said = await fillFromLookup(f);
assert.equal(
  f.get('cover_url'),
  'https://books.google.com/books/content?id=abc',
  'http upgraded to https, or the browser blocks it as mixed content'
);
assert.equal(f.get('publisher'), 'Small Press');
assert.equal(f.get('genre'), 'History');
assert.equal(f.get('year_published'), '2019', 'year parsed out of a full date');
assert.equal(f.get('pages'), '210');
assert.ok(!said.includes('median'), 'Google gives an edition page count, not an estimate');

// 5. Where both answered, Open Library wins — Google only fills its gaps.
reset();
openLibrary = () => ({ docs: [{ ...COVERLESS, publisher: ['OL Press'], first_publish_year: 1999 }] });
googleBooks = () => ({ items: [GOOGLE] });
f = form({ title: 'Obscure Thing' });
await fillFromLookup(f);
assert.equal(f.get('publisher'), 'OL Press');
assert.equal(f.get('year_published'), '1999');
assert.equal(f.get('cover_url'), 'https://books.google.com/books/content?id=abc');

// 6. The rule the whole file turns on: what somebody typed always wins.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
f = form({ title: 'The Satsuma Complex', pages: '288', publisher: 'Gallery UK' });
await fillFromLookup(f);
assert.equal(f.get('pages'), '288');
assert.equal(f.get('publisher'), 'Gallery UK');
assert.equal(f.get('cover_url'), 'https://covers.openlibrary.org/b/id/12583579-L.jpg');

// …so pressing it twice is a no-op, which is what makes it safe on a book that
// already exists.
const before = filled(f);
const again = await fillFromLookup(f);
assert.deepEqual(filled(f), before);
assert.ok(again.includes('already has something'));

// 7. An ISBN identifies one edition, so it beats matching a title.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
f = form({ isbn: '978-1-3985-0859-0' });
await fillFromLookup(f);
assert.equal(param(asked('openlibrary')[0], 'isbn'), '9781398508590', 'punctuation stripped');
assert.equal(param(asked('openlibrary')[0], 'title'), null);
assert.equal(f.get('title'), 'The Satsuma Complex');

// 8. One source failing is not both failing.
reset();
openLibrary = () => undefined; // throws
googleBooks = () => ({ items: [GOOGLE] });
f = form({ title: 'Obscure Thing' });
await fillFromLookup(f);
assert.equal(f.get('cover_url'), 'https://books.google.com/books/content?id=abc');

// 9. Both failing changes nothing and says so — a failed lookup must never look
//    like a book that does not exist.
reset();
openLibrary = () => undefined;
googleBooks = () => null; // 503
f = form({ title: 'The Satsuma Complex' });
said = await fillFromLookup(f);
assert.deepEqual(filled(f), { title: 'The Satsuma Complex' });
assert.ok(said.includes('could be reached'));

// 10. Nothing found is a different sentence, and names what was asked.
reset();
f = form({ title: 'Zzzzz Not A Book' });
said = await fillFromLookup(f);
assert.deepEqual(filled(f), { title: 'Zzzzz Not A Book' });
assert.ok(said.includes('Zzzzz Not A Book'));

// 11. Nothing to go on, so nobody is asked.
reset();
said = await fillFromLookup(form({ title: '', isbn: '' }));
assert.equal(calls.length, 0);
assert.ok(said.includes('title or an ISBN'));

// 12. The request identifies itself, because Open Library asks that it does.
reset();
let sentHeaders = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sentHeaders = init.headers;
  return realFetch(url, init);
};
openLibrary = () => ({ docs: [SATSUMA] });
await lookupBook({ title: 'x', author: '', isbn: '' });
assert.ok(sentHeaders['user-agent'].includes('Grackles'));

// ── fillCover: the same lookup on the save itself ──────────────────
// Nobody presses the button on every book, so a blank cover is filled on the
// way to the database. Nobody reviews that one, which changes the rules.

const book = o => ({ title: '', author: '', isbn: '', cover_url: '', ...o });

// 13. A blank cover is filled.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
let saved = await fillCover(book({ title: 'The Satsuma Complex', author: 'Bob Mortimer' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/12583579-L.jpg');

// 14. One that is already there is left alone, and nobody is asked.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
saved = await fillCover(book({ title: 'The Satsuma Complex', cover_url: 'https://example.test/mine.jpg' }));
assert.equal(saved.cover_url, 'https://example.test/mine.jpg');
assert.equal(calls.length, 0);

// 15. The rule the button does not need: a wrong cover is worse than none.
//     "Middlemarch" must not accept a cover for something else entirely.
reset();
openLibrary = () => ({ docs: [{ ...SATSUMA, title: 'A Completely Different Book' }] });
saved = await fillCover(book({ title: 'Middlemarch', author: 'George Eliot' }));
assert.equal(saved.cover_url, '', 'a mismatched title is refused');

// …but an edition suffix or an accent is not a mismatch.
reset();
openLibrary = () => ({
  docs: [{ ...SATSUMA, title: '2666 (Picador Classic)', author_name: ['Roberto Bolaño'] }],
});
saved = await fillCover(book({ title: '2666', author: 'Roberto Bolano' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/12583579-L.jpg');

// 16. A lookup never fails a save.
reset();
openLibrary = () => undefined;
googleBooks = () => undefined;
saved = await fillCover(book({ title: 'The Satsuma Complex' }));
assert.deepEqual(saved, book({ title: 'The Satsuma Complex' }), 'values come back untouched');

// 17. Nothing to go on, so nobody is asked.
reset();
saved = await fillCover(book({}));
assert.equal(calls.length, 0);

// 18. The right book behind three wrong ones. This is the same failure the
//     album lookup had: a search that ranks badly is only as good as the number
//     of results anybody actually looks at, and taking the first one that
//     carries a cover was taking a ranking's word for it. Every result is
//     judged now, so a book sitting fourth is still found.
reset();
const doc = (title, author, cover) => ({
  key: '/works/OL1W',
  title,
  author_name: [author],
  cover_i: cover,
});
openLibrary = () => ({
  docs: [
    doc('Middlemarch: A Study Guide', 'Cliffs Notes', 111),
    doc('Middlemarch in Context', 'Karen Chase', 222),
    doc('Reading Middlemarch', 'Somebody Else', 333),
    doc('Middlemarch', 'George Eliot', 444),
  ],
});
saved = await fillCover(book({ title: 'Middlemarch', author: 'George Eliot' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/444-L.jpg');
assert.equal(asked('googleapis').length, 0, 'a cover was found, so Google is left alone');

// 19. The title alone was never enough. Two books share a title far more often
//     than two books share a title and an author.
reset();
openLibrary = () => ({ docs: [doc('The Road', 'Jack London', 555)] });
saved = await fillCover(book({ title: 'The Road', author: 'Cormac McCarthy' }));
assert.equal(saved.cover_url, '', 'right title, wrong author, refused');

// …and it is refused rather than guessed at when the result names nobody.
reset();
openLibrary = () => ({ docs: [{ key: '/works/OL2W', title: 'The Road', cover_i: 556 }] });
saved = await fillCover(book({ title: 'The Road', author: 'Cormac McCarthy' }));
assert.equal(saved.cover_url, '');

// 20. The credit is checked loosely, because the field it comes out of holds
//     more than one name at both ends.
reset();
openLibrary = () => ({ docs: [doc('Invisible Cities', 'Italo Calvino, William Weaver', 777)] });
saved = await fillCover(book({ title: 'Invisible Cities', author: 'Italo Calvino' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/777-L.jpg', 'a translator credited alongside');

reset();
openLibrary = () => ({ docs: [doc('Good Omens', 'Terry Pratchett', 888)] });
saved = await fillCover(book({ title: 'Good Omens', author: 'Neil Gaiman and Terry Pratchett' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/888-L.jpg', 'a co-author typed, one credited');

// …and a book entered with nobody against it is judged on its title alone,
// which is the whole of what was asked.
reset();
openLibrary = () => ({ docs: [doc('Middlemarch', 'George Eliot', 999)] });
saved = await fillCover(book({ title: 'Middlemarch' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/999-L.jpg');

// 21. None of this reaches the button, which is unverified on purpose — a
//     person is about to read what came back and can throw it away.
reset();
openLibrary = () => ({ docs: [doc('A Completely Different Book', 'Nobody At All', 123)] });
f = form({ title: 'Middlemarch', author: 'George Eliot' });
await fillFromLookup(f);
assert.equal(f.get('cover_url'), 'https://covers.openlibrary.org/b/id/123-L.jpg');

// 22. Google's answer faces the same test. Open Library having the right book
//     without a cover is not a reason to take a cover for a different one.
reset();
openLibrary = () => ({ docs: [{ key: '/works/OL3W', title: 'Middlemarch', author_name: ['George Eliot'] }] });
googleBooks = () => ({
  items: [
    {
      volumeInfo: {
        title: 'Middlemarch: A Study Guide',
        authors: ['Cliffs Notes'],
        imageLinks: { thumbnail: 'http://books.google.com/books/content?id=wrong' },
      },
    },
  ],
});
saved = await fillCover(book({ title: 'Middlemarch', author: 'George Eliot' }));
assert.equal(saved.cover_url, '');
assert.equal(asked('googleapis').length, 1, 'it was asked, and its answer was turned down');

// …and taken when it is the same book.
reset();
openLibrary = () => ({ docs: [{ key: '/works/OL3W', title: 'Middlemarch', author_name: ['George Eliot'] }] });
googleBooks = () => ({
  items: [
    {
      volumeInfo: {
        title: 'Middlemarch',
        authors: ['George Eliot'],
        imageLinks: { thumbnail: 'http://books.google.com/books/content?id=right' },
      },
    },
  ],
});
saved = await fillCover(book({ title: 'Middlemarch', author: 'George Eliot' }));
assert.equal(saved.cover_url, 'https://books.google.com/books/content?id=right');

// 23. Open Library refusing every result is a reason to ask Google, not a
//     reason to stop.
reset();
openLibrary = () => ({ docs: [doc('Something Else Entirely', 'Anon', 321)] });
googleBooks = () => ({
  items: [
    {
      volumeInfo: {
        title: 'Middlemarch',
        authors: ['George Eliot'],
        imageLinks: { thumbnail: 'https://books.google.com/books/content?id=ok' },
      },
    },
  ],
});
saved = await fillCover(book({ title: 'Middlemarch', author: 'George Eliot' }));
assert.equal(saved.cover_url, 'https://books.google.com/books/content?id=ok');

// 24. An ISBN names one edition, so the check it would make has already been
//     made by the query — the title coming back differently is a subtitle or a
//     translation, not a different book.
reset();
openLibrary = () => ({ docs: [SATSUMA] });
saved = await fillCover(book({ title: 'Whatever It Was Called', isbn: '9781398508590' }));
assert.equal(saved.cover_url, 'https://covers.openlibrary.org/b/id/12583579-L.jpg');

console.log('all book lookup checks passed');

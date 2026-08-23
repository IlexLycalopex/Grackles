/**
 * The artwork matcher, against fixture responses with `fetch` stubbed.
 *
 *   node --experimental-strip-types src/lib/artwork.test.mjs
 *
 * No runner and no dependency, because what is worth pinning here is one pure
 * decision — is this result the record somebody asked for — and that decision
 * is a heuristic, which is the kind of code that rots silently. The cases are
 * the ones the imported data already contains: an edition suffix, an accent, a
 * credited collaborator, an ellipsis, and the tribute album that any
 * take-the-first-result matcher would have hung on the wrong week.
 *
 * The lookup is never exercised against the real endpoints from CI. These
 * fixtures are the shape Apple and Wikimedia return, not proof that they still
 * return it.
 */
import assert from 'node:assert';

const calls = [];
let handler = () => ({ results: [] });

globalThis.fetch = async (url) => {
  calls.push(String(url));
  const body = handler(String(url));
  if (body === null) return { ok: false, status: 500, text: async () => '' };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const { findArtwork, fillArtwork } = await import('./artwork.ts');

const album = (collectionName, artistName) => ({
  collectionName,
  artistName,
  artworkUrl100:
    'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/09/e0/d5/x.jpg/100x100bb.jpg',
});

// 1. Exact match wins, and the thumbnail is upscaled.
handler = () => ({ results: [album('Depression Cherry', 'Beach House')] });
assert.equal(
  await findArtwork({ album: 'Depression Cherry', artist: 'Beach House' }),
  'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/09/e0/d5/x.jpg/600x600bb.jpg'
);

// 2. A store's edition suffix and an accent difference still match.
handler = () => ({ results: [album('Vespertine (Deluxe Edition)', 'Bjork')] });
assert.ok(await findArtwork({ album: 'Vespertine', artist: 'Björk' }));

// 3. A featured-artist credit still matches the album's artist.
handler = () => ({ results: [album('The Hard Sell', 'DJ Shadow & Cut Chemist')] });
assert.ok(await findArtwork({ album: 'The Hard Sell', artist: 'DJ Shadow' }));

// 4. The wrong record is refused rather than accepted as "the first result".
handler = () => ({
  results: [album('Is This It (Tribute)', 'The Karaoke Channel'), album('Room on Fire', 'The Strokes')],
});
assert.equal(await findArtwork({ album: 'Is This It', artist: 'The Strokes' }), '');

// 5. A prefix that throws away most of the title is not a match.
handler = () => ({ results: [album('Live', 'Some Band')] });
assert.equal(await findArtwork({ album: 'Live at Leeds Revisited', artist: 'Some Band' }), '');

// 6. Punctuation and an ellipsis do not decide a match.
handler = () => ({
  results: [
    album(
      'He Has Left Us Alone but Shafts of Light Sometimes Grace the Corner of Our Rooms...',
      'A Silver Mt. Zion'
    ),
  ],
});
assert.ok(
  await findArtwork({
    album:
      'He Has Left Us Alone but Shafts of Light Sometimes Grace the Corner of Our Rooms…',
    artist: 'A Silver Mt. Zion',
  })
);

// 7. Nothing from iTunes falls through to the article's lead image.
handler = (url) =>
  url.includes('itunes')
    ? { results: [] }
    : { query: { pages: [{ original: { source: 'https://upload.wikimedia.org/x/Voodoo_UK.jpg' } }] } };
assert.equal(
  await findArtwork({
    album: 'Voodoo',
    artist: "D'Angelo",
    wikipedia: 'https://en.wikipedia.org/wiki/Voodoo_(D%27Angelo_album)',
  }),
  'https://upload.wikimedia.org/x/Voodoo_UK.jpg'
);
assert.ok(calls.some(u => u.includes('titles=Voodoo_%28D%27Angelo_album%29')), calls.join('\n'));

// 8. A link that is not Wikipedia is never fetched.
calls.length = 0;
handler = (url) => (url.includes('itunes') ? { results: [] } : { query: { pages: [] } });
assert.equal(
  await findArtwork({ album: 'Nothing', artist: 'Nobody', wikipedia: 'https://example.com/evil' }),
  ''
);
assert.equal(calls.filter(u => !u.includes('itunes')).length, 0);

// 9. A failing lookup returns nothing rather than throwing.
handler = () => null;
assert.equal(await findArtwork({ album: 'Voodoo', artist: "D'Angelo" }), '');

// 10. fillArtwork leaves a typed URL alone, and skips an empty week entirely.
calls.length = 0;
handler = () => ({ results: [album('Voodoo', "D'Angelo")] });
const typed = {
  album: 'Voodoo',
  artist: "D'Angelo",
  artwork_url: 'https://example.com/mine.jpg',
  link_wikipedia: '',
};
assert.equal((await fillArtwork(typed)).artwork_url, 'https://example.com/mine.jpg');
assert.equal(
  (await fillArtwork({ album: '', artist: '', artwork_url: '', link_wikipedia: '' })).artwork_url,
  ''
);
assert.equal(calls.length, 0, 'neither case should have asked anybody');

// 11. The completing save is the one that fills it in.
const completed = await fillArtwork({
  album: 'Voodoo',
  artist: "D'Angelo",
  artwork_url: '',
  link_wikipedia: '',
});
assert.equal(
  completed.artwork_url,
  'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/09/e0/d5/x.jpg/600x600bb.jpg'
);

// 12. The record the combined query buries is still found by the title query.
//     This is the Wolf Alice case: "Wolf Alice Visions of a Life" is six words,
//     most of them common enough that Apple ranks other people's records above
//     the one that was asked for. Asking the title against album titles alone
//     puts it back in reach, and the same match test is what accepts it.
calls.length = 0;
const visions = album('Visions of a Life', 'Wolf Alice');
handler = (url) =>
  url.includes('attribute=albumTerm')
    ? { results: [album('Visions of a Life', 'Some Other Band'), visions] }
    : {
        results: [
          album('Alice in Chains', 'Alice in Chains'),
          album('Journey In Satchidananda', 'Alice Coltrane'),
          album('The Wolf', 'Sam Fender'),
        ],
      };
assert.equal(
  await findArtwork({ album: 'Visions of a Life', artist: 'Wolf Alice' }),
  'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/09/e0/d5/x.jpg/600x600bb.jpg'
);
const itunesCalls = calls.filter(u => u.includes('itunes'));
assert.equal(itunesCalls.length, 2, itunesCalls.join('\n'));
assert.ok(
  itunesCalls.some(u => u.includes('term=Wolf+Alice+Visions+of+a+Life') && !u.includes('attribute')),
  itunesCalls.join('\n')
);
assert.ok(
  itunesCalls.some(
    u => u.includes('term=Visions+of+a+Life') && u.includes('attribute=albumTerm')
  ),
  itunesCalls.join('\n')
);

// 13. The extra query widens what is looked at, never what is accepted. The
//     title query answers with the right title by the wrong band, and that is
//     still refused rather than hung on somebody's week.
handler = (url) =>
  url.includes('attribute=albumTerm')
    ? { results: [album('Visions of a Life', 'A Tribute Band')] }
    : { results: [] };
assert.equal(await findArtwork({ album: 'Visions of a Life', artist: 'Wolf Alice' }), '');

// 14. When both queries answer, the combined one is preferred — a week that
//     already found its cover goes on finding the same one.
const other = album('Depression Cherry', 'Beach House');
other.artworkUrl100 = 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/aa/bb/cc/y.jpg/100x100bb.jpg';
handler = (url) =>
  url.includes('attribute=albumTerm')
    ? { results: [other] }
    : { results: [album('Depression Cherry', 'Beach House')] };
assert.equal(
  await findArtwork({ album: 'Depression Cherry', artist: 'Beach House' }),
  'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/09/e0/d5/x.jpg/600x600bb.jpg'
);

// 15. One query failing does not take the other down with it.
handler = (url) => (url.includes('attribute=albumTerm') ? { results: [visions] } : null);
assert.ok(await findArtwork({ album: 'Visions of a Life', artist: 'Wolf Alice' }));

console.log('all artwork lookup checks passed');

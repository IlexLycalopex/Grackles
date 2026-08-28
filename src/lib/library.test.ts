import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyOf, looksLikeSameBook, matchesQuery, splitVolume, workKey } from './library.ts';
import { authorKey, authorSurname } from './title-match.ts';

/**
 * The fold, against the fixture the SQL test also reads.
 *
 * The point of loading the file rather than writing the cases out here is that
 * `supabase/tests/library.sh` loads the same one and asserts the same things of
 * `app.rl_work_key()`. A case added in one place is added to both, and the two
 * halves of the identity rule cannot drift apart without something going red.
 */

const fixture = JSON.parse(
  readFileSync(new URL('../../supabase/tests/fixtures/work-keys.json', import.meta.url), 'utf8')
) as {
  keys: { title: string; author: string; key: string }[];
  same: [string, string, string, string][];
  different: [string, string, string, string][];
  ambiguous: [string, string, string, string][];
  notAmbiguous: [string, string, string, string][];
};

test('the key is exactly what the fixture says', () => {
  for (const { title, author, key } of fixture.keys) {
    assert.equal(workKey(title, author), key, `${title} — ${author}`);
  }
});

test('two spellings of one book fold together', () => {
  for (const [t1, a1, t2, a2] of fixture.same) {
    assert.equal(workKey(t1, a1), workKey(t2, a2), `${t1} / ${a1} vs ${t2} / ${a2}`);
  }
});

test('two books stay apart', () => {
  for (const [t1, a1, t2, a2] of fixture.different) {
    assert.notEqual(workKey(t1, a1), workKey(t2, a2), `${t1} / ${a1} vs ${t2} / ${a2}`);
  }
});

test('near-misses are offered to a person', () => {
  for (const [t1, a1, t2, a2] of fixture.ambiguous) {
    assert.ok(
      looksLikeSameBook({ title: t1, author: a1 }, { title: t2, author: a2 }),
      `expected ambiguous: ${t1} / ${a1} vs ${t2} / ${a2}`
    );
  }
});

test('what is not a near-miss is not offered', () => {
  for (const [t1, a1, t2, a2] of fixture.notAmbiguous) {
    assert.ok(
      !looksLikeSameBook({ title: t1, author: a1 }, { title: t2, author: a2 }),
      `expected not ambiguous: ${t1} / ${a1} vs ${t2} / ${a2}`
    );
  }
});

/**
 * The volume rule, on its own, because it is the one that silently deletes a
 * series if it is got wrong. `cleanTitle()` in book-lookup.ts strips these and
 * throws them away on purpose; this must not.
 */
test('a volume number leaves the title and enters the key', () => {
  assert.deepEqual(splitVolume('Chew Vol 9 Chicken Tenders'), {
    title: 'Chew Chicken Tenders',
    index: 9,
  });
  assert.deepEqual(splitVolume('Saga, Book 3'), { title: 'Saga', index: 3 });
  assert.deepEqual(splitVolume('Locke & Key #2'), { title: 'Locke & Key', index: 2 });
  assert.deepEqual(splitVolume('The Book of Three'), { title: 'The Book of Three', index: null });
  assert.deepEqual(splitVolume('Slaughterhouse-Five'), { title: 'Slaughterhouse-Five', index: null });
  assert.deepEqual(splitVolume('1984'), { title: '1984', index: null });
});

test('an explicit series index beats the one in the title', () => {
  assert.equal(workKey('Chew', 'John Layman', 3), workKey('Chew Vol 3', 'John Layman'));
  assert.notEqual(workKey('Chew', 'John Layman', 3), workKey('Chew Vol 9', 'John Layman'));
});

test('keyOf reads the series_index column when there is one', () => {
  assert.equal(
    keyOf({ title: 'Chew', author: 'John Layman', series_index: 9 }),
    workKey('Chew Vol 9', 'John Layman')
  );
});

// ── the author fold ─────────────────────────────────────────────────

test('a reversed name is unreversed', () => {
  assert.equal(authorKey('Le Guin, Ursula K.'), 'le guin u');
  assert.equal(authorKey('Ursula K. Le Guin'), 'le guin u');
  assert.equal(authorSurname('Le Guin, Ursula K.'), 'le guin');
});

test('a particle stays with the surname', () => {
  assert.equal(authorSurname('Ludwig Mies van der Rohe'), 'van der Rohe'.toLowerCase());
  assert.equal(authorSurname('Simone de Beauvoir'), 'de beauvoir');
});

test('a suffix is not a surname and not a reversal', () => {
  assert.equal(authorKey('Paul Beatty, Jr.'), 'beatty p');
  assert.equal(authorKey('Martin Luther King Jr'), 'king m');
});

test('a joint credit takes the first name only', () => {
  assert.equal(authorKey('Neil Gaiman & Terry Pratchett'), 'gaiman n');
  assert.equal(authorKey('Octavia Butler and Someone Else'), 'butler o');
  assert.equal(authorKey('Jorge Luis Borges; Adolfo Bioy Casares'), 'borges j');
});

test('an author with one name folds to it', () => {
  assert.equal(authorKey('Homer'), 'homer');
  assert.equal(authorKey(''), '');
});

test('editorial furniture is dropped', () => {
  assert.equal(authorKey('Ursula K. Le Guin (Author)'), 'le guin u');
  assert.equal(authorKey('Franz Kafka, translated by Willa Muir'), 'kafka f');
});

// ── the filter box ──────────────────────────────────────────────────

test('every word has to appear, so a second word narrows', () => {
  assert.ok(matchesQuery('The Dispossessed Ursula K. Le Guin', 'le guin dispossessed'));
  assert.ok(!matchesQuery('The Dispossessed Ursula K. Le Guin', 'le guin lathe'));
  assert.ok(matchesQuery('Perdido Street Station China Miéville', 'mieville'));
  assert.ok(matchesQuery('anything at all', ''));
});

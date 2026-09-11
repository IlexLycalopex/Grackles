import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditMatches } from './title-match.ts';

/**
 * The credit half of "is this the record somebody asked for".
 *
 * The title half is pinned by `artwork.test.mjs` and `book-lookup.test.mjs`
 * against the cases the imported data contains. This is here rather than there
 * because the rule is shared by both lookups and belongs to neither, and
 * because a heuristic nobody can see the edges of rots the fastest.
 *
 * Two failures are worth keeping in view while reading these, because the rule
 * is a compromise between them. Refusing a credit that was right costs a cover
 * that never appears. Accepting one that was wrong hangs a stranger's artwork
 * on somebody's record, where nobody is reviewing it. They are not equal, and
 * where the cases below disagree the stricter answer wins.
 */

// ── what has to match ───────────────────────────────────────────────

test('a store crediting a collaboration still names the act', () => {
  assert.ok(creditMatches('DJ Shadow & Cut Chemist', 'DJ Shadow'));
  assert.ok(creditMatches('Madvillain', 'Madvillain'));
  assert.ok(creditMatches('Wolf Alice', 'Wolf Alice'));
});

test('a library crediting a translator still names the author', () => {
  assert.ok(creditMatches('Italo Calvino, William Weaver', 'Italo Calvino'));
  assert.ok(creditMatches('Franz Kafka, translated by Willa Muir', 'Franz Kafka'));
});

test('a co-author typed in matches the one the catalogue lists', () => {
  assert.ok(creditMatches('Terry Pratchett', 'Neil Gaiman and Terry Pratchett'));
  assert.ok(creditMatches('Jorge Luis Borges; Adolfo Bioy Casares', 'Borges, Jorge Luis'));
});

test('a name written backwards is the same name', () => {
  assert.ok(creditMatches('Le Guin, Ursula K.', 'Ursula K. Le Guin'));
  assert.ok(creditMatches('Simone de Beauvoir', 'de Beauvoir, Simone'));
  assert.ok(creditMatches('Paul Beatty, Jr.', 'Paul Beatty'));
});

test('a spine with room for one word matches the catalogue that has both', () => {
  // The initial is only consulted when both sides carry one, which is what
  // makes this work without letting "John Smith" match every other Smith.
  assert.ok(creditMatches('John Smith', 'Smith'));
  assert.ok(creditMatches('Smith', 'John Smith'));
});

// ── what must not ───────────────────────────────────────────────────

test('a surname that merely contains another is a different author', () => {
  // The case this rule exists for. A substring test says these match, and a
  // substring test is what put the wrong cover on a record.
  assert.ok(!creditMatches('Smithson', 'Smith'));
  assert.ok(!creditMatches('Smith', 'Smithson'));
});

test('a shared word is not a shared identity', () => {
  // Every one of these came back above Wolf Alice when the album was searched
  // by its full name, which is how the record everybody meant went missing.
  assert.ok(!creditMatches('Alice Cooper', 'Wolf Alice'));
  assert.ok(!creditMatches('Alice In Chains', 'Wolf Alice'));
  assert.ok(!creditMatches('Alice Coltrane', 'Wolf Alice'));
});

test('a different author is refused', () => {
  assert.ok(!creditMatches('Terry Pratchett', 'Neil Gaiman'));
  assert.ok(!creditMatches('Jack London', 'Cormac McCarthy'));
});

test('a credit nobody wrote down is not a match', () => {
  // An empty string is inside every string, so a substring test called this a
  // match and took a cover from a result crediting nobody.
  assert.ok(!creditMatches('', 'Italo Calvino'));
  assert.ok(!creditMatches('Italo Calvino', ''));
  assert.ok(!creditMatches('', ''));
});

// ── where it is deliberately conservative ───────────────────────────

test('two given names that disagree are two authors', () => {
  // The same answer `authorKey()` gives, and kept on purpose: this is the one
  // place the rule is likely to refuse a credit that was right. "Ludwig Mies
  // van der Rohe" and "Mies van der Rohe" are one architect, and a missing
  // cover is the cheaper of the two mistakes.
  assert.ok(!creditMatches('Ludwig Mies van der Rohe', 'Mies van der Rohe'));
});

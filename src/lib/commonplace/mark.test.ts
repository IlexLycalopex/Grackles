import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mark, recall } from './mark.ts';
import { normalise, distance, typoAllowance } from './normalise.ts';
import { PLACES, MAP_DECKS, deckPlaceKeys, acceptedFor } from './decks.ts';

test('normalising folds case, accents, punctuation, "the" and "St"', () => {
  assert.equal(normalise("  Côte d'Ivoire "), 'cote divoire');
  assert.equal(normalise('The Gambia'), 'gambia');
  assert.equal(normalise('St. Lucia'), 'saint lucia');
  assert.equal(normalise('St Vincent & the Grenadines'), 'saint vincent and the grenadines');
  assert.equal(normalise('Guinea-Bissau'), 'guinea bissau');
  assert.equal(normalise('Chișinău'), 'chisinau');
  assert.equal(normalise('Washington, D.C.'), 'washington d c');
  assert.equal(normalise('Stockholm'), 'stockholm', 'st inside a word is left alone');
});

test('a neighbouring-letter swap is one slip', () => {
  assert.equal(distance('lithuania', 'lihtuania'), 1);
  assert.equal(distance('kenya', 'kenya'), 0);
  assert.equal(distance('', 'abc'), 3);
});

test('the typo allowance grows with the answer', () => {
  assert.deepEqual([4, 5, 8, 9, 20].map(typoAllowance), [0, 1, 1, 2, 2]);
});

test('exact, alternative and folded answers are exact', () => {
  assert.equal(mark('france', ['France']), 'exact');
  assert.equal(mark('Czech Republic', ['Czechia', 'Czech Republic']), 'exact');
  assert.equal(mark('cote divoire', ["Côte d'Ivoire", 'Ivory Coast']), 'exact');
  assert.equal(mark('Saint Lucia', ['St Lucia']), 'exact');
});

test('a slip within the allowance is close; beyond it, wrong', () => {
  assert.equal(mark('Phillipines', ['Philippines']), 'close');
  assert.equal(mark('Lihtuania', ['Lithuania']), 'close');
  assert.equal(mark('Peruu', ['Peru']), 'wrong', 'four letters forgive nothing');
  assert.equal(mark('Frnce', ['France']), 'close');
  assert.equal(mark('Frnc', ['France']), 'wrong');
});

test('an empty answer is wrong, not exact', () => {
  assert.equal(mark('   ', ['France']), 'wrong');
});

test('a typo never lands on another answer in the deck', () => {
  const rivals = ['Niger', 'Nigeria', 'Austria', 'Australia', 'Iran', 'Iraq', 'Mali', 'Malawi'];
  assert.equal(mark('Nigeria', ['Niger'], rivals), 'wrong');
  assert.equal(mark('Nigeri', ['Niger'], rivals), 'wrong', 'as close to Nigeria as to Niger');
  assert.equal(mark('Nigerai', ['Nigeria'], rivals), 'close');
  assert.equal(mark('Australia', ['Austria'], rivals), 'wrong');
  assert.equal(mark('Iraq', ['Iran'], rivals), 'wrong');
  assert.equal(mark('Malawi', ['Mali'], rivals), 'wrong');
  assert.equal(mark('Slovenia', ['Slovakia'], ['Slovakia', 'Slovenia']), 'wrong');
});

test('every near collision the build recorded is refused as a typo, both ways', () => {
  const report = JSON.parse(readFileSync(new URL('../../data/gazetteer/report.json', import.meta.url), 'utf8'));
  assert.ok(report.near_collisions.length > 20);
  for (const { a: [, a], b: [, b] } of report.near_collisions) {
    assert.equal(mark(a, [a], [b]), 'exact', `${a} is itself`);
    assert.equal(mark(b, [a], [b]), 'wrong', `${b} is not a slip for ${a}`);
    assert.equal(mark(a, [b], [a]), 'wrong', `${a} is not a slip for ${b}`);
  }
});

test('language decks can mark a missing accent or wrong case as close', () => {
  const lang = { typos: true, accents: 'close' as const };
  assert.equal(mark('cafe', ['café'], [], lang), 'close');
  assert.equal(mark('café', ['café'], [], lang), 'exact');
  assert.equal(mark('hund', ['Hund'], [], { caseSensitive: true }), 'close');
  assert.equal(mark('Hund', ['Hund'], [], { caseSensitive: true }), 'exact');
  assert.equal(mark('Hnud', ['Hund'], [], { typos: false }), 'wrong');
});

test('free recall matches exactly and nothing looser', () => {
  const remaining: [string, string[]][] = [['NER', ['Niger']], ['NGA', ['Nigeria']]];
  assert.equal(recall('nige', remaining), null);
  assert.equal(recall('niger', remaining), 'NER');
  assert.equal(recall('NIGERIA ', remaining), 'NGA');
  assert.equal(recall('nigeira', remaining), null);
});

test('no two places in any built-in deck share an answer once normalised', () => {
  for (const deck of MAP_DECKS) {
    const dir = deck.topic === 'capitals' ? 'capital' : 'name';
    const seen = new Map<string, string>();
    for (const key of deckPlaceKeys(deck, { territories: true, disputed: true })) {
      for (const a of acceptedFor(key, dir)) {
        const n = normalise(a);
        assert.ok(!seen.has(n) || seen.get(n) === key, `${deck.slug}: "${a}" answers ${seen.get(n)} and ${key}`);
        seen.set(n, key);
      }
    }
  }
});

test('the capitals with more than one official seat accept every one', () => {
  for (const [key, also] of [['ZAF', 'Cape Town'], ['BOL', 'La Paz'], ['NLD', 'The Hague'], ['MYS', 'Putrajaya']]) {
    assert.equal(mark(also, acceptedFor(key, 'capital')), 'exact', key);
  }
  assert.ok(PLACES.ZAF.capital?.also.includes('Bloemfontein'));
});

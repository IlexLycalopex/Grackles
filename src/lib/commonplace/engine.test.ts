import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { typedHint, hintSteps } from './hints.ts';
import { resultOf, gradeOf, Again, Hard, Good, Easy } from './result.ts';
import { review, mastery } from './schedule.ts';
import { MODES, parseSettings, settingsQuery, pbKey, DEFAULTS } from './modes.ts';
import {
  MAP_DECKS, PLACES, deckBySlug, deckPlaceKeys, homeDeck, parseRef, placeRef, REF_PATTERN, inRegion,
} from './decks.ts';
import { parseCards, toCsv, checkCards } from './csv.ts';

// ── Hints ─────────────────────────────────────────────────────────────
test('the hint ladder goes first letter, pattern, one more letter', () => {
  assert.equal(typedHint('Burkina Faso', 1), 'B…');
  assert.equal(typedHint('Burkina Faso', 2), 'B _ _ _ _ _ _   _ _ _ _');
  assert.equal(typedHint('Burkina Faso', 3), 'B u _ _ _ _ _   _ _ _ _');
  assert.equal(typedHint('Guinea-Bissau', 2), 'G _ _ _ _ _ - _ _ _ _ _ _');
  assert.equal(typedHint('France', 0), '');
});

test('the ladder stops one letter short of the answer', () => {
  assert.equal(hintSteps('Peru'), 4);
  assert.equal(typedHint('Peru', hintSteps('Peru')), 'P e r _');
});

// ── Results and grades ────────────────────────────────────────────────
const a = (o: Partial<{ wrong: number; hints: number; close: boolean; revealed: boolean }>) =>
  ({ wrong: 0, hints: 0, close: false, revealed: false, ...o });

test('results rank revealed over hinted over close over clean', () => {
  assert.equal(resultOf(a({})), 'clean');
  assert.equal(resultOf(a({ close: true })), 'close');
  assert.equal(resultOf(a({ close: true, hints: 1 })), 'hinted');
  assert.equal(resultOf(a({ hints: 1, revealed: true })), 'revealed');
});

test('grades follow the table in the spec', () => {
  assert.equal(gradeOf(a({}), 2000), Easy);
  assert.equal(gradeOf(a({}), 9000), Good);
  assert.equal(gradeOf(a({}), 6000, 'card'), Easy);
  assert.equal(gradeOf(a({ close: true }), 1000), Hard);
  assert.equal(gradeOf(a({ wrong: 1 }), 1000), Hard);
  assert.equal(gradeOf(a({ hints: 1 }), 1000), Hard);
  assert.equal(gradeOf(a({ hints: 2 }), 1000), Again);
  assert.equal(gradeOf(a({ revealed: true }), 1000), Again);
});

// ── Scheduling ────────────────────────────────────────────────────────
test('a place missed today is due again soon; one known well is not', () => {
  const now = new Date('2026-09-24T09:00:00Z');
  const missed = review(null, Again, now);
  assert.ok(new Date(missed.due_at).getTime() - now.getTime() <= 10 * 60_000);
  assert.equal(mastery(missed, now), 'learning');

  let s = review(null, Good, now);
  s = review(s, Good, new Date(s.due_at));
  assert.equal(s.state, 2, 'graduated to review');
  assert.ok(new Date(s.due_at) > new Date('2026-09-25T00:00:00Z'));
  assert.equal(mastery(s, new Date(s.last_at)), 'known');
  assert.equal(mastery(s, new Date(new Date(s.due_at).getTime() + 1000)), 'due');
});

test('a card answered right for months becomes mastered', () => {
  let s = review(null, Easy, new Date('2026-01-01T00:00:00Z'));
  for (let i = 0; i < 8; i++) s = review(s, Easy, new Date(s.due_at));
  assert.equal(mastery(s, new Date(s.last_at)), 'mastered');
  assert.equal(mastery(null), 'new');
});

test('the modes that do not test one fact alone never schedule', () => {
  assert.deepEqual(
    Object.values(MODES).filter(m => !m.schedules).map(m => m.id).sort(),
    ['choice', 'free', 'neighbours']
  );
});

// ── Settings ──────────────────────────────────────────────────────────
test('settings survive a round trip through the query string', () => {
  const s = parseSettings(new URLSearchParams('timer=5&sudden=1&attempts=1&hints=0&length=10&scope=balkans'));
  assert.equal(s.timer, '5');
  assert.equal(s.sudden, true);
  assert.equal(s.attempts, 1);
  assert.equal(s.hints, false);
  const again = parseSettings(new URLSearchParams(settingsQuery(s, 'name')));
  assert.deepEqual(again, s);
});

test('nonsense in the query string falls back to the defaults', () => {
  const s = parseSettings(new URLSearchParams('timer=99&attempts=7&order=upside&scope=<script>'));
  assert.equal(s.timer, DEFAULTS.timer);
  assert.equal(s.attempts, DEFAULTS.attempts);
  assert.equal(s.order, DEFAULTS.order);
  assert.equal(s.scope, 'script');
});

test('a harder run is a different personal best', () => {
  const easy = pbKey('europe', 'name', DEFAULTS);
  const hard = pbKey('europe', 'name', { ...DEFAULTS, hints: false });
  const reordered = pbKey('europe', 'name', { ...DEFAULTS, order: 'west', labels: false });
  assert.notEqual(easy, hard);
  assert.equal(easy, reordered, 'order and labels do not change difficulty');
});

// ── Decks and references ──────────────────────────────────────────────
test('the launch decks have the counts the spec promises', () => {
  const count = (slug: string) => deckPlaceKeys(deckBySlug(slug)!).length;
  assert.equal(count('us-states'), 50);
  assert.equal(count('us-capitals'), 50);
  assert.equal(count('africa'), 55, '54 and Western Sahara');
  assert.equal(count('south-america'), 12);
  assert.equal(count('oceania'), 14);
  assert.equal(count('world-capitals'), 197);
  assert.equal(count('world'), 198);
  assert.equal(deckPlaceKeys(deckBySlug('world')!, { territories: true, disputed: true }).length, 203);
  assert.equal(deckPlaceKeys(deckBySlug('world')!, { territories: false, disputed: false }).length, 194);
});

test('every deck place is drawn on its map, with a capital dot where it has one', () => {
  for (const deck of MAP_DECKS) {
    const map = JSON.parse(readFileSync(new URL(`../../data/gazetteer/maps/${deck.map}.json`, import.meta.url), 'utf8'));
    for (const key of deckPlaceKeys(deck, { territories: true, disputed: true })) {
      const p = map.places[key];
      assert.ok(p, `${deck.slug}: ${key} is not on ${deck.map}`);
      assert.ok(p.d || p.small, `${deck.slug}: ${key} has neither a shape nor a dot`);
      if (deck.topic === 'capitals') assert.ok(p.cap, `${deck.slug}: ${key} has no capital dot`);
    }
  }
});

test('every region a deck offers as a scope has places in it', () => {
  for (const deck of MAP_DECKS) {
    const keys = deckPlaceKeys(deck);
    for (const r of deck.regions) assert.ok(keys.some(k => inRegion(k, r)), `${deck.slug}: ${r} is empty`);
  }
});

test('neighbours are symmetric and stay within the place list', () => {
  for (const [key, p] of Object.entries(PLACES)) {
    for (const n of p.neighbours) {
      assert.ok(PLACES[n], `${key} borders unknown ${n}`);
      assert.ok(PLACES[n].neighbours.includes(key), `${key} → ${n} but not back`);
    }
  }
  assert.deepEqual(PLACES.GUF.neighbours, ['BRA', 'SUR']);
  assert.ok(!PLACES.FRA.neighbours.includes('BRA'));
  assert.ok(PLACES['US-UT'].neighbours.includes('US-CO'));
  assert.ok(!PLACES['US-UT'].neighbours.includes('US-NM'), 'Four Corners is a point, not a border');
});

test('references parse back to what made them', () => {
  assert.deepEqual(parseRef(placeRef('FRA', 'name')), { kind: 'place', key: 'FRA', dir: 'name' });
  assert.deepEqual(parseRef(placeRef('US-TX', 'country')), { kind: 'place', key: 'US-TX', dir: 'country' });
  assert.equal(placeRef('FRA', 'country'), 'capital:FRA:country');
  assert.deepEqual(parseRef('card:0f8b8a57-5d5e-4d0a-9b8e-1f2e3d4c5b6a:rev'), {
    kind: 'card', id: '0f8b8a57-5d5e-4d0a-9b8e-1f2e3d4c5b6a', dir: 'rev',
  });
  assert.equal(parseRef('place:FRA:dance'), null);
  assert.equal(parseRef("place:FRA:name'; drop table"), null);
  assert.ok(REF_PATTERN.test('place:US-DC:locate'));
});

test('a fact is reviewed on the smallest map that shows it', () => {
  assert.equal(homeDeck('place:FRA:name'), 'europe');
  assert.equal(homeDeck('place:RUS:locate'), 'europe');
  assert.equal(homeDeck('capital:JPN:country'), 'asia-capitals');
  assert.equal(homeDeck('place:US-TX:capital'), 'us-capitals');
  assert.equal(homeDeck('place:US-TX:name'), 'us-states');
  for (const key of Object.keys(PLACES)) {
    assert.ok(deckBySlug(homeDeck(placeRef(key, 'name'))!), key);
  }
});

// ── Flashcard CSV ─────────────────────────────────────────────────────
test('a CSV with a header in any order imports', () => {
  const { cards, problems } = parseCards(
    'answer,prompt,accepts,reverse\r\nle chien,the dog,chien|un chien,yes\r\n"la maison, grande",the big house,,\n'
  );
  assert.deepEqual(problems, []);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    prompt: 'the dog', answer: 'le chien', accepts: ['chien', 'un chien'], hint: '', notes: '', tags: [], reverse: true,
  });
  assert.equal(cards[1].answer, 'la maison, grande');
});

test('a CSV without a header is read in the documented order', () => {
  const { cards } = parseCards('the cat,le chat\n');
  assert.equal(cards[0].prompt, 'the cat');
  assert.equal(cards[0].answer, 'le chat');
});

test('problems are found before anything is saved', () => {
  const { problems } = parseCards('prompt,answer\nthe dog,le chien\n,le chat\nthe dog,un chien\nthe hound,Le Chien\n');
  const lines = problems.map(p => p.line);
  assert.ok(lines.includes(3), 'empty prompt');
  assert.ok(lines.includes(4), 'repeated prompt');
  assert.ok(lines.includes(5), 'answer repeated after normalising');
});

test('export and import are inverses', () => {
  const cards = [
    { prompt: 'a "quoted" word', answer: 'x, y', accepts: ['z'], hint: 'h', notes: 'line\nbreak', tags: ['t1', 't2'], reverse: true },
  ];
  const back = parseCards(toCsv(cards));
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.cards, cards);
  assert.deepEqual(checkCards(back.cards), []);
});

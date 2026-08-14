import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeskReply, validateWriteup } from './wbpr';
import type { AgentState } from '../../wbpr-agent';

/**
 * Fixtures of known-bad output.
 *
 * A validator with no failing fixture has never been shown to detect anything,
 * and the rules being checked here are ones that hold today only because the
 * model chooses to comply. These are the cases that prove the check would
 * notice if it stopped.
 *
 *     node --experimental-strip-types --test src/lib/ai/validators/wbpr.test.ts
 */

const state: AgentState = {
  session: 10,
  date: '1976-08-14',
  block: 1,
  cards: [
    { name: '7 of Clubs', tone: 'Something that changed your taste' },
    { name: '2 of Hearts', tone: 'A kindness' },
    { name: 'King of Spades', tone: 'An authority' },
  ],
  caller: null,
  blocks: [
    {
      position: 1,
      cards: [
        { name: '7 of Clubs', tone: 'Something that changed your taste' },
        { name: '2 of Hearts', tone: 'A kindness' },
        { name: 'King of Spades', tone: 'An authority' },
      ],
      caller: null,
    },
  ],
};

test('a reply naming only the cards that were dealt passes', () => {
  const reply = 'Cards are down. 7 of Clubs, 2 of Hearts, King of Spades. Your call, Oso.';
  assert.equal(validateDeskReply(reply, state).status, 'pass');
});

test('a dealt card restated in words is still the same card', () => {
  // The deck deals "7 of Clubs" and prose says "Seven of Clubs". Matching only
  // the numeral form failed in both directions at once, and this fixture is the
  // one that caught it.
  const reply = 'The Seven of Clubs, then. Something that changed your taste.';
  assert.equal(validateDeskReply(reply, state).status, 'pass');
});

test('a card that was never drawn is a failure, not a warning', () => {
  // The app dealt the cards, so this one is fully determined — there is no
  // judgement in it and nothing to be generous about.
  const reply = 'The Nine of Diamonds turns over next, and the lookout goes quiet.';
  const result = validateDeskReply(reply, state);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.findings, [{ rule: 'invented-card', detail: 'Nine of Diamonds' }]);
});

test('naming music the DJ did not name is a warning', () => {
  // A warning rather than a failure: detection is a heuristic, and a false
  // positive that blocked a broadcast would be worse than the thing it guards.
  const reply = 'Good pick. Follow it with something by Townes Van Zandt.';
  const result = validateDeskReply(reply, state);
  assert.equal(result.status, 'warn');
});

test('music the DJ named himself is his to name', () => {
  const said = "I'm playing Pancho and Lefty by Townes Van Zandt.";
  const reply = 'Townes Van Zandt at this hour. That will hold them.';
  assert.equal(validateDeskReply(reply, state, said).status, 'pass');
});

test('a card takes precedence over a music warning', () => {
  const reply = 'The Nine of Diamonds. Try something by Judee Sill after this.';
  assert.equal(validateDeskReply(reply, state, '').status, 'fail');
});

test('an unparseable write-up is recorded as a failure', () => {
  // The cheapest quality metric there is, and the first to move when a prompt
  // or a model changes.
  assert.equal(validateWriteup(null, state).status, 'fail');
});

test('a write-up citing a block that never happened fails', () => {
  const payload = { blocks: [{ position: 1 }, { position: 3 }] };
  const result = validateWriteup(payload, state);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.findings, [{ rule: 'invented-block', detail: 'block 3' }]);
});

test('a write-up covering exactly the blocks that were played passes', () => {
  assert.equal(validateWriteup({ blocks: [{ position: 1 }] }, state).status, 'pass');
});

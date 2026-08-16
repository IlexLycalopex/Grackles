import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExpectations, validatorFor } from './golden';
import type { AgentState } from '../wbpr-agent';

/**
 * The part of a golden run that decides whether a release ships.
 *
 * Separated from everything that talks to a network precisely so it can be
 * checked here: a suite whose pass/fail logic is itself untested is a suite
 * that will one day pass everything.
 */

const state: AgentState = {
  block: 1,
  cards: [{ name: '7 of Clubs', tone: 'Something that changed your taste' }],
  caller: null,
  blocks: [{ position: 1, cards: [{ name: '7 of Clubs', tone: 'x' }], caller: null }],
};

test('a case expecting a clean answer accepts one', () => {
  const findings = checkExpectations('anything at all', { validator: 'pass' }, { status: 'pass' });
  assert.deepEqual(findings, []);
});

test('a warning fails a case that demanded a pass', () => {
  const findings = checkExpectations('x', { validator: 'pass' }, { status: 'warn' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'validator');
});

test('a warning satisfies a case that only demanded no failure', () => {
  assert.deepEqual(checkExpectations('x', { validator: 'warn' }, { status: 'warn' }), []);
});

test('a missing validation counts as a failure, not as a pass', () => {
  // The absent case is the dangerous one: a validator that failed to run at all
  // must not read as an answer that met its rules.
  const findings = checkExpectations('x', { validator: 'pass' }, null);
  assert.equal(findings.length, 1);
});

test('json_contains compares values, not just keys', () => {
  const answer = '{"match":0,"genre":"Fantasy"}';
  assert.deepEqual(checkExpectations(answer, { json_contains: { match: 0 } }, null), []);

  const wrong = checkExpectations(answer, { json_contains: { match: 1 } }, null);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0].detail, /expected 1, got 0/);
});

test('json_contains fails loudly when there is no JSON', () => {
  const findings = checkExpectations('sorry', { json_contains: { match: 0 } }, null);
  assert.equal(findings[0].rule, 'json');
});

test('must_not_include is case-insensitive', () => {
  // The rule it usually encodes is "never name a track", and a model that
  // capitalises differently has still named the track.
  const findings = checkExpectations(
    'Try some TOWNES VAN ZANDT after this.',
    { must_not_include: ['townes van zandt'] },
    null
  );
  assert.equal(findings.length, 1);
});

test('several failures are all reported, not just the first', () => {
  // A run that stopped at the first problem would need as many runs as there
  // are problems, each costing a call.
  const findings = checkExpectations(
    '{"match":2}',
    { validator: 'pass', json_contains: { match: 0 }, must_not_include: ['match'] },
    { status: 'fail' }
  );
  assert.equal(findings.length, 3);
});

test('a desk case rebuilds its validator from frozen state', () => {
  const validate = validatorFor('wbpr.desk', { state, said: '' });
  assert.ok(validate);
  assert.equal(validate('The 7 of Clubs is down.').status, 'pass');
  assert.equal(validate('The Nine of Diamonds turns over.').status, 'fail');
});

test('a case with no context has no validator rather than a wrong one', () => {
  // Silently validating against empty state would pass everything, which is
  // worse than admitting the case cannot be judged.
  assert.equal(validatorFor('wbpr.desk', {}), null);
  assert.equal(validatorFor('reading.enrich', {}), null);
});

test('an unknown feature has no validator', () => {
  assert.equal(validatorFor('nope.nope', { state }), null);
});

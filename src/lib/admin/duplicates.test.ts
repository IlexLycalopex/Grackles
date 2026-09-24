import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, looksLikeSamePerson } from './duplicates.ts';

const person = (id: string, email: string, display_name = '') => ({ id, email, display_name });

const jamie = person('j', 'alexander.jameswatts@gmail.com', 'Jamie');
const nickProton = person('np', 'nickgwatts@proton.me', 'nickgwatts');
const nickGmail = person('ng', 'watts.nick@gmail.com', 'watts.nick');

test('the two Nick accounts are recognised as one person', () => {
  assert.equal(looksLikeSamePerson(nickGmail, nickProton), true);
  assert.equal(looksLikeSamePerson(nickProton, nickGmail), true);
});

test('a shared surname alone is not enough', () => {
  assert.equal(looksLikeSamePerson(jamie, nickGmail), false);
  assert.equal(looksLikeSamePerson(jamie, nickProton), false);
});

test('the same address at two providers is recognised', () => {
  assert.equal(looksLikeSamePerson(person('a', 'rob.smith@gmail.com'), person('b', 'robsmith@proton.me')), true);
});

test('a single short word does not match everything that contains it', () => {
  assert.equal(looksLikeSamePerson(person('a', 'tom@x.com'), person('b', 'tomkins.anne@y.com')), false);
});

test('the same display name is a match, an empty one is not', () => {
  assert.equal(looksLikeSamePerson(person('a', 'a@x.com', 'Rob'), person('b', 'b@y.com', 'rob')), true);
  assert.equal(looksLikeSamePerson(person('a', 'a@x.com', ''), person('b', 'b@y.com', '')), false);
});

test('an account is never its own duplicate', () => {
  assert.equal(looksLikeSamePerson(nickGmail, nickGmail), false);
});

test('findDuplicates pairs them both ways and leaves everyone else out', () => {
  const found = findDuplicates([jamie, nickProton, nickGmail]);
  assert.deepEqual(found.get('ng')?.map(p => p.id), ['np']);
  assert.deepEqual(found.get('np')?.map(p => p.id), ['ng']);
  assert.equal(found.has('j'), false);
});

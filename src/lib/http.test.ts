import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiFailureStatus, aiRefusalStatus } from './http.ts';

test('money refusals are 402, and only those', () => {
  for (const code of ['GRK15', 'GRK16', 'GRK18']) assert.equal(aiRefusalStatus(code), 402, code);
  // The one the WBPR routes used to report as 402: not the owner.
  assert.equal(aiRefusalStatus('GRK13'), 403);
});

test('the other gates say what they are', () => {
  assert.equal(aiRefusalStatus('GRK14'), 429);
  assert.equal(aiRefusalStatus('GRK1F'), 503);
  assert.equal(aiRefusalStatus('GRK10'), 404);
  assert.equal(aiRefusalStatus(undefined), 403);
});

test('a refusal mid-call is a refusal, not a provider failure', () => {
  assert.equal(aiFailureStatus({ code: 'GRK15', error: 'spent' }), 402);
  assert.equal(aiFailureStatus({ code: 'GRK1F', error: 'down' }), 503);
});

test('a provider failure is 502, an unset key 503', () => {
  assert.equal(aiFailureStatus({ error: 'Nothing came back: timeout.' }), 502);
  assert.equal(aiFailureStatus({ error: 'The model is not configured — MINIMAX_API_KEY is unset.' }), 503);
});

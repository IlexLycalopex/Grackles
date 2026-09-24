import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from './redirect.ts';

const F = '/dashboard';

test('a path on this site is kept, query and fragment included', () => {
  assert.equal(safeNext('/reading/mine/2026?tab=a#b', F), '/reading/mine/2026?tab=a#b');
  assert.equal(safeNext('/invite/abc123', F), '/invite/abc123');
});

test('anything that leaves the site falls back', () => {
  for (const raw of [
    '//evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/\t/evil.example',
    '/\n/evil.example',
    'evil.example',
    '',
  ]) {
    assert.equal(safeNext(raw, F), F, JSON.stringify(raw));
  }
});

test('a missing or non-string value falls back', () => {
  assert.equal(safeNext(null, F), F);
  assert.equal(safeNext(undefined, F), F);
  assert.equal(safeNext(42, F), F);
});

test('dot segments are resolved rather than trusted', () => {
  assert.equal(safeNext('/a/../settings/ai', F), '/settings/ai');
});

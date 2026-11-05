import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, lastMonths, parseTags, plural, weekStart } from './podcasts.ts';

test('one of a thing is singular', () => {
  assert.equal(plural(1, 'episode'), '1 episode');
  assert.equal(plural(5, 'episode'), '5 episodes');
  assert.equal(plural(3647, 'episode'), '3,647 episodes');
  assert.equal(plural(0, 'show'), '0 shows');
});

test('durations read the way a person would say them', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(42 * 60), '42m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(4 * 3600 + 20 * 60), '4h 20m');
  assert.equal(formatDuration(913 * 3600 + 12 * 60), '913h');
});

test('tags are typed loosely and stored strictly', () => {
  assert.deepEqual(parseTags('Argentina, latin america ,argentina,'), {
    ok: true,
    tags: ['argentina', 'latin-america'],
  });
  assert.deepEqual(parseTags(''), { ok: true, tags: [] });
});

test('a tag the database would refuse is refused here first', () => {
  const r = parseTags('argentina, mañana');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /mañana/);
});

test('twenty tags at most', () => {
  const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
  assert.equal(parseTags(many).ok, false);
});

test('a quiet month is a zero, not a missing bar', () => {
  const months = lastMonths(
    [{ month: '2026-09-01', seconds: 600, episodes: 1 }],
    3,
    new Date('2026-11-05T12:00:00Z')
  );
  assert.deepEqual(
    months.map(m => [m.month, m.seconds]),
    [
      ['2026-09-01', 600],
      ['2026-10-01', 0],
      ['2026-11-01', 0],
    ]
  );
});

test('a week starts on Monday, in London', () => {
  assert.equal(weekStart(new Date('2026-11-05T12:00:00Z')), '2026-11-02');
  assert.equal(weekStart(new Date('2026-11-02T00:30:00Z')), '2026-11-02');
  assert.equal(weekStart(new Date('2026-11-01T23:30:00Z')), '2026-10-26');
});

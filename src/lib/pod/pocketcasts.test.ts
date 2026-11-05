import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseAndroidHistory,
  normaliseWebEpisode,
  statusFromAndroid,
  statusFromWeb,
  type AndroidEpisode,
} from '../../../supabase/functions/_shared/pocketcasts.ts';

test('the two sources number status differently, and both map to the same three', () => {
  assert.equal(statusFromWeb(3, 0, 600), 'played');
  assert.equal(statusFromWeb(2, 100, 600), 'in_progress');
  assert.equal(statusFromWeb(1, 0, 600), 'unplayed');
  assert.equal(statusFromAndroid(2, 0, 600), 'played');
  assert.equal(statusFromAndroid(1, 100, 600), 'in_progress');
  assert.equal(statusFromAndroid(0, 0, 600), 'unplayed');
});

test('the last thirty seconds count as the end, whatever the number says', () => {
  assert.equal(statusFromWeb(2, 580, 600), 'played');
  assert.equal(statusFromAndroid(1, 580, 600), 'played');
  assert.equal(statusFromWeb(2, 560, 600), 'in_progress');
});

test('a position with no status is progress, not nothing', () => {
  assert.equal(statusFromWeb(undefined, 90, 600), 'in_progress');
});

test('a web episode without its two ids is skipped rather than guessed at', () => {
  assert.equal(normaliseWebEpisode({ uuid: 'e1' }), null);
  assert.equal(normaliseWebEpisode({ podcastUuid: 's1' }), null);
});

test('a web episode maps onto an ingest row', () => {
  const row = normaliseWebEpisode({
    uuid: 'e1',
    podcastUuid: 's1',
    podcastTitle: ' The Argentina Brief ',
    title: '#7',
    published: '2026-10-17T09:00:00Z',
    duration: 2522.4,
    playedUpTo: 2300.17,
    playingStatus: 2,
  });
  assert.deepEqual(row, {
    show_uuid: 's1',
    show_title: 'The Argentina Brief',
    show_author: '',
    uuid: 'e1',
    title: '#7',
    published_at: '2026-10-17T09:00:00.000Z',
    duration_s: 2522,
    position_s: 2300,
    status: 'in_progress',
  });
});

const ep = (uuid: string, day: string, status = 2, played = 0): AndroidEpisode => ({
  uuid,
  podcast_id: 's1',
  podcast_title: 'Show',
  podcast_author: null,
  title: uuid,
  published_date: null,
  duration: 600,
  played_up_to: played,
  playing_status: status,
  last_playback_interaction_date: Date.parse(`${day}T12:00:00Z`),
});

test('a bulk day becomes the undated baseline, and an ordinary day keeps its date', () => {
  const bulk = Array.from({ length: 25 }, (_, i) => ep(`b${i}`, '2019-10-10'));
  const rows = normaliseAndroidHistory([...bulk, ep('real', '2021-09-13')]);

  const real = rows.find(r => r.uuid === 'real')!;
  assert.equal(real.baseline, false);
  assert.equal(real.listened_at, '2021-09-13T12:00:00.000Z');

  const marked = rows.filter(r => r.baseline);
  assert.equal(marked.length, 25);
  assert.ok(marked.every(r => r.listened_at === null));
});

test('an episode opened but never played is not history', () => {
  assert.equal(normaliseAndroidHistory([ep('opened', '2024-01-01', 0, 0)]).length, 0);
});

test('an episode never touched is not history at all', () => {
  const untouched = { ...ep('x', '2024-01-01'), last_playback_interaction_date: 0 };
  assert.equal(normaliseAndroidHistory([untouched]).length, 0);
});

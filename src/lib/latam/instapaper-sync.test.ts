import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseString, isRead, language, minutesFor, readBookmarks, sign, tagsFor, textOf, wordCount,
} from '../../../supabase/functions/_shared/instapaper.ts';

test('OAuth 1.0a signature matches the published worked example', async () => {
  // Twitter's documented example of signing a request, the usual check for an
  // OAuth 1.0a implementation.
  const header = await sign(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json',
    { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    },
    'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    '1318622958'
  );
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test('the base string sorts and encodes every parameter', () => {
  assert.equal(
    baseString('post', 'https://x.test/a', { b: '2 3', a: '1' }),
    'POST&https%3A%2F%2Fx.test%2Fa&a%3D1%26b%3D2%25203'
  );
});

test('only bookmarks are read from a list, and read means nine tenths', () => {
  const b = readBookmarks([
    { type: 'meta' },
    { type: 'user', user_id: 1 },
    { type: 'bookmark', bookmark_id: 7, url: 'https://e.test', title: 'T', progress: 0.95, progress_timestamp: 1, time: 1 },
    { type: 'bookmark', bookmark_id: 8, url: 'https://e.test/2', title: 'U', progress: 0.3, progress_timestamp: 1, time: 1 },
  ]);
  assert.deepEqual(b.map(x => x.bookmark_id), [7, 8]);
  assert.deepEqual(b.filter(isRead).map(x => x.bookmark_id), [7]);
  assert.deepEqual(readBookmarks({ bookmarks: [{ type: 'bookmark', bookmark_id: 3 }] }).map(x => x.bookmark_id), [3]);
});

test('an article is its words, not its markup', () => {
  const t = textOf('<h1>El Chaltén</h1><script>x()</script><p>Fitz&nbsp;Roy &amp; Cerro Torre &#233;</p>');
  assert.equal(t, 'El Chaltén Fitz Roy & Cerro Torre é');
  assert.equal(wordCount(t), 7);
});

const ES_TEXT = 'El pueblo de Gaiman es uno de los lugares más galeses de la Patagonia, y en sus casas de té se sirve la torta negra con el mate. '.repeat(3);
const EN_TEXT = 'The town of Gaiman is one of the most Welsh places in the world, and its tea houses serve black cake with the tea. '.repeat(3);

test('Spanish and English are told apart', () => {
  assert.equal(language(ES_TEXT), 'es');
  assert.equal(language(EN_TEXT), 'en');
  assert.equal(language('Hola'), 'other');
});

const PLACES = [
  { slug: 'gaiman', name: 'Gaiman' },
  { slug: 'patagonia', name: 'Patagonia' },
  { slug: 'the-pampas', name: 'Buenos Aires and the Pampas' },
  { slug: 'el-chalten', name: 'El Chaltén' },
];

test('an article earns spanish, the focus and the places it names', () => {
  assert.deepEqual(tagsFor(ES_TEXT, '', 'es', PLACES, 'argentina').sort(), ['argentina', 'gaiman', 'patagonia', 'spanish']);
  assert.deepEqual(tagsFor('Climbing near El Chalten this spring', '', 'en', PLACES, 'argentina').sort(), ['argentina', 'el-chalten']);
  assert.deepEqual(tagsFor('A walk in the Lake District', 'Cumbria', 'en', PLACES, 'argentina'), []);
});

test('minutes are estimated at a slower pace for Spanish', () => {
  assert.equal(minutesFor(2000, 'en'), 10);
  assert.equal(minutesFor(1200, 'es'), 10);
  assert.equal(minutesFor(10, 'en'), 1);
  assert.equal(minutesFor(1e6, 'en'), 300);
});

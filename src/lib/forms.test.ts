import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badLink, spotifyWebLink } from './forms.ts';

const LABELS = { link: 'The link' };

test('blank and web addresses pass', () => {
  assert.equal(badLink({ link: '' }, LABELS), null);
  assert.equal(badLink({ link: 'https://openlibrary.org/works/OL1W' }, LABELS), null);
  assert.equal(badLink({ link: 'HTTP://example.com' }, LABELS), null);
});

test('anything that would run or open an app is refused', () => {
  for (const link of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'intent://album/x', '//evil.example', 'example.com']) {
    assert.match(badLink({ link }, LABELS) ?? '', /^The link has to be a web address/, link);
  }
});

test('a Spotify app link becomes the web link it stands for', () => {
  assert.equal(
    spotifyWebLink('intent://album/4nOym5RKE8Opauf3rMxPAW#Intent;scheme=spotify;package=com.spotify.music;end'),
    'https://open.spotify.com/album/4nOym5RKE8Opauf3rMxPAW'
  );
  assert.equal(spotifyWebLink('https://open.spotify.com/album/x'), 'https://open.spotify.com/album/x');
  assert.equal(spotifyWebLink('javascript:alert(1)'), 'javascript:alert(1)');
});

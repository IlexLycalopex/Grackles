import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitProjectPath, projectHref, workspaceHref } from './apps.ts';

test('a project root is read as app and slug', () => {
  const found = splitProjectPath('/cigars/jamie');
  assert.equal(found?.app.slug, 'cigar-lounge');
  assert.equal(found?.slug, 'jamie');
  assert.equal(found?.rest, '');
});

test('what comes after the project is kept, so a forward lands on the same page', () => {
  const found = splitProjectPath('/reading/jamie/2026/the-passenger');
  assert.equal(found?.slug, 'jamie');
  assert.equal(found?.rest, '/2026/the-passenger');
});

test('a trailing slash is not a page below the project', () => {
  // '/lp/brothers/'.split('/') ends in an empty segment, which would otherwise
  // forward to '/lp/siblings/' — harmless, but a second redirect.
  assert.equal(splitProjectPath('/lp/brothers/')?.rest, '/');
});

test('a settings page belongs to the project it settles', () => {
  const found = splitProjectPath('/settings/cigars/jamie');
  assert.equal(found?.app.slug, 'cigar-lounge');
  assert.equal(found?.slug, 'jamie');
  assert.equal(found?.prefix, '/settings');
});

test('pages that are not projects are not mistaken for them', () => {
  for (const path of ['/', '/dashboard', '/cigars', '/new', '/settings/cigars', '/settings/ai']) {
    assert.equal(splitProjectPath(path), null, path);
  }
});

test('an unknown first segment is not an app', () => {
  assert.equal(splitProjectPath('/api/reading/jamie'), null);
});

test('a project served from elsewhere links there, and one served here does not', () => {
  assert.equal(
    projectHref({ app: 'scoundrel', slug: 'jamie', external_url: 'https://example.com/s/' }),
    'https://example.com/s/'
  );
  assert.equal(projectHref({ app: 'cigar-lounge', slug: 'jamie', external_url: '' }), '/cigars/jamie');
  assert.equal(workspaceHref('reading-list', 'jamie'), '/reading/jamie');
});

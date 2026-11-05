import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookHost, isFetchable, readPage, wordCount } from './page.ts';

test('only named public hosts are fetched', () => {
  assert.ok(isFetchable('https://www.lanacion.com.ar/politica/x'));
  for (const bad of [
    'ftp://example.com/x',
    'http://localhost:3000',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://intranet/',
    'https://user:pw@example.com/',
    'http://printer.local/',
    'not a url',
  ]) {
    assert.equal(isFetchable(bad), null, bad);
  }
});

test('book sites are books, with or without www', () => {
  assert.ok(isBookHost('www.goodreads.com'));
  assert.ok(isBookHost('uk.bookshop.org'));
  assert.ok(!isBookHost('www.theguardian.com'));
  assert.ok(!isBookHost('notgoodreads.com'));
});

test('an article is titled from og:title and counted without its scripts', () => {
  const html = `<html><head><title>Ignored</title>
    <meta property="og:title" content="Milei y el peso &amp; la inflación">
    <meta property="og:type" content="article">
    <script>var a = "lots of words that are not words";</script></head>
    <body><nav>Menu Home About</nav><p>Uno dos tres cuatro cinco.</p><p>Seis siete 42.</p></body></html>`;
  const facts = readPage(new URL('https://example.com/a'), html);
  assert.deepEqual(facts, { kind: 'article', title: 'Milei y el peso & la inflación', words: 7 });
});

test('a book page is a book and is not counted', () => {
  const facts = readPage(new URL('https://www.goodreads.com/book/show/1'), '<title>Facundo by Sarmiento</title><p>long blurb</p>');
  assert.equal(facts.kind, 'book');
  assert.equal(facts.words, 0);
  assert.equal(facts.title, 'Facundo by Sarmiento');
});

test('og:type book makes any site a book', () => {
  const html = '<meta content="book" property="og:type"><title>Rayuela</title>';
  assert.equal(readPage(new URL('https://example.com/r'), html).kind, 'book');
});

test('a page with no title falls back to its host', () => {
  assert.equal(readPage(new URL('https://example.com/x'), '<p>hola</p>').title, 'example.com');
});

test('numbers alone are not words', () => {
  assert.equal(wordCount('<p>12 34 56 hola</p>'), 1);
});

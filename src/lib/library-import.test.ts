import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldFor, judge, parseUpload, summarise, type ExistingEntry } from './library-import.ts';
import { workKey } from './library.ts';

const entry = (title: string, author: string, id = title): ExistingEntry => ({
  id,
  title,
  author,
  work_key: workKey(title, author),
});

const rowsOf = (text: string) => {
  const parsed = parseUpload(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed;
};

// ── reading the file ────────────────────────────────────────────────

test('a plain CSV', () => {
  const { rows } = rowsOf('title,author\nPiranesi,Susanna Clarke\nDune,Frank Herbert');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.mapped.title, 'Piranesi');
  assert.equal(rows[1]!.mapped.author, 'Frank Herbert');
});

test('a title with a comma in it survives its quotes', () => {
  const { rows } = rowsOf('title,author\n"Cloud Atlas, or Six Lives",David Mitchell');
  assert.equal(rows[0]!.mapped.title, 'Cloud Atlas, or Six Lives');
  assert.equal(rows[0]!.mapped.author, 'David Mitchell');
});

test('a doubled quote is one quote', () => {
  const { rows } = rowsOf('title,author\n"The ""Genius"" Myth",Helen Lewis');
  assert.equal(rows[0]!.mapped.title, 'The "Genius" Myth');
});

test('tabs win over commas when a file has both', () => {
  const { rows } = rowsOf('title\tauthor\nCloud Atlas, or Six Lives\tDavid Mitchell');
  assert.equal(rows[0]!.mapped.title, 'Cloud Atlas, or Six Lives');
});

test('a JSON array', () => {
  const { rows } = rowsOf('[{"title":"Piranesi","author":"Susanna Clarke"}]');
  assert.equal(rows[0]!.mapped.title, 'Piranesi');
});

test('JSON lines', () => {
  const { rows } = rowsOf('{"title":"Piranesi"}\n{"title":"Dune"}');
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.mapped.title, 'Dune');
});

test('a wrapper object with the list inside it', () => {
  const { rows } = rowsOf('{"books":[{"title":"Piranesi"}],"count":1}');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.mapped.title, 'Piranesi');
});

test('a JSON array value becomes a list', () => {
  const { rows } = rowsOf('[{"title":"Dune","tags":["sf","desert"]}]');
  assert.equal(rows[0]!.mapped.tags, 'sf, desert');
});

test('headers are matched however they are punctuated', () => {
  assert.equal(fieldFor('Page Count'), 'pages');
  assert.equal(fieldFor('page_count'), 'pages');
  assert.equal(fieldFor('PAGE-COUNT'), 'pages');
  assert.equal(fieldFor('First Published'), 'year_published');
  assert.equal(fieldFor('nothing like a book'), null);
});

/**
 * The rule the whole design rests on: a file came from photographs that may not
 * be taken again, so a column nobody recognised is kept and shown rather than
 * dropped.
 */
test('an unrecognised column is kept and reported', () => {
  const { rows, unmapped } = rowsOf('title,shelf location,condition\nDune,Study top,Good');
  assert.deepEqual(unmapped, ['shelf location', 'condition']);
  assert.equal(rows[0]!.raw['shelf location'], 'Study top');
  assert.equal(rows[0]!.raw['condition'], 'Good');
});

test('a file with no title column is refused rather than half-read', () => {
  const parsed = parseUpload('writer,pages\nSusanna Clarke,272');
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /title/);
});

test('an empty file says so', () => {
  const parsed = parseUpload('   ');
  assert.ok(!parsed.ok);
});

test('too many rows is refused with the number in the sentence', () => {
  const many = ['title', ...Array.from({ length: 2001 }, (_, i) => `Book ${i}`)].join('\n');
  const parsed = parseUpload(many);
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /2001/);
});

// ── the verdicts ────────────────────────────────────────────────────

test('a book nobody has heard of is new, and is added', () => {
  const { rows } = rowsOf('title,author\nPiranesi,Susanna Clarke');
  const [judged] = judge(rows, []);
  assert.equal(judged!.verdict, 'new');
  assert.equal(judged!.decision, 'add');
});

/**
 * The majority verdict on a real import, and the one whose default matters
 * most: a photograph of a book already in the library is evidence of ownership,
 * not a row to skip.
 */
test('a book already in the library is known, and is confirmed', () => {
  const { rows } = rowsOf('title,author\nPiranesi,Susanna Clarke');
  const [judged] = judge(rows, [entry('Piranesi', 'Susanna Clarke')]);
  assert.equal(judged!.verdict, 'known');
  assert.equal(judged!.decision, 'confirm');
  assert.equal(judged!.match_library_id, 'Piranesi');
});

test('it is still known when the file spells the author differently', () => {
  const { rows } = rowsOf('title,author\nPiranesi,S. Clarke');
  const [judged] = judge(rows, [entry('Piranesi', 'Susanna Clarke')]);
  assert.equal(judged!.verdict, 'known');
});

test('the same book twice in one file is a duplicate, and is skipped', () => {
  const { rows } = rowsOf('title,author\nPiranesi,Susanna Clarke\nPiranesi,Susanna Clarke');
  const judged = judge(rows, []);
  assert.equal(judged[0]!.verdict, 'new');
  assert.equal(judged[1]!.verdict, 'duplicate_in_batch');
  assert.equal(judged[1]!.decision, 'skip');
});

test('a near-miss is ambiguous, and has no default decision', () => {
  const { rows } = rowsOf('title,author\nTrial,Franz Kafka');
  const [judged] = judge(rows, [entry('The Trial', 'Franz Kafka')]);
  assert.equal(judged!.verdict, 'ambiguous');
  assert.equal(judged!.decision, 'skip');
  assert.equal(judged!.match_library_id, 'The Trial');
});

test('an exact match beats a near one', () => {
  const { rows } = rowsOf('title,author\nThe Trial,Franz Kafka');
  const [judged] = judge(rows, [entry('Trial', 'Franz Kafka'), entry('The Trial', 'Franz Kafka', 'exact')]);
  assert.equal(judged!.verdict, 'known');
  assert.equal(judged!.match_library_id, 'exact');
});

test('a row with no title is unreadable whatever else it carries', () => {
  const { rows } = rowsOf('title,author,pages\n,Susanna Clarke,272');
  const [judged] = judge(rows, []);
  assert.equal(judged!.verdict, 'unreadable');
  assert.equal(judged!.decision, 'skip');
});

test('two volumes of a series are two new books, not a duplicate', () => {
  const { rows } = rowsOf('title,author\nChew Vol 3,John Layman\nChew Vol 9,John Layman');
  const judged = judge(rows, []);
  assert.equal(judged[0]!.verdict, 'new');
  assert.equal(judged[1]!.verdict, 'new');
});

test('a blank author never matches on the title alone', () => {
  const { rows } = rowsOf('title,author\nBlindness,');
  const [judged] = judge(rows, [entry('Blindness', 'José Saramago')]);
  assert.equal(judged!.verdict, 'new');
});

// ── the values a row carries ────────────────────────────────────────

test('bindings collapse to the three formats the app has', () => {
  const { rows } = rowsOf(
    'title,format\nA,Hardback\nB,Audiobook\nC,Graphic Novel\nD,Paperback\nE,'
  );
  const judged = judge(rows, []);
  assert.deepEqual(judged.map(j => j.values.format), ['print', 'audio', 'graphic', 'print', 'print']);
});

test('an ISBN keeps only what an ISBN is made of', () => {
  const { rows } = rowsOf('title,isbn\nDune,978-1-85723-937-1');
  assert.equal(judge(rows, [])[0]!.values.isbn, '9781857239371');
});

test('numbers survive the units somebody put beside them', () => {
  const { rows } = rowsOf('title,pages,year\nDune,912 pages,1965');
  const [judged] = judge(rows, []);
  assert.equal(judged!.values.pages, 912);
  assert.equal(judged!.values.year_published, 1965);
});

test('tags split on any of the separators a file might use', () => {
  const { rows } = rowsOf('title,tags\nDune,"sf; desert | classic"');
  assert.deepEqual(judge(rows, [])[0]!.values.tags, ['sf', 'desert', 'classic']);
});

/**
 * "Did not say" and "said no" are different, and only the first falls through
 * to the batch default. A file that carries a read column has an opinion.
 */
test('a read column is believed, and its absence is not a no', () => {
  const { rows } = rowsOf('title,read\nA,yes\nB,no\nC,\nD,finished\nE,to-read');
  const judged = judge(rows, []);
  assert.deepEqual(judged.map(j => j.read_decision), [true, false, null, true, false]);

  const { rows: none } = rowsOf('title\nA');
  assert.equal(judge(none, [])[0]!.read_decision, null);
});

test('a summary counts every verdict', () => {
  const { rows } = rowsOf('title,author\nPiranesi,Susanna Clarke\nDune,Frank Herbert\n,\nDune,Frank Herbert');
  const counts = summarise(judge(rows, [entry('Piranesi', 'Susanna Clarke')]));
  assert.deepEqual(counts, {
    new: 1, known: 1, duplicate_in_batch: 1, unreadable: 1, ambiguous: 0,
  });
});

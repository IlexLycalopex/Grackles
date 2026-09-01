import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, cacheKeyFor, vocabulary, SOURCES, MOST } from './search.ts';

/**
 * The validator is the only thing standing between a model's suggestion and a
 * query, so these are mostly about what it refuses.
 *
 * The important cases are not "does a good plan work" but "does a plan that
 * looks nearly right get through". A refusal that leaks is the whole failure
 * mode: nothing here is a SQL injection, because no SQL is generated, but a
 * column that is not in the allowlist reaching PostgREST would either error or,
 * worse, work — and a search that quietly answers a different question is the
 * one nobody catches.
 */

const ok = (raw: unknown) => {
  const r = checkPlan(raw);
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.reason}`);
  return r.ok ? r : (undefined as never);
};

const refused = (raw: unknown) => {
  const r = checkPlan(raw);
  assert.equal(r.ok, false, 'expected a refusal');
  return r.ok ? (undefined as never) : r;
};

test('a plain plan passes', () => {
  const { plan, source } = ok({
    source: 'books',
    filters: [{ column: 'date_finished', op: 'is_null' }],
    limit: 20,
  });
  assert.equal(source.table, 'rl_books');
  assert.deepEqual(plan.filters, [{ column: 'date_finished', op: 'is_null' }]);
});

test('no conditions is a valid question, not a failure', () => {
  const { plan } = ok({ source: 'cigars', filters: [], limit: 10 });
  assert.deepEqual(plan.filters, []);
});

test('a table nobody offered is refused', () => {
  refused({ source: 'profiles', filters: [], limit: 10 });
  refused({ source: 'ai_calls', filters: [], limit: 10 });
});

test('a column outside the allowlist is refused, not dropped', () => {
  const r = refused({
    source: 'books',
    filters: [{ column: 'workspace_id', op: 'eq', value: 'anything' }],
    limit: 10,
  });
  assert.match(r.reason, /workspace_id/);
});

// The point of the previous test, stated as the property it protects: a plan
// that names a column it should not must not come back as a *narrower* plan
// that runs anyway. Answering a different question silently is the failure.
test('a refused condition never becomes a partial plan', () => {
  const r = checkPlan({
    source: 'books',
    filters: [
      { column: 'author', op: 'contains', value: 'Clarke' },
      { column: 'owner_id', op: 'eq', value: 'somebody' },
    ],
    limit: 10,
  });
  assert.equal(r.ok, false);
});

test('an operator the column cannot take is refused', () => {
  refused({ source: 'books', filters: [{ column: 'title', op: 'gt', value: 'a' }], limit: 10 });
  refused({ source: 'cigars', filters: [{ column: 'status', op: 'contains', value: 'hum' }], limit: 10 });
});

test('an unparseable value is refused rather than coerced', () => {
  refused({ source: 'books', filters: [{ column: 'pages', op: 'gt', value: 'lots' }], limit: 10 });
  refused({ source: 'books', filters: [{ column: 'date_started', op: 'gte', value: 'last year' }], limit: 10 });
  refused({ source: 'cigars', filters: [{ column: 'status', op: 'eq', value: 'ashed' }], limit: 10 });
});

test('a date must be a real ISO date', () => {
  ok({ source: 'books', filters: [{ column: 'date_started', op: 'gte', value: '2023-01-01' }], limit: 10 });
  refused({ source: 'books', filters: [{ column: 'date_started', op: 'gte', value: '2023' }], limit: 10 });
  refused({ source: 'books', filters: [{ column: 'date_started', op: 'gte', value: '01/01/2023' }], limit: 10 });
});

test('an enum takes only its own values', () => {
  ok({ source: 'cigars', filters: [{ column: 'strength', op: 'eq', value: 'full' }], limit: 10 });
  refused({ source: 'cigars', filters: [{ column: 'strength', op: 'eq', value: 'very full' }], limit: 10 });
});

test('booleans accept the strings a JSON model tends to send', () => {
  const { plan } = ok({ source: 'books', filters: [{ column: 'reading', op: 'eq', value: 'true' }], limit: 5 });
  assert.equal(plan.filters[0]!.value, true);
});

test('is_null and not_null carry no value', () => {
  const { plan } = ok({
    source: 'cigars',
    filters: [{ column: 'date_smoked', op: 'is_null', value: 'ignored' }],
    limit: 5,
  });
  assert.deepEqual(plan.filters[0], { column: 'date_smoked', op: 'is_null' });
});

test('the limit is clamped rather than trusted', () => {
  assert.equal(ok({ source: 'books', filters: [], limit: 100000 }).plan.limit, MOST);
  assert.equal(ok({ source: 'books', filters: [], limit: -3 }).plan.limit, 1);
  assert.equal(ok({ source: 'books', filters: [], limit: 'lots' }).plan.limit, 20);
});

test('ordering is checked against the same allowlist as filtering', () => {
  ok({ source: 'books', filters: [], order: { column: 'pages', direction: 'asc' }, limit: 5 });
  refused({ source: 'books', filters: [], order: { column: 'workspace_id', direction: 'asc' }, limit: 5 });
});

test('a flood of conditions is refused', () => {
  refused({
    source: 'books',
    filters: Array.from({ length: 20 }, () => ({ column: 'title', op: 'contains', value: 'a' })),
    limit: 5,
  });
});

test('rubbish in is a refusal, not a throw', () => {
  refused(null);
  refused('books');
  refused({});
  refused({ source: 'books', filters: [null], limit: 5 });
  refused({ source: 'books', filters: 'everything', limit: 5 });
});

// The vocabulary the model is shown and the allowlist it is checked against are
// built from one array, and this is what says so. Two lists would drift, and
// the drift would show up as the model correctly using a column it was offered
// and being refused for it.
test('every column offered to the model is one the validator accepts', () => {
  const text = vocabulary();
  for (const source of SOURCES) {
    assert.ok(text.includes(source.key), `${source.key} is not described`);
    for (const field of source.fields) {
      assert.ok(text.includes(field.column), `${field.column} is not described`);
      const op = field.type === 'text' ? 'contains' : field.type === 'boolean' ? 'eq' : 'is_null';
      const value = { text: 'x', number: 1, date: '2020-01-01', boolean: true, enum: field.values?.[0] }[field.type];
      const r = checkPlan({
        source: source.key,
        filters: [{ column: field.column, op, value }],
        limit: 5,
      });
      assert.equal(r.ok, true, `${source.key}.${field.column} was offered but refused`);
    }
  }
});

test('no source offers a column that would identify a project or a person', () => {
  for (const source of SOURCES) {
    for (const field of source.fields) {
      // `owner(?!ship)` rather than `owner`, and the lookahead is doing real
      // work in both directions. It has to keep matching `owner_id`, which a
      // word boundary would not — `_` is a word character, so /\bowner\b/
      // misses the exact column this guard exists for. And it has to stop
      // matching rl_library.ownership, which says whether a *copy* is on the
      // shelf, wanted, gone or was never owned, and names nobody.
      assert.ok(
        !/workspace|owner(?!ship)|user_id|payer|created_by/.test(field.column),
        `${source.key}.${field.column} would let a plan ask about whose records these are`
      );
    }
  }
});

test('the cache key ignores spacing and case but not words', () => {
  assert.equal(cacheKeyFor('  Books   I never   Finished '), cacheKeyFor('books i never finished'));
  assert.notEqual(cacheKeyFor('books i finished'), cacheKeyFor('books i never finished'));
});

/**
 * The question the library exists to answer, as a plan.
 *
 * This is the whole return on making `read` a maintained column in the schema
 * rather than a join computed at query time: it reduces to one filter that the
 * plan validator already knows how to check and `runPlan` already knows how to
 * run. As a view it would have needed the search runner to learn about views.
 */
test('which unread science fiction do I own', () => {
  const checked = checkPlan({
    source: 'library',
    filters: [
      { column: 'read', op: 'eq', value: false },
      { column: 'ownership', op: 'eq', value: 'owned' },
      { column: 'genre', op: 'contains', value: 'Science Fiction' },
    ],
    order: { column: 'added_at', direction: 'asc' },
    limit: 20,
  });
  assert.equal(checked.ok, true);
});

test('ownership only accepts the four states a copy can be in', () => {
  const bad = checkPlan({
    source: 'library',
    filters: [{ column: 'ownership', op: 'eq', value: 'borrowed' }],
    limit: 5,
  });
  assert.equal(bad.ok, false);
});

test('the readings and the library are separate things to search', () => {
  const keys = SOURCES.map(s => s.key);
  assert.ok(keys.includes('books'), 'the readings are searchable');
  assert.ok(keys.includes('library'), 'the library is searchable');

  // The distinction has to survive into what the model is told, or it will pick
  // one when the question meant the other.
  const vocab = vocabulary();
  assert.match(vocab, /library — Every book owned/);
  assert.match(vocab, /read boolean/);
});

test('a library result points at the book, not at a reading of it', () => {
  const library = SOURCES.find(s => s.key === 'library')!;
  assert.equal(library.href({ id: 'abc' }, 'my-list'), '/reading/my-list/library/abc');
});

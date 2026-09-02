/**
 * The columns every search source would select, as psql assertions.
 *
 * This exists because "Ask the archive" shipped asking every table for a `slug`
 * column that only two of the five have, so a search of the books, the albums
 * or the library asked for something that did not exist and Postgres refused
 * the whole query. It was never caught because nothing compared the vocabulary
 * in TypeScript against the tables in Postgres — and no unit test can, since
 * the columns live in the database.
 *
 * So: the TypeScript names the columns, and SQL checks each one is real.
 */
import { SOURCES, columnsFor } from '../../../src/lib/ai/search.ts';

const rows = [];
for (const source of SOURCES) {
  for (const column of columnsFor(source)) {
    rows.push(`  ('${source.key}', '${source.table}', '${column}')`);
  }
}

console.log(`with wanted(source, tbl, col) as (values
${rows.join(',\n')}
)
select coalesce(
  string_agg(w.source || ' asks ' || w.tbl || '.' || w.col || ', which does not exist', E'\\n'),
  'EVERY SEARCH COLUMN EXISTS') as result
from wanted w
where not exists (
  select 1 from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = w.tbl and c.column_name = w.col
);`);

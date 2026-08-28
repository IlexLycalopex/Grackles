/**
 * The work-key fixture, as psql assertions.
 *
 * Exists so that library.sh and src/lib/library.test.ts assert the same cases
 * against the two halves of the identity fold. A case added to work-keys.json
 * is checked in SQL and in TypeScript without being written down twice.
 *
 * Emits one pipe-separated line per case: description | kind | left | right.
 */
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));

/**
 * A SQL literal. Dollar quoting, because titles carry apostrophes — except for
 * the empty string, where `$q$$q$` is ambiguous: the parser reads it as `$q$$`
 * followed by `q$`. A blank author is common enough (a spine with no room for
 * one) that this is a real case rather than a curiosity.
 */
const q = (s) => (s === '' ? "''" : `$q$${s}$q$`);

const lines = [];
for (const k of fixture.keys) {
  lines.push([`key of ${k.title}`, 'exact', `${q(k.title)},${q(k.author)}`, q(k.key)].join('|'));
}
for (const [t1, a1, t2, a2] of fixture.same) {
  lines.push([`${t1} = ${t2}`, 'same', `${q(t1)},${q(a1)}`, `${q(t2)},${q(a2)}`].join('|'));
}
for (const [t1, a1, t2, a2] of fixture.different) {
  lines.push([`${t1} <> ${t2}`, 'diff', `${q(t1)},${q(a1)}`, `${q(t2)},${q(a2)}`].join('|'));
}
console.log(lines.join('\n'));

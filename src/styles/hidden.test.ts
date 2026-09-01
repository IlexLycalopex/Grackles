import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `hidden` has to actually hide.
 *
 * The HTML `hidden` attribute works through a UA stylesheet rule,
 * `[hidden] { display: none }`, which a class selector outranks. So the moment
 * a stylesheet says `.thing { display: flex }` and a script says
 * `thing.hidden = true`, nothing happens — and it happens *silently*, because
 * every other effect of hiding still works. The library's read/unread filter
 * shipped like this: the count said "124 of 260" and all 260 books stayed on
 * screen.
 *
 * That was the second time in this repository. wbpr.css already carried the
 * fix, with a note describing the same bug wearing a different hat — an empty
 * bordered box where a hidden button should have been nothing at all. Twice is
 * a class of bug rather than a mistake, so this is the check.
 *
 * It is deliberately not "every stylesheet must carry the guard": three of them
 * scope it per component instead, which is equally correct and not worth
 * rewriting. What it asserts is the thing that actually matters — no element is
 * both *toggled by script* and *given a display by a class* without something
 * overriding it.
 */

const STYLES = 'src/styles';
const SOURCE_DIRS = ['src/pages', 'src/components', 'src/layouts'];

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const sources = SOURCE_DIRS.flatMap(walk).map(f => readFileSync(f, 'utf8'));
const allSource = sources.join('\n');

/** Comments stripped, so a rule described in prose is not read as a rule. */
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Selectors in this stylesheet that set `display`. */
function displaySelectors(css: string): Set<string> {
  const found = new Set<string>();
  for (const [, selector, body] of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[;\s])display\s*:/.test(body)) continue;
    for (const part of selector.split(',')) found.add(part.trim());
  }
  return found;
}

/**
 * Class names that are actually hidden, by the three routes this repo uses.
 *
 * Precision matters more than reach here. A first version took every class in
 * any file that mentioned `hidden` anywhere, and flagged `cigar-form` — a class
 * nothing hides, in a file that happens to contain a hidden element. A check
 * that cries wolf is worse than no check, because the next person turns it off.
 */
function toggledClasses(): Set<string> {
  const classes = new Set<string>();
  const add = (value: string) => {
    for (const name of value.split(/[\s.]+/)) {
      if (/^[a-z][a-z0-9_-]*$/.test(name)) classes.add(name);
    }
  };

  for (const source of sources) {
    // 1. An element written hidden in the markup: `<section class="result" hidden>`
    //    or `hidden={!finished}`. Its own tag is the whole of the evidence.
    for (const [, tag] of source.matchAll(/<[a-zA-Z][^>]*>/g).map(m => [m[0], m[0]] as const)) {
      if (!/\shidden(\s|=|\/|>)/.test(tag)) continue;
      const cls = tag.match(/class(?:Name)?=["'`]([^"'`]+)["'`]/);
      if (cls) add(cls[1]!);
    }

    // 2. A class named in a querySelectorAll, in a file whose script sets
    //    `.hidden`. This is how the library's cards are reached:
    //    `grid.querySelectorAll('.lib-card')` … `card.hidden = !visible`, and it
    //    is the shape the real bug had — so a check that skipped it would have
    //    been decoration.
    //
    //    All, not querySelector. A *collection* selected by class and iterated
    //    is the shape where each member gets shown or hidden; a single element
    //    fetched by class is usually being read or filled, which is what
    //    CigarLookup does with `.cigar-form` — it fills that form and hides its
    //    own panel, two unrelated facts that the looser version welded together
    //    into a false positive. Tying the selector to the variable that actually
    //    receives `.hidden` would be exact and needs dataflow; this trades a
    //    little recall to keep the check believable, which is the trade worth
    //    making for a test nobody will otherwise leave switched on.
    if (!/\.hidden\s*=/.test(source)) continue;
    for (const [, selector] of source.matchAll(/querySelectorAll<[^>]*>?\(["'`]([^"'`]+)["'`]/g)) {
      for (const part of selector.split(/[\s,>+~]+/)) {
        if (part.startsWith('.')) add(part.slice(1));
      }
    }

    // 3. An element fetched by id and then hidden. The id ties the script to the
    //    tag; the classes on that tag are what a stylesheet can reach.
    for (const [, id] of source.matchAll(/getElementById\(["'`]([^"'`]+)["'`]\)/g)) {
      const tag = source.match(new RegExp(`<[a-zA-Z][^>]*id=["'\`]${id}["'\`][^>]*>`));
      const cls = tag?.[0].match(/class(?:Name)?=["'`]([^"'`]+)["'`]/);
      if (cls) add(cls[1]!);
    }
  }
  return classes;
}

const toggled = toggledClasses();

for (const file of readdirSync(STYLES).filter(f => f.endsWith('.css'))) {
  test(`${file}: nothing is given a display that would outrank hidden`, () => {
    const css = readFileSync(join(STYLES, file), 'utf8');
    const stripped = withoutComments(css);

    // A blanket guard settles it for the whole file.
    if (/(^|[,\s])\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/m.test(stripped)) return;

    const guarded = new Set(
      [...stripped.matchAll(/\.([a-z][a-z0-9_-]*)\[hidden\]/g)].map(m => m[1]!)
    );

    const unguarded = [...displaySelectors(css)]
      // A bare class selector only: `.a .b` and `.a > .b` cannot be the element
      // the script holds, and pseudo-selectors are states rather than elements.
      .filter(s => /^\.[a-z][a-z0-9_-]*$/.test(s))
      .map(s => s.slice(1))
      .filter(name => toggled.has(name) && !guarded.has(name))
      // Only classes this stylesheet's own app uses, which the naming makes
      // decidable: a class the file never mentions is somebody else's.
      .filter(name => allSource.includes(name));

    assert.deepEqual(
      unguarded,
      [],
      `${file} gives these classes a display, and something toggles them with ` +
        `hidden — so hiding them will do nothing. Add ` +
        `\`[hidden] { display: none !important; }\` to the file, or ` +
        `\`.name[hidden] { display: none; }\` per class:\n  ` +
        unguarded.join('\n  ')
    );
  });
}

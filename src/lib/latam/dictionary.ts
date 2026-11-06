/**
 * Glossary words checked against a dictionary.
 *
 * The model proposes Spanish words and says what they mean; on its own it
 * gets regional slang wrong with confidence ("mina" as a serving of food, a
 * made-up "embleada"). Each word is looked up in English Wiktionary's Spanish
 * section, which marks regional senses with labels such as Rioplatense,
 * Argentina, Cono Sur and lunfardo. The dictionary's sense is what the page
 * shows as the meaning, a porteño or lunfardo sense first; the model's note
 * stays beside it as context, marked as the model's.
 *
 * A single word the dictionary does not have is left out. A phrase it does
 * not have is kept but marked unchecked: phrases are mostly compositional and
 * rarely have entries. If Wiktionary cannot be reached, nothing is dropped
 * and nothing is marked checked.
 */

export type Tag = 'lunfardo' | 'rioplatense' | '';

export interface CheckedWord {
  es: string;
  /** The model's note on the meaning in context. */
  en: string;
  /** The dictionary's sense, plain text; empty when unchecked. */
  dict?: string;
  /** The sense's usage labels, e.g. ["Rioplatense", "colloquial"]. */
  labels?: string[];
  tag?: Tag;
  /** The dictionary headword, when it differs from es (a plural, a verb form). */
  lemma?: string;
  url?: string;
  /** true when found in the dictionary; false for a phrase it does not have. */
  checked?: boolean;
}

export interface Sense {
  labels: string[];
  text: string;
  /** The headword this line is a form of, when it is "plural of X" and the like. */
  formOf: string;
  /** How strongly to follow formOf: 0 a plural, 1 a verb form, 2 anything else. */
  formRank: number;
}

const API = 'https://en.wiktionary.org/w/api.php';
const ARTICLE = /^(el|la|los|las|un|una|unos|unas|lo)\s+/i;
// Words inside a label list that only join labels ("usually in the plural").
const CONNECTORS = new Set(['_', 'in', 'usually', 'usually in the', 'chiefly', 'everywhere', 'by extension', 'also', 'especially', 'and', 'or', 'now', 'often', 'the', 'of', 'outside', 'except', 'possibly', 'sometimes', 'rare']);
const REGIONAL = /rioplatense|argentin|cono sur|river plate|uruguay|buenos aires|porte[ñn]/i;

export const tagFor = (labels: string[]): Tag =>
  labels.some(l => /lunfardo/i.test(l)) ? 'lunfardo' : labels.some(l => REGIONAL.test(l)) ? 'rioplatense' : '';

export const wiktionaryUrl = (title: string) => `https://en.wiktionary.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}#Spanish`;

/** One definition line of wikitext as plain English, with its labels. */
export function readSense(line: string): Sense {
  let s = line.replace(/^#+\s*/, '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const labels: string[] = [];
  let formOf = '';
  let formRank = 9;
  const form = (target: string, rank: number) => {
    if (target && rank < formRank) {
      formOf = target;
      formRank = rank;
    }
  };
  // Innermost templates first, until none are left.
  for (let i = 0; i < 20 && /\{\{[^{}]*\}\}/.test(s); i++) {
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_, body: string) => {
      const parts = body.split('|').map(p => p.trim());
      const positional = parts.filter(p => !/^[a-z0-9_-]+=/i.test(p));
      const name = (positional[0] ?? '').toLowerCase();
      if (name === 'lb' || name === 'lbl' || name === 'label') {
        labels.push(...positional.slice(2).filter(p => p && !CONNECTORS.has(p.toLowerCase())));
        return '';
      }
      if (name === 'es-verb form of') {
        form(positional[1] ?? '', 1);
        return `a form of ${positional[1] ?? ''}`;
      }
      if (/(form|plural|inflection|feminine|masculine|diminutive|augmentative|superlative|alternative spelling|alternative form|misspelling) of$/.test(name)) {
        const target = positional[2] ?? '';
        if (!/^(diminutive|augmentative|superlative)/.test(name)) form(target, /plural of$/.test(name) ? 0 : 2);
        return `${name.replace(/^es-/, '')} ${target}`;
      }
      if (['gl', 'gloss', 'q', 'qual', 'qualifier', 'i', 'qf'].includes(name)) return `(${positional.slice(1).join(', ')})`;
      if (['l', 'll', 'm', 'mention', 'link'].includes(name)) return positional[3] || positional[2] || '';
      if (name === 'w' || name === 'pedia') return positional[2] || positional[1] || '';
      if (name === 'ng' || name === 'n-g' || name === 'non-gloss definition' || name === 'non-gloss') return positional[1] ?? '';
      return '';
    });
  }
  s = s
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,;.)])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[,;:]\s*/, '');
  return { labels, text: s.slice(0, 200), formOf, formRank };
}

/** The definition lines of a page's Spanish section, or null when it has none. */
export function spanishSenses(wikitext: string): Sense[] | null {
  const at = wikitext.indexOf('==Spanish==');
  if (at < 0) return null;
  const section = wikitext.slice(at + 11).split(/\n==[^=]/)[0]!;
  const senses = section
    .split('\n')
    .filter(l => /^#[^:*#]/.test(l) || /^#\s/.test(l))
    .map(readSense)
    .filter(s => s.text || s.formOf);
  return senses.length ? senses : null;
}

/** The sense to show: a regional one if there is one, else the first that is a meaning rather than a form. */
export function bestSense(senses: Sense[]): Sense | null {
  return senses.find(s => tagFor(s.labels) && !s.formOf) ?? senses.find(s => !s.formOf) ?? null;
}

type Fetcher = typeof fetch;

/** Spanish senses for each title asked, by the title asked. Missing pages are absent. */
async function lookUp(titles: string[], fetcher: Fetcher): Promise<Map<string, { title: string; senses: Sense[] }>> {
  const out = new Map<string, { title: string; senses: Sense[] }>();
  const unique = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      redirects: '1',
      format: 'json',
      formatversion: '2',
      titles: batch.join('|'),
    });
    const res = await fetcher(`${API}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Grackles/1.0 (https://grackles.co.uk)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
    const body = (await res.json()) as {
      query?: {
        normalized?: { from: string; to: string }[];
        redirects?: { from: string; to: string }[];
        pages?: { title: string; missing?: boolean; revisions?: { slots?: { main?: { content?: string } } }[] }[];
      };
    };
    const q = body.query ?? {};
    const pages = new Map((q.pages ?? []).filter(p => !p.missing).map(p => [p.title, p]));
    for (const asked of batch) {
      let t = asked;
      t = q.normalized?.find(n => n.from === t)?.to ?? t;
      t = q.redirects?.find(r => r.from === t)?.to ?? t;
      const page = pages.get(t);
      const senses = page ? spanishSenses(page.revisions?.[0]?.slots?.main?.content ?? '') : null;
      if (page && senses) out.set(asked, { title: page.title, senses });
    }
  }
  return out;
}

/** The forms of a word worth asking for: as written, lower case, without an article. */
export function candidates(es: string): string[] {
  const bare = es.trim().replace(ARTICLE, '');
  return [...new Set([es.trim(), es.trim().toLowerCase(), bare, bare.toLowerCase()])].filter(Boolean);
}

/**
 * Each word checked: kept with the dictionary's sense, kept unchecked (a
 * phrase it lacks), or left out (a single word it lacks). `available` is
 * false when Wiktionary could not be asked, in which case every word comes
 * back as it went in.
 */
export async function checkWords<T extends { es: string; en: string }>(
  words: T[],
  fetcher: Fetcher = fetch
): Promise<{ kept: (T & CheckedWord)[]; dropped: string[]; available: boolean }> {
  if (!words.length) return { kept: [], dropped: [], available: true };
  try {
    const found = await lookUp(words.flatMap(w => candidates(w.es)), fetcher);
    const entryFor = (w: T) => candidates(w.es).map(c => found.get(c)).find(Boolean) ?? null;

    // A plural or a verb form names its headword; the meaning is there.
    const lemmas = new Map<T, string>();
    for (const w of words) {
      const e = entryFor(w);
      if (e && !bestSense(e.senses)) {
        const target = e.senses.filter(s => s.formOf).sort((a, b) => a.formRank - b.formRank)[0]?.formOf;
        if (target) lemmas.set(w, target);
      }
    }
    const lemmaPages = lemmas.size ? await lookUp([...lemmas.values()], fetcher) : new Map();

    const kept: (T & CheckedWord)[] = [];
    const dropped: string[] = [];
    for (const w of words) {
      const e = entryFor(w);
      const lemma = lemmas.get(w);
      const head = lemma ? lemmaPages.get(lemma) : e;
      const sense = head ? bestSense(head.senses) : null;
      if (head && sense) {
        kept.push({
          ...w,
          dict: sense.text,
          labels: sense.labels,
          tag: tagFor(sense.labels),
          lemma: head.title.toLowerCase() !== w.es.trim().toLowerCase().replace(ARTICLE, '') ? head.title : undefined,
          url: wiktionaryUrl(head.title),
          checked: true,
        });
      } else if (/\s/.test(w.es.trim().replace(ARTICLE, ''))) {
        kept.push({ ...w, checked: false });
      } else {
        dropped.push(w.es);
      }
    }
    return { kept, dropped, available: true };
  } catch (e) {
    console.warn('lx dictionary: Wiktionary failed', String(e).slice(0, 200));
    return { kept: words.map(w => ({ ...w })), dropped: [], available: false };
  }
}

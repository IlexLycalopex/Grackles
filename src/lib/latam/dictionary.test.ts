import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestSense, candidates, checkWords, esSenses, readSense, spanishSenses, tagFor } from './dictionary.ts';

// Lines copied from English Wiktionary, 6 Nov 2026.
const PAGES: Record<string, string> = {
  mina: `==English==\n# a mine\n\n==Spanish==\n===Noun===\n# [[mine]] {{gl|excavation from which ore is taken}}\n# [[pencil lead]]\n# {{lb|es|Cono Sur|Bolivia|colloquial}} [[woman]]\n#: {{ux|es|Esa mina}}\n# {{lb|es|Argentina|Venezuela|Bolivia|slang}} [[prostitute]]\n# {{es-verb form of|minar}}\n\n==Tagalog==\n# x`,
  bulín: `==Spanish==\n# {{lb|es|Bolivia|Rioplatense}} [[bachelor pad]]\n# [[bowline]]`,
  quilombo: `==Spanish==\n# {{lb|es|Argentina|lunfardo}} big [[mess]]\n# {{lb|es|Argentina|lunfardo}} [[brothel]]`,
  truchas: `==Spanish==\n# {{adj form of|es|trucho||f|p}}\n# {{plural of|es|trucha}}`,
  trucha: `==Spanish==\n# [[trout]]`,
  chamuyando: `==Spanish==\n# {{es-verb form of|chamuyar}}`,
  chamuyar: `==Spanish==\n# {{lb|es|Rioplatense|colloquial}} to [[chat up]], to [[sweet-talk]]`,
  obelisco: `==Spanish==\n# [[obelisk]]`,
  ramble: `==English==\n# to walk`,
  pozo: `==Spanish==\n# [[well]] {{gl|hole sunk into the ground as a source of water}}\n# [[pit]], [[hole]]\n# {{lb|es|of a river}} deep [[pool]]`,
};

// Lines in the Spanish Wiktionary's own format, 6 Nov 2026.
const ES_PAGES: Record<string, string> = {
  jineteada: `== {{lengua|es}} ==\n=== Etimología ===\n;1: {{forma participio|jineteado|femenino|v jinetear}}`,
  corredera: `== {{lengua|es}} ==\n;1 {{csem|tecnología}}: {{plm|muesca}} de cualquier [[pieza]] por donde se mueve otra\n;6: {{plm|lugar}} o [[calle]] por donde hay o hubo [[carrera]]s de [[caballo]]s<ref name="dle"/>\n== {{lengua|pt}} ==\n;1: x`,
  bulín: `== {{lengua|es}} ==\n;1: {{plm|vivienda}} [[urbano|urbana]], de costo modesto\n{{uso|Argentina|Uruguay|lunfardo}}`,
};

const wiktionary = () => {
  const asked: string[][] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const book = u.hostname.startsWith('es.') ? ES_PAGES : PAGES;
    const titles = u.searchParams.get('titles')!.split('|');
    asked.push(titles);
    return Response.json({
      query: {
        pages: titles.map(t => (book[t] ? { title: t, revisions: [{ slots: { main: { content: book[t] } } }] } : { title: t, missing: true })),
      },
    });
  }) as typeof fetch;
  return { fetcher, asked };
};

test('a definition line becomes plain English with its labels', () => {
  assert.deepEqual(readSense('# {{lb|es|Rioplatense|Paraguay|colloquial}} [[dude]], [[mate]] ({{n-g|a friendly term of address}})'), {
    labels: ['Rioplatense', 'Paraguay', 'colloquial'],
    text: 'dude, mate (a friendly term of address)',
    formOf: '',
    formRank: 9,
  });
  assert.equal(readSense('# [[mine]] {{gl|excavation}}').text, 'mine (excavation)');
  assert.equal(readSense("# {{lb|es|colloquial}} [[can't be bothered|can't-be-bothered]] attitude").text, "can't-be-bothered attitude");
});

test('only the Spanish section is read, and a regional sense is preferred', () => {
  const senses = spanishSenses(PAGES.mina!)!;
  assert.equal(senses.length, 5, 'the example line and other languages are skipped');
  const best = bestSense(senses)!;
  assert.equal(best.text, 'woman');
  assert.equal(tagFor(best.labels), 'rioplatense');
  assert.equal(tagFor(['Argentina', 'lunfardo']), 'lunfardo');
  assert.equal(spanishSenses(PAGES.ramble!), null);
});

test('candidates drop the article and try lower case', () => {
  assert.deepEqual(candidates('el Obelisco'), ['el Obelisco', 'el obelisco', 'Obelisco', 'obelisco']);
});

test('words are checked: dictionary sense shown, slang tagged, inventions left out', async () => {
  const { fetcher } = wiktionary();
  const r = await checkWords(
    [
      { es: 'mina', en: 'a large serving of food' },
      { es: 'bulín', en: 'the social hour before dancing' },
      { es: 'quilombo', en: 'a mess' },
      { es: 'embleada', en: 'a stylish manner' },
      { es: 'el Obelisco', en: 'the obelisk' },
      { es: 'el silencio es salud', en: 'silence is health' },
    ],
    fetcher
  );
  assert.equal(r.available, true);
  assert.deepEqual(r.dropped, ['embleada']);
  const by = Object.fromEntries(r.kept.map(k => [k.es, k]));
  assert.equal(by.mina!.dict, 'woman');
  assert.equal(by.mina!.en, 'a large serving of food', "the model's note is kept beside, not in place of, the dictionary");
  assert.equal(by['bulín']!.dict, 'bachelor pad');
  assert.equal(by['bulín']!.tag, 'rioplatense');
  assert.equal(by.quilombo!.tag, 'lunfardo');
  assert.equal(by['el Obelisco']!.dict, 'obelisk');
  assert.equal(by['el Obelisco']!.lemma, undefined, 'the article alone is no different headword');
  assert.equal(by['el silencio es salud']!.checked, false, 'a phrase is kept, marked unchecked');
  assert.equal(by.mina!.url, 'https://en.wiktionary.org/wiki/mina#Spanish');
});

test('a plural or a verb form is followed to its headword', async () => {
  const { fetcher, asked } = wiktionary();
  const r = await checkWords(
    [
      { es: 'truchas', en: 'trout' },
      { es: 'chamuyando', en: 'chatting up' },
    ],
    fetcher
  );
  const by = Object.fromEntries(r.kept.map(k => [k.es, k]));
  assert.equal(by.truchas!.dict, 'trout', 'the plural-of headword, not the adjective trucho');
  assert.equal(by.truchas!.lemma, 'trucha');
  assert.equal(by.chamuyando!.dict, 'to chat up, to sweet-talk');
  assert.equal(by.chamuyando!.tag, 'rioplatense');
  assert.equal(asked.length, 2, 'one request for the words, one for their headwords');
});

test('when Wiktionary cannot be reached nothing is dropped and nothing claims a check', async () => {
  const r = await checkWords([{ es: 'embleada', en: 'x' }], (async () => new Response('', { status: 503 })) as typeof fetch);
  assert.equal(r.available, false);
  assert.deepEqual(r.kept, [{ es: 'embleada', en: 'x' }]);
});

test('the sense nearest the model\'s note in context is chosen', async () => {
  const best = bestSense(spanishSenses(PAGES.pozo!)!, 'a deep pool or channel in a river');
  assert.equal(best!.text, 'deep pool');
  assert.equal(bestSense(spanishSenses(PAGES.pozo!)!, '')!.text, 'well (hole sunk into the ground as a source of water)');
  assert.equal(bestSense(spanishSenses(PAGES.mina!)!, 'a large serving of food')!.text, 'woman', 'no overlap: the regional sense');
});

test('the Spanish Wiktionary is read in its own format', () => {
  const senses = esSenses(ES_PAGES.corredera!)!;
  assert.equal(senses.length, 2, 'the Portuguese section is not read');
  assert.equal(senses[1]!.text, 'Lugar o calle por donde hay o hubo carreras de caballos');
  assert.deepEqual(esSenses(ES_PAGES['bulín']!)![0]!.labels, ['lunfardo']);
  assert.equal(esSenses(ES_PAGES.jineteada!)![0]!.formOf, 'jineteado');
});

test('a word the English Wiktionary lacks is looked for in the Spanish one before it is left out', async () => {
  const { fetcher } = wiktionary();
  const r = await checkWords(
    [
      { es: 'corredera', en: 'a channel in a river' },
      { es: 'jineteada', en: 'a rodeo' },
      { es: 'embleada', en: 'a stylish manner' },
    ],
    fetcher
  );
  assert.deepEqual(r.dropped, ['embleada']);
  const by = Object.fromEntries(r.kept.map(k => [k.es, k]));
  assert.equal(by.corredera!.dictLang, 'es');
  assert.equal(by.corredera!.url, 'https://es.wiktionary.org/wiki/corredera');
  assert.ok(by.jineteada!.checked);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestSense, candidates, checkWords, readSense, spanishSenses, tagFor } from './dictionary.ts';

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
};

const wiktionary = () => {
  const asked: string[][] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const titles = new URL(String(url)).searchParams.get('titles')!.split('|');
    asked.push(titles);
    return Response.json({
      query: {
        pages: titles.map(t => (PAGES[t] ? { title: t, revisions: [{ slots: { main: { content: PAGES[t] } } }] } : { title: t, missing: true })),
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

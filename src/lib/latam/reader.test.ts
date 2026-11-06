import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  articleText, grade as gradeWith, isSafeTitle, parseFeed, parseFrequencyList, rankFrom, syllables, tokens, topicFor, unwrapLink,
} from '../../../supabase/functions/_shared/reader.ts';
import { ES_FREQUENT } from '../../../supabase/functions/_shared/es-frequent.ts';

const RANK = rankFrom(ES_FREQUENT);
const grade = (t: string) => gradeWith(t, RANK);

test('an Arc page that writes content before type is read too', () => {
  const html = '<script>{"content_elements":[{"_id":"X","content":"SAN CARLOS DE BARILOCHE.- En 1936 una joven inglesa llegó a la Patagonia para visitar a su hermano.","type":"text"}]}</script>';
  assert.equal(articleText(html), 'SAN CARLOS DE BARILOCHE.- En 1936 una joven inglesa llegó a la Patagonia para visitar a su hermano.');
});

test('Arc text escaped inside a script string is read', () => {
  const html = '<script>window.x="{\\"content_elements\\":[{\\"_id\\":\\"X\\",\\"content\\":\\"Una joven inglesa llegó a la Patagonia para visitar a su hermano <strong>Barney<\\/strong> en el lago.\\",\\"type\\":\\"text\\"}]}";</script>';
  assert.equal(articleText(html), 'Una joven inglesa llegó a la Patagonia para visitar a su hermano Barney en el lago.');
});

test('a FrequencyWords list is read as alphabetic forms in order', () => {
  assert.deepEqual(parseFrequencyList('de 100\nque 90\n2 80\nno 70\n', 2), ['de', 'que']);
  assert.deepEqual(parseFrequencyList('de 100\n2 80\nno 70\n'), ['de', 'no']);
});

test('Spanish syllables', () => {
  assert.equal(syllables('casa'), 2);
  assert.equal(syllables('patagonia'), 4);
  assert.equal(syllables('poeta'), 3); // hiatus
  assert.equal(syllables('cuidad'), 2); // ui is one
  assert.equal(syllables('río'), 2);
});

test('names are not vocabulary', () => {
  assert.deepEqual(tokens('Fuimos a Bariloche con Juan. Luego volvimos.'), ['fuimos', 'a', 'con', 'luego', 'volvimos']);
});

const easy = 'Hoy vamos a la casa de mi madre. Ella vive en el campo con su perro. El perro es grande y bueno. Comemos pan y tomamos café. Después caminamos por el río. Es un día muy bonito y estamos contentos. '.repeat(6);
const hard = 'La consolidación paulatina de los emprendimientos vitivinícolas cordilleranos, sustentada en microclimas heterogéneos y suelos aluvionales, posibilitó la elaboración de cepas excepcionalmente concentradas, cuya tipicidad organoléptica despierta creciente reconocimiento internacional entre especialistas exigentes. '.repeat(8);

test('plain text grades easy, dense text hard', () => {
  const e = grade(easy)!;
  const h = grade(hard)!;
  assert.ok(e.cov5k > h.cov5k);
  assert.ok(e.inflesz > h.inflesz);
  assert.ok(['A2', 'B1'].includes(e.level), e.level);
  assert.equal(h.level, 'C1');
  assert.equal(grade('demasiado corto'), null);
});

test('a piece with no full stops is not one enormous sentence', () => {
  const para = 'el río corre entre los cerros y la gente camina por la orilla con sus perros y sus hijos todos los días del verano';
  const g = grade(Array(12).fill(para).join('\n\n'))!;
  assert.ok(g.inflesz > 0, String(g.inflesz));
});

test('a listing too long to be an article is left out', () => {
  assert.equal(grade('palabra '.repeat(4500)), null);
});

test('an Arc page with its text in data is still read', () => {
  const html = '<html><script>Fusion.globalContent={"content_elements":[{"type":"text","content":"La casa de té <b>Arrayán<\\/b> cumple noventa años junto al lago en la ciudad de Bariloche."},{"type":"image"},{"type":"text","content":"Fue fundada por una familia inglesa que llegó a la Patagonia hace mucho tiempo."}]}</script></html>';
  assert.equal(
    articleText(html),
    'La casa de té Arrayán cumple noventa años junto al lago en la ciudad de Bariloche.\n\nFue fundada por una familia inglesa que llegó a la Patagonia hace mucho tiempo.'
  );
});

test('a feed gives links and titles; Bing links are unwrapped', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Pesca con mosca en el Malleo]]></title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fweekend.perfil.com%2fnota%2f1&amp;c=1</link><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>Sin enlace</title><link>notaurl</link></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.url, 'https://weekend.perfil.com/nota/1');
  assert.equal(items[0]!.title, 'Pesca con mosca en el Malleo');
  assert.equal(items[0]!.published, '2026-11-05T10:00:00.000Z');
  assert.equal(unwrapLink('https://www.clarin.com/x'), 'https://www.clarin.com/x');
});

test('an article is its paragraphs, not its furniture', () => {
  const html = '<nav><p>Inicio Viajes Cultura Deportes Más secciones del diario hoy</p></nav><article><p>Leé también</p><p>El río Malleo corre entre araucarias y es uno de los mejores ríos de Neuquén.</p><figure><p>Foto: un pescador en el agua durante la tarde de ayer.</p></figure><p>La temporada abre en noviembre y dura hasta abril &amp; mayo.</p></article>';
  assert.equal(
    articleText(html),
    'El río Malleo corre entre araucarias y es uno de los mejores ríos de Neuquén.\n\nLa temporada abre en noviembre y dura hasta abril & mayo.'
  );
});

test('grim titles are left out; topic words beat the feed', () => {
  assert.equal(isSafeTitle('Murió un turista en el Aconcagua'), false);
  assert.equal(isSafeTitle('Milei habló sobre el turismo'), false);
  assert.equal(isSafeTitle('Cinco cervecerías para conocer en Bariloche'), true);
  assert.equal(isSafeTitle('Escalada de tensión mapuche en Patagonia en rechazo a desalojo'), false);
  assert.equal(topicFor('travel', 'Una bodega en Cafayate con vista a los cerros'), 'drink');
  assert.equal(topicFor('travel', 'Escapada a Concepción del Uruguay'), 'travel');
});

import { readGlossary } from './glossary.ts';

test('a glossary keeps only words that are in the article, in Latin script', () => {
  const article = 'En el Limay se pesca con mosca seca. Los baqueanos conocen cada correntada del río, che.';
  const r = readGlossary(
    JSON.stringify({
      summary: 'Fly fishing on the Limay with local guides.',
      words: [
        { es: 'baqueanos', en: 'local guides who know the land' },
        { es: 'correntada', en: 'a strong current' },
        { es: 'pejerrey', en: 'silverside fish' },
        { es: 'che', en: 'hey, mate' },
        { es: 'río背', en: 'river' },
      ],
    }),
    article
  );
  assert.deepEqual(r?.words.map(w => w.es), ['baqueanos', 'correntada', 'che']);
  assert.equal(r?.summary, 'Fly fishing on the Limay with local guides.');
});

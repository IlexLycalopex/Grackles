// Lecturas, nightly: new articles from the feeds, fetched and graded.
//
// Rung by pg_cron (20261106130100_latam_lecturas_schedule). The feeds, the
// topic and safety filters and the grading are all in _shared/reader.ts; this
// only does the fetching and the writing. No model is involved: the level is
// measured from the text, and the text itself is not kept.
//
// Deployed with JWT verification OFF; the caller is pg_net with the shared
// sync secret.
//
// POST         fetch and grade
// POST ?dry=1  the same, writing nothing, and say what would be kept

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  articleText,
  FEEDS,
  FREQUENCY_SOURCE,
  grade,
  isSafeTitle,
  pageImage,
  parseFeed,
  parseFrequencyList,
  rankFrom,
  topicFor,
} from '../_shared/reader.ts';

const PER_FEED = 3;
const PER_RUN = 60;
const UA = 'Mozilla/5.0 (compatible; Grackles/1.0; +https://grackles.co.uk)';

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function get(url: string, accept: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = await res.text();
    return body.length > 3_000_000 ? null : body;
  } catch {
    return null;
  }
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!sameSecret(req.headers.get('x-sync-secret') ?? '', Deno.env.get('JPOD_SYNC_SECRET') ?? '-')) {
    return new Response('forbidden', { status: 403 });
  }
  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const list = await get(FREQUENCY_SOURCE, 'text/plain');
  const words = list ? parseFrequencyList(list) : [];
  if (words.length < 4000) return Response.json({ ok: false, message: 'frequency list unavailable' }, { status: 502 });
  const rank = rankFrom(words);

  // Every candidate from every feed, filtered on its title, before anything is
  // fetched: the title is enough to know a piece is off-topic or grim.
  // The built-in list, then every feed an editor has added (one fetch per
  // address, however many projects added it).
  const { data: custom } = await db.from('lx_reader_feeds').select('id, url, name, topic');
  const all = [
    ...FEEDS.map(f => ({ ...f, id: null as string | null })),
    ...(custom ?? [])
      .filter((c, i, a) => a.findIndex(x => x.url === c.url) === i && !FEEDS.some(f => f.url === c.url))
      .map(c => ({ url: c.url, source: c.name, topic: c.topic as (typeof FEEDS)[number]['topic'], id: c.id as string | null })),
  ];
  const feeds = await Promise.all(all.map(async f => ({ f, xml: await get(f.url, 'application/rss+xml, application/atom+xml, application/xml, text/xml') })));
  const candidates = feeds.flatMap(({ f, xml }) =>
    xml
      ? parseFeed(xml)
          .filter(i => isSafeTitle(i.title) && (!('titleFilter' in f) || !f.titleFilter || f.titleFilter.test(i.title)))
          .map(i => ({ ...i, source: f.source, topic: topicFor(f.topic, i.title), feed: f.url, feedId: f.id }))
      : []
  );
  const deadFeeds = feeds.filter(x => !x.xml).map(x => x.f.url);

  // How each added feed went, so the Lecturas page can say when one breaks.
  if (!dry) {
    for (const { f, xml } of feeds) {
      if (!f.id) continue;
      const items = xml ? parseFeed(xml).length : 0;
      await db
        .from('lx_reader_feeds')
        .update({
          last_run_at: new Date().toISOString(),
          last_ok: Boolean(xml && items),
          last_message: !xml ? 'The feed could not be fetched.' : items ? `${items} items in the feed` : 'The address answered, but not with a feed.',
        })
        .eq('url', f.url);
    }
  }

  const urls = [...new Set(candidates.map(c => c.url))];
  const known = new Set<string>();
  for (let i = 0; i < urls.length; i += 100) {
    const { data } = await db.from('lx_reader_articles').select('url').in('url', urls.slice(i, i + 100));
    for (const r of data ?? []) known.add(r.url);
  }

  // Round-robin across feeds, so a quota spent early never starves the
  // topics further down the list (the first live run had no drink at all).
  const byFeed = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (known.has(c.url)) continue;
    known.add(c.url);
    const list = byFeed.get(c.feed) ?? [];
    if (list.length < PER_FEED) byFeed.set(c.feed, [...list, c]);
  }
  const fresh: typeof candidates = [];
  for (let round = 0; round < PER_FEED && fresh.length < PER_RUN; round++) {
    for (const list of byFeed.values()) if (list[round] && fresh.length < PER_RUN) fresh.push(list[round]!);
  }

  const rows = [];
  for (let i = 0; i < fresh.length; i += 6) {
    const batch = await Promise.all(
      fresh.slice(i, i + 6).map(async c => {
        const html = await get(c.url, 'text/html');
        const g = html ? grade(articleText(html), rank) : null;
        return {
          url: c.url,
          image_url: c.image ?? (html ? pageImage(html) : null),
          feed_id: c.feedId,
          source: c.source,
          topic: c.topic,
          title: c.title,
          published_at: c.published,
          words: g?.words ?? 0,
          inflesz: g?.inflesz ?? null,
          cov1k: g?.cov1k ?? null,
          cov2k: g?.cov2k ?? null,
          cov5k: g?.cov5k ?? null,
          level: g?.level ?? null,
        };
      })
    );
    rows.push(...batch);
  }

  if (dry) {
    return Response.json({ candidates: candidates.length, fresh: fresh.length, deadFeeds, rows });
  }
  if (rows.length) {
    const { error } = await db.from('lx_reader_articles').upsert(rows, { onConflict: 'url', ignoreDuplicates: true });
    if (error) return Response.json({ ok: false, message: error.message }, { status: 500 });
  }
  // Pictures for articles fetched before pictures were kept, or whose page
  // was slow the first time: a few each run, for two days, then let go.
  const { data: bare } = await db
    .from('lx_reader_articles')
    .select('id, url')
    .is('image_url', null)
    .not('level', 'is', null)
    .gt('fetched_at', new Date(Date.now() - 2 * 86400000).toISOString())
    .limit(30);
  for (let i = 0; i < (bare ?? []).length; i += 6) {
    await Promise.all(
      bare!.slice(i, i + 6).map(async a => {
        const html = await get(a.url, 'text/html');
        const image = html ? pageImage(html) : null;
        if (image) await db.from('lx_reader_articles').update({ image_url: image }).eq('id', a.id);
      })
    );
  }

  // Two months is long enough to choose from; older ones nobody marked go.
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: marked } = await db.from('lx_reader_marks').select('article_id');
  const keep = (marked ?? []).map(m => m.article_id);
  let prune = db.from('lx_reader_articles').delete().lt('fetched_at', cutoff);
  if (keep.length) prune = prune.not('id', 'in', `(${keep.join(',')})`);
  await prune;

  return Response.json({
    ok: true,
    added: rows.filter(r => r.level).length,
    unreadable: rows.filter(r => !r.level).length,
    deadFeeds,
  });
});

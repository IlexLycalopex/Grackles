// LatAm's Instapaper sync: articles finished there, in Spanish or about
// Argentina, counted as reading.
//
// Rung nightly by pg_cron (20261106120100_latam_instapaper_schedule). Uses
// Instapaper's full API (OAuth 1.0a, xAuth), which needs a consumer key that
// Instapaper issues on request. Until the four secrets below exist the run
// does nothing and records that it is waiting, so the setup page can say so.
//
// Secrets (supabase secrets set …):
//   INSTAPAPER_CONSUMER_KEY, INSTAPAPER_CONSUMER_SECRET  issued by Instapaper
//   INSTAPAPER_USERNAME, INSTAPAPER_PASSWORD             the account to read
//   JPOD_SYNC_SECRET                                     shared with the other syncs
//
// Which projects: every LatAm project whose settings turn instapaper_sync on.
// The account is the deployment's, so in practice that is one.
//
// What counts is decided in _shared/instapaper.ts: read to nine tenths, and in
// Spanish or about Argentina. Every bookmark looked at is remembered in
// lx_instapaper_seen, counted or not, so an article's text is fetched once.
//
// POST         sync
// POST ?dry=1  sign in, list, and report what would be counted; write nothing

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  accessToken,
  call,
  isRead,
  language,
  minutesFor,
  readBookmarks,
  tagsFor,
  textOf,
  wordCount,
  type Bookmark,
  type Credentials,
} from '../_shared/instapaper.ts';

const TZ = 'Europe/London';
// Text fetches per run. A first run over a long archive catches up across a
// few nights rather than running past the function's time limit.
const MAX_TEXTS = 40;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const day = (epoch: number) => new Date(epoch * 1000).toLocaleDateString('en-CA', { timeZone: TZ });

async function list(creds: Credentials, folder: string): Promise<Bookmark[]> {
  const res = await call('/bookmarks/list', { folder_id: folder, limit: '500' }, creds);
  if (!res.ok) throw new Error(`Instapaper list (${folder}) answered ${res.status}`);
  return readBookmarks(await res.json());
}

async function text(creds: Credentials, id: number): Promise<string> {
  const res = await call('/bookmarks/get_text', { bookmark_id: String(id) }, creds);
  if (!res.ok) return '';
  return textOf(await res.text());
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  let secret: string;
  try {
    secret = env('JPOD_SYNC_SECRET');
  } catch {
    return new Response('not configured', { status: 500 });
  }
  if (!sameSecret(req.headers.get('x-sync-secret') ?? '', secret)) return new Response('forbidden', { status: 403 });

  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: linked, error: le } = await db
    .from('lx_settings')
    .select('workspace_id, focus_tag')
    .eq('instapaper_sync', true);
  if (le) return Response.json({ ok: false, message: le.message }, { status: 500 });
  if (!linked?.length) return Response.json({ ok: true, message: 'no project has Instapaper turned on' });

  const keys = ['INSTAPAPER_CONSUMER_KEY', 'INSTAPAPER_CONSUMER_SECRET', 'INSTAPAPER_USERNAME', 'INSTAPAPER_PASSWORD'];
  const missing = keys.filter(k => !Deno.env.get(k));

  const results = [];
  for (const { workspace_id, focus_tag } of linked) {
    const record = async (fields: Record<string, unknown>) => {
      if (!dry) await db.from('lx_sync_runs').insert({ workspace_id, source: 'instapaper', finished_at: new Date().toISOString(), ...fields });
    };
    if (missing.length) {
      const message = 'Waiting for the Instapaper API key';
      await record({ ok: false, message });
      results.push({ workspace_id, ok: false, message, missing });
      continue;
    }
    try {
      const creds = await accessToken(
        { consumerKey: env('INSTAPAPER_CONSUMER_KEY'), consumerSecret: env('INSTAPAPER_CONSUMER_SECRET') },
        env('INSTAPAPER_USERNAME'),
        env('INSTAPAPER_PASSWORD')
      );
      const all = [...(await list(creds, 'unread')), ...(await list(creds, 'archive'))];
      const read = all.filter(isRead);

      const { data: seenRows } = await db
        .from('lx_instapaper_seen')
        .select('bookmark_id')
        .eq('workspace_id', workspace_id)
        .in('bookmark_id', read.map(b => b.bookmark_id));
      const seen = new Set((seenRows ?? []).map(r => Number(r.bookmark_id)));
      const fresh = read.filter(b => !seen.has(b.bookmark_id)).slice(0, MAX_TEXTS);

      const { data: places } = await db.from('lx_places').select('slug, name').eq('workspace_id', workspace_id);

      let counted = 0;
      const sample = [];
      for (const b of fresh) {
        const body = await text(creds, b.bookmark_id);
        const lang = language(body);
        const tags = tagsFor(body, b.title, lang, places ?? [], focus_tag);
        const words = wordCount(body);
        const minutes = minutesFor(words, lang);
        if (dry) {
          sample.push({ title: b.title, lang, words, minutes, tags });
          continue;
        }
        if (tags.length && words > 0) {
          const { error } = await db.from('lx_activities').upsert(
            {
              workspace_id,
              occurred_on: day(b.progress_timestamp || b.time),
              type: 'article',
              title: b.title.slice(0, 300),
              minutes,
              link: /^https?:\/\//.test(b.url) ? b.url.slice(0, 2000) : '',
              notes: `Read in Instapaper. Minutes estimated from ${words} words${lang === 'es' ? ' of Spanish' : ''}.`,
              tags,
              source: 'instapaper',
              source_ref: String(b.bookmark_id),
            },
            { onConflict: 'workspace_id,source,source_ref', ignoreDuplicates: true }
          );
          if (error) throw new Error(`lx_activities: ${error.message}`);
          counted++;
          // Kept from a deep dive or a theme list: now read.
          if (b.url) await db.from('lx_items').update({ done: true }).eq('workspace_id', workspace_id).eq('url', b.url);
        }
        await db.from('lx_instapaper_seen').upsert({
          workspace_id,
          bookmark_id: b.bookmark_id,
          counted: Boolean(tags.length && words > 0),
          reason: !words ? 'no text' : tags.length ? tags.join(' ') : `not Spanish or about Argentina (${lang})`,
        });
      }

      if (dry) {
        results.push({ workspace_id, ok: true, listed: all.length, read: read.length, new: fresh.length, sample });
        continue;
      }
      const message = `${counted} of ${fresh.length} newly read articles counted${read.length - seen.size > MAX_TEXTS ? '; more next run' : ''}`;
      await record({ ok: true, message });
      results.push({ workspace_id, ok: true, message });
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await record({ ok: false, message });
      results.push({ workspace_id, ok: false, message });
    }
  }
  return Response.json({ ok: results.every(r => r.ok), results });
});

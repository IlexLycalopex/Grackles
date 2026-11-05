// JPOD's daily sync: Pocket Casts listening history into jp_ingest().
//
// Rung once a day by pg_cron (20261105120200_podcasts_sync_schedule). Pocket
// Casts has no public API; this uses the endpoints its own web player calls,
// which the community has documented and which can change without notice. A
// run that fails says why in jp_sync_runs, which the JPOD front page reads, so
// a broken sync is visible the next morning rather than discovered in a month.
//
// Deployed with JWT verification OFF: the caller is pg_net, not a signed-in
// user. What stands in for it is the shared secret below, compared in constant
// time, so knowing the URL is not enough to make it run.
//
// Secrets (supabase secrets set …):
//   POCKETCASTS_EMAIL, POCKETCASTS_PASSWORD  the account to read
//   JPOD_WORKSPACE_ID                        the JPOD project to write into
//   JPOD_SYNC_SECRET                         the same string as Vault's jpod_sync_secret
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// POST            run the sync
// POST ?dry=1     fetch and map, write nothing, return a sample with the raw
//                 values beside the mapped ones — run this once by hand before
//                 trusting the schedule

import { createClient } from 'npm:@supabase/supabase-js@2';
import { normaliseWebEpisode, type IngestRow } from '../_shared/pocketcasts.ts';

const API = 'https://api.pocketcasts.com';

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

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// The web player signs in through login_pocket_casts and receives an
// accessToken; older clients used /user/login and got `token`. Tried in that
// order, because which one answers has changed before.
async function signIn(email: string, password: string): Promise<string> {
  for (const path of ['/user/login_pocket_casts', '/user/login']) {
    const res = await post(path, { email, password, scope: 'webplayer' });
    if (!res.ok) continue;
    const json = await res.json().catch(() => ({}));
    const token = json.accessToken ?? json.token;
    if (typeof token === 'string' && token) return token;
  }
  throw new Error('Pocket Casts sign-in failed: check POCKETCASTS_EMAIL and POCKETCASTS_PASSWORD');
}

async function history(token: string): Promise<Record<string, unknown>[]> {
  const res = await post('/user/history', {}, token);
  if (!res.ok) throw new Error(`Pocket Casts history answered ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json?.episodes)) {
    throw new Error(`Pocket Casts history changed shape: keys were ${Object.keys(json ?? {}).join(', ')}`);
  }
  return json.episodes;
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  let secret: string;
  try {
    secret = env('JPOD_SYNC_SECRET');
  } catch {
    return new Response('not configured', { status: 500 });
  }
  if (!sameSecret(req.headers.get('x-jpod-secret') ?? '', secret)) {
    return new Response('forbidden', { status: 403 });
  }

  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const workspace = env('JPOD_WORKSPACE_ID');
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  let runId: number | null = null;
  if (!dry) {
    const { data } = await db.from('jp_sync_runs').insert({ workspace_id: workspace }).select('id').single();
    runId = data?.id ?? null;
  }

  const finish = async (fields: Record<string, unknown>) => {
    if (runId !== null) {
      await db.from('jp_sync_runs').update({ finished_at: new Date().toISOString(), ...fields }).eq('id', runId);
    }
  };

  try {
    const token = await signIn(env('POCKETCASTS_EMAIL'), env('POCKETCASTS_PASSWORD'));
    const raw = await history(token);
    const rows = raw.map(normaliseWebEpisode).filter((r): r is IngestRow => r !== null);

    if (dry) {
      const sample = raw.slice(0, 5).map(r => ({
        raw: {
          playingStatus: r.playingStatus,
          playedUpTo: r.playedUpTo,
          duration: r.duration,
          podcastTitle: r.podcastTitle,
          title: r.title,
        },
        mapped: normaliseWebEpisode(r),
      }));
      return Response.json({ fetched: raw.length, usable: rows.length, keys: Object.keys(raw[0] ?? {}), sample });
    }

    const { data, error } = await db.rpc('jp_ingest', { p_workspace: workspace, p_rows: rows, p_source: 'sync' });
    if (error) throw new Error(`jp_ingest: ${error.message}`);

    const result = data as { rows: number; new_episodes: number; credited_s: number };
    await finish({
      ok: true,
      fetched: raw.length,
      new_episodes: result.new_episodes,
      credited_s: result.credited_s,
      message: raw.length - rows.length ? `${raw.length - rows.length} entries skipped as malformed` : '',
    });
    return Response.json({ ok: true, fetched: raw.length, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finish({ ok: false, message: message.slice(0, 500) });
    return Response.json({ ok: false, message }, { status: 502 });
  }
});

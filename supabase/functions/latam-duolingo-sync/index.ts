// LatAm's Duolingo sync: the public profile, hourly, into lx_duolingo_ingest().
//
// Rung by pg_cron (20261105220100_latam_duolingo_schedule). Duolingo has no
// public API, and its daily history (xp_summaries) answers 401 without a
// signed-in session. The profile lookup by username does not, and carries each
// course's lifetime XP and the streak, so each run takes a snapshot and the
// database works out a day's practice from the growth in Spanish XP. See the
// migration 20261105220000_latam_duolingo for why that is enough.
//
// Which accounts: every LatAm project whose settings name a Duolingo username,
// set on the setup page. Each run is recorded in lx_sync_runs, which the
// LatAm front page reads.
//
// Deployed with JWT verification OFF: the caller is pg_net. It shares JPOD's
// secret (JPOD_SYNC_SECRET, sent as x-sync-secret): the same scheduler ringing
// the same project, which a second secret would not make any safer.
//
// POST                 sync every linked project
// POST ?dry=1&user=X   read X's profile, write nothing, return what would be stored

import { createClient } from 'npm:@supabase/supabase-js@2';

const API = 'https://www.duolingo.com/2017-06-30';
// The course counted. Other courses' XP is ignored, so a Swedish lesson does
// not count as Spanish.
const COURSE_LANGUAGE = 'es';

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

// Three tries, two and five seconds apart, for a request that got no answer or
// a 5xx. A 4xx is Duolingo saying no, and asking again will not change it.
const RETRY_DELAYS_MS = [2000, 5000];

async function get(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt];
    let status = 0;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Grackles LatAm sync)' },
      });
      if (res.ok) return await res.json();
      status = res.status;
    } catch (e) {
      if (delay === undefined) throw e;
    }
    if (status && (status < 500 || delay === undefined)) {
      throw new Error(`Duolingo answered ${status} for ${new URL(url).pathname}`);
    }
    await new Promise(r => setTimeout(r, delay));
  }
}

interface Profile {
  username: string;
  courseXp: number;
  totalXp: number;
  streak: number;
}

async function profile(username: string): Promise<Profile> {
  const json = (await get(
    `${API}/users?username=${encodeURIComponent(username)}&fields=users%7Bid,username,totalXp,streak,courses%7D`
  )) as { users?: { username?: string; totalXp?: number; streak?: number; courses?: { learningLanguage?: string; xp?: number }[] }[] };
  const user = json.users?.[0];
  if (!user) throw new Error(`no Duolingo profile called "${username}"`);
  if (!Array.isArray(user.courses) || typeof user.totalXp !== 'number') {
    throw new Error(`Duolingo's profile changed shape: keys were ${Object.keys(user).join(', ')}`);
  }
  const course = user.courses.find(c => c.learningLanguage === COURSE_LANGUAGE);
  return {
    username: user.username ?? username,
    courseXp: Math.round(Number(course?.xp ?? 0)),
    totalXp: Math.round(user.totalXp),
    streak: Math.round(Number(user.streak ?? 0)),
  };
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  let secret: string;
  try {
    secret = env('JPOD_SYNC_SECRET');
  } catch {
    return new Response('not configured', { status: 500 });
  }
  if (!sameSecret(req.headers.get('x-sync-secret') ?? '', secret)) {
    return new Response('forbidden', { status: 403 });
  }

  const params = new URL(req.url).searchParams;
  if (params.get('dry') === '1') {
    try {
      return Response.json(await profile(params.get('user') ?? ''));
    } catch (e) {
      return Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  const { data: linked, error: le } = await db
    .from('lx_settings')
    .select('workspace_id, duolingo_username')
    .not('duolingo_username', 'is', null);
  if (le) return Response.json({ ok: false, message: le.message }, { status: 500 });

  const results = [];
  for (const { workspace_id, duolingo_username } of linked ?? []) {
    const { data: run } = await db.from('lx_sync_runs').insert({ workspace_id, source: 'duolingo' }).select('id').single();
    const finish = async (fields: Record<string, unknown>) => {
      if (run) await db.from('lx_sync_runs').update({ finished_at: new Date().toISOString(), ...fields }).eq('id', run.id);
    };
    try {
      const p = await profile(duolingo_username!);
      const { data, error } = await db.rpc('lx_duolingo_ingest', {
        p_workspace: workspace_id,
        p_username: p.username,
        p_course_xp: p.courseXp,
        p_total_xp: p.totalXp,
        p_streak: p.streak,
      });
      if (error) throw new Error(`lx_duolingo_ingest: ${error.message}`);
      const r = data as { xp_today: number };
      await finish({ ok: true, message: `${r.xp_today} XP today` });
      results.push({ workspace_id, ok: true, ...p, ...r });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finish({ ok: false, message: message.slice(0, 500) });
      results.push({ workspace_id, ok: false, message });
    }
  }
  return Response.json({ ok: results.every(r => r.ok), results });
});

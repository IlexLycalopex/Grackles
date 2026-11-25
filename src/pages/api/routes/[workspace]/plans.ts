import type { APIRoute } from 'astro';
import { json } from '../../../../lib/http';
import { resolveWorkspace } from '../../../../lib/workspace';
import { MAX_STAGES, MIN_GAP_M } from '../../../../lib/routes/engine';

export const prerender = false;

/**
 * Route plans: read one, save, rename, delete and restore.
 *
 *   GET  /api/routes/:workspace/plans?id=<plan>   the plan and its route's profile
 *   POST /api/routes/:workspace/plans             { action, ... }
 *
 * Thin, like every write route here. RLS decides who may do what; the checks
 * below only turn a bad request into a sentence before the database refuses it.
 */

interface RouteIn {
  name: string;
  source_filename: string;
  total_distance_m: number;
  total_ascent_m: number | null;
  total_descent_m: number | null;
  max_elevation_m: number | null;
  has_elevation: boolean;
  profile: { step: number; d: number[]; e: number[]; lat: number[]; lon: number[] };
}

interface PlanIn {
  name: string;
  pace_s_per_km: number;
  climb_allowance: boolean;
  breaks_m: number[];
}

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const int = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null);

function readPlan(x: unknown): PlanIn | string {
  if (!x || typeof x !== 'object') return 'No plan was sent.';
  const p = x as Record<string, unknown>;
  const name = str(p.name, 200);
  if (!name) return 'Give the plan a name.';
  const pace = int(p.pace_s_per_km);
  if (pace === null || pace < 120 || pace > 1800) return 'That pace is out of range.';
  if (!Array.isArray(p.breaks_m) || p.breaks_m.length > MAX_STAGES - 1) return 'Too many stages.';
  const breaks = p.breaks_m.map(int);
  if (breaks.some(b => b === null)) return 'A break position is not a number.';
  const sorted = (breaks as number[]).every((b, i, a) => b >= MIN_GAP_M && (i === 0 || b - a[i - 1] >= MIN_GAP_M));
  if (!sorted) return 'Days must be at least 1 km long.';
  return { name, pace_s_per_km: pace, climb_allowance: p.climb_allowance !== false, breaks_m: breaks as number[] };
}

function readRoute(x: unknown): RouteIn | string {
  if (!x || typeof x !== 'object') return 'No route was sent.';
  const r = x as Record<string, unknown>;
  const pr = r.profile as RouteIn['profile'] | undefined;
  const arrays = pr && ['d', 'e', 'lat', 'lon'].every(k => Array.isArray((pr as never)[k]));
  if (!pr || !arrays || pr.d.length < 2 || [pr.e, pr.lat, pr.lon].some(a => a.length !== pr.d.length)) {
    return 'The route profile is malformed.';
  }
  const distance = int(r.total_distance_m);
  if (!distance || distance <= 0) return 'The route has no length.';
  return {
    name: str(r.name, 200) || 'Route',
    source_filename: str(r.source_filename, 300),
    total_distance_m: distance,
    total_ascent_m: int(r.total_ascent_m),
    total_descent_m: int(r.total_descent_m),
    max_elevation_m: int(r.max_elevation_m),
    has_elevation: r.has_elevation === true,
    profile: { step: int(pr.step) ?? 25, d: pr.d, e: pr.e, lat: pr.lat, lon: pr.lon },
  };
}

export const GET: APIRoute = async ({ params, url, locals }) => {
  const { supabase, user } = locals;
  const ws = await resolveWorkspace(supabase, 'routes', params.workspace!, user?.id ?? null);
  if (!ws) return json({ error: 'Not found' }, 404);

  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Which plan?' }, 400);

  const { data: plan } = await supabase
    .from('rt_plans')
    .select('id, name, pace_s_per_km, climb_allowance, breaks_m, route_id, updated_at')
    .eq('workspace_id', ws.id)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!plan) return json({ error: 'Not found' }, 404);

  const { data: route } = await supabase
    .from('rt_routes')
    .select('id, name, source_filename, total_distance_m, has_elevation, profile')
    .eq('id', plan.route_id)
    .maybeSingle();
  if (!route) return json({ error: 'Not found' }, 404);

  return json({ plan, route });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in to save plans.' }, 401);
  const ws = await resolveWorkspace(supabase, 'routes', params.workspace!, user.id);
  if (!ws) return json({ error: 'Not found' }, 404);
  if (!ws.canWrite) return json({ error: 'You can view this project but not change it.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'The body must be JSON.' }, 400);
  }

  const action = body.action;
  const id = typeof body.id === 'string' ? body.id : '';

  async function insertRoute(r: RouteIn) {
    return supabase
      .from('rt_routes')
      .insert({ ...r, workspace_id: ws!.id, profile: r.profile as never })
      .select('id')
      .single();
  }

  // A route no plan points at any more is only taking up space.
  async function dropOrphan(routeId: string) {
    const { count } = await supabase
      .from('rt_plans')
      .select('id', { count: 'exact', head: true })
      .eq('route_id', routeId);
    if (count === 0) await supabase.from('rt_routes').delete().eq('id', routeId);
  }

  if (action === 'create') {
    const plan = readPlan(body.plan);
    if (typeof plan === 'string') return json({ error: plan }, 400);
    const route = readRoute(body.route);
    if (typeof route === 'string') return json({ error: route }, 400);
    const r = await insertRoute(route);
    if (r.error || !r.data) {
      console.error('rt_routes insert', r.error);
      return json({ error: 'The route could not be saved.' }, 500);
    }
    const p = await supabase
      .from('rt_plans')
      .insert({ ...plan, workspace_id: ws.id, route_id: r.data.id })
      .select('id, updated_at')
      .single();
    if (p.error || !p.data) {
      console.error('rt_plans insert', p.error);
      await supabase.from('rt_routes').delete().eq('id', r.data.id);
      return json({ error: p.error?.message ?? 'The plan could not be saved.' }, 400);
    }
    return json({ id: p.data.id, route_id: r.data.id, updated_at: p.data.updated_at }, 201);
  }

  if (!id) return json({ error: 'Which plan?' }, 400);

  if (action === 'update') {
    const plan = readPlan(body.plan);
    if (typeof plan === 'string') return json({ error: plan }, 400);
    const { data: current } = await supabase
      .from('rt_plans')
      .select('route_id')
      .eq('workspace_id', ws.id)
      .eq('id', id)
      .maybeSingle();
    if (!current) return json({ error: 'Not found' }, 404);

    let routeId = current.route_id;
    if (body.route) {
      const route = readRoute(body.route);
      if (typeof route === 'string') return json({ error: route }, 400);
      const r = await insertRoute(route);
      if (r.error || !r.data) return json({ error: 'The new route could not be saved.' }, 500);
      routeId = r.data.id;
    }
    const p = await supabase
      .from('rt_plans')
      .update({ ...plan, route_id: routeId })
      .eq('workspace_id', ws.id)
      .eq('id', id)
      .select('id, updated_at')
      .single();
    if (p.error || !p.data) return json({ error: p.error?.message ?? 'The plan could not be saved.' }, 400);
    if (routeId !== current.route_id) await dropOrphan(current.route_id);
    return json({ id, route_id: routeId, updated_at: p.data.updated_at });
  }

  if (action === 'rename') {
    const name = str(body.name, 200);
    if (!name) return json({ error: 'Give the plan a name.' }, 400);
    const { error } = await supabase.from('rt_plans').update({ name }).eq('workspace_id', ws.id).eq('id', id);
    return error ? json({ error: error.message }, 400) : json({ id, name });
  }

  if (action === 'delete' || action === 'restore') {
    const { error } = await supabase
      .from('rt_plans')
      .update({ deleted_at: action === 'delete' ? new Date().toISOString() : null })
      .eq('workspace_id', ws.id)
      .eq('id', id);
    return error ? json({ error: error.message }, 400) : json({ id });
  }

  return json({ error: 'Unknown action.' }, 400);
};

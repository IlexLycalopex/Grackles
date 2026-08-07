import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { chat, MODEL } from '../../../../lib/minimax';
import {
  bestCached, LOOKUP_BUDGET, LOOKUP_TEMPERATURE, lookupMessages, narrowingTerms,
  parseQuery, readLookup, referenceKey,
  type CachedRow, type CigarReference,
} from '../../../../lib/cigar-lookup';

export const prerender = false;

/**
 * What is this cigar?
 *
 * Three stages, and the order is the entire cost design:
 *
 *   0. the workspace's own entries — free, and done on the page rather than
 *      here, because both list pages already hold every row;
 *   1. the shared reference cache — one select, and the answer for every cigar
 *      anybody has ever looked up;
 *   2. one call to M3 — reached only on a genuine miss.
 *
 * The stage that matters most is the one that is not in this file. Stages 0 and
 * 1 run as somebody types; stage 2 is a button they press. A debounced
 * type-ahead against this endpoint would spend money answering queries the user
 * is still halfway through writing, and is the way a feature like this becomes
 * expensive.
 *
 * The gate is `canWrite` rather than owner-only, which departs from the WBPR
 * desk deliberately: a night at the desk is an open-ended spend and the owner's
 * bill, whereas this is one bounded call, and an editor who cannot use quick-add
 * has a feature that does not work for them. The daily cap is what makes the
 * looser gate defensible, and it is a CHECK inside the insert policy as well as
 * a count here — this route tells you what happened in a sentence, the policy is
 * what actually holds.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Must agree with the count in `cl_cigar_reference_insert`. */
const DAILY_CAP = 50;

/** How many candidate rows the cache select may return before ranking. */
const CACHE_WINDOW = 200;

const CACHED_COLUMNS =
  'id, key, brand, line, name, vitola, length_inches, ring_gauge, wrapper, country';

const FULL_COLUMNS = `${CACHED_COLUMNS}, binder, filler, factory, strength, flavour, confidence, alternates`;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;

  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'cigar-lounge', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  if (!workspace.canWrite) {
    return json({ error: 'You need to be able to edit this lounge to look a cigar up.' }, 403);
  }

  const body = await request.json().catch(() => null);
  const asked = String(body?.query ?? '').trim().slice(0, 200);
  if (!asked) return json({ error: 'Type something to look up.' }, 400);

  const query = parseQuery(asked);
  if (query.empty) return json({ error: 'That is not enough to go on.' }, 400);

  // ── Stage 1: the cache ─────────────────────────────────────────────
  // Postgres narrows on the query's most distinctive words, and the matcher
  // from the filter box ranks what comes back. Doing the narrowing in SQL and
  // the matching in TypeScript keeps one definition of "matches" for the search
  // box and the cache both — a query that finds a cigar in your humidor finds
  // the same cigar here.
  const terms = narrowingTerms(query);
  let cached: CachedRow | null = null;

  if (terms.length > 0) {
    const filter = terms
      .flatMap(term => [`brand.ilike.%${term}%`, `name.ilike.%${term}%`, `line.ilike.%${term}%`])
      .join(',');

    const { data } = await supabase
      .from('cl_cigar_reference')
      .select(CACHED_COLUMNS)
      .or(filter)
      .limit(CACHE_WINDOW);

    cached = bestCached((data ?? []) as CachedRow[], query);
  }

  if (cached) {
    const { data: full } = await supabase
      .from('cl_cigar_reference')
      .select(FULL_COLUMNS)
      .eq('id', cached.id)
      .maybeSingle();

    if (full) return json({ source: 'cache', match: full });
  }

  // ── Stage 2: the model ─────────────────────────────────────────────
  // Checked here so a lounge at its limit is told so in a sentence. The policy
  // on the table is what stops it, and would reject the insert below whether or
  // not this ran — but a 42501 is not an explanation.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await supabase
    .from('cl_cigar_reference')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspace.id)
    .gt('created_at', since);

  if ((count ?? 0) >= DAILY_CAP) {
    return json(
      {
        error: `That is ${DAILY_CAP} lookups in a day for this lounge, which is the limit. Cached cigars still come back for nothing.`,
      },
      429
    );
  }

  const result = await chat(lookupMessages(asked), {
    maxTokens: LOOKUP_BUDGET,
    temperature: LOOKUP_TEMPERATURE,
  });

  if (!result.ok) {
    return json(
      {
        error: result.reason === 'unconfigured'
          ? 'Lookups are not configured — MINIMAX_API_KEY is unset.'
          : `Nothing came back: ${result.reason}.`,
      },
      result.reason === 'unconfigured' ? 503 : 502
    );
  }

  const reference = readLookup(result.content);

  if (!reference) {
    // Not cached. A reply that identified nothing is as likely to be a bad
    // moment as a bad question, and storing it would hand the same nothing to
    // the next person for free instead of giving them a second chance.
    console.error('cigar lookup: nothing usable came back', {
      query: asked,
      sample: result.content.slice(0, 300),
    });
    return json({ source: 'model', match: null, usage: result.usage });
  }

  const key = referenceKey(reference);

  const { data: stored, error: writeError } = await supabase
    .from('cl_cigar_reference')
    .insert({
      key,
      query: asked,
      ...reference,
      model: MODEL,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      workspace_id: workspace.id,
      looked_up_by: user.id,
    })
    .select(FULL_COLUMNS)
    .single();

  if (stored) return json({ source: 'model', match: stored, usage: result.usage });

  // A duplicate key means somebody else's lookup landed on this cigar between
  // our cache read and our write. Theirs is as good as ours and is already
  // stored, so it is returned — the tokens are spent either way, and answering
  // with the row that exists beats answering with an error about a race.
  if (writeError?.code === '23505') {
    const { data: theirs } = await supabase
      .from('cl_cigar_reference')
      .select(FULL_COLUMNS)
      .eq('key', key)
      .maybeSingle();

    if (theirs) return json({ source: 'cache', match: theirs, usage: result.usage });
  }

  // Anything else — the cap, most likely, if it filled between the count above
  // and here. The answer is still returned rather than thrown away, because it
  // was paid for; it simply will not be there for the next person.
  console.error('cigar lookup: could not cache', writeError);
  return json({
    source: 'model',
    match: { ...reference, id: null, key } satisfies CigarReference & { id: null; key: string },
    usage: result.usage,
    warning: 'That lookup was not saved, so asking again will cost another one.',
  });
};

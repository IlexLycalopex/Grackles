import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { withJob } from '../../../../lib/ai/job';
import { describeAiError } from '../../../../lib/ai/features';
import {
  buildLookupTurn, forbiddenFields, LOOKUP_SYSTEM, readLookup, referenceKey, scoreReference,
} from '../../../../lib/book-reference';
import { lookupBook, type Edition } from '../../../../lib/ai/openlibrary';
import { looselyEqual, normalise } from '../../../../lib/title-match';

export const prerender = false;

/**
 * What book is this?
 *
 * Four stages, cheapest first, stopping at the first that answers:
 *
 *   0. your own library — free, and done on the page rather than here, because
 *      the picker and the lookup page both already hold every entry. Standing
 *      in a bookshop, "do I already own this?" is the most valuable thing this
 *      feature does and it never reaches this file;
 *   1. the shared reference cache — one select, and the answer for every book
 *      anybody has ever looked up;
 *   2. OpenLibrary, then Google Books — free, and right about page counts;
 *   3. one call to M3 — reached only on a genuine miss.
 *
 * Stage 3 is a button somebody presses, never a keystroke. A debounced
 * type-ahead against a paid endpoint spends money answering queries the user is
 * still halfway through writing, and is the way a feature like this becomes
 * expensive.
 *
 * When stage 3 does run, what comes back is **a better query, not a better
 * record**: the model says which book is meant, and the app then asks
 * OpenLibrary again using its answer. The facts on the row below come from the
 * catalogue every time. See lib/book-reference.ts for why that line is drawn
 * here rather than where the cigar desk draws it.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answer shape, identical whichever stage produced it. */
const answered = (
  source: 'cache' | 'catalogue' | 'model',
  row: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => json({ source, match: row, ...extra });

/**
 * The best of what OpenLibrary returned for a title and author.
 *
 * `looselyEqual` on both halves, which is what stops a catalogue's habit of
 * answering every query with *something* becoming a wrong cover on somebody's
 * record. A candidate that does not match is not a worse answer than nothing;
 * it is a different book.
 */
function bestEdition(candidates: Edition[], title: string, author: string): Edition | null {
  const wantedTitle = normalise(title);
  const wantedAuthor = normalise(author);

  return (
    candidates.find(
      c =>
        looselyEqual(normalise(c.title), wantedTitle) &&
        (!wantedAuthor || looselyEqual(normalise(c.author), wantedAuthor))
    ) ?? null
  );
}

/** A reference row, from a catalogue edition and whatever named it. */
const rowFrom = (
  title: string,
  author: string,
  edition: Edition | null,
  extra: Record<string, unknown>
) => ({
  title,
  author,
  // Every one of these is the catalogue's. Nothing here is ever taken from a
  // completion — see the note on ISBN in lib/book-reference.ts.
  isbn: edition?.isbn ?? '',
  pages: edition?.pages ?? null,
  publisher: edition?.publisher ?? '',
  cover_url: edition?.cover_url ?? '',
  link_openlibrary: edition?.link_openlibrary ?? '',
  year_published: edition?.year_published ?? null,
  ...extra,
});

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'reading-list', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  // A courtesy check. The insert policy on rl_book_reference refuses a viewer
  // anyway, which is the one that holds when somebody posts here directly.
  if (!workspace.canWrite) return json({ error: 'You may not change this project.' }, 403);

  const body = await request.json().catch(() => null);
  const query = String(body?.query ?? '').trim().slice(0, 200);
  if (!query) return json({ error: 'What are you looking for?' }, 400);

  // ── Stage 1: the shared cache ────────────────────────────────────

  // Narrowed in the database, ranked here. A leading-wildcard ilike cannot use
  // the index either way, so this asks for the plausible rows and lets
  // scoreReference decide — the same arrangement the cigar desk arrived at.
  const words = normalise(query).split(' ').filter(Boolean);
  const { data: cached } = await supabase
    .from('rl_book_reference')
    .select('id, key, query, title, author, series, series_index, year_published, confidence, alternates, isbn, pages, publisher, cover_url, link_openlibrary')
    .or(words.map(w => `title.ilike.%${w}%,author.ilike.%${w}%,query.ilike.%${w}%`).join(','))
    .limit(30);

  const ranked = (cached ?? [])
    .map(row => ({ row, score: scoreReference(row, query) }))
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length) {
    return answered('cache', ranked[0]!.row, {
      // A cache hit costs nothing and inserts nothing, so it does not count
      // against the daily cap. That is the right incentive.
      alternates: ranked.slice(1, 3).map(hit => hit.row.title),
    });
  }

  // ── Stage 2: the catalogue, on the words as typed ────────────────

  const direct = await lookupBook(query, '');
  if (direct.ok && direct.candidates.length) {
    const edition = bestEdition(direct.candidates, query, '');
    if (edition) {
      return answered('catalogue', rowFrom(edition.title, edition.author, edition, {
        series: '',
        series_index: null,
        confidence: 'high',
        alternates: direct.candidates.slice(1, 3).map(c => c.title),
      }));
    }
  }

  // ── Stage 3: one call, and only now ──────────────────────────────

  const outcome = await withJob(
    {
      supabase,
      feature: 'reading.lookup',
      workspaceId: workspace.id,
      class: 'single',
      // The same question twice within the hour is the same lookup. Somebody
      // pressing the button twice should not open a second job.
      idempotencyKey: `lookup:${workspace.id}:${normalise(query)}`,
    },
    async job => {
      const turn = await job.chat({
        messages: [
          { role: 'system', content: LOOKUP_SYSTEM },
          { role: 'user', content: buildLookupTurn(query) },
        ],
        systemPrompt: LOOKUP_SYSTEM,
        // Recall, not improvisation — and a low temperature makes two people
        // asking the same thing more likely to produce the same cache key.
        temperature: 0.2,
        cacheKey: `booklookup:${normalise(query)}`,
        validate: content => {
          const read = readLookup(content);
          if (!read) {
            return { status: 'fail', findings: [{ rule: 'unreadable', detail: 'no usable title' }] };
          }
          // A prompt being ignored is worth recording even though the parser
          // has already dropped the field. This is what the quality floor acts
          // on, and it is how "the model started volunteering ISBNs again"
          // becomes visible rather than merely harmless.
          const smuggled = forbiddenFields(content);
          return smuggled.length
            ? { status: 'fail', findings: smuggled.map(f => ({ rule: 'forbidden-field', detail: f })) }
            : { status: 'pass' };
        },
      });

      if (!turn.ok) return { ok: false as const, error: turn.error };
      const read = readLookup(turn.content);
      if (!read) return { ok: false as const, error: 'nothing usable came back' };
      return { ok: true as const, read, callId: turn.callId, usage: turn.usage };
    }
  );

  if (!outcome.ok) {
    return json({ error: describeAiError({ code: outcome.code, message: outcome.error }) }, 402);
  }
  if (!outcome.value.ok) {
    return json({ error: 'Nothing could be found for that.' }, 404);
  }

  const { read } = outcome.value;

  // The whole point of the stage: ask the catalogue again, properly this time.
  const second = await lookupBook(read.title, read.author);
  const edition = second.ok ? bestEdition(second.candidates, read.title, read.author) : null;

  const row = rowFrom(read.title, read.author, edition, {
    series: read.series,
    series_index: read.series_index,
    // The model's year only where the catalogue has none. The catalogue is
    // right about first publication and the model is guessing at it.
    year_published: edition?.year_published ?? read.year_published,
    confidence: read.confidence,
    alternates: read.alternates,
  });

  // Cached for everybody, keyed on what it turned out to be rather than on what
  // was asked — which is why the second person to want this book pays nothing
  // even if they ask for it in different words.
  const { data: saved } = await supabase
    .from('rl_book_reference')
    .insert({
      key: referenceKey(read.title, read.author),
      query,
      ...row,
      model: 'minimax-m3',
      prompt_tokens: outcome.value.usage?.prompt_tokens ?? 0,
      completion_tokens: outcome.value.usage?.completion_tokens ?? 0,
      workspace_id: workspace.id,
      looked_up_by: user.id,
    })
    .select('id')
    .maybeSingle();

  // A refused insert is the daily cap, or somebody else caching the same book
  // between our select and our insert. Neither is a reason to withhold the
  // answer we already paid for.
  return answered('model', { id: saved?.id ?? null, ...row });
};

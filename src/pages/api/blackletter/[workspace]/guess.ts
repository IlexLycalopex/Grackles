import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { LENGTHS, isPlayableLength } from '../../../../lib/blackletter';

export const prerender = false;

/**
 * One guess.
 *
 * This route is thin on purpose. It does not mark the guess, does not decide
 * whether the game is over, and never sees the answer unless the database
 * chooses to send one back — all of that is `blackletter_guess()`, which is
 * where it has to be, because a rule enforced in this file is a rule a crafted
 * request can skip by not using this file.
 *
 * What it does add is the translation from a SQLSTATE to a sentence, which is
 * the same division of labour `lib/records/save.ts` draws: the database is the
 * guarantee, and this turns its refusal into something a player can read.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A refusal a player caused, and can do something about. */
const SENTENCES: Record<string, (m: string) => string> = {
  // The message already names the word: "PLINTH is not in the word list".
  GRK06: m => m,
  GRK07: () => 'That game is already finished.',
  GRK05: () => 'Blackletter has run out of words at that length. Tell Jamie.',
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  const { workspace: slug } = params;

  if (!user) return json({ error: 'Sign in to play.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'blackletter', slug!, user.id);
  if (!workspace) return json({ error: 'Not found' }, 404);

  let body: { length?: unknown; guess?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }

  const length = Number(body.length);
  const guess = String(body.guess ?? '').trim().toLowerCase();

  // Checked here as well as in the database because an unlisted length would
  // otherwise mint a puzzle for it — the function is happy to schedule a
  // nine-letter word, and nothing else in the app would ever show it.
  if (!isPlayableLength(length)) {
    return json({ error: `Blackletter plays at ${LENGTHS.join(', ')} letters.` }, 400);
  }
  if (!/^[a-z]+$/.test(guess) || guess.length !== length) {
    return json({ error: `Type a ${length}-letter word.` }, 400);
  }

  const { data, error } = await supabase.rpc('blackletter_guess', {
    p_workspace: workspace.id,
    p_length: length,
    p_guess: guess,
  });

  if (error) {
    const sentence = SENTENCES[error.code ?? '']?.(error.message);
    if (sentence) return json({ error: sentence }, 400);
    // Anything else is ours, not theirs. Logged with the original so the cause
    // survives, answered with a sentence that does not repeat a database error
    // at somebody trying to play a word game.
    console.error('blackletter_guess failed', error);
    return json({ error: 'Something went wrong saving that guess.' }, 500);
  }

  return json(data);
};

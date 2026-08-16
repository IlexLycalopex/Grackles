/**
 * Reading JSON back out of a model.
 *
 * M3 does not usefully support `response_format` on the OpenAI-compatible
 * path — the parameter documented for MiniMax-Text-01 is accepted and ignored
 * rather than rejected, which is the worst of the three possible behaviours:
 * the request looks like it worked and the constraint was never applied. So
 * the shape is asked for in the prompt, and read back tolerantly here.
 *
 * Lifted out of the WBPR write-up, which had the only copy, because the cigar
 * lookup needs exactly the same thing and a second copy would be a second
 * chance to fix a bug once.
 *
 * The brace-span itself lives in `ai/json.ts`, which grew the same rule
 * independently while the governance layer was being built. This module is the
 * tolerant, guardless reading of it — "give me the object or give me null" —
 * and `ai/json.ts` is the one that says why it failed. Two questions, one
 * answer about where the JSON starts.
 */

import { extractJson } from './ai/json';

/**
 * The object a model meant to send, or null.
 *
 * A model told to answer with JSON and nothing else will sometimes wrap it in a
 * fence or introduce it with a sentence anyway. Taking the span between the
 * outermost braces costs nothing and recovers both, where a second call asking
 * it to try again costs a whole call and might not.
 */
export function parseJsonObject<T>(text: string): T | null {
  const span = extractJson(text);
  if (span === null) return null;
  try {
    return JSON.parse(span) as T;
  } catch {
    return null;
  }
}

/** One of a fixed set, or the fallback. The model's word is never taken for a column's. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** One of a fixed set, or null — for a column where "not known" is a real answer. */
export function oneOfOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

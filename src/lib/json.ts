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
 */

/**
 * The first `{` to the last `}`.
 *
 * A model told to answer with JSON and nothing else will sometimes wrap it in a
 * fence or introduce it with a sentence anyway. Taking the span between the
 * outermost braces costs nothing and recovers both, where a second call asking
 * it to try again costs a whole call and might not.
 */
export function parseJsonObject<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
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

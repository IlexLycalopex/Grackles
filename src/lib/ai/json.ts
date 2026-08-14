/**
 * Asking for a shape and getting one.
 *
 * Every feature that wants structured output needs the same three things: take
 * the JSON out of whatever the model wrapped it in, parse it without throwing,
 * and check it is the shape that was asked for. Written once here because the
 * fourth copy is the one that forgets the fence.
 */

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'no-json' | 'unparseable' | 'wrong-shape'; detail?: string };

/**
 * The first `{` to the last `}`.
 *
 * The instruction says JSON and nothing else, and the model will sometimes wrap
 * it in a fence anyway. Taking the span is cheaper and more reliable than
 * another call asking it to try again — and a second call to fix the first is
 * the most expensive way there is to handle a stray backtick.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse against a guard.
 *
 * The guard is the shape check, and it is required rather than optional: a
 * parse that succeeds tells you the model produced JSON, not that it produced
 * the JSON you asked for, and everything downstream is written as though it
 * did.
 */
export function parseShape<T>(text: string, guard: (v: unknown) => v is T): Parsed<T> {
  const span = extractJson(text);
  if (!span) return { ok: false, reason: 'no-json' };

  let value: unknown;
  try {
    value = JSON.parse(span);
  } catch (cause) {
    return { ok: false, reason: 'unparseable', detail: String(cause).slice(0, 200) };
  }

  if (!guard(value)) return { ok: false, reason: 'wrong-shape' };
  return { ok: true, value };
}

/** Whether the parse itself failed, which is the cheapest quality metric there is. */
export const isShapeFailure = (p: Parsed<unknown>) => !p.ok;

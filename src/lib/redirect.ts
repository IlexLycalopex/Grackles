/**
 * Where to send somebody next, given an address that arrived from outside.
 *
 * Four routes take a `next` from a query string or a form field, and each had
 * written its own check. Two looked for a leading `/` and nothing else, so
 * `//evil.example` got through; the other two also refused `//` but let
 * `/\evil.example` through, which every browser reads as the same thing. The
 * rule is now to resolve the address the way a browser would and keep it only
 * if it still lands on this site, which is the one test the tricks cannot pass.
 */
const BASE = 'https://grackles.invalid';

export function safeNext(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback;
  // Backslashes and control characters have no business in a path of ours,
  // and are how the browser-side reinterpretations start.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;

  return url.pathname + url.search + url.hash;
}

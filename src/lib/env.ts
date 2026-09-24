/**
 * A server-side setting, read when the request asks for it.
 *
 * Astro inlines `import.meta.env` into the bundle at build time, so a key
 * rotated in the Vercel dashboard would keep its old value until the next
 * deploy; `process.env` is read live by the function. The second lookup keeps
 * `astro dev` and `.env` working, and the guard keeps a test run (which has
 * no `import.meta.env`) from throwing.
 *
 * Lifted out of lib/email.ts, which found this first, so the model key and
 * the Google Books key are read the same way as the mail key.
 */
export function env(name: string): string | undefined {
  const live = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return live ?? (import.meta.env as Record<string, string | undefined> | undefined)?.[name];
}

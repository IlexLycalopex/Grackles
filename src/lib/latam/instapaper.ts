/**
 * Saving a link to Instapaper, for reading later on the phone.
 *
 * Instapaper's Simple API: one POST with the account's username and password,
 * a URL and a title. It needs no OAuth application, which is why it suits one
 * person's site. The credentials are environment secrets on the deployment
 * (INSTAPAPER_USERNAME, INSTAPAPER_PASSWORD), never a database row, and only
 * the project's owner may send, because the account is the owner's.
 *
 * https://www.instapaper.com/api/simple
 */

const ADD = 'https://www.instapaper.com/api/add';

export type Sent = { ok: true } | { ok: false; reason: 'not-configured' | 'refused' | 'failed'; message: string };

// Vercel exposes secrets on process.env at runtime; import.meta.env is absent
// outside Vite (the test runner), hence the optional chain.
const fromEnv = (name: string): string | undefined =>
  process.env[name] ?? (import.meta as { env?: Record<string, string | undefined> }).env?.[name];

function credentials(): { username: string; password: string } | null {
  const username = fromEnv('INSTAPAPER_USERNAME');
  const password = fromEnv('INSTAPAPER_PASSWORD') ?? '';
  return username ? { username, password } : null;
}

export const instapaperConfigured = () => credentials() !== null;

export async function sendToInstapaper(url: string, title: string, note = '', fetcher: typeof fetch = fetch): Promise<Sent> {
  const creds = credentials();
  if (!creds) return { ok: false, reason: 'not-configured', message: 'Instapaper is not connected.' };
  if (!/^https?:\/\//.test(url)) return { ok: false, reason: 'refused', message: 'There is no link to send.' };

  const body = new URLSearchParams({ url, title: title.slice(0, 300) });
  if (note) body.set('selection', note.slice(0, 600));
  try {
    const res = await fetcher(ADD, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 201) return { ok: true };
    if (res.status === 403) return { ok: false, reason: 'refused', message: 'Instapaper did not accept the login.' };
    if (res.status === 400) return { ok: false, reason: 'refused', message: 'Instapaper would not take that link.' };
    return { ok: false, reason: 'failed', message: `Instapaper answered ${res.status}. Try again later.` };
  } catch {
    return { ok: false, reason: 'failed', message: 'Instapaper could not be reached. Try again later.' };
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToInstapaper } from './instapaper.ts';

const answering = (status: number, seen: { auth?: string; body?: string }[] = []) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ auth: new Headers(init?.headers).get('authorization') ?? '', body: String(init?.body) });
    return new Response('', { status });
  }) as typeof fetch;

test('without credentials nothing is sent', async () => {
  delete process.env.INSTAPAPER_USERNAME;
  const r = await sendToInstapaper('https://example.com', 'X', '', answering(201));
  assert.deepEqual(r, { ok: false, reason: 'not-configured', message: 'Instapaper is not connected.' });
});

test('a link is sent with the account login and the reason as the selection', async () => {
  process.env.INSTAPAPER_USERNAME = 'jamie';
  process.env.INSTAPAPER_PASSWORD = 'pw';
  const seen: { auth?: string; body?: string }[] = [];
  const r = await sendToInstapaper('https://en.wikipedia.org/wiki/Y_Wladfa', 'Y Wladfa', 'The Welsh colony', answering(201, seen));
  assert.deepEqual(r, { ok: true });
  assert.equal(seen[0]!.auth, `Basic ${btoa('jamie:pw')}`);
  assert.match(seen[0]!.body!, /selection=The\+Welsh\+colony/);
});

test('a refused login says so', async () => {
  process.env.INSTAPAPER_USERNAME = 'jamie';
  const r = await sendToInstapaper('https://example.com', 'X', '', answering(403));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'refused');
  delete process.env.INSTAPAPER_USERNAME;
  delete process.env.INSTAPAPER_PASSWORD;
});

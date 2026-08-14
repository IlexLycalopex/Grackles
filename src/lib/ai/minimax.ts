/**
 * Talking to MiniMax M3.
 *
 * The API is OpenAI-shaped, so this is a single fetch rather than an SDK — the
 * same reasoning as `lib/email.ts`, where a dependency would only start earning
 * its place once we needed to read something back that a POST does not give us.
 *
 * The key is server-only. It has no PUBLIC_ prefix, so Astro will not put it in
 * the client bundle, and every call goes through an API route rather than from
 * the browser. A key that reaches a browser is a key anyone can spend.
 *
 * Moved here from lib/minimax.ts when the governance layer landed. The only
 * change is the shape: it is now one implementation of `Provider` rather than
 * the single global `chat()`, and the model is passed in rather than being a
 * constant, because ai_features binds a model per feature.
 */

import { noUsage, type ChatMessage, type ChatResult, type CompleteOptions, type Provider } from './provider';

const ENDPOINT = 'https://api.minimax.io/v1/chat/completions';

export const DEFAULT_MODEL = 'minimax-m3';

/**
 * One completion.
 *
 * `thinking: disabled` is deliberate and is worth the sentence. On the
 * OpenAI-compatible path M3 enables adaptive thinking when the parameter is
 * omitted, so leaving it out silently buys reasoning tokens on every turn. This
 * is a DJ improvising over a card draw — there is nothing here to reason about
 * that is worth paying for, and the latency lands in the middle of a
 * conversation somebody is having in real time.
 *
 * `maxTokens` is a cost ceiling as much as a length one, and it is no longer
 * the caller's to choose freely: withJob() clamps it to the feature's
 * registered max_tokens, because that is the number the reservation was taken
 * against.
 */
async function complete(messages: ChatMessage[], options: CompleteOptions): Promise<ChatResult> {
  const key = import.meta.env.MINIMAX_API_KEY;
  if (!key) {
    // Reported as an unconfigured state rather than an error, the way a missing
    // RESEND_API_KEY is: it is how the app runs until somebody sets it.
    return { ok: false, reason: 'unconfigured', usage: noUsage };
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature ?? 1,
        thinking: { type: 'disabled' },
      }),
    });
  } catch (cause) {
    console.error('minimax fetch failed', cause);
    return { ok: false, reason: 'the station could not reach the model', usage: noUsage };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Logged whole, reported short. The body can carry a key echo or a request
    // id, neither of which belongs on a page.
    console.error('minimax returned an error', { status: response.status, body: body.slice(0, 500) });

    // 429 and 5xx are the provider being unavailable rather than the request
    // being wrong, and they are what the breaker counts. Said in those words so
    // that the reason on the call row distinguishes "it is down" from "we asked
    // it something it would not do" — the two want different responses and the
    // ledger is where somebody looks to tell them apart.
    const retryAfter = response.headers.get('retry-after');
    const reason =
      response.status === 401 ? 'the model refused the key'
      : response.status === 429
        ? `the model is rate-limiting us${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`
      : response.status >= 500 ? `the model is unavailable (${response.status})`
      : `the model answered ${response.status}`;

    return { ok: false, reason, usage: noUsage };
  }

  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;

  // Read before the content check, not after. A response that came back with a
  // usage block and no content still cost what the usage block says, and
  // reporting that as free is how the ledger and the invoice come apart.
  const usage = {
    prompt_tokens: payload?.usage?.prompt_tokens ?? 0,
    completion_tokens: payload?.usage?.completion_tokens ?? 0,
  };

  if (typeof content !== 'string' || !content.trim()) {
    console.error('minimax returned no content', { payload });
    return { ok: false, reason: 'the model answered with nothing', usage };
  }

  return { ok: true, content: content.trim(), usage };
}

export const minimax: Provider = { name: 'minimax', complete };

/** Every provider the platform knows how to reach, by the name ai_models uses. */
export const PROVIDERS: Record<string, Provider> = { minimax };

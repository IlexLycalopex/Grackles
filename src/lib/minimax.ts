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
 */

const ENDPOINT = 'https://api.minimax.io/v1/chat/completions';

export const MODEL = 'minimax-m3';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type ChatResult =
  | { ok: true; content: string; usage: Usage }
  | { ok: false; reason: string };

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
 * `max_tokens` is a cost ceiling as much as a length one: a model that decides
 * to write the whole night in one turn is the failure mode that makes a feature
 * like this expensive, and the caller passes a budget suited to what it asked
 * for.
 */
export async function chat(
  messages: ChatMessage[],
  options: { maxTokens: number; temperature?: number } = { maxTokens: 700 }
): Promise<ChatResult> {
  const key = import.meta.env.MINIMAX_API_KEY;
  if (!key) {
    // Reported as an unconfigured state rather than an error, the way a missing
    // RESEND_API_KEY is: it is how the app runs until somebody sets it.
    return { ok: false, reason: 'unconfigured' };
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
        model: MODEL,
        messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature ?? 1,
        thinking: { type: 'disabled' },
      }),
    });
  } catch (cause) {
    console.error('minimax fetch failed', cause);
    return { ok: false, reason: 'the station could not reach the model' };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Logged whole, reported short. The body can carry a key echo or a request
    // id, neither of which belongs on a page.
    console.error('minimax returned an error', { status: response.status, body: body.slice(0, 500) });
    return {
      ok: false,
      reason: response.status === 401
        ? 'the model refused the key'
        : `the model answered ${response.status}`,
    };
  }

  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    console.error('minimax returned no content', { payload });
    return { ok: false, reason: 'the model answered with nothing' };
  }

  return {
    ok: true,
    content: content.trim(),
    usage: {
      prompt_tokens: payload?.usage?.prompt_tokens ?? 0,
      completion_tokens: payload?.usage?.completion_tokens ?? 0,
    },
  };
}

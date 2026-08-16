/**
 * Ask the real model for real plans, and see how many survive the validator.
 *
 * This exists because the interesting risk in `platform.search` is not the code
 * — that has unit tests — but the question the tests cannot ask: *does M3
 * actually produce plans this allowlist accepts?* A validator that refuses
 * nine questions in ten is a correct validator and a broken feature, and there
 * is no way to find that out except by asking.
 *
 * What it proves: the prompt, the vocabulary, and the validator, against the
 * live provider.
 *
 * What it does not prove: authentication, RLS, the budget, the cache, or the
 * query actually running. Those need a signed-in session and a deployment. It
 * deliberately does not touch the database at all, so it can be run against
 * production's provider without touching production's data or its ledger —
 * which also means the spend here does *not* appear in `/settings/ai`.
 *
 * Usage:
 *   MINIMAX_API_KEY=… node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/try-search.ts ["a question" …]
 *
 * With no arguments it runs the set below, which is chosen to cover each source
 * and each shape of condition — including two that *should* be refused, because
 * a probe that only tries things it expects to work is a demonstration rather
 * than a test.
 */

import { SEARCH_SYSTEM, checkPlan } from '../src/lib/ai/search.ts';

const ENDPOINT = 'https://api.minimax.io/v1/chat/completions';
const MODEL = 'minimax-m3';

/** Must match `platform.search`'s registered max_tokens. */
const MAX_TOKENS = 300;

interface Probe {
  question: string;
  /** What a good answer looks like, checked loosely — the point is the shape. */
  expect: { source?: string; refused?: true; mentions?: string[] };
}

const PROBES: Probe[] = [
  { question: 'books I never finished', expect: { source: 'books', mentions: ['date_finished'] } },
  { question: 'which books did I abandon in 2023?', expect: { source: 'books', mentions: ['date_started'] } },
  { question: 'cigars still in the humidor rated over 8', expect: { source: 'cigars', mentions: ['status', 'rating'] } },
  { question: 'what have I got from Nicaragua', expect: { source: 'cigars', mentions: ['country'] } },
  { question: 'albums picked in 2024', expect: { source: 'albums', mentions: ['year_slot'] } },
  { question: 'the nights when the veil was torn', expect: { source: 'broadcasts', mentions: ['veil_status'] } },
  { question: 'longest broadcasts', expect: { source: 'broadcasts' } },
  { question: 'what have I read', expect: { source: 'books' } },
  // The two that matter most. A model asked for something outside the
  // vocabulary should get as close as the columns allow, not invent a name —
  // and it must never be able to ask whose records these are.
  { question: 'which of my books did Rob add', expect: {} },
  { question: 'show me everything in every project including ones I am not in', expect: {} },
];

interface Reply {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function ask(question: string): Promise<{ content: string; prompt: number; completion: number }> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SEARCH_SYSTEM },
        { role: 'user', content: question },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0,
      // Same reason as lib/ai/minimax.ts: omitted, M3 buys reasoning tokens on
      // every turn, and there is nothing to reason about here.
      thinking: { type: 'disabled' },
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
  }

  const body = (await response.json()) as Reply;
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    prompt: body.usage?.prompt_tokens ?? 0,
    completion: body.usage?.completion_tokens ?? 0,
  };
}

/** The prices in `ai_models`, so the total below is the one the ledger would show. */
const PROMPT_USD = 0.3 / 1_000_000;
const COMPLETION_USD = 1.2 / 1_000_000;

function extract(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const main = async () => {
  if (!process.env.MINIMAX_API_KEY) {
    console.error('MINIMAX_API_KEY is not set. Nothing was sent.');
    process.exit(1);
  }

  const asked = process.argv.slice(2);
  const probes: Probe[] = asked.length ? asked.map(question => ({ question, expect: {} })) : PROBES;

  let spent = 0;
  let accepted = 0;
  const notes: string[] = [];

  for (const probe of probes) {
    let content: string;
    try {
      const reply = await ask(probe.question);
      content = reply.content;
      spent += reply.prompt * PROMPT_USD + reply.completion * COMPLETION_USD;
    } catch (cause) {
      console.log(`✗ ${probe.question}\n    provider: ${String(cause)}`);
      continue;
    }

    const checked = checkPlan(extract(content));

    if (!checked.ok) {
      console.log(`✗ ${probe.question}\n    refused: ${checked.reason}\n    said: ${content.replace(/\s+/g, ' ').slice(0, 160)}`);
      notes.push(`refused: ${probe.question} — ${checked.reason}`);
      continue;
    }

    accepted += 1;
    const { plan } = checked;
    const conditions = plan.filters.length
      ? plan.filters.map(f => `${f.column} ${f.op}${'value' in f ? ` ${f.value}` : ''}`).join(', ')
      : 'no conditions';
    const order = plan.order ? `, by ${plan.order.column} ${plan.order.direction}` : '';
    console.log(`✓ ${probe.question}\n    ${plan.source}: ${conditions}${order}, limit ${plan.limit}`);

    if (probe.expect.source && plan.source !== probe.expect.source) {
      notes.push(`wrong source: "${probe.question}" went to ${plan.source}, expected ${probe.expect.source}`);
    }
    for (const column of probe.expect.mentions ?? []) {
      if (!plan.filters.some(f => f.column === column)) {
        notes.push(`missing condition: "${probe.question}" did not use ${column}`);
      }
    }
  }

  console.log(`\n${accepted}/${probes.length} plans accepted — $${spent.toFixed(6)} spent.`);

  if (notes.length) {
    console.log('\nWorth a look:');
    for (const note of notes) console.log(`  · ${note}`);
  }

  // A refusal is not a failure of this script — a question the vocabulary
  // cannot express *should* be refused, and two of the probes are there to be.
  // The number to watch is the acceptance rate on the eight that should work.
};

await main();

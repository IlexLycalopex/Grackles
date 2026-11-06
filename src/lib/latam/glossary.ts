/**
 * A glossary for one Lecturas article: ten words worth learning from it, and
 * two lines of English on what it is about.
 *
 * The model reads the article (fetched here, never stored) and proposes; the
 * app keeps a word only if it actually appears in the article, in the form
 * given, and is written in Latin script. A gloss for a word the reader will
 * never meet in the text is noise; an invented one is worse.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { withJob } from '../ai/job';
import { describeAiError } from '../ai/features';
import { parseJsonObject } from '../json';
import { articleText } from '../../../supabase/functions/_shared/reader.ts';
import { hasForeign } from './research';

type Db = SupabaseClient<Database>;

export interface Gloss {
  es: string;
  en: string;
}

export const GLOSSARY_SYSTEM = `You help an English speaker at B1–B2 level read an Argentine Spanish article.

Answer with JSON and nothing else:

{
  "summary": "Two sentences in English on what the article is about.",
  "words": [{ "es": "a word or short phrase exactly as it appears in the article", "en": "its meaning here, in a few words" }]
}

Choose up to ten words or short phrases a B1–B2 learner is unlikely to know and that matter for understanding this article. Prefer Argentine and regional usage, voseo forms and lunfardo where they appear. Copy each one exactly as it is written in the article. British English. Latin script only.`;

const fold = (s: string) => s.toLowerCase().normalize('NFC');

/** The model's answer, with every word checked against the article. */
export function readGlossary(content: string, article: string): { summary: string; words: Gloss[] } | null {
  const raw = parseJsonObject<Record<string, unknown>>(content);
  if (!raw) return null;
  const summary = typeof raw.summary === 'string' && !hasForeign(raw.summary) ? raw.summary.trim().slice(0, 600) : '';
  const text = fold(article);
  const words = (Array.isArray(raw.words) ? raw.words : [])
    .map(w => w as Record<string, unknown>)
    .filter(w => typeof w?.es === 'string' && typeof w?.en === 'string')
    .map(w => ({ es: (w.es as string).trim().slice(0, 80), en: (w.en as string).trim().slice(0, 160) }))
    .filter(w => w.es && w.en && !hasForeign(w.es) && !hasForeign(w.en) && text.includes(fold(w.es)))
    .slice(0, 10);
  if (!summary && !words.length) return null;
  return { summary, words };
}

async function fetchArticle(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Grackles/1.0; +https://grackles.co.uk)', Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    return articleText(await res.text());
  } catch {
    return '';
  }
}

export async function makeGlossary(
  db: Db,
  workspaceId: string,
  article: { id: string; url: string; title: string }
): Promise<{ ok: true; words: number } | { ok: false; error: string }> {
  const text = await fetchArticle(article.url);
  if (text.length < 400) return { ok: false, error: 'The article could not be read from its site, so there is nothing to make a glossary from.' };

  const outcome = await withJob(
    { supabase: db, feature: 'latam.glossary', workspaceId, class: 'single', idempotencyKey: `glossary:${article.id}` },
    async job => {
      const turn = await job.chat({
        messages: [
          { role: 'system', content: GLOSSARY_SYSTEM },
          { role: 'user', content: `Title: ${article.title}\n\n${text.slice(0, 6000)}` },
        ],
        systemPrompt: GLOSSARY_SYSTEM,
        temperature: 0.2,
        cacheKey: `glossary:${article.url}`,
        validate: c => (readGlossary(c, text) ? { status: 'pass' } : { status: 'fail', findings: [{ rule: 'unreadable' }] }),
      });
      if (!turn.ok) return { ok: false as const, error: turn.error };
      const read = readGlossary(turn.content, text);
      if (!read) return { ok: false as const, error: 'The glossary could not be read. Try again.' };
      return { ok: true as const, read, callId: turn.callId };
    }
  );
  if (!outcome.ok) return { ok: false, error: describeAiError({ code: outcome.code, message: outcome.error }) };
  if (!outcome.value.ok) return { ok: false, error: outcome.value.error };

  const { read, callId } = outcome.value;
  const { error } = await db.rpc('lx_reader_enrich', {
    p_article: article.id,
    p_summary: read.summary,
    p_glossary: read.words as never,
    p_call: callId,
  });
  if (error) return { ok: false, error: 'The glossary was made but could not be saved.' };
  return { ok: true, words: read.words.length };
}

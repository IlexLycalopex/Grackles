import { normalise } from './normalise.ts';

/**
 * Flashcards in and out as CSV.
 *
 * Columns: prompt, answer, accepts, hint, notes, tags, reverse. `accepts` and
 * `tags` hold several values separated by `|`. The header row is optional, and
 * when present its order wins, so a spreadsheet with the columns shuffled still
 * imports. Only prompt and answer are required.
 */

export interface CardDraft {
  id?: string;
  prompt: string;
  answer: string;
  accepts: string[];
  hint: string;
  notes: string;
  tags: string[];
  reverse: boolean;
}

export const COLUMNS = ['prompt', 'answer', 'accepts', 'hint', 'notes', 'tags', 'reverse'] as const;

/** RFC 4180 as spreadsheets actually write it: quoted fields, doubled quotes, CRLF or LF. */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

const split = (v: string | undefined) => (v ?? '').split('|').map(x => x.trim()).filter(Boolean);
const truthy = (v: string | undefined) => /^(1|y|yes|true|x)$/i.test((v ?? '').trim());

export interface ImportProblem {
  /** 1-based, counting the header if there was one, so it matches the spreadsheet. */
  line: number;
  message: string;
}

export interface ImportResult {
  cards: CardDraft[];
  problems: ImportProblem[];
}

/**
 * Parse, then check. Rows with problems are still returned (with the problem
 * listed) so the preview can show the whole file; saving is refused until the
 * list is empty.
 */
export function parseCards(text: string): ImportResult {
  const rows = parseRows(text);
  if (!rows.length) return { cards: [], problems: [{ line: 1, message: 'The file is empty.' }] };

  const first = rows[0].map(h => h.trim().toLowerCase());
  const hasHeader = first.includes('prompt') && first.includes('answer');
  const order = hasHeader ? first : [...COLUMNS];
  const col = (r: string[], name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? undefined : r[i]?.trim();
  };

  const body = hasHeader ? rows.slice(1) : rows;
  const offset = hasHeader ? 2 : 1;
  const cards = body.map(r => ({
    prompt: col(r, 'prompt') ?? '',
    answer: col(r, 'answer') ?? '',
    accepts: split(col(r, 'accepts')),
    hint: col(r, 'hint') ?? '',
    notes: col(r, 'notes') ?? '',
    tags: split(col(r, 'tags')),
    reverse: truthy(col(r, 'reverse')),
  }));
  return { cards, problems: checkCards(cards, offset) };
}

/**
 * The same checks the editor runs before saving: nothing empty, no duplicate
 * prompts, and no two answers that are the same once normalised — the marker
 * would have no way to tell which card was meant.
 */
export function checkCards(cards: CardDraft[], firstLine = 1): ImportProblem[] {
  const problems: ImportProblem[] = [];
  const prompts = new Map<string, number>();
  const answers = new Map<string, number>();
  cards.forEach((c, i) => {
    const line = i + firstLine;
    if (!c.prompt.trim()) problems.push({ line, message: 'No prompt.' });
    if (!c.answer.trim()) problems.push({ line, message: 'No answer.' });
    if (c.prompt.length > 500 || c.answer.length > 500) problems.push({ line, message: 'Longer than 500 characters.' });
    const p = normalise(c.prompt);
    if (p && prompts.has(p)) problems.push({ line, message: `Same prompt as line ${prompts.get(p)}.` });
    else if (p) prompts.set(p, line);
    for (const a of [c.answer, ...c.accepts]) {
      const n = normalise(a);
      if (!n) continue;
      const other = answers.get(n);
      if (other !== undefined && other !== line) {
        problems.push({ line, message: `"${a}" is also an answer on line ${other}.` });
      } else {
        answers.set(n, line);
      }
    }
  });
  return problems;
}

const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(cards: CardDraft[]): string {
  const lines = [COLUMNS.join(',')];
  for (const c of cards) {
    lines.push([
      c.prompt, c.answer, c.accepts.join('|'), c.hint, c.notes, c.tags.join('|'), c.reverse ? 'yes' : '',
    ].map(quote).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

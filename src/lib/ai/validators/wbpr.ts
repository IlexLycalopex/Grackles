import { RANKS, SUITS } from '../../wbpr-deck';
import type { AgentState } from '../../wbpr-agent';
import type { Validation } from '../job';

/**
 * The desk's rules, checked rather than hoped for.
 *
 * The system prompt states two of them plainly — never name a track, never
 * invent a card — and today they hold because the model complies. If it stops
 * complying, Jamie notices or he does not, and nothing records it either way.
 *
 * Both are functions of state this app is already holding: it dealt the cards
 * and it has the transcript. A rule worth writing into a prompt is worth
 * verifying, or it is a wish.
 *
 * This is a validator, not a judge. It does not decide whether the prose is any
 * good; it decides whether the answer is legal.
 */

export interface Finding {
  rule: 'invented-card' | 'named-music';
  detail: string;
}

/**
 * The deck deals numerals — `cardName` produces "9 of Diamonds" — and prose
 * says "Nine of Diamonds". Both have to be recognised as the same card or the
 * check fails in both directions at once: an invented card written in words
 * slips past, and a legitimate one restated in words is reported as invented.
 *
 * The first version of this validator matched only the numerals, which meant
 * its very first fixture — a model narrating the Nine of Diamonds it had never
 * been dealt — passed clean.
 */
const WORD_RANKS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10',
};

const RANK_FORMS = [...RANKS, ...Object.keys(WORD_RANKS)];

const CARD_PATTERN = new RegExp(
  `\\b(${RANK_FORMS.join('|')})\\s+of\\s+(${SUITS.join('|')})\\b`,
  'gi'
);

/** "Nine of Diamonds" and "9 of Diamonds" reduce to the same string. */
const canonicalCard = (rank: string, suit: string) =>
  `${WORD_RANKS[rank.toLowerCase()] ?? rank} of ${suit}`.toLowerCase();

/**
 * Music the model named that the DJ did not.
 *
 * Deliberately a heuristic and deliberately only a warning. The rule is
 * absolute but its detection cannot be: there is no list of every song to check
 * against, so this looks for the shape a named track takes — something quoted,
 * or something followed by "by <a capitalised name>". A quoted line of dialogue
 * will occasionally trip it.
 *
 * A warning rather than a failure because a false positive that blocked a
 * broadcast would be worse than the thing it was guarding, and the number that
 * matters is the trend: this firing three times a night when it used to fire
 * never is the signal, not any single instance.
 */
const QUOTED = /[“"']([A-Z][^”"']{2,60})[”"']/g;
const BY_ARTIST = /\bby\s+([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})\b/g;

export function validateDeskReply(
  content: string,
  state: AgentState,
  /** What the DJ said this turn — anything he named himself is his to name. */
  said = ''
): Validation {
  const findings: Finding[] = [];

  // ── Cards ────────────────────────────────────────────────────────────
  // Fully deterministic: the app drew them, so it knows every card that is
  // legitimately in play. Anything else is invented.
  const legal = new Set<string>();
  const remember = (name: string | undefined) => {
    if (!name) return;
    const parts = /^(\S+)\s+of\s+(\S+)$/.exec(name);
    legal.add(parts ? canonicalCard(parts[1], parts[2]) : name.toLowerCase());
  };

  for (const c of state.cards ?? []) remember(c.name);
  remember(state.caller?.card);
  for (const block of state.blocks ?? []) {
    for (const c of block.cards ?? []) remember(c.name);
    remember(block.caller?.card);
  }

  for (const match of content.matchAll(CARD_PATTERN)) {
    if (!legal.has(canonicalCard(match[1], match[2]))) {
      findings.push({ rule: 'invented-card', detail: `${match[1]} of ${match[2]}` });
    }
  }

  // ── Music ────────────────────────────────────────────────────────────
  const djsOwnWords = said.toLowerCase();
  const mentioned = new Set<string>();

  for (const [, phrase] of content.matchAll(QUOTED)) {
    if (phrase && !djsOwnWords.includes(phrase.toLowerCase())) mentioned.add(phrase);
  }
  for (const [, artist] of content.matchAll(BY_ARTIST)) {
    if (artist && !djsOwnWords.includes(artist.toLowerCase())) mentioned.add(artist);
  }

  for (const phrase of mentioned) {
    findings.push({ rule: 'named-music', detail: phrase });
  }

  if (findings.some(f => f.rule === 'invented-card')) {
    return { status: 'fail', findings };
  }
  if (findings.length > 0) return { status: 'warn', findings };
  return { status: 'pass' };
}

/**
 * The write-up, checked against the sitting rather than against taste.
 *
 * The model is asked for prose, tracks and phenomena; the cards, rolls and
 * block numbers come from our own state. So the thing to verify is that it has
 * not quietly answered a question it was not asked: a block that did not
 * happen, or a position outside the four.
 */
export function validateWriteup(
  payload: { blocks?: { position: number }[] } | null,
  state: AgentState
): Validation {
  if (!payload) {
    // The cheapest quality metric there is, and the first to move when a prompt
    // or a model changes.
    return { status: 'fail', findings: [{ rule: 'unparseable', detail: 'no JSON in the reply' }] };
  }

  const played = new Set((state.blocks ?? []).map(b => b.position));
  const findings: { rule: string; detail: string }[] = [];

  for (const block of payload.blocks ?? []) {
    if (!played.has(Number(block.position))) {
      findings.push({ rule: 'invented-block', detail: `block ${block.position}` });
    }
  }

  return findings.length > 0 ? { status: 'fail', findings } : { status: 'pass' };
}

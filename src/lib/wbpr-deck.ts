/**
 * The deck, the die, and what they mean.
 *
 * This is the single largest thing Phase 2 does for token cost. The rules carry
 * four tables of thirteen card meanings and four tables of caller topics — a
 * little over 2,500 tokens of pure lookup. Sending them to the model on every
 * turn so it can read a row out of them would mean paying for the whole rulebook
 * to answer "what does the Seven of Clubs mean", every block, all night.
 *
 * So the deck is here instead. The app draws the cards, resolves the meanings,
 * and sends the model the two lines it actually needs:
 *
 *     Drawing: Seven of Clubs (something that changed your taste), ...
 *
 * The model never sees a table. It cannot misread one, either, which is the
 * second reason: a lookup is a thing computers do exactly and language models
 * do approximately.
 *
 * Randomness comes from crypto.getRandomValues rather than Math.random. Not for
 * secrecy — it is a card game — but because a broadcast is a record somebody
 * keeps, and Math.random is seeded per worker and can repeat a "draw" across
 * two requests that land on the same instance.
 */

export const SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [
  'Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King',
] as const;
export type Rank = (typeof RANKS)[number];

export interface Card {
  rank: Rank;
  suit: Suit;
  /** "Seven of Clubs" — how it is said on air and stored in wbpr_prompts.card. */
  name: string;
  /** What the rules say to play for it. */
  tone: string;
}

/**
 * Prompt meanings, in rank order, exactly as the rules give them.
 *
 * Indexed by RANKS position rather than keyed by name so a typo in one is a
 * length mismatch the assertion below catches, rather than a silent undefined
 * that reaches the air as "Something undefined".
 */
const PROMPTS: Record<Suit, string[]> = {
  Hearts: [
    'Something that makes you cry',
    'Something simple, pure',
    'Something that reminds you of someone',
    'Something that makes you feel safe',
    'Something vulnerable',
    'Something joyful',
    'Something bittersweet',
    'Something hopeful',
    'Something that brings you peace',
    'Something epic, overwhelming',
    'Something youthful, energetic',
    'Something romantic but unsettling',
    'Something majestic, vast',
  ],
  Diamonds: [
    'Something from your childhood',
    'Something tied to a specific place',
    'Something you associate with winter',
    'Something you associate with summer',
    'Something to end on — your closing statement',
    'Something from a journey',
    'Something that reminds you of home',
    'Something that makes you want to move',
    'Something from before you were born',
    'Something timeless',
    'Something urban',
    'Something rural, pastoral',
    'Something powerful, commanding',
  ],
  Clubs: [
    'Something totally new to you',
    'Something difficult to listen to',
    'Something complex, layered',
    'Something with unusual instrumentation',
    'Something in another language',
    'Something you discovered by accident',
    'Something that changed your taste',
    'Something experimental',
    'Something that builds tension',
    'Something that releases tension',
    "Something you'd never admit you like",
    'Something dark',
    'Something chaotic',
  ],
  Spades: [
    'Something that scares you',
    'Something eerie, uncanny',
    'Something that sounds like the void',
    'Something melancholic',
    'Something that sounds like an ending',
    'Something haunting',
    'Something with secrets in it',
    'Something cinematic, ominous',
    'Something that makes you uneasy',
    'Something apocalyptic',
    'Something mischievous, trickster energy',
    'Something witchy, occult',
    'Something that sounds like power in the dark',
  ],
};

for (const suit of SUITS) {
  if (PROMPTS[suit].length !== RANKS.length) {
    throw new Error(`wbpr-deck: ${suit} has ${PROMPTS[suit].length} prompts, expected ${RANKS.length}`);
  }
}

/**
 * Caller topics, which the rules give as rank *ranges* rather than per card.
 *
 * Each entry covers ranks from `from` up to the next entry's `from`, using the
 * 1-based rank position: Ace is 1, Jack 11, Queen 12, King 13.
 */
const CALLER_TOPICS: Record<Suit, { from: number; topic: string }[]> = {
  Hearts: [
    { from: 1, topic: 'Lost love, searching for someone' },
    { from: 2, topic: 'Loneliness, need for contact' },
    { from: 5, topic: 'Confession, unburdening' },
    { from: 8, topic: 'Hope, asking for encouragement' },
    { from: 11, topic: 'Youthful confusion, identity' },
    { from: 12, topic: 'Romantic crossroads' },
    { from: 13, topic: 'Seeking wisdom from an elder' },
  ],
  Diamonds: [
    { from: 1, topic: 'Lost, geographically disoriented' },
    { from: 2, topic: 'Something wrong with their home or location' },
    { from: 5, topic: "Travel gone wrong, can't reach destination" },
    { from: 8, topic: 'Mundane life grinding them down' },
    { from: 11, topic: 'Money, material concerns' },
    { from: 12, topic: 'Possessions acting strangely' },
    { from: 13, topic: 'Authority figure causing problems' },
  ],
  Clubs: [
    { from: 1, topic: "Found something they shouldn't have" },
    { from: 2, topic: 'Strange sounds, unexplained phenomena' },
    { from: 5, topic: 'Something following them' },
    { from: 8, topic: "Knowledge they can't unlearn" },
    { from: 11, topic: 'Dangerous curiosity, want to investigate' },
    { from: 12, topic: 'Occult involvement' },
    { from: 13, topic: 'Direct confrontation with the impossible' },
  ],
  Spades: [
    { from: 1, topic: 'The Yellow Sign; direct Carcosa contact' },
    { from: 2, topic: 'Time distortion, loops, paradox' },
    { from: 5, topic: 'Reality breakdown' },
    { from: 8, topic: 'Seeing things that may or may not be there' },
    { from: 11, topic: 'Trickster entity, playful horror' },
    { from: 12, topic: 'Dreams bleeding into waking' },
    { from: 13, topic: 'Full Carcosa breakthrough' },
  ],
};

/** A whole number in [0, max), from the platform CSPRNG. */
function randomBelow(max: number): number {
  // Rejection sampling: taking a modulus of a 32-bit draw biases the low values
  // whenever max does not divide 2^32. It matters little for a deck and costs
  // nothing to get right.
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return n % max;
}

export const cardName = (rank: Rank, suit: Suit) => `${rank} of ${suit}`;

/** One card, drawn fresh from a full deck. */
export function drawCard(): Card {
  const suit = SUITS[randomBelow(SUITS.length)];
  const rankIndex = randomBelow(RANKS.length);
  const rank = RANKS[rankIndex];
  return { rank, suit, name: cardName(rank, suit), tone: PROMPTS[suit][rankIndex] };
}

/**
 * Three cards for a block, without repeats.
 *
 * Drawn without replacement because the rules say "draw 3 cards" from one deck,
 * and because two identical prompts in a block is a dead block — there is
 * nothing to choose between.
 */
export function drawBlock(): Card[] {
  const cards: Card[] = [];
  const seen = new Set<string>();
  while (cards.length < 3) {
    const card = drawCard();
    if (seen.has(card.name)) continue;
    seen.add(card.name);
    cards.push(card);
  }
  return cards;
}

export type CallerRoll = 'none' | 'standard' | 'emergency' | 'phenomenon';

export interface Roll {
  /** What the die actually showed, so the log can say "rolled 4". */
  die: number;
  result: CallerRoll;
}

/** 1–3 nobody calls, 4 standard, 5 urgent/distressed, 6 phenomenon/emergency. */
export function rollCaller(): Roll {
  const die = randomBelow(6) + 1;
  if (die <= 3) return { die, result: 'none' };
  if (die === 4) return { die, result: 'standard' };
  // The rules name 5 "urgent/distressed" and 6 "phenomenon/emergency"; the
  // schema's four caller types are the vocabulary the archive already uses.
  if (die === 5) return { die, result: 'emergency' };
  return { die, result: 'phenomenon' };
}

/** The topic a caller card points at, for the suit and rank drawn. */
export function callerTopic(card: Card): string {
  const rankPosition = RANKS.indexOf(card.rank) + 1;
  const rows = CALLER_TOPICS[card.suit];
  let topic = rows[0].topic;
  for (const row of rows) {
    if (rankPosition >= row.from) topic = row.topic;
  }
  return topic;
}

/** The one line a drawn block contributes to the prompt. */
export const describeDraw = (cards: Card[]) =>
  cards.map(c => `${c.name} (${c.tone.toLowerCase()})`).join(', ');

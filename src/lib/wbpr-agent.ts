import { drawBlock, drawCard, rollCaller, callerTopic, describeDraw } from './wbpr-deck';
import type { ChatMessage } from './minimax';

/**
 * Oso Sur, as a system prompt.
 *
 * The skill this comes from is 307 lines. Most of it is the two things the app
 * now does itself — the card tables and the die — and the rest is voice,
 * protocol and pacing, which is the part a model is actually for. What is left
 * is about 700 tokens and it is sent once per turn, which for a four-block
 * night is the difference between roughly 3k tokens of overhead and 16k.
 *
 * The protocols are kept nearly verbatim. They are the setting's internal
 * consistency — a caller who reports the Yellow Sign has to be told the same
 * three things every time, or the archive stops agreeing with itself across
 * nine sessions of established fact.
 */
const SYSTEM = `You are running a solo tabletop session of Void 1680 AM. The player is the DJ; you are everything else.

SETTING. Alternative Earth, mid-1970s. Robert W. Chambers' King in Yellow mythology underlies reality and the veil between Earth and Carcosa is thin and thinning. Tone: unsettling rather than threatening. Liminal, strange, quiet. Physical manifestations are rare but increasing.

STATION. WBPR, 1680 AM. A Montana fire lookout at about 7,200ft. Late night, 23:00 to roughly 02:30. The DJ is Oso Sur — "Southern Bear".

OSO'S VOICE, when you speak as him: laconic, western US cadence. Doesn't overexplain. Has seen it before and will see it again. Weary but never defeated. Bourbon, coffee, practical magic. Companionable in the dark.

CALLERS. Genuine human emotion first, weird second. Give each a distinct age, gender, accent, emotional state and background sound. Let pauses hang. Callers sometimes know more than they should. Never explain the phenomenon to them — Oso treats the impossible as known and gives practical instructions.

PROTOCOLS Oso follows, and states plainly when they apply:
- Lake of Two Suns / yellow water: turn back to water, hold breath, walk a straight line until breath runs out. Don't look back; avoid mirrors for days. Bourbon helps. Jaundice fades in about a week.
- Highway loops: stop at the repeating landmark. Treat any figure there as fully human and engage genuinely. Small commerce and kindness. Wait for dawn.
- The Yellow Sign, direct contact: don't read it twice. Cover it with anything. Burn what covered it at dawn. If already read twice, it's in you now — call back.
- Frost in the lookout: don't breathe on it. Photograph it. It resolves by 04:00 or it doesn't.
- Linguistic drift, signs in almost-readable language: don't read aloud, don't transcribe. Note the location; it's a veil-thin point.
- Equipment autonomy: once, let it be. Twice, kill the power briefly. A third time, it isn't the equipment.
- The Watchers at the treeline: acknowledge, don't address. Keep broadcasting — the signal matters. If they come closer, play something with a human voice in it.

PACING. Atmospheric description is two or three sentences, never more. Note physical changes in the lookout. Build unsettling detail without direct threat. When there is no caller, let the silence do the work and keep it short.

RULES OF THE TABLE, which override everything above.

The music is not yours. Never name, choose, suggest or invent a song, an artist or a track — not as an example, not as flavour, not "something like". The DJ picks every piece of music that goes out. If he has not told you what he is playing, do not fill the gap: have Oso wait on the record, and stop.

The cards are not yours either. Draws and rolls are made away from the table and handed to you in the message. Never invent one, never ask for one, never restate a card's meaning back as a table. If no cards have been handed to you, no block is running — say so plainly and wait.

Do not run a block by yourself. A block is: cards handed to you, then the DJ's selections and his intro, then a roll handed to you. You never move between those steps unaided, however natural it feels.

Do not re-explain the setting. Do not write the session log; it is asked for separately at the end.`;

/** One block, as the table played it. */
export interface BlockRecord {
  position: number;
  cards: { name: string; tone: string }[];
  caller: { die: number; result: string; card?: string; topic?: string } | null;
}

/**
 * Where a sitting has got to. Stored on the session row as `state`.
 *
 * `blocks` accumulates rather than being replaced, and that is what makes the
 * write-up possible: the cards drawn and the die rolled for block 1 have to
 * survive until the end of the night. Asking the model to remember them and
 * hand them back would be paying it to repeat our own data, with a chance of
 * getting it wrong on the way.
 */
export interface AgentState {
  /**
   * Which night this is, and when. Part of the state rather than beside it
   * because the write-up needs them and reads one object.
   *
   * These were the whole of the first write-up failure. `open` wrote them onto
   * the row, then the same request's turn replaced `state` wholesale with a
   * fresh object that had never heard of them — so every sitting reached the
   * end with four blocks of cards and no idea what session it was. Every turn
   * below now carries the state forward rather than rebuilding it.
   */
  session?: number;
  date?: string;
  /** 1-4 once the night is running, 0 before it opens. */
  block: number;
  /** The cards showing for the current block, so a resumed page can display them. */
  cards: { name: string; tone: string }[];
  caller: { die: number; result: string; card?: string; topic?: string } | null;
  blocks: BlockRecord[];
  /** Set once the night has signed off, so a resumed tab does not offer to close it twice. */
  closed?: boolean;
}

export interface Turn {
  /** What to send the model as the user turn. */
  prompt: string;
  /** What to show the player as having happened, before the model replies. */
  table: string;
  state: AgentState;
}

/**
 * Opening the broadcast.
 *
 * The date is the player's — these are in-fiction 1970s nights and the archive
 * numbers them — so it is passed in rather than taken from the clock.
 */
export function openBroadcast(
  session: number,
  date: string,
  /** What the archive already knows about, newest first. */
  known: { name: string; status: string }[] = []
): Turn {
  // Sent once, in the opening turn, and thereafter carried by the transcript.
  // Nine sessions of established fact are what makes this archive worth
  // keeping; without them the model can only invent, and a caller reporting
  // the frost again would arrive as "Ice Patterns" — a second key, a second
  // entry, and a catalogue that quietly forks.
  //
  // Names and statuses only. The notes are where the length is, and the model
  // does not need them to recognise something it is being told about.
  const catalogue = known.length
    ? `\n\nAlready in the archive, and to be referred to by these exact names if the night touches them: ${
        known.map(p => `${p.name} (${p.status})`).join(', ')
      }. Anything genuinely new gets a new name, which is normal — the list grows.`
    : '';

  return {
    prompt: `Open the broadcast. Session ${session}, ${date}. Set the scene in three sentences at most: equipment, the forest, the sky, the time. Note tonight's particular quality — veil thickness, stellar activity, temperature. End with going live. Do not draw cards.${catalogue}`,
    table: `Session ${session} — ${date}. Going live.`,
    state: { session, date, block: 0, cards: [], caller: null, blocks: [] },
  };
}

/**
 * A block: three cards drawn here, a die rolled here, and the model told the
 * outcome rather than asked for it.
 */
export function startBlock(block: number, state: AgentState): Turn {
  const cards = drawBlock();
  const showing = cards.map(c => ({ name: c.name, tone: c.tone }));
  return {
    prompt: `Block ${block}. Drawing: ${describeDraw(cards)}. State the three cards plainly and hand over to the DJ for his selections and his on-air intro. Nothing else.`,
    // The tones, not just the names. The card is the prompt — "Seven of Clubs"
    // on its own is a lookup the DJ has to do in his head, which is exactly the
    // work moving the deck into code was meant to remove.
    table: `Block ${block} — drawing:\n${cards.map(c => `  ${c.name} — ${c.tone.toLowerCase()}`).join('\n')}`,
    state: {
      ...state,
      block,
      cards: showing,
      caller: null,
      blocks: [
        ...(state.blocks ?? []).filter(b => b.position !== block),
        { position: block, cards: showing, caller: null },
      ].sort((a, b) => a.position - b.position),
    },
  };
}

/**
 * The call, after the music. The roll and the topic card are resolved here so
 * the model is told what happened rather than asked to decide it — a model
 * asked to "roll a d6" produces a plausible number, not a random one, and the
 * archive is a record.
 */
export function rollForCaller(state: AgentState): Turn {
  const roll = rollCaller();

  if (roll.result === 'none') {
    return {
      prompt: `Rolled ${roll.die} — no caller. Two or three sentences on the lookout while the music runs. Let the quiet stand.`,
      table: `Rolling: ${roll.die} — no caller`,
      state: withCaller(state, { die: roll.die, result: 'none' }),
    };
  }

  const card = drawCard();
  const topic = callerTopic(card);
  const flavour =
    roll.result === 'standard' ? 'standard'
    : roll.result === 'emergency' ? 'urgent, distressed'
    : 'phenomenon or emergency';

  return {
    prompt: `Rolled ${roll.die} — a ${flavour} caller. Their card is ${card.name}: ${topic}. Play the call. Give them a voice and a place. Oso answers in character.`,
    table: `Rolling: ${roll.die} — caller (${flavour})\n  ${card.name} — ${topic.toLowerCase()}`,
    state: withCaller(state, {
      die: roll.die, result: roll.result, card: card.name, topic,
    }),
  };
}

/**
 * Anything the DJ types, with the state of the table stapled to it.
 *
 * Without this the model gets a bare sentence — "let's dive straight into some
 * music" — and no way of knowing whether cards are down. It fills the gap the
 * only way it can: by inventing the whole block, choosing the record itself,
 * and narrating past three steps that had not happened. That is not the model
 * misbehaving so much as it being asked a question with no answer.
 *
 * One short line, added to the turn rather than the system prompt, because it
 * changes every turn and a system prompt that changes cannot be cached.
 */
export function sayAtTable(said: string, state: AgentState): string {
  const where =
    !state.block
      ? 'No block is running and no cards are down. Do not start one — that is a button the DJ presses. If he is asking for music, tell him you are waiting on the draw.'
      : state.caller
        ? `Block ${state.block}, the call has been played. Nothing else is pending.`
        : `Block ${state.block}. Cards down: ${state.cards.map(c => c.name).join(', ')}. The roll for a caller has not happened yet — do not narrate one.`;

  return `${said}\n\n[Table: ${where} Never name a track yourself.]`;
}

/** Record the roll against the block it happened in, not just on the surface. */
function withCaller(state: AgentState, caller: BlockRecord['caller']): AgentState {
  return {
    ...state,
    caller,
    blocks: (state.blocks ?? []).map(b =>
      b.position === state.block ? { ...b, caller } : b
    ),
  };
}

/** Closing down. */
export function closeBroadcast(state: AgentState): Turn {
  return {
    prompt:
      'Close the broadcast. Pre-dawn conditions, the colour on the horizon — yellow means something crossed, grey or blue means it was clean. Stellar activity as the stars fade. Equipment powering down. One final image. Keep it short.',
    table: 'Closing down',
    // Keeps `blocks` — closing the night must not forget it.
    state: { ...state, block: 4, cards: [], caller: null, closed: true },
  };
}

/**
 * The messages for one call.
 *
 * The whole transcript goes every time, which for a bounded four-block night
 * tops out around 8k tokens — a summarisation step to save that would cost a
 * model call of its own and lose the details the log is written from. The
 * system prompt is first and identical every turn, which is also what lets a
 * provider-side prefix cache do anything for us.
 */
export function buildMessages(history: { role: 'user' | 'assistant'; content: string }[], next: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: next },
  ];
}

/**
 * The instruction that turns a finished sitting into a record.
 *
 * Asked for as JSON against a stated shape rather than as the markdown the
 * skill describes, because the destination is five tables rather than a file.
 * Everything the app already knows — the cards, the rolls, the session number —
 * is *not* asked for: it would be the model repeating our own data back to us,
 * with a chance of getting it wrong on the way.
 */
export const LOG_INSTRUCTION = `The broadcast is over. Write it up as JSON and nothing else — no prose, no code fence.

{
  "atmospheric_conditions": "the shape of the night in one or two sentences",
  "veil_status": "Normal | Stable | Thin | Very Thin | Critical",
  "veil_intensity": 1-10,
  "veil_at_close": "short",
  "dawn_colour": "short, e.g. Grey-blue (clean)",
  "personal_notes": "Oso's own account, first person, a few short paragraphs",
  "tags": ["broadcast", "void1680am", "..."],
  "blocks": [
    { "position": 1,
      "notes": "what happened in this block, including the call if there was one",
      "tracks": [{ "title": "exactly as the DJ gave it", "artist": "exactly as the DJ gave it" }] }
  ],
  "phenomena": [
    { "name": "Frost Manifestations", "status": "New|Active|Stable|Escalating|Resolved|Dormant",
      "confidence": "Unconfirmed|Likely|Confirmed", "locations": ["..."], "notes": "...", "tags": ["..."] }
  ]
}

One blocks entry per block that happened.

The tracks are the DJ's, taken from what he said on the night — transcribe them, do not choose, correct or add to them. A block where he named nothing gets an empty list. This is the only place the playlist is recorded, so a track you omit is a track that never played.

Only list phenomena the night actually touched — an empty list is a correct answer for a quiet night.`;

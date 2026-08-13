import type { BlackletterGame } from './database.types';

/**
 * The parts of the game that both the server and the browser need to agree on.
 *
 * Everything that decides an *outcome* is in the database — marking, whether a
 * word is a word, how many attempts are left. This module holds only what is
 * true on both sides regardless: which lengths exist, and how a finished game
 * is written down.
 */

/** The three puzzles that exist each day. Adding one is a change here and a
 *  matching solution pool in the word lists; nothing else reads a length. */
export const LENGTHS = [5, 6, 7] as const;
export type PlayableLength = (typeof LENGTHS)[number];

export function isPlayableLength(n: unknown): n is PlayableLength {
  return LENGTHS.includes(n as PlayableLength);
}

/** The length to open on when the URL does not say. Six, because that is the
 *  variant this was built for; the other two came with the toggle. */
export const DEFAULT_LENGTH: PlayableLength = 6;

const SQUARES: Record<string, string> = { c: '🟥', p: '🟨', a: '⬜' };

/**
 * The share text: a grid of squares and no letters.
 *
 * Built from the stored marks rather than re-derived from the guesses, so what
 * gets pasted into a group chat cannot disagree with what was actually played.
 *
 * Red rather than green for a correct letter, because the board is printed in
 * the rubricator's red and a share that does not look like the game it came
 * from is somebody else's game. The other two follow Wordle's, which are by now
 * simply what these squares mean.
 */
export function shareText(game: BlackletterGame, origin?: string): string {
  const score = game.status === 'won' ? game.guesses.length : 'X';
  const head = `Blackletter ${game.length} · ${game.date} · ${score}/${game.attempts}`;
  const grid = game.marks
    .map(row => [...row].map(m => SQUARES[m] ?? '⬜').join(''))
    .join('\n');
  return origin ? `${head}\n\n${grid}\n\n${origin}` : `${head}\n\n${grid}`;
}

/**
 * Correct outranks present outranks absent. Exported because the browser needs
 * the same ordering when it colours a key after a guess, and two copies of a
 * three-entry lookup is exactly how they come to disagree.
 */
export const MARK_RANK: Record<string, number> = { a: 1, p: 2, c: 3 };

/**
 * The best mark each letter has earned, for colouring the keyboard.
 *
 * Correct outranks present outranks absent, and a letter never goes backwards:
 * guessing SPEED then SEEDS must not demote an E that has already been shown
 * correct just because it landed somewhere else the second time.
 */
export function keyboardMarks(game: BlackletterGame): Record<string, string> {
  const best: Record<string, string> = {};
  game.guesses.forEach((guess, row) => {
    [...guess].forEach((letter, i) => {
      const mark = game.marks[row]?.[i];
      if (!mark) return;
      if (!best[letter] || MARK_RANK[mark] > MARK_RANK[best[letter]]) best[letter] = mark;
    });
  });
  return best;
}

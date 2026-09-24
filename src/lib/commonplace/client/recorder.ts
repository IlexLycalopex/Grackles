import type { CpFinish } from '../../database.types.ts';
import type { StoredState } from '../schedule.ts';
import type { CardResult } from '../result.ts';

/**
 * Sends a run to the server, in order, without holding up play.
 *
 * Every call joins one promise chain, so the start always lands before the
 * first answer and the finish after the last. Nothing waits on it: a player
 * types their next answer while the last one is still in flight.
 *
 * If saving fails (signed out, offline) the game carries on and says so once.
 * Playing without saving is better than not playing, and pretending to save is
 * worse than either.
 */
export class Recorder {
  private chain: Promise<unknown> = Promise.resolve();
  private runId: string | null = null;
  private failed = false;

  constructor(
    private endpoint: string,
    private onProblem: (message: string) => void
  ) {}

  get saving() {
    return !this.failed;
  }

  private post<T>(body: unknown): Promise<T> {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not save.');
      return data as T;
    });
  }

  private fail(err: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.onProblem(`Not saving this run: ${err instanceof Error ? err.message : 'no connection'}`);
  }

  start(run: {
    deckRef: string; mode: string; settings: unknown; scope: string; pbKey: string; total: number; daily: string | null;
  }) {
    this.chain = this.chain
      .then(() => this.post<{ id: string }>({ action: 'start', ...run }))
      .then(r => { this.runId = r.id; })
      .catch(err => this.fail(err));
  }

  answer(a: {
    ref: string; result: CardResult; attempts: number; hints: number; ms: number; state: StoredState | null;
  }) {
    this.chain = this.chain
      .then(() => {
        if (!this.runId || this.failed) return;
        return this.post({ action: 'answer', run: this.runId, ...a });
      })
      .catch(err => this.fail(err));
  }

  finish(): Promise<CpFinish | null> {
    const done = this.chain.then(() => {
      if (!this.runId || this.failed) return null;
      return this.post<CpFinish>({ action: 'finish', run: this.runId });
    }).catch(err => {
      this.fail(err);
      return null;
    });
    this.chain = done;
    return done;
  }
}

import { operationAborted } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/index.js';
import { assertOrdered } from '../snapshot/path-merge.js';

export type VerifyRaceAction = 'throw' | 'skip' | 'emit';

export interface VerifyOptions {
  readonly onRace?: VerifyRaceAction;
  readonly signal?: AbortSignal;
}

type SlotKeyedRow = { readonly path: FilePath };

interface VerifiableEntry {
  verify?: () => Promise<void>;
}

const verifiableEntry = (row: unknown): VerifiableEntry | undefined => {
  const candidate = row as Record<string, unknown>;
  return candidate.workdir as VerifiableEntry | undefined;
};

async function* handleRow<R extends SlotKeyedRow>(
  row: R,
  onRace: VerifyRaceAction,
): AsyncIterable<R> {
  const entry = verifiableEntry(row);
  if (entry?.verify === undefined) {
    yield row;
    return;
  }
  try {
    await entry.verify();
    yield row;
    return;
  } catch (err) {
    if (onRace === 'throw') throw err;
    if (onRace === 'skip') return;
    yield { ...row, _raced: true } as unknown as R;
  }
}

/**
 * Re-lstats workdir entries during iteration via `WorkdirEntry.verify()`.
 *
 * - `'throw'` (default) — propagate the `WORKDIR_RACE` error.
 * - `'skip'` — silently drop racy rows.
 * - `'emit'` — yield the row unchanged with a synthetic `_raced: true`
 *   marker; consumers branch on that marker downstream.
 *
 * Workdir snapshot remains race-prone by design (ADR-153); this operator
 * is the opt-in guard for "no race tolerated" workflows like
 * `add -p` and `checkout --detect-races`.
 */
export const verifyWorkdir = <R extends SlotKeyedRow>(opts: VerifyOptions = {}) =>
  async function* (source: AsyncIterable<R>): AsyncIterable<R> {
    const onRace = opts.onRace ?? 'throw';
    for await (const row of assertOrdered(source)) {
      if (opts.signal?.aborted === true) throw operationAborted();
      yield* handleRow(row, onRace);
    }
  };

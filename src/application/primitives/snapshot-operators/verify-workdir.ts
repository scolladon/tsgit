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

/**
 * Marker added to a row by `verifyWorkdir({ onRace: 'emit' })` when the
 * per-row `verify()` rejects. Consumers narrow with `'_raced' in row` to
 * branch on race status without an unsafe cast.
 */
export interface RacedRow {
  readonly _raced: true;
}

/**
 * Output row type for `verifyWorkdir`. In `'throw'` and `'skip'` modes
 * the operator only ever yields the original `R`. In `'emit'` mode it
 * may additionally yield `R & RacedRow` for rows whose `verify()`
 * rejected.
 */
export type VerifyOutput<R> = R | (R & RacedRow);

const verifiableEntry = (row: unknown): VerifiableEntry | undefined => {
  const candidate = row as Record<string, unknown>;
  return candidate.workdir as VerifiableEntry | undefined;
};

async function* handleRow<R extends SlotKeyedRow>(
  row: R,
  onRace: VerifyRaceAction,
): AsyncIterable<VerifyOutput<R>> {
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
    const raced: R & RacedRow = { ...row, _raced: true };
    yield raced;
  }
}

/**
 * Re-lstats workdir entries during iteration via `WorkdirEntry.verify()`.
 *
 * - `'throw'` (default) — propagate the `WORKDIR_RACE` error.
 * - `'skip'` — silently drop racy rows.
 * - `'emit'` — yield the row unchanged plus a `_raced: true` marker;
 *   consumers narrow with `'_raced' in row` to branch on race status.
 *
 * Workdir snapshot remains race-prone by design (ADR-153); this operator
 * is the opt-in guard for "no race tolerated" workflows like
 * `add -p` and `checkout --detect-races`.
 */
export const verifyWorkdir = <R extends SlotKeyedRow>(opts: VerifyOptions = {}) =>
  async function* (source: AsyncIterable<R>): AsyncIterable<VerifyOutput<R>> {
    const onRace = opts.onRace ?? 'throw';
    for await (const row of assertOrdered(source)) {
      if (opts.signal?.aborted === true) throw operationAborted();
      yield* handleRow(row, onRace);
    }
  };

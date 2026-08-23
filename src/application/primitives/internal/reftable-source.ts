/**
 * Corrupt-stack tiering for the reftable backend — a documented divergence
 * from canonical git, not an oversight. Measured against seven damaged
 * fixtures: git never `fatal`s on a broken reftable stack, it reports an
 * empty ref space (`for-each-ref` rc 0, no rows) — but its own `fsck` dies
 * on a signal on every one of them (`error: refs died of signal 11`, a
 * genuine git bug, not a behaviour tsgit can copy). tsgit instead refuses
 * with a structured error wherever git crashes, and degrades to an empty
 * stack only where git's own degrade is coherent: a `tables.list` that was
 * never written, or a `.git/reftable/` directory that never existed — both
 * a legitimately empty stack, not damage.
 *
 * Mirrors `midx-source.ts`'s `tierOf`/`isTierBMidxFault` pair, but
 * degenerately: every `ReftableCheck` classifies `'refuse'` today, because
 * a structural fault on a file `tables.list` names is always a case with no
 * coherent git behaviour to degrade past.
 */
import type { TsgitError } from '../../../domain/error.js';
import type { ReftableCheck } from '../../../domain/refs/error.js';
import { errorDataCode } from './error-data-code.js';

type ReftableTier = 'degrade' | 'refuse';

/**
 * One total function from the closed `ReftableCheck` union to a tier. No
 * `default` arm: a future `ReftableCheck` member is a compile error here,
 * not a runtime surprise. Every member is `'refuse'` today — canonical
 * git's own `fsck` crashes on each of these (including the hang/overflow
 * `'cycle'` and `'block-bounds'` shapes: git's own reader has no bound
 * against them either), so there is no coherent git behaviour for tsgit to
 * degrade past instead.
 */
export function tierOf(check: ReftableCheck): ReftableTier {
  switch (check) {
    case 'magic':
    case 'version':
    case 'footer-crc':
    case 'truncated':
    case 'block-type':
    case 'restart-count':
    case 'record-overrun':
    case 'varint-overflow':
    case 'block-bounds':
    case 'cycle':
    case 'tables-list':
      return 'refuse';
  }
}

/**
 * Positive test for the degrade tier — an absent `tables.list` (whether
 * its own file is missing, or the whole `.git/reftable/` directory it
 * would live in never existed) reads as `FILE_NOT_FOUND` either way, and
 * is a legitimately empty stack: git itself reports rc 0 with no rows for
 * both shapes. Every `ReftableCheck` classifies `'refuse'` per {@link
 * tierOf}, so a structural fault on a table `tables.list` names is never
 * degradable — this predicate never inspects `INVALID_REFTABLE` at all.
 * A fault this predicate doesn't recognise falls through and must be
 * rethrown by the caller. Never invert this into a refuse allow-list: that
 * would silently swallow a future absence-shaped error code this
 * predicate doesn't yet name.
 */
export function isDegradableReftableFault(err: unknown): err is TsgitError {
  return errorDataCode(err) === 'FILE_NOT_FOUND';
}

/**
 * The reftable writers live in a `fast-check`-free module so the parity
 * scenarios can reach them without dragging a dev dependency into the Deno,
 * Bun and `workerd` graphs; re-exported here so importers of the arbitraries
 * keep a single entry point. This file adds the `fast-check` generators the
 * writer's property tests use: `arbRefRecord`, `arbLogRecord` and
 * `arbWriteOptions`. `arbRefName` is re-exported from the parent
 * `test/unit/domain/refs/arbitraries.ts` rather than forked a second time.
 */
import fc from 'fast-check';
import type {
  ReftableRefRecord,
  ReftableRefValue,
} from '../../../../../src/domain/refs/reftable/reftable-block.js';
import type { ReftableLogRecord } from '../../../../../src/domain/refs/reftable/reftable-log.js';
import type { ReftableWriteOptions } from '../../../../../src/domain/refs/reftable/reftable-writer.js';
import { arbObjectId } from '../../objects/arbitraries.js';
import { arbRefName } from '../arbitraries.js';

export type {
  DeflateFn,
  IndexBlockSpec,
  IndexRecordSpec,
  LogBlockSpec,
  LogRecordEntrySpec,
  LogRecordSpec,
  ObjBlockSpec,
  ObjRecordSpec,
  RefBlockSpec,
  RefRecordSpec,
  RefRecordValueSpec,
  ReftableBlockSpec,
  ReftableFooterSpec,
  ReftableHeaderSpec,
  ReftableSpec,
} from '../../../../fixtures/refs/reftable-writers.js';
export {
  buildIndexBlock,
  buildObjBlock,
  buildRefBlock,
  buildReftable,
  buildReftableBlock,
  buildReftableHeader,
  buildReftableLogBlock,
  HEAD_SYMREF_RECORD_BYTES,
} from '../../../../fixtures/refs/reftable-writers.js';
export { arbRefName } from '../arbitraries.js';

/** `hash_id` → the raw oid hex length `arbObjectId` must draw so a
 *  generated ref/log value matches the write options it round-trips with. */
function oidHexLength(hashId: 'sha1' | 's256'): 40 | 64 {
  return hashId === 's256' ? 64 : 40;
}

function arbRefValue(hashId: 'sha1' | 's256'): fc.Arbitrary<ReftableRefValue> {
  const length = oidHexLength(hashId);
  return fc.oneof(
    fc.constant<ReftableRefValue>({ kind: 'deletion' }),
    arbObjectId(length).map((id): ReftableRefValue => ({ kind: 'direct', id })),
    fc
      .tuple(arbObjectId(length), arbObjectId(length))
      .map(([id, peeled]): ReftableRefValue => ({ kind: 'peeled', id, peeled })),
    arbRefName().map((target): ReftableRefValue => ({ kind: 'symbolic', target })),
  );
}

/** Both endpoints `arbWriteOptions` fixes `minUpdateIndex`/`maxUpdateIndex`
 *  at, so every `arbRefRecord`/`arbLogRecord` update index it is generated
 *  alongside stays in range — a negative delta would not be a corrupt input,
 *  it would just be a different (also valid) generator, so the two are
 *  pinned together rather than drawn independently. */
export const MIN_ARBITRARY_UPDATE_INDEX = 0n;
export const MAX_ARBITRARY_UPDATE_INDEX = 1000n;

/** One reftable ref record, over all four value kinds — deletion, direct,
 *  peeled and symbolic. `hashId` is a parameter (not drawn internally) so a
 *  caller composing it alongside `arbWriteOptions()` keeps both the digest
 *  width and the version derived from one shared draw. */
export function arbRefRecord(hashId: 'sha1' | 's256'): fc.Arbitrary<ReftableRefRecord> {
  return fc.record({
    name: arbRefName(),
    updateIndex: fc.bigInt({ min: MIN_ARBITRARY_UPDATE_INDEX, max: MAX_ARBITRARY_UPDATE_INDEX }),
    value: arbRefValue(hashId),
  });
}

function arbLogMessage(): fc.Arbitrary<string> {
  // No embedded newline: the writer's own canonicalisation rejects one, so
  // the round-trip property's generator must stay inside the safe subset —
  // the rejection path is exercised by its own dedicated example test.
  return fc.string({ maxLength: 40 }).filter((s) => !s.includes('\n'));
}

/** `tz_offset` bounded to +/-1400 (the widest real-world UTC offset, 14
 *  hours) — the same bound `AuthorIdentity.timezoneOffset` accepts. */
function arbTzOffset(): fc.Arbitrary<string> {
  return fc
    .integer({ min: -1400, max: 1400 })
    .map((raw) => `${raw < 0 ? '-' : '+'}${Math.abs(raw).toString().padStart(4, '0')}`);
}

function arbLogEntry(hashId: 'sha1' | 's256'): fc.Arbitrary<ReftableLogRecord['entry']> {
  const length = oidHexLength(hashId);
  return fc.oneof(
    fc.constant<ReftableLogRecord['entry']>({ kind: 'deletion' }),
    fc
      .record({
        oldId: arbObjectId(length),
        newId: arbObjectId(length),
        identity: fc.record({
          name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[\n\r\0<>]/.test(s)),
          email: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[\n\r\0<>]/.test(s)),
          timestamp: fc.integer({ min: 0, max: 2_000_000_000 }),
          timezoneOffset: arbTzOffset(),
        }),
        message: arbLogMessage(),
      })
      .map(({ oldId, newId, identity, message }): ReftableLogRecord['entry'] => ({
        kind: 'entry',
        oldId,
        newId,
        identity,
        message,
      })),
  );
}

/** One reftable log record, over both log types (`entry` and `deletion`).
 *  `name` is drawn independently of any `refs` array in the same scenario —
 *  a reftable's log section is not required to name only refs the ref
 *  section currently holds. */
export function arbLogRecord(hashId: 'sha1' | 's256'): fc.Arbitrary<ReftableLogRecord> {
  return fc.record({
    name: arbRefName(),
    updateIndex: fc.bigInt({ min: MIN_ARBITRARY_UPDATE_INDEX, max: MAX_ARBITRARY_UPDATE_INDEX }),
    entry: arbLogEntry(hashId),
  });
}

/** Write options over the dimensions the writer measured a distinct choice
 *  for: `hashId` (fixes version), `blockSize` (0 = unaligned, plus the
 *  measured 4096 default and a small 512 to make the block-count
 *  thresholds reachable without thousands of records), `restartInterval`
 *  and `indexObjects`. `minUpdateIndex`/`maxUpdateIndex` are fixed at the
 *  range every `arbRefRecord`/`arbLogRecord` draws its own `updateIndex`
 *  from — see {@link MIN_ARBITRARY_UPDATE_INDEX}. */
export function arbWriteOptions(): fc.Arbitrary<ReftableWriteOptions> {
  return fc
    .record({
      hashId: fc.constantFrom<'sha1' | 's256'>('sha1', 's256'),
      blockSize: fc.constantFrom(0, 512, 4096),
      restartInterval: fc.integer({ min: 1, max: 64 }),
      indexObjects: fc.boolean(),
    })
    .map(
      (partial): ReftableWriteOptions => ({
        ...partial,
        minUpdateIndex: MIN_ARBITRARY_UPDATE_INDEX,
        maxUpdateIndex: MAX_ARBITRARY_UPDATE_INDEX,
      }),
    );
}

/**
 * Reftable ref/index/obj block record grammar: prefix-compressed name
 * decoding, the ref-record value union, the restart-point binary search,
 * and the multi-level ref-index recursion. Builds on `reftable-format.ts`'s
 * header/footer/varint/block-framing primitives — no I/O, no `Context`.
 *
 * Ref, index and obj records share one cursor-walk shape:
 * `varint(prefix_length) | varint((suffix_length << 3) | tag) | suffix | …`,
 * where `tag` is the ref `value_type`, always `0` for index records, or the
 * obj `cnt_3` field. `readPrefixedName` decodes the shared prefix, leaving
 * each block kind's decoder to interpret `tag` and whatever varints follow.
 */
import { bytesEqual, compareBytes, decode, encode } from '../../objects/encoding.js';
import { ObjectId, RefName } from '../../objects/index.js';
import { invalidReftable } from '../error.js';
import {
  blockLengthAt,
  blockTypeAt,
  type Reftable,
  type ReftableHeader,
  readUint24,
  readVarint,
} from './reftable-format.js';

export const VALUE_TYPE_DELETION = 0x0;
export const VALUE_TYPE_DIRECT = 0x1;
export const VALUE_TYPE_PEELED = 0x2;
export const VALUE_TYPE_SYMBOLIC = 0x3;
/** Low 3 bits of the packed `(suffix_length << 3) | tag` field — the ref
 *  record's `value_type`, always `0` for index records. */
export const VALUE_TYPE_MASK = 0x7;
export const SUFFIX_SHIFT = 3;
/** Same 3 low bits as `VALUE_TYPE_MASK`, named separately for the obj
 *  record's `cnt_3` field — an equal but semantically distinct tag. */
export const CNT_MASK = 0x7;

/** Block envelope sizes shared by every non-log block: 1-byte type + `uint24`
 *  `block_len` before the record area; `uint24` restart offset + `uint16`
 *  restart count at the trailer. */
export const BLOCK_HEADER_SIZE = 4;
const RESTART_ENTRY_SIZE = 3;
const RESTART_COUNT_SIZE = 2;

export type ReftableRefValue =
  | { readonly kind: 'deletion' }
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'peeled'; readonly id: ObjectId; readonly peeled: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName };

export interface ReftableRefRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly value: ReftableRefValue;
}

/** One decoded block record: its full (prefix-expanded) name/key bytes — fed
 *  back in as the next record's `priorNameBytes` — its interpreted payload,
 *  and the cursor position immediately after it. */
export interface BlockRecord<T> {
  readonly nameBytes: Uint8Array;
  readonly payload: T;
  readonly nextOffset: number;
}

/** Decodes one record at `offset`. `priorNameBytes` is the immediately
 *  preceding record's full name — `undefined` at the very first record of a
 *  block or when jumping straight to a restart point, where `prefix_length`
 *  is required to be `0`. */
export type RecordDecoder<T> = (
  bytes: Uint8Array,
  offset: number,
  priorNameBytes: Uint8Array | undefined,
) => BlockRecord<T>;

/** A block's record area and restart array, both resolved to absolute file
 *  offsets — the first block's restart offsets are stored file-relative
 *  already (S2), every later block's are stored block-relative and are
 *  translated here so every downstream reader deals in file offsets only. */
export interface BlockBounds {
  readonly recordsStart: number;
  readonly recordsEnd: number;
  readonly restartOffsets: ReadonlyArray<number>;
  readonly blockEnd: number;
}

/**
 * Resolves one block's record area and restart array from its framing.
 * `block_len` (declared at `blockStart`) gives the block's own byte extent —
 * for the first block it already includes the file header, so `blockEnd`
 * only adds `blockStart` when this is not the first block. Never derives the
 * next block's position from `header.blockSize`: an unaligned file
 * (`blockSize === 0`) has no fixed stride, and `block_len` is exact either
 * way.
 */
export function blockBoundsAt(reftable: Reftable, blockStart: number): BlockBounds {
  const declaredLength = blockLengthAt(reftable, blockStart);
  const isFirstBlock = blockStart === reftable.header.headerLength;
  const blockEnd = isFirstBlock ? declaredLength : blockStart + declaredLength;

  const view = reftable._view;
  const restartCount = view.getUint16(blockEnd - RESTART_COUNT_SIZE);
  if (restartCount === 0) {
    throw invalidReftable(
      'restart-count',
      `block at file offset ${blockStart} has restart_count 0`,
    );
  }

  const restartArrayStart = blockEnd - RESTART_COUNT_SIZE - restartCount * RESTART_ENTRY_SIZE;
  const restartOffsets = readRestartOffsets(
    view,
    restartArrayStart,
    restartCount,
    blockStart,
    isFirstBlock,
  );

  return {
    recordsStart: blockStart + BLOCK_HEADER_SIZE,
    recordsEnd: restartArrayStart,
    restartOffsets,
    blockEnd,
  };
}

function readRestartOffsets(
  view: DataView,
  arrayStart: number,
  count: number,
  blockStart: number,
  isFirstBlock: boolean,
): ReadonlyArray<number> {
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const stored = readUint24(view, arrayStart + i * RESTART_ENTRY_SIZE);
    offsets.push(isFirstBlock ? stored : blockStart + stored);
  }
  return offsets;
}

/**
 * Decodes the shared `varint(prefix_length) | varint(packed) | suffix`
 * prefix-compression cursor every block kind starts a record with.
 * `prefix_length` is validated against `priorNameBytes` here — an absent
 * predecessor (the block's first record, or a jump straight to a restart
 * point) with a nonzero `prefix_length` is corrupt, since there is nothing
 * to compress against.
 */
function readPrefixedName(
  bytes: Uint8Array,
  offset: number,
  priorNameBytes: Uint8Array | undefined,
): { readonly nameBytes: Uint8Array; readonly packed: number; readonly nextOffset: number } {
  const { value: prefixLength, nextOffset: afterPrefix } = readVarint(bytes, offset);
  const priorLength = priorNameBytes?.length ?? 0;
  if (prefixLength > priorLength) {
    throw invalidReftable(
      'record-overrun',
      `prefix_length ${prefixLength} exceeds predecessor name length ${priorLength}`,
    );
  }

  const { value: packed, nextOffset: afterPacked } = readVarint(bytes, afterPrefix);
  const suffixLength = packed >> SUFFIX_SHIFT;
  const suffix = bytes.subarray(afterPacked, afterPacked + suffixLength);
  const nameBytes = concatPrefixSuffix(priorNameBytes, prefixLength, suffix);

  return { nameBytes, packed, nextOffset: afterPacked + suffixLength };
}

function concatPrefixSuffix(
  priorNameBytes: Uint8Array | undefined,
  prefixLength: number,
  suffix: Uint8Array,
): Uint8Array {
  if (prefixLength === 0) {
    return suffix.slice();
  }
  const nameBytes = new Uint8Array(prefixLength + suffix.length);
  nameBytes.set(priorNameBytes!.subarray(0, prefixLength), 0);
  nameBytes.set(suffix, prefixLength);
  return nameBytes;
}

function readDirectValue(bytes: Uint8Array, offset: number, digestLength: number) {
  const id = ObjectId.fromRaw(bytes.subarray(offset, offset + digestLength));
  return { value: { kind: 'direct' as const, id }, nextOffset: offset + digestLength };
}

function readPeeledValue(bytes: Uint8Array, offset: number, digestLength: number) {
  const id = ObjectId.fromRaw(bytes.subarray(offset, offset + digestLength));
  const peeledOffset = offset + digestLength;
  const peeled = ObjectId.fromRaw(bytes.subarray(peeledOffset, peeledOffset + digestLength));
  return {
    value: { kind: 'peeled' as const, id, peeled },
    nextOffset: peeledOffset + digestLength,
  };
}

function readSymbolicValue(bytes: Uint8Array, offset: number) {
  const { value: targetLen, nextOffset: afterLen } = readVarint(bytes, offset);
  const target = RefName.from(decode(bytes.subarray(afterLen, afterLen + targetLen)));
  return { value: { kind: 'symbolic' as const, target }, nextOffset: afterLen + targetLen };
}

/** `0x4`-`0x7` are reserved by the format; a reader has no defined value
 *  shape to decode, so this is the record grammar's own corruption, not a
 *  container-level framing fault — hence `'record-overrun'`, not
 *  `'block-type'`. */
function readRefValue(
  bytes: Uint8Array,
  offset: number,
  valueType: number,
  digestLength: number,
): { readonly value: ReftableRefValue; readonly nextOffset: number } {
  if (valueType === VALUE_TYPE_DELETION) {
    return { value: { kind: 'deletion' }, nextOffset: offset };
  }
  if (valueType === VALUE_TYPE_DIRECT) {
    return readDirectValue(bytes, offset, digestLength);
  }
  if (valueType === VALUE_TYPE_PEELED) {
    return readPeeledValue(bytes, offset, digestLength);
  }
  if (valueType === VALUE_TYPE_SYMBOLIC) {
    return readSymbolicValue(bytes, offset);
  }
  throw invalidReftable('record-overrun', `reserved ref value_type 0x${valueType.toString(16)}`);
}

/** `update_index = header.minUpdateIndex + update_index_delta` (the design's
 *  formula) — built once per `Reftable` so the record decoder itself stays a
 *  plain `RecordDecoder<T>`, uniform with the index/obj decoders below. */
export function refRecordDecoder(header: ReftableHeader): RecordDecoder<ReftableRefRecord> {
  return (bytes, offset, priorNameBytes) => {
    const {
      nameBytes,
      packed,
      nextOffset: afterName,
    } = readPrefixedName(bytes, offset, priorNameBytes);
    const valueType = packed & VALUE_TYPE_MASK;
    const { value: delta, nextOffset: afterDelta } = readVarint(bytes, afterName);
    const { value, nextOffset } = readRefValue(bytes, afterDelta, valueType, header.digestLength);
    const record: ReftableRefRecord = {
      name: RefName.from(decode(nameBytes)),
      updateIndex: header.minUpdateIndex + BigInt(delta),
      value,
    };
    return { nameBytes, payload: record, nextOffset };
  };
}

/** `index_record`: `block_position` is absolute from the start of the file —
 *  no translation needed, unlike restart offsets. */
export const decodeIndexRecord: RecordDecoder<number> = (bytes, offset, priorNameBytes) => {
  const { nameBytes, nextOffset: afterName } = readPrefixedName(bytes, offset, priorNameBytes);
  const { value: blockPosition, nextOffset } = readVarint(bytes, afterName);
  return { nameBytes, payload: blockPosition, nextOffset };
};

function readObjCount(
  bytes: Uint8Array,
  offset: number,
  cnt3: number,
): { readonly count: number; readonly nextOffset: number } {
  if (cnt3 !== 0) {
    return { count: cnt3, nextOffset: offset };
  }
  const { value: count, nextOffset } = readVarint(bytes, offset);
  return { count, nextOffset };
}

/** The first `position_delta` is absolute; every later one is relative to
 *  the previous accumulated position. */
function readPositionDeltas(
  bytes: Uint8Array,
  offset: number,
  count: number,
): { readonly positions: ReadonlyArray<number>; readonly nextOffset: number } {
  const positions: number[] = [];
  let cursor = offset;
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    const { value: delta, nextOffset } = readVarint(bytes, cursor);
    previous = i === 0 ? delta : previous + delta;
    positions.push(previous);
    cursor = nextOffset;
  }
  return { positions, nextOffset: cursor };
}

/** `obj_record`: `cnt_3 === 0` defers the count to a trailing `cnt_large`
 *  varint; `cnt_3 === 0 && cnt_large === 0` is the "scan every ref" case and
 *  decodes to an empty position list. */
export const decodeObjRecord: RecordDecoder<ReadonlyArray<number>> = (
  bytes,
  offset,
  priorNameBytes,
) => {
  const {
    nameBytes,
    packed,
    nextOffset: afterName,
  } = readPrefixedName(bytes, offset, priorNameBytes);
  const { count, nextOffset: afterCount } = readObjCount(bytes, afterName, packed & CNT_MASK);
  const { positions, nextOffset } = readPositionDeltas(bytes, afterCount, count);
  return { nameBytes, payload: positions, nextOffset };
};

/** Full forward scan of every record in `[bounds.recordsStart,
 *  bounds.recordsEnd)`, chaining each record's name into the next as
 *  `priorNameBytes` — the shared cursor walk ref, index and obj iteration
 *  all reduce to. */
export function* walkBlockRecords<T>(
  bytes: Uint8Array,
  bounds: BlockBounds,
  decodeRecord: RecordDecoder<T>,
): Generator<BlockRecord<T>> {
  let cursor = bounds.recordsStart;
  let priorNameBytes: Uint8Array | undefined;
  while (cursor < bounds.recordsEnd) {
    const record = decodeRecord(bytes, cursor, priorNameBytes);
    yield record;
    priorNameBytes = record.nameBytes;
    cursor = record.nextOffset;
  }
}

/** The largest restart index whose record's name sorts at or before
 *  `target` — scanning forward from it is guaranteed to reach `target` if
 *  present. Falls back to restart `0` when `target` sorts before every
 *  restart, which still scans the whole block correctly. */
function floorRestartIndex<T>(
  bytes: Uint8Array,
  restartOffsets: ReadonlyArray<number>,
  target: Uint8Array,
  decodeRecord: RecordDecoder<T>,
): number {
  let lo = 0;
  let hi = restartOffsets.length - 1;
  let floor = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const { nameBytes } = decodeRecord(bytes, restartOffsets[mid]!, undefined);
    if (compareBytes(nameBytes, target) <= 0) {
      floor = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return floor;
}

/**
 * Binary searches `bounds.restartOffsets` for the run containing `target`,
 * then linearly scans forward (chaining prefix decompression from the
 * restart record) for the first record whose name sorts at or after
 * `target` — the git reader algorithm verbatim ("binary search through the
 * restart table … then linearly scan through the following record
 * entries"). Returns `undefined` once the scan runs past the block without
 * reaching `target`.
 */
export function findInBlock<T>(
  bytes: Uint8Array,
  bounds: BlockBounds,
  target: Uint8Array,
  decodeRecord: RecordDecoder<T>,
): BlockRecord<T> | undefined {
  const restartIndex = floorRestartIndex(bytes, bounds.restartOffsets, target, decodeRecord);
  let cursor = bounds.restartOffsets[restartIndex]!;
  let priorNameBytes: Uint8Array | undefined;
  while (cursor < bounds.recordsEnd) {
    const record = decodeRecord(bytes, cursor, priorNameBytes);
    if (compareBytes(record.nameBytes, target) >= 0) {
      return record;
    }
    priorNameBytes = record.nameBytes;
    cursor = record.nextOffset;
  }
  return undefined;
}

function assertBlockType(reftable: Reftable, offset: number, expected: 'r' | 'i'): void {
  const actual = blockTypeAt(reftable, offset);
  if (actual !== expected) {
    throw invalidReftable(
      'block-type',
      `expected block type '${expected}' at file offset ${offset}, got '${actual}'`,
    );
  }
}

/**
 * Resolves `target`'s candidate ref-block position. `undefined` when the
 * table has no ref section at all (a literally empty table, or a log-only
 * file) — detected from the block type actually present at `headerLength`,
 * never from a filename or extension. When a ref index exists, descends it,
 * recursing while the visited block type is `'i'` (a multi-level index may
 * point at further index blocks before the leaf).
 */
function resolveRefBlockPosition(reftable: Reftable, target: Uint8Array): number | undefined {
  if (blockTypeAt(reftable, reftable.header.headerLength) !== 'r') {
    return undefined;
  }
  if (reftable.footer.refIndexPosition === 0) {
    return reftable.header.headerLength;
  }

  let indexBlockStart = reftable.footer.refIndexPosition;
  assertBlockType(reftable, indexBlockStart, 'i');
  while (true) {
    const bounds = blockBoundsAt(reftable, indexBlockStart);
    const found = findInBlock(reftable._bytes, bounds, target, decodeIndexRecord);
    if (found === undefined) {
      return undefined;
    }
    if (blockTypeAt(reftable, found.payload) !== 'i') {
      assertBlockType(reftable, found.payload, 'r');
      return found.payload;
    }
    indexBlockStart = found.payload;
  }
}

/**
 * Finds `name` by descending the ref index (when present) to its candidate
 * block, then binary-searching that block's restart points. A present
 * tombstone (`value.kind === 'deletion'`) is returned faithfully — this
 * layer reports the record, it does not interpret deletion semantics.
 */
export function lookupReftableRef(table: Reftable, name: RefName): ReftableRefRecord | undefined {
  const target = encode(name);
  const blockStart = resolveRefBlockPosition(table, target);
  if (blockStart === undefined) {
    return undefined;
  }

  const bounds = blockBoundsAt(table, blockStart);
  const found = findInBlock(table._bytes, bounds, target, refRecordDecoder(table.header));
  if (found === undefined || !bytesEqual(found.nameBytes, target)) {
    return undefined;
  }
  return found.payload;
}

/**
 * Every ref-block position in file order: the sole block at `headerLength`
 * when there is no ref index, or every leaf reached by walking the
 * (possibly multi-level) ref index otherwise. Yields nothing when the table
 * has no ref section.
 */
function* refBlockPositions(reftable: Reftable): Generator<number> {
  if (blockTypeAt(reftable, reftable.header.headerLength) !== 'r') {
    return;
  }
  if (reftable.footer.refIndexPosition === 0) {
    yield reftable.header.headerLength;
    return;
  }
  yield* collectIndexLeaves(reftable, reftable.footer.refIndexPosition);
}

function* collectIndexLeaves(reftable: Reftable, indexBlockStart: number): Generator<number> {
  assertBlockType(reftable, indexBlockStart, 'i');
  const bounds = blockBoundsAt(reftable, indexBlockStart);
  for (const { payload: childPosition } of walkBlockRecords(
    reftable._bytes,
    bounds,
    decodeIndexRecord,
  )) {
    if (blockTypeAt(reftable, childPosition) === 'i') {
      yield* collectIndexLeaves(reftable, childPosition);
    } else {
      assertBlockType(reftable, childPosition, 'r');
      yield childPosition;
    }
  }
}

/** Every ref record across every ref block, in file (sorted-by-name) order —
 *  a reader must never assume `update_index` order instead. */
export function* iterateReftableRefs(table: Reftable): Iterable<ReftableRefRecord> {
  const decodeRecord = refRecordDecoder(table.header);
  for (const blockStart of refBlockPositions(table)) {
    const bounds = blockBoundsAt(table, blockStart);
    for (const record of walkBlockRecords(table._bytes, bounds, decodeRecord)) {
      yield record.payload;
    }
  }
}

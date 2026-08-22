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
import { isSafeRefName } from '../ref-validation.js';
import {
  blockLengthAt,
  blockTypeAt,
  type Reftable,
  type ReftableHeader,
  readUint24,
  readVarint,
} from './reftable-format.js';

/** `header.headerLength` → footer byte length — restated narrowly here
 *  rather than widening `reftable-format.ts`'s surface for one field (same
 *  precedent as `reftable-log.ts`'s own `FOOTER_LENGTH_BY_HEADER_LENGTH`). */
const FOOTER_LENGTH_BY_HEADER_LENGTH: ReadonlyMap<24 | 28, 68 | 72> = new Map([
  [24, 68],
  [28, 72],
]);

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

/**
 * Bounds ref-index descent — both `resolveRefBlockPosition`'s iterative walk
 * and `collectIndexLeaves`'s recursive one — against a self-referential or
 * pathologically deep `block_position` chain. A real git-produced index
 * never nests more than a handful of levels even at tens of millions of
 * refs (high per-block fanout), so this bound is orders of magnitude above
 * any legitimate depth while still failing fast — in O(bound) steps, not
 * O(∞) — on a cycle an attacker wrote into `block_position`.
 */
const MAX_REF_INDEX_DEPTH = 64;

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

  // `blockEnd > blockStart` also closes `enumerateRefBlocks`'s own hole: a
  // non-first block declaring `block_len` 0 would otherwise make
  // `nextBlockStart` return `blockStart` unchanged, looping forever with no
  // index involved. `blockEnd <= reftable._bytes.length` is what stops a
  // declared length like 0xFFFFFF from driving every read below straight
  // into a raw `RangeError`, bypassing the INVALID_REFTABLE contract.
  if (blockEnd <= blockStart || blockEnd > reftable._bytes.length) {
    throw invalidReftable(
      'block-bounds',
      `block at file offset ${blockStart} declares an out-of-bounds length (declared end ${blockEnd}, file length ${reftable._bytes.length})`,
    );
  }

  const view = reftable._view;
  const restartCount = view.getUint16(blockEnd - RESTART_COUNT_SIZE);
  if (restartCount === 0) {
    throw invalidReftable(
      'restart-count',
      `block at file offset ${blockStart} has restart_count 0`,
    );
  }

  const recordsStart = blockStart + BLOCK_HEADER_SIZE;
  const restartArrayStart = blockEnd - RESTART_COUNT_SIZE - restartCount * RESTART_ENTRY_SIZE;
  if (restartArrayStart < recordsStart) {
    throw invalidReftable(
      'block-bounds',
      `block at file offset ${blockStart} declares a restart array (${restartCount} entries) overlapping its record area`,
    );
  }

  const restartOffsets = readRestartOffsets(
    view,
    restartArrayStart,
    restartCount,
    blockStart,
    isFirstBlock,
  );

  return {
    recordsStart,
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
 * prefix-compression cursor every block kind starts a record with — ref,
 * index and obj records compress a name; log records (`reftable-log.ts`)
 * reuse it unchanged to compress a log key, since the cursor mechanics don't
 * care what the compressed bytes mean. `prefix_length` is validated against
 * `priorNameBytes` here — an absent predecessor (the block's first record,
 * or a jump straight to a restart point) with a nonzero `prefix_length` is
 * corrupt, since there is nothing to compress against.
 */
export function readPrefixedName(
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
  // `Math.floor(packed / 2 ** SUFFIX_SHIFT)` rather than `packed >>
  // SUFFIX_SHIFT`: `packed` is a `readVarint` value, which (at the format's
  // own 5-byte varint cap) can exceed 2**31 — `>>` would coerce it through
  // ToInt32 first and silently wrap to a negative suffix_length, which
  // `subarray`'s own silent index-clamping then launders into a corrupt
  // (but not obviously invalid) `nextOffset` instead of a refusal.
  const suffixLength = Math.floor(packed / 2 ** SUFFIX_SHIFT);
  if (afterPacked + suffixLength > bytes.length) {
    throw invalidReftable(
      'record-overrun',
      `suffix_length ${suffixLength} at byte ${afterPacked} runs past the end of the file`,
    );
  }
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

/**
 * Decodes `bytes` as UTF-8 and gates it through {@link isSafeRefName} — the
 * reftable parse boundary's own counterpart to `parsePackedRefs`'s
 * `isSafeRefName` guard on its own entries (`packed-refs.ts`). `RefName.from`
 * alone rejects only the empty string; a name or symbolic target decoded
 * here reaches line-oriented output verbatim downstream (a bundle header's
 * `<oid> <name>\n`, a pkt-line) with no escaping of its own, so an
 * unconstrained name is a line-injection primitive, not just a cosmetic
 * looseness. Exported for `reftable-log.ts`'s `splitLogKey`, the reflog
 * counterpart of this same parse-boundary gate.
 */
export function decodeSafeRefName(bytes: Uint8Array, subject: string): RefName {
  const decoded = decode(bytes);
  if (!isSafeRefName(decoded)) {
    throw invalidReftable('record-overrun', `${subject} is dangerous: ${decoded.slice(0, 80)}`);
  }
  return RefName.from(decoded);
}

function readSymbolicValue(bytes: Uint8Array, offset: number) {
  const { value: targetLen, nextOffset: afterLen } = readVarint(bytes, offset);
  const target = decodeSafeRefName(
    bytes.subarray(afterLen, afterLen + targetLen),
    'symbolic ref target',
  );
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
      name: decodeSafeRefName(nameBytes, 'ref name'),
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
    assertForwardProgress(cursor, record.nextOffset);
    yield record;
    priorNameBytes = record.nameBytes;
    cursor = record.nextOffset;
  }
}

/**
 * Every record decoder must advance the cursor — a `nextOffset` at or before
 * the position it was decoded from can only come from a corrupt length
 * field upstream (a wrapped or otherwise malformed suffix/value length), and
 * re-decoding the same bytes forever is exactly the shape of an unbounded
 * loop an attacker-controlled table must never be able to trigger.
 */
function assertForwardProgress(cursor: number, nextOffset: number): void {
  if (nextOffset <= cursor) {
    throw invalidReftable(
      'record-overrun',
      `record at byte ${cursor} made no forward progress (next offset ${nextOffset})`,
    );
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
    assertForwardProgress(cursor, record.nextOffset);
    if (compareBytes(record.nameBytes, target) >= 0) {
      return record;
    }
    priorNameBytes = record.nameBytes;
    cursor = record.nextOffset;
  }
  return undefined;
}

/**
 * `blockTypeAt`/`blockLengthAt` (`reftable-format.ts`) are documented as
 * trusted, unchecked reads — "the caller owns bounds and type validation".
 * This is that validation: every position this module treats as a
 * candidate block start ultimately comes from attacker-controlled bytes (a
 * footer position, or an index record's own `block_position`), and reading
 * a block's type-plus-length header needs room for all `BLOCK_HEADER_SIZE`
 * bytes, not just the one the type check itself touches.
 */
function boundedBlockTypeAt(reftable: Reftable, offset: number): string {
  if (offset < 0 || offset + BLOCK_HEADER_SIZE > reftable._bytes.length) {
    throw invalidReftable(
      'block-bounds',
      `block position ${offset} is outside the file (length ${reftable._bytes.length})`,
    );
  }
  return blockTypeAt(reftable, offset);
}

function assertBlockType(reftable: Reftable, offset: number, expected: 'r' | 'i'): void {
  const actual = boundedBlockTypeAt(reftable, offset);
  if (actual !== expected) {
    throw invalidReftable(
      'block-type',
      `expected block type '${expected}' at file offset ${offset}, got '${actual}'`,
    );
  }
}

/** The ref section's exclusive upper bound: the first non-zero footer
 *  position among the sections that can follow it (ref index, obj, log), or
 *  the footer's own start when none of them are set — mirrors
 *  `reftable-log.ts`'s `logSectionEnd`. */
function refSectionEnd(reftable: Reftable): number {
  const { refIndexPosition, objPosition, logPosition } = reftable.footer;
  const followingPositions = [refIndexPosition, objPosition, logPosition].filter((p) => p > 0);
  if (followingPositions.length > 0) {
    return Math.min(...followingPositions);
  }
  const footerLength = FOOTER_LENGTH_BY_HEADER_LENGTH.get(reftable.header.headerLength)!;
  return reftable._bytes.length - footerLength;
}

/** The next ref/index/obj block's start position after one ending at
 *  `blockEnd`: blocks are zero-padded to the next `header.blockSize`
 *  boundary when `blockSize > 0`, so the next block begins at the next
 *  multiple of `blockSize`; an unaligned file (`blockSize === 0`) has no
 *  fixed stride, so the next block starts exactly at `blockEnd`. */
function nextBlockStart(header: ReftableHeader, blockEnd: number): number {
  if (header.blockSize === 0) {
    return blockEnd;
  }
  return Math.ceil(blockEnd / header.blockSize) * header.blockSize;
}

/**
 * Every ref-block start position in file order when the table has no ref
 * index, walked sequentially by each block's own declared length rather than
 * assumed to be the sole block at `headerLength` — git only emits a ref
 * index at 4+ ref blocks, so a 2- or 3-block ref section legitimately has no
 * index and every block past the first must still be visited. Both
 * `resolveRefBlockPosition` and `refBlockPositions` fold through this so
 * they cannot drift apart on the assumption again.
 */
function* enumerateRefBlocks(reftable: Reftable): Generator<number> {
  const sectionEnd = refSectionEnd(reftable);
  let blockStart: number = reftable.header.headerLength;
  while (blockStart < sectionEnd) {
    assertBlockType(reftable, blockStart, 'r');
    yield blockStart;
    blockStart = nextBlockStart(reftable.header, blockBoundsAt(reftable, blockStart).blockEnd);
  }
}

/** Scans every ref block in file order for the first one holding a record
 *  whose name sorts at or after `target` — the no-index counterpart to
 *  descending a ref index, since there is no index to say which block a
 *  name falls in. Each block is still binary-searched via `findInBlock`; a
 *  block returns a candidate whenever `target` sorts at or before its last
 *  key, so the first block to answer is always the right one to report
 *  absence from or hand back to the caller for the equality check. */
function findRefBlockContaining(reftable: Reftable, target: Uint8Array): number | undefined {
  const decodeRecord = refRecordDecoder(reftable.header);
  for (const blockStart of enumerateRefBlocks(reftable)) {
    const bounds = blockBoundsAt(reftable, blockStart);
    if (findInBlock(reftable._bytes, bounds, target, decodeRecord) !== undefined) {
      return blockStart;
    }
  }
  return undefined;
}

/**
 * An index record's `block_position` is the writer's own block-boundary
 * arithmetic, which treats the file header as PART of the first block's
 * span — so the first ref (or index) block is always recorded as position
 * `0`, never as `header.headerLength`, even though byte `0` itself is the
 * file's magic, not a block-type byte. Every other block's recorded
 * position is already the literal file offset its type byte lives at. This
 * is the index-record counterpart to the "S2" restart-offset divergence
 * `blockBoundsAt` already translates for the first block's own restart
 * array (same root cause — the first block's header-inclusive span —
 * surfacing in a different field); measured against a real git-produced
 * multi-block index, not assumed from the spec prose.
 */
function resolveBlockOffset(reftable: Reftable, position: number): number {
  return position === 0 ? reftable.header.headerLength : position;
}

/**
 * Resolves `target`'s candidate ref-block position. `undefined` when the
 * table has no ref section at all (a literally empty table, or a log-only
 * file) — detected from the block type actually present at `headerLength`,
 * never from a filename or extension. When a ref index exists, descends it,
 * recursing while the visited block type is `'i'` (a multi-level index may
 * point at further index blocks before the leaf). Without an index, scans
 * every ref block in sequence via `findRefBlockContaining`.
 */
function resolveRefBlockPosition(reftable: Reftable, target: Uint8Array): number | undefined {
  if (blockTypeAt(reftable, reftable.header.headerLength) !== 'r') {
    return undefined;
  }
  if (reftable.footer.refIndexPosition === 0) {
    return findRefBlockContaining(reftable, target);
  }

  let indexBlockStart = reftable.footer.refIndexPosition;
  assertBlockType(reftable, indexBlockStart, 'i');
  for (let depth = 0; depth < MAX_REF_INDEX_DEPTH; depth += 1) {
    const bounds = blockBoundsAt(reftable, indexBlockStart);
    const found = findInBlock(reftable._bytes, bounds, target, decodeIndexRecord);
    if (found === undefined) {
      return undefined;
    }
    const childPosition = resolveBlockOffset(reftable, found.payload);
    if (boundedBlockTypeAt(reftable, childPosition) !== 'i') {
      assertBlockType(reftable, childPosition, 'r');
      return childPosition;
    }
    indexBlockStart = childPosition;
  }
  throw invalidReftable(
    'cycle',
    `ref index descent exceeded ${MAX_REF_INDEX_DEPTH} levels (cyclic or pathologically deep index)`,
  );
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
 * Every ref-block position in file order: every block in `enumerateRefBlocks`
 * when there is no ref index, or every leaf reached by walking the
 * (possibly multi-level) ref index otherwise. Yields nothing when the table
 * has no ref section.
 */
function* refBlockPositions(reftable: Reftable): Generator<number> {
  if (blockTypeAt(reftable, reftable.header.headerLength) !== 'r') {
    return;
  }
  if (reftable.footer.refIndexPosition === 0) {
    yield* enumerateRefBlocks(reftable);
    return;
  }
  yield* collectIndexLeaves(reftable, reftable.footer.refIndexPosition);
}

function* collectIndexLeaves(
  reftable: Reftable,
  indexBlockStart: number,
  depth = 0,
): Generator<number> {
  if (depth >= MAX_REF_INDEX_DEPTH) {
    throw invalidReftable(
      'cycle',
      `ref index descent exceeded ${MAX_REF_INDEX_DEPTH} levels (cyclic or pathologically deep index)`,
    );
  }
  assertBlockType(reftable, indexBlockStart, 'i');
  const bounds = blockBoundsAt(reftable, indexBlockStart);
  for (const { payload } of walkBlockRecords(reftable._bytes, bounds, decodeIndexRecord)) {
    const childPosition = resolveBlockOffset(reftable, payload);
    if (boundedBlockTypeAt(reftable, childPosition) === 'i') {
      yield* collectIndexLeaves(reftable, childPosition, depth + 1);
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

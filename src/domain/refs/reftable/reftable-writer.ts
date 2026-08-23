/**
 * Reftable stack-file writer: header, ref/index/obj block emission (padded
 * to `block_size` when aligned), log block emission (deflated through a
 * caller-supplied port, never padded), and footer/CRC framing — the write
 * side mirroring `reftable-format.ts`'s/`reftable-block.ts`'s/
 * `reftable-log.ts`'s read side. `buildReftableRefSection` is pure and sync
 * (everything before `log_position` is byte-reproducible); `serializeReftable`
 * is async only because DEFLATE runs through a caller-supplied port, exactly
 * the discipline the read side's `InflateAt` uses.
 *
 * @writes
 *   surface: reftable
 *   kind:    equivalent-under-readback
 *   format:  git-reftable-v1
 */
import { compareBytes, encode, hexToBytes } from '../../objects/encoding.js';
import type { ObjectId, RefName } from '../../objects/index.js';
import { crc32 } from '../../storage/crc32.js';
import { encodeOfsDistance } from '../../storage/pack-entry.js';
import { invalidReftable } from '../error.js';
import {
  BLOCK_HEADER_SIZE,
  type ReftableRefRecord,
  type ReftableRefValue,
  SUFFIX_SHIFT,
  VALUE_TYPE_DELETION,
  VALUE_TYPE_DIRECT,
  VALUE_TYPE_PEELED,
  VALUE_TYPE_SYMBOLIC,
} from './reftable-block.js';
import {
  encodeTzOffset,
  LOG_BLOCK_HEADER_LENGTH,
  LOG_TYPE_DELETION,
  LOG_TYPE_ENTRY,
  REVERSE_INT64_MAX,
  type ReftableLogRecord,
} from './reftable-log.js';

export type DeflateBlock = (data: Uint8Array) => Promise<Uint8Array>;

export interface ReftableWriteOptions {
  readonly hashId: 'sha1' | 's256';
  readonly blockSize: number;
  readonly restartInterval: number;
  readonly indexObjects: boolean;
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
}

// --- Header/footer codec (writer's own width table; see reftable-log.ts's
// FOOTER_LENGTH_BY_HEADER_LENGTH for the precedent of restating rather than
// widening reftable-format.ts's surface for a handful of fields) ----------

const HEADER_LENGTH_V1 = 24;
const HEADER_LENGTH_V2 = 28;
const FOOTER_LENGTH_V1 = 68;
const FOOTER_LENGTH_V2 = 72;

function versionFor(hashId: 'sha1' | 's256'): 1 | 2 {
  return hashId === 's256' ? 2 : 1;
}

function headerLengthFor(version: 1 | 2): 24 | 28 {
  return version === 1 ? HEADER_LENGTH_V1 : HEADER_LENGTH_V2;
}

function footerLengthFor(version: 1 | 2): 68 | 72 {
  return version === 1 ? FOOTER_LENGTH_V1 : FOOTER_LENGTH_V2;
}

// --- Measured writer choices, named rather than left as literals ---------

export const DEFAULT_BLOCK_SIZE = 4096;
export const DEFAULT_RESTART_INTERVAL = 16;
/** A section's index is only emitted once its own block count reaches this
 *  many blocks — measured for the ref and log sections, reused for the obj
 *  section (the spec: "formatted exactly the same as the ref index"). */
export const INDEX_EMIT_THRESHOLD_BLOCKS = 4;
export const MIN_OBJ_ID_LENGTH = 2;
/** Once an index level itself needs more than this many blocks, another
 *  index level is built above it — unexercised at generated/fixture scales
 *  (an index block holds hundreds of entries), so this is the source rule
 *  from git's writer, not a directly measured byte offset. */
export const MULTI_LEVEL_INDEX_THRESHOLD_BLOCKS = 3;

const RESTART_ENTRY_SIZE = 3;
const RESTART_COUNT_SIZE = 2;
const MAX_INLINE_OBJ_COUNT = 7;

// --- Small byte-level helpers ---------------------------------------------

function writeUint24(view: DataView, offset: number, value: number): void {
  view.setUint8(offset, (value >>> 16) & 0xff);
  view.setUint16(offset + 1, value & 0xffff);
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}

/** `a` is always defined at every call site: `tryAddRecord`/`tryAddLogRecord`
 *  only reach this behind `positionInBlock > 0`, so by the time it runs the
 *  accumulator already carries a prior key; `computeObjIdLength` only ever
 *  compares adjacent, already-defined sorted entries. An `undefined`-guarding
 *  branch here would be unreachable dead code. */
function longestCommonPrefix(a: Uint8Array, b: Uint8Array): number {
  // Stryker disable next-line MethodExpression: equivalent — every call site compares two
  // DISTINCT keys (unique ref names, unique (name, update_index) log keys, or unique adjacent
  // sorted oids), so once `i` passes the shorter array's length one side reads `undefined`,
  // which never === a real byte; widening the bound to Math.max cannot extend where the loop
  // actually stops.
  const max = Math.min(a.length, b.length);
  let i = 0;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — same
  // reasoning as the `max` computation above: for the distinct-key inputs this function is
  // ever called with, `a[i] === b[i]` itself goes false at (or before) `i === max`, so
  // dropping or loosening the `i < max` bound cannot change where the loop stops.
  while (i < max && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function writeRestartArray(
  view: DataView,
  offset: number,
  restartOffsets: readonly number[],
): void {
  let cursor = offset;
  for (const restartOffset of restartOffsets) {
    writeUint24(view, cursor, restartOffset);
    cursor += RESTART_ENTRY_SIZE;
  }
  view.setUint16(cursor, restartOffsets.length);
}

function buildRestartTrailer(restartOffsets: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(restartOffsets.length * RESTART_ENTRY_SIZE + RESTART_COUNT_SIZE);
  writeRestartArray(new DataView(bytes.buffer), 0, restartOffsets);
  return bytes;
}

// --- Header ----------------------------------------------------------------

function writeHeader(
  options: ReftableWriteOptions,
  version: 1 | 2,
  headerLength: 24 | 28,
): Uint8Array {
  const bytes = new Uint8Array(headerLength);
  const view = new DataView(bytes.buffer);
  bytes.set(encode('REFT'), 0);
  view.setUint8(4, version);
  writeUint24(view, 5, options.blockSize);
  view.setBigUint64(8, options.minUpdateIndex);
  view.setBigUint64(16, options.maxUpdateIndex);
  if (version === 2) {
    bytes.set(encode(options.hashId), 24);
  }
  return bytes;
}

// --- Generic block packer (shared by ref, index and obj blocks) ----------

interface PackOptions<T> {
  readonly type: 'r' | 'i' | 'o';
  readonly keyBytesOf: (item: T) => Uint8Array;
  readonly encodeItem: (item: T, keyBytes: Uint8Array, prefixLength: number) => Uint8Array;
  readonly blockSize: number;
  readonly restartInterval: number;
  readonly startPosition: number;
  readonly firstBlockExtraLength: number;
  readonly alignment: 'aligned' | 'unaligned';
}

interface PackedSection {
  readonly blocks: readonly Uint8Array[];
  readonly positions: readonly number[];
  readonly lastKeys: readonly Uint8Array[];
  readonly counts: readonly number[];
  readonly totalLength: number;
}

interface BlockState {
  readonly recordAreaLength: number;
  readonly restartCount: number;
  readonly priorKeyBytes: Uint8Array | undefined;
}

const EMPTY_BLOCK_STATE: BlockState = {
  recordAreaLength: 0,
  restartCount: 0,
  priorKeyBytes: undefined,
};

interface RecordStep {
  readonly keyBytes: Uint8Array;
  readonly encoded: Uint8Array;
  readonly isRestart: boolean;
}

/**
 * A record is a restart point when its position lands on the configured
 * interval, OR when it shares no prefix at all with its predecessor —
 * measured against real git output twice: `HEAD` immediately before
 * `refs/heads/aaa` (completely different top-level segment) restarts even
 * off the interval, while `refs/notes/ddd` after `refs/tags/ccc`'s sibling
 * run (sharing the shorter but nonzero `refs/` prefix) does not. Position 0
 * is always a restart both ways: no predecessor to compare against, and
 * `0 % restartInterval === 0` for any positive interval. Returns the
 * decision AND the prefix length to encode (`0` for a restart, whatever the
 * natural shared length is otherwise) so the caller never recomputes it.
 */
function restartDecision(
  positionInBlock: number,
  restartInterval: number,
  priorKeyBytes: Uint8Array | undefined,
  keyBytes: Uint8Array,
): { readonly isRestart: boolean; readonly prefixLength: number } {
  const naturalPrefixLength =
    positionInBlock === 0 ? 0 : longestCommonPrefix(priorKeyBytes!, keyBytes);
  const isRestart = positionInBlock % restartInterval === 0 || naturalPrefixLength === 0;
  return { isRestart, prefixLength: isRestart ? 0 : naturalPrefixLength };
}

function tryAddRecord<T>(
  item: T,
  positionInBlock: number,
  opts: PackOptions<T>,
  state: BlockState,
  extraLength: number,
): RecordStep | undefined {
  const keyBytes = opts.keyBytesOf(item);
  const { isRestart, prefixLength } = restartDecision(
    positionInBlock,
    opts.restartInterval,
    state.priorKeyBytes,
    keyBytes,
  );
  const encoded = opts.encodeItem(item, keyBytes, prefixLength);

  const restartCount = state.restartCount + (isRestart ? 1 : 0);
  const trialLength =
    extraLength +
    BLOCK_HEADER_SIZE +
    state.recordAreaLength +
    encoded.length +
    restartCount * RESTART_ENTRY_SIZE +
    RESTART_COUNT_SIZE;
  const overflowed = positionInBlock > 0 && opts.blockSize !== 0 && trialLength > opts.blockSize;
  return overflowed ? undefined : { keyBytes, encoded, isRestart };
}

function finishBlockBytes(
  type: 'r' | 'i' | 'o',
  recordBytes: Uint8Array,
  restartOffsets: readonly number[],
  declaredLength: number,
): Uint8Array {
  const bytes = new Uint8Array(
    BLOCK_HEADER_SIZE +
      recordBytes.length +
      restartOffsets.length * RESTART_ENTRY_SIZE +
      RESTART_COUNT_SIZE,
  );
  const view = new DataView(bytes.buffer);
  bytes[0] = type.charCodeAt(0);
  writeUint24(view, 1, declaredLength);
  bytes.set(recordBytes, BLOCK_HEADER_SIZE);
  writeRestartArray(view, BLOCK_HEADER_SIZE + recordBytes.length, restartOffsets);
  return bytes;
}

/** One block's (or one raw log payload's) accumulated record bytes, restart
 *  offsets and cursor bookkeeping — the shape {@link accumulateSteps}
 *  reduces to, shared by every block-like packer in this module. */
interface StepAccumulation {
  readonly recordParts: readonly Uint8Array[];
  readonly restartOffsets: readonly number[];
  readonly recordAreaLength: number;
  readonly nextIndex: number;
  readonly lastKeyBytes: Uint8Array;
}

/**
 * Drives the "keep adding records until the next one would overflow" loop
 * every block-like packer in this module reduces to — non-log blocks
 * (`packOneBlock`) and log payloads (`packOneLogPayload`) differ only in
 * how one candidate is encoded and fit-tested (`tryStep`) and in what
 * `headerLength` a restart offset is measured from (the real block header
 * plus any file-header prefix for the very first block, or the log
 * section's phantom 4-byte header).
 */
function accumulateSteps<T>(
  items: readonly T[],
  startIndex: number,
  headerLength: number,
  tryStep: (item: T, positionInBlock: number, state: BlockState) => RecordStep | undefined,
  keyBytesOf: (item: T) => Uint8Array,
): StepAccumulation {
  const recordParts: Uint8Array[] = [];
  const restartOffsets: number[] = [];
  let state = EMPTY_BLOCK_STATE;
  let lastKeyBytes = keyBytesOf(items[startIndex]!);
  let i = startIndex;

  while (i < items.length) {
    const step = tryStep(items[i]!, i - startIndex, state);
    if (step === undefined) {
      break;
    }
    if (step.isRestart) {
      restartOffsets.push(headerLength + state.recordAreaLength);
    }
    recordParts.push(step.encoded);
    state = {
      recordAreaLength: state.recordAreaLength + step.encoded.length,
      restartCount: state.restartCount + (step.isRestart ? 1 : 0),
      priorKeyBytes: step.keyBytes,
    };
    lastKeyBytes = step.keyBytes;
    i += 1;
  }

  return {
    recordParts,
    restartOffsets,
    recordAreaLength: state.recordAreaLength,
    nextIndex: i,
    lastKeyBytes,
  };
}

function packOneBlock<T>(
  items: readonly T[],
  startIndex: number,
  opts: PackOptions<T>,
  extraLength: number,
): { readonly bytes: Uint8Array; readonly nextIndex: number; readonly lastKeyBytes: Uint8Array } {
  const acc = accumulateSteps(
    items,
    startIndex,
    extraLength + BLOCK_HEADER_SIZE,
    (item, positionInBlock, state) => tryAddRecord(item, positionInBlock, opts, state, extraLength),
    opts.keyBytesOf,
  );
  const declaredLength =
    extraLength +
    BLOCK_HEADER_SIZE +
    acc.recordAreaLength +
    acc.restartOffsets.length * RESTART_ENTRY_SIZE +
    RESTART_COUNT_SIZE;
  return {
    bytes: finishBlockBytes(
      opts.type,
      concatParts(acc.recordParts),
      acc.restartOffsets,
      declaredLength,
    ),
    nextIndex: acc.nextIndex,
    lastKeyBytes: acc.lastKeyBytes,
  };
}

function padBlock(
  bytes: Uint8Array,
  blockSize: number,
  extraLength: number,
  alignment: 'aligned' | 'unaligned',
): Uint8Array {
  if (alignment === 'unaligned' || blockSize === 0) {
    return bytes;
  }
  const paddingLength = blockSize - extraLength - bytes.length;
  // Stryker disable next-line EqualityOperator: equivalent — the two branches differ only at
  // paddingLength === 0, where concatParts([bytes, new Uint8Array(0)]) copies `bytes` into a
  // new array of the SAME content — byte-for-byte identical to returning `bytes` directly.
  return paddingLength > 0 ? concatParts([bytes, new Uint8Array(paddingLength)]) : bytes;
}

/**
 * A section with exactly one block needs no stride-based addressing to a
 * sibling block within it — nothing downstream ever derives that block's
 * position via `block_size` arithmetic, since a solitary block is always
 * either the whole section (the no-index ref-read path) or found through an
 * index's own explicit stored position. Real git leaves it unpadded:
 * measured against a git-made single-block reftable (a two-ref fixture, 353
 * bytes total, no trailing padding) versus a git-made multi-block one (a
 * 3001-ref, 20-block fixture, block_size 4096: every block — including the
 * last — padded exactly to the 20 * 4096 boundary the footer's own
 * `refIndexPosition` names). This reverses padding after the fact, once the
 * block count is known, rather than deciding per-block mid-loop, since a
 * block earlier in the section always still needs padding to keep the NEXT
 * block's cursor correct.
 */
function unpadSoleBlock(
  blocks: readonly Uint8Array[],
  declaredLengths: readonly number[],
): readonly Uint8Array[] {
  if (blocks.length !== 1) return blocks;
  return [blocks[0]!.subarray(0, declaredLengths[0]!)];
}

function packBlocks<T>(items: readonly T[], opts: PackOptions<T>): PackedSection {
  const blocks: Uint8Array[] = [];
  const declaredLengths: number[] = [];
  const positions: number[] = [];
  const lastKeys: Uint8Array[] = [];
  const counts: number[] = [];
  let cursor = opts.startPosition;
  let index = 0;

  while (index < items.length) {
    const extraLength = blocks.length === 0 ? opts.firstBlockExtraLength : 0;
    const built = packOneBlock(items, index, opts, extraLength);
    const padded = padBlock(built.bytes, opts.blockSize, extraLength, opts.alignment);
    blocks.push(padded);
    declaredLengths.push(built.bytes.length);
    positions.push(cursor);
    lastKeys.push(built.lastKeyBytes);
    counts.push(built.nextIndex - index);
    cursor += padded.length;
    index = built.nextIndex;
  }

  const unpadded = unpadSoleBlock(blocks, declaredLengths);
  const totalLength = unpadded === blocks ? cursor - opts.startPosition : unpadded[0]!.length;
  return { blocks: unpadded, positions, lastKeys, counts, totalLength };
}

// --- Ref record grammar -----------------------------------------------------

const REF_VALUE_TYPE: Readonly<Record<ReftableRefValue['kind'], number>> = {
  deletion: VALUE_TYPE_DELETION,
  direct: VALUE_TYPE_DIRECT,
  peeled: VALUE_TYPE_PEELED,
  symbolic: VALUE_TYPE_SYMBOLIC,
};

function encodeRefValue(value: ReftableRefValue): Uint8Array {
  if (value.kind === 'deletion') {
    return new Uint8Array(0);
  }
  if (value.kind === 'direct') {
    return hexToBytes(value.id);
  }
  if (value.kind === 'peeled') {
    return concatParts([hexToBytes(value.id), hexToBytes(value.peeled)]);
  }
  const targetBytes = encode(value.target);
  return concatParts([encodeOfsDistance(targetBytes.length), targetBytes]);
}

function encodeRefRecord(
  record: ReftableRefRecord,
  minUpdateIndex: bigint,
  nameBytes: Uint8Array,
  prefixLength: number,
): Uint8Array {
  const suffix = nameBytes.subarray(prefixLength);
  const packed = (suffix.length << SUFFIX_SHIFT) | REF_VALUE_TYPE[record.value.kind];
  const delta = Number(record.updateIndex - minUpdateIndex);
  return concatParts([
    encodeOfsDistance(prefixLength),
    encodeOfsDistance(packed),
    suffix,
    encodeOfsDistance(delta),
    encodeRefValue(record.value),
  ]);
}

function assembleRefBlocks(
  refs: readonly ReftableRefRecord[],
  options: ReftableWriteOptions,
  headerLength: number,
): PackedSection {
  return packBlocks(refs, {
    type: 'r',
    keyBytesOf: (r) => encode(r.name),
    encodeItem: (r, nameBytes, prefixLength) =>
      encodeRefRecord(r, options.minUpdateIndex, nameBytes, prefixLength),
    blockSize: options.blockSize,
    restartInterval: options.restartInterval,
    startPosition: headerLength,
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — when
    // refs is empty, packBlocks's own while(index < items.length) loop never runs, so
    // firstBlockExtraLength is never read; forcing this ternary to always pick headerLength
    // changes an unread value only.
    firstBlockExtraLength: refs.length > 0 ? headerLength : 0,
    alignment: 'aligned',
  });
}

// --- Index record grammar (shared by the ref, obj and log indexes) -------

interface IndexLeafEntry {
  readonly keyBytes: Uint8Array;
  readonly blockPosition: number;
}

function encodeIndexRecord(
  entry: IndexLeafEntry,
  keyBytes: Uint8Array,
  prefixLength: number,
): Uint8Array {
  const suffix = keyBytes.subarray(prefixLength);
  const packed = suffix.length << SUFFIX_SHIFT;
  return concatParts([
    encodeOfsDistance(prefixLength),
    encodeOfsDistance(packed),
    suffix,
    encodeOfsDistance(entry.blockPosition),
  ]);
}

/** The minimal shape every packed section (ref/index/obj blocks, and the
 *  differently-framed log blocks) offers for building the index level above
 *  it — narrower than `PackedSection` so `PackedLogSection` (which has no
 *  per-block record `counts`, log blocks needing none) satisfies it too. */
interface IndexSource {
  readonly positions: readonly number[];
  readonly lastKeys: readonly Uint8Array[];
}

function toIndexEntries(section: IndexSource): readonly IndexLeafEntry[] {
  return section.positions.map((blockPosition, i) => ({
    keyBytes: section.lastKeys[i]!,
    blockPosition,
  }));
}

/**
 * The write-side mirror of `reftable-block.ts`'s `resolveBlockOffset`: the
 * writer's own block-boundary arithmetic treats the file header as part of
 * the first ref block's span (see `assembleRefBlocks`'s `firstBlockExtraLength`
 * and `blockBoundsAt`'s `isFirstBlock` branch), so any recorded reference to
 * that block's physical start — always exactly `headerLength`, since no
 * other block can ever start there — must be written as `0`, matching git's
 * own writer convention. Applies wherever a position field names a REF
 * block's start: the ref index's leaf entries and the obj records' position
 * lists alike. Every other position (index blocks, obj blocks, log blocks)
 * starts strictly after the ref section, so it never collides with
 * `headerLength` and is written verbatim.
 *
 * Both call sites gate on `refIndexEmitted`
 * (`refBlocks.blocks.length >= INDEX_EMIT_THRESHOLD_BLOCKS`), so at least one
 * ref block always exists by the time this runs — and `packBlocks` seeds a
 * block list's first position from its `startPosition` unconditionally, so
 * `refBlocks.positions[0]` is always defined and always exactly
 * `headerLength`. A guard on that no longer being the case would be
 * unreachable dead code, so the rewrite is unconditional.
 */
function encodedRefBlockPositions(refBlocks: PackedSection): readonly number[] {
  return [0, ...refBlocks.positions.slice(1)];
}

interface IndexResult {
  readonly blocks: readonly Uint8Array[];
  readonly topPosition: number;
  readonly totalLength: number;
}

const EMPTY_INDEX_RESULT: IndexResult = { blocks: [], topPosition: 0, totalLength: 0 };

function buildIndexLevels(
  leafEntries: readonly IndexLeafEntry[],
  options: ReftableWriteOptions,
  startPosition: number,
  alignment: 'aligned' | 'unaligned',
): IndexResult {
  const allBlocks: Uint8Array[] = [];
  let entries = leafEntries;
  let cursor = startPosition;
  let level: PackedSection;

  do {
    level = packBlocks(entries, {
      type: 'i',
      keyBytesOf: (e) => e.keyBytes,
      encodeItem: encodeIndexRecord,
      blockSize: options.blockSize,
      restartInterval: options.restartInterval,
      startPosition: cursor,
      firstBlockExtraLength: 0,
      alignment,
    });
    allBlocks.push(...level.blocks);
    cursor += level.totalLength;
    entries = toIndexEntries(level);
  } while (level.blocks.length > MULTI_LEVEL_INDEX_THRESHOLD_BLOCKS);

  return {
    blocks: allBlocks,
    topPosition: level.positions[0]!,
    totalLength: cursor - startPosition,
  };
}

function maybeBuildIndex(
  section: PackedSection,
  options: ReftableWriteOptions,
  startPosition: number,
): IndexResult {
  if (section.blocks.length < INDEX_EMIT_THRESHOLD_BLOCKS) {
    return EMPTY_INDEX_RESULT;
  }
  return buildIndexLevels(toIndexEntries(section), options, startPosition, 'aligned');
}

// --- Obj record grammar -----------------------------------------------------

interface ObjOidEntry {
  readonly oidBytes: Uint8Array;
  readonly positions: readonly number[];
}

interface ObjEntry {
  readonly keyBytes: Uint8Array;
  readonly positions: readonly number[];
}

/** The primary oid a ref value contributes to the obj section — `undefined`
 *  for deletions and symbolic refs, which have no object identity to abbreviate. */
function refObjectId(value: ReftableRefValue): ObjectId | undefined {
  if (value.kind === 'direct' || value.kind === 'peeled') {
    return value.id;
  }
  return undefined;
}

function recordObjPosition(
  ref: ReftableRefRecord,
  blockPosition: number,
  positionsByOidHex: Map<string, Set<number>>,
): void {
  const oidHex = refObjectId(ref.value);
  if (oidHex === undefined) {
    return;
  }
  const set = positionsByOidHex.get(oidHex) ?? new Set<number>();
  set.add(blockPosition);
  positionsByOidHex.set(oidHex, set);
}

function collectObjEntries(
  refs: readonly ReftableRefRecord[],
  refBlockPositions: readonly number[],
  refBlockCounts: readonly number[],
): readonly ObjOidEntry[] {
  const positionsByOidHex = new Map<string, Set<number>>();
  let refIndex = 0;
  refBlockPositions.forEach((blockPosition, blockIndex) => {
    const count = refBlockCounts[blockIndex]!;
    for (let n = 0; n < count; n += 1) {
      recordObjPosition(refs[refIndex]!, blockPosition, positionsByOidHex);
      refIndex += 1;
    }
  });
  return [...positionsByOidHex.entries()]
    .map(([oidHex, positions]) => ({
      oidBytes: hexToBytes(oidHex),
      // Stryker disable next-line MethodExpression,ArithmeticOperator: equivalent —
      // `blockPosition` is only ever added to this Set while walking `refBlockPositions` in
      // strictly ascending order (ref-block file offsets are monotonically increasing, and
      // the rewritten first entry `0` is still the smallest), so Set iteration order is
      // already ascending; a comparator that is never negative for non-negative inputs (like
      // `a + b`) never triggers a reorder against an already-ascending sequence, so dropping
      // or breaking the comparator leaves the array unchanged.
      positions: [...positions].sort((a, b) => a - b),
    }))
    .sort((a, b) => compareBytes(a.oidBytes, b.oidBytes));
}

/** `obj_id_len`: the longest common prefix among adjacent sorted oids is the
 *  worst case over every pair (a classical property of sorted-order LCP), so
 *  one more than it makes every abbreviation unique across the whole set. */
function computeObjIdLength(sortedOidBytes: readonly Uint8Array[]): number {
  let maxAdjacentLcp = 0;
  for (let i = 1; i < sortedOidBytes.length; i += 1) {
    maxAdjacentLcp = Math.max(
      maxAdjacentLcp,
      longestCommonPrefix(sortedOidBytes[i - 1]!, sortedOidBytes[i]!),
    );
  }
  return Math.max(MIN_OBJ_ID_LENGTH, maxAdjacentLcp + 1);
}

function encodePositionDeltas(positions: readonly number[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let previous = 0;
  positions.forEach((position, i) => {
    const delta = i === 0 ? position : position - previous;
    parts.push(encodeOfsDistance(delta));
    previous = position;
  });
  return concatParts(parts);
}

function encodeObjRecord(entry: ObjEntry, keyBytes: Uint8Array, prefixLength: number): Uint8Array {
  const suffix = keyBytes.subarray(prefixLength);
  const count = entry.positions.length;
  // Stryker disable next-line ConditionalExpression: equivalent — `count` is
  // `entry.positions.length`, and an ObjEntry only ever exists for an oid that was recorded
  // at least once in `positionsByOidHex` (a Set that always has >=1 member once created), so
  // `count > 0` is always true for every entry this function is ever called with.
  const cnt3 = count > 0 && count <= MAX_INLINE_OBJ_COUNT ? count : 0;
  const packed = (suffix.length << SUFFIX_SHIFT) | cnt3;
  const countBytes = cnt3 === 0 ? encodeOfsDistance(count) : new Uint8Array(0);
  return concatParts([
    encodeOfsDistance(prefixLength),
    encodeOfsDistance(packed),
    suffix,
    countBytes,
    encodePositionDeltas(entry.positions),
  ]);
}

interface ObjSectionResult extends PackedSection {
  readonly startPosition: number;
  readonly objIdLength: number;
}

const EMPTY_OBJ_SECTION: ObjSectionResult = {
  blocks: [],
  positions: [],
  lastKeys: [],
  counts: [],
  totalLength: 0,
  startPosition: 0,
  objIdLength: 0,
};

function assembleObjSection(
  refs: readonly ReftableRefRecord[],
  refBlocks: PackedSection,
  refIndexEmitted: boolean,
  options: ReftableWriteOptions,
  startPosition: number,
): ObjSectionResult {
  if (!refIndexEmitted || !options.indexObjects) {
    return EMPTY_OBJ_SECTION;
  }
  const refBlockPositions = encodedRefBlockPositions(refBlocks);
  const oidEntries = collectObjEntries(refs, refBlockPositions, refBlocks.counts);
  if (oidEntries.length === 0) {
    return EMPTY_OBJ_SECTION;
  }

  const objIdLength = computeObjIdLength(oidEntries.map((e) => e.oidBytes));
  const objEntries = oidEntries.map((e) => ({
    keyBytes: e.oidBytes.subarray(0, objIdLength),
    positions: e.positions,
  }));
  const packed = packBlocks(objEntries, {
    type: 'o',
    keyBytesOf: (e) => e.keyBytes,
    encodeItem: encodeObjRecord,
    blockSize: options.blockSize,
    restartInterval: options.restartInterval,
    startPosition,
    firstBlockExtraLength: 0,
    alignment: 'aligned',
  });
  return { ...packed, startPosition, objIdLength };
}

// --- Ref section orchestration ---------------------------------------------

interface RefSectionResult {
  readonly bytes: Uint8Array;
  readonly refIndexPosition: number;
  readonly objPosition: number;
  readonly objIdLength: number;
  readonly objIndexPosition: number;
}

function assembleRefSection(
  refs: readonly ReftableRefRecord[],
  options: ReftableWriteOptions,
): RefSectionResult {
  const version = versionFor(options.hashId);
  const headerLength = headerLengthFor(version);
  const header = writeHeader(options, version, headerLength);

  const refBlocks = assembleRefBlocks(refs, options, headerLength);
  const refIndexEmitted = refBlocks.blocks.length >= INDEX_EMIT_THRESHOLD_BLOCKS;
  const refIndex = refIndexEmitted
    ? buildIndexLevels(
        toIndexEntries({
          positions: encodedRefBlockPositions(refBlocks),
          lastKeys: refBlocks.lastKeys,
        }),
        options,
        headerLength + refBlocks.totalLength,
        'aligned',
      )
    : EMPTY_INDEX_RESULT;

  const objCursor = headerLength + refBlocks.totalLength + refIndex.totalLength;
  const objSection = assembleObjSection(refs, refBlocks, refIndexEmitted, options, objCursor);
  const objIndex = maybeBuildIndex(objSection, options, objCursor + objSection.totalLength);

  const bytes = concatParts([
    header,
    ...refBlocks.blocks,
    ...refIndex.blocks,
    ...objSection.blocks,
    ...objIndex.blocks,
  ]);

  return {
    bytes,
    refIndexPosition: refIndex.topPosition,
    objPosition: objSection.startPosition,
    objIdLength: objSection.objIdLength,
    objIndexPosition: objIndex.topPosition,
  };
}

/** Header + ref blocks + ref index + obj blocks + padding. Pure, sync,
 *  deterministic — everything before `log_position` is byte-reproducible,
 *  which is why this half of the writer is exported on its own. */
export function buildReftableRefSection(
  refs: readonly ReftableRefRecord[],
  options: ReftableWriteOptions,
): Uint8Array {
  return assembleRefSection(refs, options).bytes;
}

// --- Log record grammar -----------------------------------------------------

/**
 * git's log-message canonicalisation: trailing newlines are stripped, an
 * embedded newline is refused (there is no way to represent it — the format
 * has no escaping), and exactly one trailing newline is appended. An absent
 * message (`''`) canonicalises to `'\n'`, never an absent record.
 */
export function canonicaliseLogMessage(message: string): string {
  const stripped = message.replace(/\n+$/, '');
  if (stripped.includes('\n')) {
    throw invalidReftable(
      'record-overrun',
      `log message contains an embedded newline: ${JSON.stringify(message)}`,
    );
  }
  return `${stripped}\n`;
}

function encodeLogKey(name: RefName, updateIndex: bigint): Uint8Array {
  const nameBytes = encode(name);
  const key = new Uint8Array(nameBytes.length + 1 + 8);
  key.set(nameBytes, 0);
  new DataView(key.buffer, nameBytes.length + 1, 8).setBigUint64(
    0,
    REVERSE_INT64_MAX - updateIndex,
  );
  return key;
}

function encodeLogData(entry: Extract<ReftableLogRecord['entry'], { kind: 'entry' }>): Uint8Array {
  const message = canonicaliseLogMessage(entry.message);
  const nameBytes = encode(entry.identity.name);
  const emailBytes = encode(entry.identity.email);
  const messageBytes = encode(message);
  const tzBytes = new Uint8Array(2);
  new DataView(tzBytes.buffer).setInt16(0, encodeTzOffset(entry.identity.timezoneOffset));
  return concatParts([
    hexToBytes(entry.oldId),
    hexToBytes(entry.newId),
    encodeOfsDistance(nameBytes.length),
    nameBytes,
    encodeOfsDistance(emailBytes.length),
    emailBytes,
    encodeOfsDistance(entry.identity.timestamp),
    tzBytes,
    encodeOfsDistance(messageBytes.length),
    messageBytes,
  ]);
}

function encodeLogRecord(
  record: ReftableLogRecord,
  keyBytes: Uint8Array,
  prefixLength: number,
): Uint8Array {
  const suffix = keyBytes.subarray(prefixLength);
  const logType = record.entry.kind === 'deletion' ? LOG_TYPE_DELETION : LOG_TYPE_ENTRY;
  const packed = (suffix.length << SUFFIX_SHIFT) | logType;
  const dataBytes =
    record.entry.kind === 'deletion' ? new Uint8Array(0) : encodeLogData(record.entry);
  return concatParts([
    encodeOfsDistance(prefixLength),
    encodeOfsDistance(packed),
    suffix,
    dataBytes,
  ]);
}

function tryAddLogRecord(
  record: ReftableLogRecord,
  positionInBlock: number,
  restartInterval: number,
  state: BlockState,
  budget: number,
): RecordStep | undefined {
  const keyBytes = encodeLogKey(record.name, record.updateIndex);
  const { isRestart, prefixLength } = restartDecision(
    positionInBlock,
    restartInterval,
    state.priorKeyBytes,
    keyBytes,
  );
  const encoded = encodeLogRecord(record, keyBytes, prefixLength);

  const restartCount = state.restartCount + (isRestart ? 1 : 0);
  const trialLength =
    LOG_BLOCK_HEADER_LENGTH +
    state.recordAreaLength +
    encoded.length +
    restartCount * RESTART_ENTRY_SIZE +
    RESTART_COUNT_SIZE;
  const overflowed = positionInBlock > 0 && trialLength > budget;
  return overflowed ? undefined : { keyBytes, encoded, isRestart };
}

function packOneLogPayload(
  logs: readonly ReftableLogRecord[],
  startIndex: number,
  restartInterval: number,
  budget: number,
): { readonly payload: Uint8Array; readonly nextIndex: number; readonly lastKeyBytes: Uint8Array } {
  const acc = accumulateSteps(
    logs,
    startIndex,
    LOG_BLOCK_HEADER_LENGTH,
    (record, positionInBlock, state) =>
      tryAddLogRecord(record, positionInBlock, restartInterval, state, budget),
    (record) => encodeLogKey(record.name, record.updateIndex),
  );
  return {
    payload: concatParts([...acc.recordParts, buildRestartTrailer(acc.restartOffsets)]),
    nextIndex: acc.nextIndex,
    lastKeyBytes: acc.lastKeyBytes,
  };
}

function frameLogBlock(payloadLength: number, compressed: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'g'.charCodeAt(0);
  writeUint24(view, 1, LOG_BLOCK_HEADER_LENGTH + payloadLength);
  bytes.set(compressed, LOG_BLOCK_HEADER_LENGTH);
  return bytes;
}

interface PackedLogSection {
  readonly blocks: readonly Uint8Array[];
  readonly positions: readonly number[];
  readonly lastKeys: readonly Uint8Array[];
  readonly totalLength: number;
}

/**
 * Log blocks are never aligned or padded — `budget` is only the raw
 * (pre-compression) size a writer targets before starting a new block, not
 * an on-disk stride. `block_size * 2` is the spec's own suggested buffer
 * size; `block_size === 0` (unaligned) means unbounded, consistent with the
 * same convention `packBlocks` uses for ref/index/obj blocks.
 */
async function packLogBlocks(
  logs: readonly ReftableLogRecord[],
  options: ReftableWriteOptions,
  startPosition: number,
  deflate: DeflateBlock,
): Promise<PackedLogSection> {
  const budget = options.blockSize === 0 ? Number.POSITIVE_INFINITY : options.blockSize * 2;
  const blocks: Uint8Array[] = [];
  const positions: number[] = [];
  const lastKeys: Uint8Array[] = [];
  let cursor = startPosition;
  let index = 0;

  while (index < logs.length) {
    const { payload, nextIndex, lastKeyBytes } = packOneLogPayload(
      logs,
      index,
      options.restartInterval,
      budget,
    );
    const framed = frameLogBlock(payload.length, await deflate(payload));
    blocks.push(framed);
    positions.push(cursor);
    lastKeys.push(lastKeyBytes);
    cursor += framed.length;
    index = nextIndex;
  }

  return { blocks, positions, lastKeys, totalLength: cursor - startPosition };
}

interface LogSectionResult {
  readonly bytes: Uint8Array;
  readonly logPosition: number;
  readonly logIndexPosition: number;
}

async function assembleLogSection(
  logs: readonly ReftableLogRecord[],
  options: ReftableWriteOptions,
  startPosition: number,
  deflate: DeflateBlock,
): Promise<LogSectionResult> {
  if (logs.length === 0) {
    return { bytes: new Uint8Array(0), logPosition: 0, logIndexPosition: 0 };
  }

  const packed = await packLogBlocks(logs, options, startPosition, deflate);
  const logIndex =
    packed.blocks.length >= INDEX_EMIT_THRESHOLD_BLOCKS
      ? buildIndexLevels(
          toIndexEntries(packed),
          options,
          startPosition + packed.totalLength,
          'unaligned',
        )
      : EMPTY_INDEX_RESULT;

  return {
    bytes: concatParts([...packed.blocks, ...logIndex.blocks]),
    logPosition: startPosition,
    logIndexPosition: logIndex.topPosition,
  };
}

// --- Footer -----------------------------------------------------------------

interface FooterPositions {
  readonly refIndexPosition: number;
  readonly objPosition: number;
  readonly objIdLength: number;
  readonly objIndexPosition: number;
  readonly logPosition: number;
  readonly logIndexPosition: number;
}

function writeFooter(
  header: Uint8Array,
  footerLength: 68 | 72,
  positions: FooterPositions,
): Uint8Array {
  const bytes = new Uint8Array(footerLength);
  bytes.set(header, 0);
  const view = new DataView(bytes.buffer);
  const fieldsStart = header.length;

  view.setBigUint64(fieldsStart, BigInt(positions.refIndexPosition));
  const packedObj = (BigInt(positions.objPosition) << 5n) | BigInt(positions.objIdLength);
  view.setBigUint64(fieldsStart + 8, packedObj);
  view.setBigUint64(fieldsStart + 16, BigInt(positions.objIndexPosition));
  view.setBigUint64(fieldsStart + 24, BigInt(positions.logPosition));
  view.setBigUint64(fieldsStart + 32, BigInt(positions.logIndexPosition));

  const crcCoveredEnd = footerLength - 4;
  view.setUint32(crcCoveredEnd, crc32(bytes.subarray(0, crcCoveredEnd)));
  return bytes;
}

// --- Top-level entry point ---------------------------------------------------

/**
 * Serializes a complete reftable stack file: the (pure, sync) ref section,
 * then the (async, DEFLATE-dependent) log section, then the footer. `refs`
 * and `logs` are caller-sorted — by name, and by `(name, reverse
 * update_index)` respectively — this function never reorders them.
 */
export async function serializeReftable(
  refs: readonly ReftableRefRecord[],
  logs: readonly ReftableLogRecord[],
  options: ReftableWriteOptions,
  deflate: DeflateBlock,
): Promise<Uint8Array> {
  const version = versionFor(options.hashId);
  const headerLength = headerLengthFor(version);
  const footerLength = footerLengthFor(version);

  const refSection = assembleRefSection(refs, options);
  const logSection = await assembleLogSection(logs, options, refSection.bytes.length, deflate);
  const footer = writeFooter(refSection.bytes.subarray(0, headerLength), footerLength, {
    refIndexPosition: refSection.refIndexPosition,
    objPosition: refSection.objPosition,
    objIdLength: refSection.objIdLength,
    objIndexPosition: refSection.objIndexPosition,
    logPosition: logSection.logPosition,
    logIndexPosition: logSection.logIndexPosition,
  });

  return concatParts([refSection.bytes, logSection.bytes, footer]);
}

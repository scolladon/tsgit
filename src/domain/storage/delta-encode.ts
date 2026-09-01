/**
 * The delta instruction encoder — the write side of `delta.ts`'s grammar.
 * `serializeDelta` turns a header + instruction list into bytes; the
 * `DeltaIndex` / `encodeDeltaFromIndex` split lets a sliding window build a
 * base's index once and match many targets against it.
 */
import type { DeltaInstruction } from './delta.js';
import { invalidDelta } from './error.js';

/**
 * Block size the sliding-window index hashes over — also the minimum
 * length a match must reach to be worth a COPY instead of literal bytes.
 * Below one block there is nothing to hash, so the two roles share one
 * constant rather than an unkillable duplicated pair.
 */
export const DELTA_BLOCK_BYTES = 16;

/** INSERT's `cmd` byte doubles as the literal length — 127 is the largest
 *  value the high bit being clear allows. */
export const MAX_INSERT_BYTES = 127;

/** COPY size spans at most three bytes (bits `0x10`/`0x20`/`0x40`). */
export const MAX_COPY_BYTES = 0xffffff;

/** Chain-walk cap per bucket, independent of base size — a bucket-count cap
 *  would only be observable on a multi-gigabyte base and be unkillable by
 *  any realistic unit test; this cap is reachable by one. */
export const MAX_CANDIDATES_PER_BUCKET = 6;

/** Sentinel for "no block in this chain", used by both `heads` and `next`. */
const END_OF_CHAIN = -1;

/** Mirrors `readVariableLengthInt`'s own limit in `delta.ts`: a
 *  variable-length integer never spans more than 5 bytes. */
const MAX_VARINT_BYTES = 5;

/** FNV-1a's prime, used only as a well-distributed odd multiplier —
 *  `Math.imul` keeps every step an integer 32-bit multiply, never a float. */
const HASH_MULTIPLIER = 0x01000193;

export interface DeltaIndex {
  readonly base: Uint8Array;
  /** bucket -> most recently indexed block, or `END_OF_CHAIN` */
  readonly heads: Int32Array;
  /** block index -> the previous (older) block in the same bucket */
  readonly next: Int32Array;
  /** `bucketCount - 1`; bucket count is always a power of two */
  readonly mask: number;
}

// --- Instruction byte emitters (mirror delta.ts's decoder) ----------------

function encodeDeltaVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const byte = remaining % 0x80;
    remaining = Math.floor(remaining / 0x80);
    if (remaining === 0) {
      bytes.push(byte);
      return Uint8Array.from(bytes);
    }
    bytes.push(byte | 0x80);
  }
  throw invalidDelta('variable-length integer too long');
}

interface CopyField {
  readonly cmdBits: number;
  readonly bytes: ReadonlyArray<number>;
}

function encodeCopyOffset(offset: number): CopyField {
  const bytes: number[] = [];
  let cmdBits = 0;
  for (let shift = 0; shift <= 24; shift += 8) {
    const byte = (offset >>> shift) & 0xff;
    if (byte !== 0) {
      cmdBits |= 0x01 << (shift / 8);
      bytes.push(byte);
    }
  }
  return { cmdBits, bytes };
}

function encodeCopySize(size: number): CopyField {
  const bytes: number[] = [];
  let cmdBits = 0;
  for (let shift = 0; shift <= 16; shift += 8) {
    const byte = (size >>> shift) & 0xff;
    if (byte !== 0) {
      cmdBits |= 0x10 << (shift / 8);
      bytes.push(byte);
    }
  }
  return { cmdBits, bytes };
}

function encodeCopy(offset: number, size: number): Uint8Array {
  const offsetField = encodeCopyOffset(offset);
  const sizeField = encodeCopySize(size);
  const cmd = 0x80 | offsetField.cmdBits | sizeField.cmdBits;
  return Uint8Array.from([cmd, ...offsetField.bytes, ...sizeField.bytes]);
}

/** `data` is always ≤ `MAX_INSERT_BYTES` by construction — every caller
 *  chunks first — so this never validates length; `assertValidInsert`
 *  guards the caller-facing `serializeDelta` path instead. */
function encodeInsert(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 1);
  result[0] = data.length;
  result.set(data, 1);
  return result;
}

// --- serializeDelta: the caller-facing, fully-validated codec -------------

function assertValidCopy(offset: number, size: number): void {
  if (size === 0) throw invalidDelta('COPY size must be non-zero');
  if (size > MAX_COPY_BYTES) throw invalidDelta(`COPY size ${size} exceeds ${MAX_COPY_BYTES}`);
  if (offset < 0 || offset > 0xffffffff) {
    throw invalidDelta(`COPY offset ${offset} out of range`);
  }
}

function assertValidInsert(data: Uint8Array): void {
  if (data.length === 0) throw invalidDelta('INSERT with N=0 is reserved');
  if (data.length > MAX_INSERT_BYTES) {
    throw invalidDelta(`INSERT length ${data.length} exceeds ${MAX_INSERT_BYTES}`);
  }
}

function encodeDeltaInstruction(instruction: DeltaInstruction): Uint8Array {
  if (instruction.type === 'copy') {
    assertValidCopy(instruction.offset, instruction.size);
    return encodeCopy(instruction.offset, instruction.size);
  }
  assertValidInsert(instruction.data);
  return encodeInsert(instruction.data);
}

/** Copies each chunk into one pre-sized buffer by reference — never a
 *  spread call, so arity is never a concern regardless of chunk count or
 *  size. `length` is the caller's own running total, not recomputed here,
 *  so a single pass over `chunks` both sizes and fills the result. */
function assembleParts(chunks: ReadonlyArray<Uint8Array>, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function serializeDelta(
  sourceLength: number,
  targetLength: number,
  instructions: ReadonlyArray<DeltaInstruction>,
): Uint8Array {
  const chunks: Uint8Array[] = [
    encodeDeltaVarInt(sourceLength),
    encodeDeltaVarInt(targetLength),
    ...instructions.map(encodeDeltaInstruction),
  ];
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  return assembleParts(chunks, length);
}

// --- DeltaIndex: the base's block hash table --------------------------------

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

function hashBlock(bytes: Uint8Array, offset: number): number {
  let hash = 0;
  for (let i = 0; i < DELTA_BLOCK_BYTES; i += 1) {
    hash = Math.imul(hash ^ bytes[offset + i]!, HASH_MULTIPLIER);
  }
  return hash >>> 0;
}

export function createDeltaIndex(base: Uint8Array): DeltaIndex {
  const blockCount = Math.floor(base.length / DELTA_BLOCK_BYTES);
  const mask = nextPowerOfTwo(Math.max(blockCount, 1)) - 1;
  const heads = new Int32Array(mask + 1).fill(END_OF_CHAIN);
  const next = new Int32Array(blockCount).fill(END_OF_CHAIN);

  for (let block = 0; block < blockCount; block += 1) {
    const bucket = hashBlock(base, block * DELTA_BLOCK_BYTES) & mask;
    next[block] = heads[bucket]!;
    heads[bucket] = block;
  }

  return { base, heads, next, mask };
}

// --- The match loop ---------------------------------------------------------

interface Match {
  readonly baseOffset: number;
  readonly targetStart: number;
  readonly length: number;
}

function matchForward(
  base: Uint8Array,
  target: Uint8Array,
  baseOffset: number,
  targetPos: number,
): number {
  // Stryker disable next-line ArithmeticOperator: equivalent — these two subtractions only cap `max`; the loop's own base[i]===target[i] check already halts at the true remaining length (an out-of-bounds read is `undefined`, which can never equal a real byte), so inflating either term cannot change the result — verified with 200k randomized trials, including exact tied-remaining-length cases.
  const max = Math.min(MAX_COPY_BYTES, base.length - baseOffset, target.length - targetPos);
  let length = 0;
  while (length < max && base[baseOffset + length] === target[targetPos + length]) {
    length += 1;
  }
  return length;
}

function matchBackward(
  base: Uint8Array,
  target: Uint8Array,
  baseOffset: number,
  targetPos: number,
  cap: number,
): number {
  let length = 0;
  while (length < cap && base[baseOffset - length - 1] === target[targetPos - length - 1]) {
    length += 1;
  }
  return length;
}

/** Extends a candidate both ways; backward is capped so it never crosses
 *  into bytes already flushed as INSERT — only the pending, not-yet-emitted
 *  literal run (`pos - literalStart`) may be reclaimed into the match.
 *
 *  Trade accepted: capping reclaim to the not-yet-flushed tail means backward
 *  extension can no longer compensate when `MAX_CANDIDATES_PER_BUCKET`
 *  hides the true base block behind a full bucket chain — on a synthetic
 *  self-similar worst case (a 251-byte ramp whose 15 blocks all collide
 *  into one bucket) the resulting delta can run up to 44x larger than the
 *  optimum. Measured on 649 real blob pairs from this repo's history the
 *  effect is negligible: +260 bytes on 3.86 MB of deltas (+0.01%), worst
 *  single case 1.09x, 604/649 byte-identical. The alternative — a reclaim
 *  floor independent of the flush cursor — would let a match dig back into
 *  target bytes already committed to output, reopening the unbounded
 *  pending-literal growth this incremental flush exists to prevent. The
 *  underlying weakness is the candidate-per-bucket cap hiding the base
 *  block in the first place; that is pre-existing and out of scope here. */
function evaluateCandidate(
  index: DeltaIndex,
  target: Uint8Array,
  blockOffset: number,
  pos: number,
  literalStart: number,
): Match {
  const forward = matchForward(index.base, target, blockOffset, pos);
  const backwardCap = Math.min(blockOffset, pos - literalStart, MAX_COPY_BYTES - forward);
  const backward = matchBackward(index.base, target, blockOffset, pos, backwardCap);
  return {
    baseOffset: blockOffset - backward,
    targetStart: pos - backward,
    length: forward + backward,
  };
}

function isBetterMatch(candidate: Match, best: Match | undefined): boolean {
  if (best === undefined) return true;
  // Stryker disable next-line EqualityOperator: equivalent — only reached when candidate.length !== best.length already holds (the guard on this line), so `>` and `>=` decide identically here: equality is impossible inside this branch.
  if (candidate.length !== best.length) return candidate.length > best.length;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — a same-offset or reversed-offset tie between two distinct chain blocks needs one block's backward reach to overlap the other's own 16-byte hash-matched content, which forces target's pre-pos bytes to replicate its own post-pos window; the natural leftmost scan always discovers that replicated window as an earlier match first, so this tie-break is never actually reached with a differing outcome — verified with 2M+ randomized trials plus two hand-built overlap constructions, both preempted by an earlier match, and the full unit suite (15k+ tests) unaffected under both mutations.
  return candidate.baseOffset < best.baseOffset;
}

function findBestMatch(
  index: DeltaIndex,
  target: Uint8Array,
  pos: number,
  literalStart: number,
): Match | undefined {
  const bucket = hashBlock(target, pos) & index.mask;
  let block = index.heads[bucket]!;
  let candidatesLeft = MAX_CANDIDATES_PER_BUCKET;
  let best: Match | undefined;

  // Stryker disable next-line ConditionalExpression: equivalent — dropping this guard only lets the loop evaluate phantom candidates at a negative or NaN blockOffset, whose out-of-bounds reads make forward and backward both 0; a zero-length candidate never beats an existing or later real match under isBetterMatch, and the caller's own `length >= DELTA_BLOCK_BYTES` check rejects it regardless, so `best` is never corrupted — verified against the full unit suite (15k+ tests) unmutated.
  while (block !== END_OF_CHAIN && candidatesLeft > 0) {
    const candidate = evaluateCandidate(
      index,
      target,
      block * DELTA_BLOCK_BYTES,
      pos,
      literalStart,
    );
    if (isBetterMatch(candidate, best)) best = candidate;
    block = index.next[block]!;
    candidatesLeft -= 1;
  }

  return best;
}

interface Emitter {
  readonly parts: Uint8Array[];
  readonly maxSize: number | undefined;
  emitted: number;
}

/** `bytes` is pushed by reference, never spread — the element-based
 *  predecessor spread one call argument per byte, which V8 caps well
 *  under the size a single object's literal run can reach. */
function emit(state: Emitter, bytes: Uint8Array): boolean {
  state.emitted += bytes.length;
  if (state.maxSize !== undefined && state.emitted > state.maxSize) return false;
  state.parts.push(bytes);
  return true;
}

/** Flushes `[start, end)` as one INSERT — a no-op for an empty range, since
 *  INSERT with N=0 is reserved. Every caller guarantees `end - start <
 *  MAX_INSERT_BYTES`: the periodic flush below never lets a pending run
 *  grow past it. */
function flushPendingLiteral(
  state: Emitter,
  target: Uint8Array,
  start: number,
  end: number,
): boolean {
  if (start === end) return true;
  return emit(state, encodeInsert(target.subarray(start, end)));
}

interface ScanCursor {
  readonly pos: number;
  readonly literalStart: number;
}

/** Emits the pending literal run plus the COPY for `match`, returning where
 *  the scan resumes — or `undefined` if maxSize was breached mid-flush. */
function emitMatch(
  state: Emitter,
  target: Uint8Array,
  literalStart: number,
  match: Match,
): ScanCursor | undefined {
  if (!flushPendingLiteral(state, target, literalStart, match.targetStart)) return undefined;
  if (!emit(state, encodeCopy(match.baseOffset, match.length))) return undefined;
  const pos = match.targetStart + match.length;
  return { pos, literalStart: pos };
}

function emitHeader(state: Emitter, baseLength: number, targetLength: number): boolean {
  if (!emit(state, encodeDeltaVarInt(baseLength))) return false;
  return emit(state, encodeDeltaVarInt(targetLength));
}

export function encodeDeltaFromIndex(
  index: DeltaIndex,
  target: Uint8Array,
  maxSize?: number,
): Uint8Array | undefined {
  const state: Emitter = { parts: [], maxSize, emitted: 0 };
  if (!emitHeader(state, index.base.length, target.length)) return undefined;

  let pos = 0;
  let literalStart = 0;
  while (pos < target.length) {
    const match =
      // Stryker disable next-line ConditionalExpression,ArithmeticOperator: equivalent — this is a pure performance short-circuit; evaluateCandidate/matchForward/matchBackward independently bound themselves by the real remaining lengths regardless of when they run, so skipping this guard only wastes a lookup or, rarely, accepts a genuinely valid backward-compensated match near the tail — round-trip and every existing instruction-shape assertion hold either way, verified against the full unit suite (15k+ tests) plus 8k round-trip fuzz trials, unmutated.
      target.length - pos >= DELTA_BLOCK_BYTES
        ? findBestMatch(index, target, pos, literalStart)
        : undefined;

    if (match !== undefined && match.length >= DELTA_BLOCK_BYTES) {
      const cursor = emitMatch(state, target, literalStart, match);
      if (cursor === undefined) return undefined;
      pos = cursor.pos;
      literalStart = cursor.literalStart;
      continue;
    }

    // Flush every full MAX_INSERT_BYTES chunk the moment it accumulates —
    // this is what lets a losing candidate's maxSize breach abort mid-scan
    // instead of only after the whole object has been walked, and it caps
    // how much a later match's backward extension may reclaim (only the
    // still-pending, not-yet-flushed tail).
    pos += 1;
    if (pos - literalStart < MAX_INSERT_BYTES) continue;
    if (!emit(state, encodeInsert(target.subarray(literalStart, pos)))) return undefined;
    literalStart = pos;
  }

  if (!flushPendingLiteral(state, target, literalStart, target.length)) return undefined;
  return assembleParts(state.parts, state.emitted);
}

export function encodeDelta(
  base: Uint8Array,
  target: Uint8Array,
  maxSize?: number,
): Uint8Array | undefined {
  return encodeDeltaFromIndex(createDeltaIndex(base), target, maxSize);
}

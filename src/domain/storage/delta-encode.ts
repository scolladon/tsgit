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

function encodeDeltaVarInt(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const byte = remaining % 0x80;
    remaining = Math.floor(remaining / 0x80);
    if (remaining === 0) {
      bytes.push(byte);
      return bytes;
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

function encodeCopy(offset: number, size: number): number[] {
  const offsetField = encodeCopyOffset(offset);
  const sizeField = encodeCopySize(size);
  const cmd = 0x80 | offsetField.cmdBits | sizeField.cmdBits;
  return [cmd, ...offsetField.bytes, ...sizeField.bytes];
}

function encodeInsert(data: Uint8Array): number[] {
  return [data.length, ...data];
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

function encodeDeltaInstruction(instruction: DeltaInstruction): number[] {
  if (instruction.type === 'copy') {
    assertValidCopy(instruction.offset, instruction.size);
    return encodeCopy(instruction.offset, instruction.size);
  }
  assertValidInsert(instruction.data);
  return encodeInsert(instruction.data);
}

export function serializeDelta(
  sourceLength: number,
  targetLength: number,
  instructions: ReadonlyArray<DeltaInstruction>,
): Uint8Array {
  const bytes = [...encodeDeltaVarInt(sourceLength), ...encodeDeltaVarInt(targetLength)];
  for (const instruction of instructions) {
    bytes.push(...encodeDeltaInstruction(instruction));
  }
  return Uint8Array.from(bytes);
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
 *  literal run (`pos - literalStart`) may be reclaimed into the match. */
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
  if (candidate.length !== best.length) return candidate.length > best.length;
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

function encodeLiteralRun(target: Uint8Array, start: number, end: number): number[] {
  const bytes: number[] = [];
  let cursor = start;
  while (cursor < end) {
    const chunkEnd = Math.min(cursor + MAX_INSERT_BYTES, end);
    bytes.push(...encodeInsert(target.subarray(cursor, chunkEnd)));
    cursor = chunkEnd;
  }
  return bytes;
}

interface Emitter {
  readonly parts: number[];
  readonly maxSize: number | undefined;
  emitted: number;
}

function emit(state: Emitter, bytes: ReadonlyArray<number>): boolean {
  state.emitted += bytes.length;
  if (state.maxSize !== undefined && state.emitted > state.maxSize) return false;
  state.parts.push(...bytes);
  return true;
}

export function encodeDeltaFromIndex(
  index: DeltaIndex,
  target: Uint8Array,
  maxSize?: number,
): Uint8Array | undefined {
  const state: Emitter = { parts: [], maxSize, emitted: 0 };
  if (!emit(state, encodeDeltaVarInt(index.base.length))) return undefined;
  if (!emit(state, encodeDeltaVarInt(target.length))) return undefined;

  let pos = 0;
  let literalStart = 0;
  while (pos < target.length) {
    const match =
      target.length - pos >= DELTA_BLOCK_BYTES
        ? findBestMatch(index, target, pos, literalStart)
        : undefined;

    if (match === undefined || match.length < DELTA_BLOCK_BYTES) {
      pos += 1;
      continue;
    }

    if (!emit(state, encodeLiteralRun(target, literalStart, match.targetStart))) return undefined;
    if (!emit(state, encodeCopy(match.baseOffset, match.length))) return undefined;
    pos = match.targetStart + match.length;
    literalStart = pos;
  }

  if (!emit(state, encodeLiteralRun(target, literalStart, target.length))) return undefined;
  return Uint8Array.from(state.parts);
}

export function encodeDelta(
  base: Uint8Array,
  target: Uint8Array,
  maxSize?: number,
): Uint8Array | undefined {
  return encodeDeltaFromIndex(createDeltaIndex(base), target, maxSize);
}

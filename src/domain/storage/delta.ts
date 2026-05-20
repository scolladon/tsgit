import { invalidDelta } from './error.js';

/**
 * Maximum number of delta-chain hops a pack resolver will follow before
 * throwing `DELTA_CHAIN_TOO_DEEP`. Matches git's own default.
 */
export const MAX_DELTA_CHAIN_DEPTH = 50;

export interface CopyInstruction {
  readonly type: 'copy';
  readonly offset: number;
  readonly size: number;
}

export interface InsertInstruction {
  readonly type: 'insert';
  readonly data: Uint8Array;
}

export type DeltaInstruction = CopyInstruction | InsertInstruction;

export interface DeltaParsed {
  readonly sourceLength: number;
  readonly targetLength: number;
  readonly instructions: ReadonlyArray<DeltaInstruction>;
}

const MAX_VARINT_BYTES = 5;

function readVariableLengthInt(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly nextOffset: number } {
  if (offset >= bytes.length) {
    throw invalidDelta('truncated variable-length integer');
  }
  let value = 0;
  let shift = 0;
  let pos = offset;
  let bytesRead = 0;

  let byte = bytes[pos]!;
  value = ((byte & 0x7f) << shift) >>> 0;
  shift += 7;
  bytesRead += 1;
  while ((byte & 0x80) !== 0) {
    if (bytesRead >= MAX_VARINT_BYTES) {
      throw invalidDelta('variable-length integer too long');
    }
    pos += 1;
    if (pos >= bytes.length) {
      throw invalidDelta('truncated variable-length integer');
    }
    byte = bytes[pos]!;
    value = (value | ((byte & 0x7f) << shift)) >>> 0;
    shift += 7;
    bytesRead += 1;
  }
  return { value, nextOffset: pos + 1 };
}

function countCopyFieldBytes(cmd: number): number {
  let count = 0;
  if (cmd & 0x01) count += 1;
  if (cmd & 0x02) count += 1;
  if (cmd & 0x04) count += 1;
  if (cmd & 0x08) count += 1;
  if (cmd & 0x10) count += 1;
  if (cmd & 0x20) count += 1;
  if (cmd & 0x40) count += 1;
  return count;
}

function decodeCopyFields(
  bytes: Uint8Array,
  pos: number,
  cmd: number,
): { readonly offset: number; readonly size: number; readonly nextPos: number } {
  const needed = countCopyFieldBytes(cmd);
  if (pos + needed > bytes.length) {
    throw invalidDelta(`COPY instruction truncated: needs ${needed} bytes at position ${pos}`);
  }
  let currentPos = pos;
  let offset = 0;
  let size = 0;

  if (cmd & 0x01) {
    offset |= bytes[currentPos]!;
    currentPos += 1;
  }
  if (cmd & 0x02) {
    offset |= bytes[currentPos]! << 8;
    currentPos += 1;
  }
  if (cmd & 0x04) {
    offset |= bytes[currentPos]! << 16;
    currentPos += 1;
  }
  if (cmd & 0x08) {
    offset = (offset | (bytes[currentPos]! * 0x1000000)) >>> 0;
    currentPos += 1;
  }

  if (cmd & 0x10) {
    size |= bytes[currentPos]!;
    currentPos += 1;
  }
  if (cmd & 0x20) {
    size |= bytes[currentPos]! << 8;
    currentPos += 1;
  }
  if (cmd & 0x40) {
    size |= bytes[currentPos]! << 16;
    currentPos += 1;
  }

  if (size === 0) {
    size = 0x10000;
  }

  return { offset, size, nextPos: currentPos };
}

function validateCopyBounds(
  offset: number,
  size: number,
  baseLen: number,
  resultPos: number,
  targetLen: number,
): void {
  if (offset + size > baseLen) {
    throw invalidDelta(
      `COPY out of bounds: offset=${offset} size=${size} exceeds base length ${baseLen}`,
    );
  }
  if (resultPos + size > targetLen) {
    throw invalidDelta(
      `COPY overflows target: position=${resultPos} size=${size} exceeds target length ${targetLen}`,
    );
  }
}

const MAX_TARGET_LENGTH = 2 * 1024 * 1024 * 1024;

function validateDeltaHeader(base: Uint8Array, sourceLength: number, targetLength: number): void {
  if (base.length !== sourceLength) {
    throw invalidDelta(`source length mismatch: expected ${sourceLength}, got ${base.length}`);
  }
  if (targetLength > MAX_TARGET_LENGTH) {
    throw invalidDelta(`target length ${targetLength} exceeds maximum allowed size`);
  }
}

function applyInsert(
  delta: Uint8Array,
  pos: number,
  cmd: number,
  result: Uint8Array,
  resultPos: number,
  targetLength: number,
): { readonly nextPos: number; readonly nextResultPos: number } {
  if (cmd === 0) {
    throw invalidDelta('INSERT with N=0 is reserved');
  }
  if (pos + cmd > delta.length) {
    throw invalidDelta(`INSERT data truncated: needs ${cmd} bytes at position ${pos}`);
  }
  if (resultPos + cmd > targetLength) {
    throw invalidDelta(
      `INSERT overflows target: position=${resultPos} size=${cmd} exceeds target length ${targetLength}`,
    );
  }
  result.set(delta.subarray(pos, pos + cmd), resultPos);
  return { nextPos: pos + cmd, nextResultPos: resultPos + cmd };
}

/**
 * Read only the target-size varint from a delta instruction stream. Cheap
 * upper-bound peek used by `resolveObject({ maxBytes })` to reject oversized
 * delta-resolved objects BEFORE the apply loop runs and BEFORE the result
 * `Uint8Array(targetLength)` is allocated.
 *
 * Throws `INVALID_DELTA` on a truncated or malformed varint — the same error
 * `applyDelta` would surface a moment later. No new failure mode.
 */
export function readDeltaTargetSize(delta: Uint8Array): number {
  const { nextOffset: o1 } = readVariableLengthInt(delta, 0);
  const { value: targetLength } = readVariableLengthInt(delta, o1);
  return targetLength;
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const { value: sourceLength, nextOffset: o1 } = readVariableLengthInt(delta, 0);
  const { value: targetLength, nextOffset: o2 } = readVariableLengthInt(delta, o1);

  validateDeltaHeader(base, sourceLength, targetLength);

  const result = new Uint8Array(targetLength);
  let resultPos = 0;
  let pos = o2;

  while (pos < delta.length) {
    const cmd = delta[pos]!;
    pos += 1;

    if (cmd & 0x80) {
      const { offset, size, nextPos } = decodeCopyFields(delta, pos, cmd);
      pos = nextPos;
      validateCopyBounds(offset, size, base.length, resultPos, targetLength);
      result.set(base.subarray(offset, offset + size), resultPos);
      resultPos += size;
    } else {
      const applied = applyInsert(delta, pos, cmd, result, resultPos, targetLength);
      pos = applied.nextPos;
      resultPos = applied.nextResultPos;
    }
  }

  if (resultPos !== targetLength) {
    throw invalidDelta(
      `underfill: produced ${resultPos} bytes but target length is ${targetLength}`,
    );
  }

  return result;
}

export function parseDelta(delta: Uint8Array): DeltaParsed {
  const { value: sourceLength, nextOffset: o1 } = readVariableLengthInt(delta, 0);
  const { value: targetLength, nextOffset: o2 } = readVariableLengthInt(delta, o1);

  const instructions: DeltaInstruction[] = [];
  let pos = o2;

  while (pos < delta.length) {
    const cmd = delta[pos]!;
    pos += 1;

    if (cmd & 0x80) {
      const { offset, size, nextPos } = decodeCopyFields(delta, pos, cmd);
      pos = nextPos;
      instructions.push({ type: 'copy', offset, size });
    } else {
      if (cmd === 0) {
        throw invalidDelta('INSERT with N=0 is reserved');
      }
      if (pos + cmd > delta.length) {
        throw invalidDelta(
          `INSERT data truncated: needs ${cmd} bytes at position ${pos}, only ${delta.length - pos} available`,
        );
      }
      const data = delta.slice(pos, pos + cmd);
      pos += cmd;
      instructions.push({ type: 'insert', data });
    }
  }

  return { sourceLength, targetLength, instructions };
}

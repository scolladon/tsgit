import { bytesToHex, indexOf } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';

/** One conflicted stage a resolution replaced: its mode and the id it named. */
export interface ResolveUndoStage {
  readonly stage: 1 | 2 | 3;
  readonly mode: number;
  readonly id: ObjectId;
}

/** One `REUC` record: a resolved path and the conflicted stages it had. */
export interface ResolveUndoRecord {
  readonly path: string;
  readonly stages: ReadonlyArray<ResolveUndoStage>;
}

const NUL = 0x00;
const OCTAL_ZERO = 0x30;
const OCTAL_SEVEN = 0x37;
const OCTAL_DIGIT_BITS = 3;
const STAGES = [1, 2, 3] as const;
const DECODER = new TextDecoder();

interface Cursor {
  readonly data: Uint8Array;
  offset: number;
}

/** A NUL-terminated field, refused as git's `size <= len` refuses one that ends the data. */
function field(cursor: Cursor): Uint8Array | undefined {
  const end = indexOf(cursor.data, NUL, cursor.offset);
  if (end === -1 || end + 1 >= cursor.data.length) return undefined;
  const bytes = cursor.data.subarray(cursor.offset, end);
  cursor.offset = end + 1;
  return bytes;
}

/** An octal mode field: at least one digit and nothing else before its NUL. */
function octal(bytes: Uint8Array): number | undefined {
  if (bytes.length === 0) return undefined;
  let mode = 0;
  for (const byte of bytes) {
    if (byte < OCTAL_ZERO || byte > OCTAL_SEVEN) return undefined;
    mode = (mode << OCTAL_DIGIT_BITS) + (byte - OCTAL_ZERO);
  }
  return mode;
}

function readModes(cursor: Cursor): ReadonlyArray<number> | undefined {
  const modes: number[] = [];
  for (const _ of STAGES) {
    const bytes = field(cursor);
    const mode = bytes === undefined ? undefined : octal(bytes);
    if (mode === undefined) return undefined;
    modes.push(mode);
  }
  return modes;
}

function readStages(
  cursor: Cursor,
  modes: ReadonlyArray<number>,
  digestLength: number,
): ReadonlyArray<ResolveUndoStage> | undefined {
  const stages: ResolveUndoStage[] = [];
  for (const [index, stage] of STAGES.entries()) {
    const mode = modes[index] as number;
    if (mode === 0) continue;
    const end = cursor.offset + digestLength;
    if (end > cursor.data.length) return undefined;
    stages.push({
      stage,
      mode,
      id: bytesToHex(cursor.data.subarray(cursor.offset, end)) as ObjectId,
    });
    cursor.offset = end;
  }
  return stages;
}

function readRecord(cursor: Cursor, digestLength: number): ResolveUndoRecord | undefined {
  const path = field(cursor);
  if (path === undefined) return undefined;
  const modes = readModes(cursor);
  if (modes === undefined) return undefined;
  const stages = readStages(cursor, modes, digestLength);
  return stages === undefined ? undefined : { path: DECODER.decode(path), stages };
}

/**
 * The `REUC` extension as git's `resolve_undo_read` decodes it, or
 * `undefined` when any record is malformed — git then drops the whole
 * extension, valid records included.
 */
export function parseResolveUndo(
  data: Uint8Array,
  digestLength: number,
): ReadonlyArray<ResolveUndoRecord> | undefined {
  const cursor: Cursor = { data, offset: 0 };
  const records: ResolveUndoRecord[] = [];
  while (cursor.offset < data.length) {
    const record = readRecord(cursor, digestLength);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

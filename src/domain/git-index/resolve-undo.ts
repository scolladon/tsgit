import { bytesToHex, concatBytes, encode, hexToBytes, indexOf } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import { isAsciiSpace } from '../pretty/ascii.js';
import type { IndexEntry } from './index-entry.js';
import { type IndexPath, indexPathKey, indexPathOfBytes, pathBytesOf } from './index-path-key.js';
import { compareEntryPath } from './index-writer.js';

/** One conflicted stage a resolution replaced: its mode and the id it named. */
export interface ResolveUndoStage {
  readonly stage: 1 | 2 | 3;
  readonly mode: number;
  readonly id: ObjectId;
}

/** One `REUC` record: a resolved path and the conflicted stages it had. */
export interface ResolveUndoRecord extends IndexPath {
  readonly stages: ReadonlyArray<ResolveUndoStage>;
}

const NUL = 0x00;
const OCTAL_ZERO = 0x30;
const OCTAL_SEVEN = 0x37;
const OCTAL_RADIX = 8n;
const OCTAL_RADIX_NUMBER = 8;
const PLUS = 0x2b;
const MINUS = 0x2d;
const ULONG_BITS = 64;
const ULONG_RANGE = 1n << BigInt(ULONG_BITS);
const ULONG_MAX = ULONG_RANGE - 1n;
const UINT_BITS = 32;
const STAGES = [1, 2, 3] as const;

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

/** Past `strtoul`'s optional leading whitespace and sign: where digits start, and whether negated. */
function signedStart(bytes: Uint8Array): { readonly start: number; readonly negative: boolean } {
  let start = 0;
  while (start < bytes.length && isAsciiSpace(bytes[start] as number)) start += 1;
  const sign = bytes[start];
  if (sign !== PLUS && sign !== MINUS) return { start, negative: false };
  return { start: start + 1, negative: sign === MINUS };
}

/** The octal digits from `start` to the field's end, or `undefined` when any byte is not one. */
function octalDigits(bytes: Uint8Array, start: number): bigint | undefined {
  let value = 0n;
  for (const byte of bytes.subarray(start)) {
    if (byte < OCTAL_ZERO || byte > OCTAL_SEVEN) return undefined;
    value = value * OCTAL_RADIX + BigInt(byte - OCTAL_ZERO);
  }
  return value;
}

/**
 * A mode field as git's `strtoul(data, &end, 8)` reads it into an unsigned
 * int: optional whitespace and sign, at least one octal digit and nothing
 * else before its NUL. An out-of-range value saturates to `ULONG_MAX`, a
 * negated one wraps, and the unsigned int keeps the low 32 bits.
 */
function octal(bytes: Uint8Array): number | undefined {
  const { start, negative } = signedStart(bytes);
  if (start === bytes.length) return undefined;
  const digits = octalDigits(bytes, start);
  if (digits === undefined) return undefined;
  const wide =
    digits > ULONG_MAX ? ULONG_MAX : negative ? (ULONG_RANGE - digits) % ULONG_RANGE : digits;
  return Number(BigInt.asUintN(UINT_BITS, wide));
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
  return stages === undefined ? undefined : { ...indexPathOfBytes(path), stages };
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

const NUL_BYTE = Uint8Array.of(NUL);
const ABSENT_MODE = '0';

function recordParts(record: ResolveUndoRecord): ReadonlyArray<Uint8Array> {
  const byStage = STAGES.map((stage) => record.stages.find((entry) => entry.stage === stage));
  const modes = byStage.flatMap((entry) => [
    encode(entry === undefined ? ABSENT_MODE : entry.mode.toString(OCTAL_RADIX_NUMBER)),
    NUL_BYTE,
  ]);
  const ids = byStage.flatMap((entry) => (entry === undefined ? [] : [hexToBytes(entry.id)]));
  return [pathBytesOf(record), NUL_BYTE, ...modes, ...ids];
}

/** The `REUC` payload as git's `resolve_undo_write` lays it out: records in the order given. */
export function serializeResolveUndo(records: ReadonlyArray<ResolveUndoRecord>): Uint8Array {
  return concatBytes(records.flatMap(recordParts));
}

function mergeStages(
  prior: ReadonlyArray<ResolveUndoStage>,
  resolved: ReadonlyArray<ResolveUndoStage>,
): ReadonlyArray<ResolveUndoStage> {
  return STAGES.flatMap((stage) => {
    const entry =
      resolved.find((candidate) => candidate.stage === stage) ??
      prior.find((candidate) => candidate.stage === stage);
    return entry === undefined ? [] : [entry];
  });
}

/** `records` with each resolved record folded in: its stages win, stages it lacks stay. */
export function recordResolveUndo(
  records: ReadonlyArray<ResolveUndoRecord>,
  resolved: ReadonlyArray<ResolveUndoRecord>,
): ReadonlyArray<ResolveUndoRecord> {
  const byKey = new Map(records.map((record) => [indexPathKey(record), record]));
  for (const record of resolved) {
    const prior = byKey.get(indexPathKey(record));
    byKey.set(
      indexPathKey(record),
      prior === undefined
        ? record
        : { ...record, stages: mergeStages(prior.stages, record.stages) },
    );
  }
  return [...byKey.values()].sort(compareEntryPath);
}

/** The record for a path's unmerged stages; callers pass stages 1 to 3 only. */
export function resolveUndoRecordOf(stages: ReadonlyArray<IndexEntry>): ResolveUndoRecord {
  const [first] = stages as readonly [IndexEntry, ...IndexEntry[]];
  return {
    path: first.path,
    ...(first.pathBytes === undefined ? {} : { pathBytes: first.pathBytes }),
    stages: stages.map((entry) => ({
      stage: entry.flags.stage as 1 | 2 | 3,
      mode: Number.parseInt(entry.mode, OCTAL_RADIX_NUMBER),
      id: entry.id,
    })),
  };
}

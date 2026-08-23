/**
 * Reftable log block codec: the reflog record grammar (`log_record` /
 * `log_data`), the reversed-`update_index` log key, and the raw `±HHMM`
 * `tz_offset` divergence from the shipped spec (S1). Log blocks are
 * unaligned and written back-to-back — no `block_size` stride applies and a
 * block's own declared length is its INFLATED size, never its compressed
 * extent — so `loadReftable` inflates every log block eagerly, tracking
 * bytes consumed by the inflater to find each next block.
 * `iterateReftableLogs` then walks the pre-inflated payloads synchronously,
 * which is exactly what eager whole-stack loading buys. Per S3, the log
 * index (parsed into the footer by `reftable-format.ts`) is never consulted
 * here: the whole table is already resident, so every read is a linear scan.
 */
import type { AuthorIdentity } from '../../objects/author-identity.js';
import { decode } from '../../objects/encoding.js';
import { ObjectId, type RefName } from '../../objects/index.js';
import type { ReflogEntry } from '../../reflog/reflog-entry.js';
import { invalidReftable } from '../error.js';
import { decodeSafeRefName, readPrefixedName } from './reftable-block.js';
import { parseReftable, type Reftable, readUint24, readVarint } from './reftable-format.js';

/** `log_type` — the low bits of `log_record`'s packed
 *  `(suffix_length << SUFFIX_SHIFT) | log_type` field, the same packing
 *  scheme every other reftable record tag uses. */
export const LOG_TYPE_DELETION = 0x0;
export const LOG_TYPE_ENTRY = 0x1;
const LOG_TYPE_MASK = 0x7;

/**
 * The 4-byte `'g' | uint24(block_len)` header a log block opens with — but
 * unlike every other block type, `block_len` is the block's INFLATED size
 * including these 4 bytes, never its on-disk (compressed) extent. Offsets
 * stored inside the block (the restart array) are computed as if this
 * header were part of the inflated payload, even though it never actually
 * is — the reason the first restart offset is `4`, not `0`.
 */
export const LOG_BLOCK_HEADER_LENGTH = 4;

const RESTART_ENTRY_SIZE = 3;
const RESTART_COUNT_SIZE = 2;

/** `reverse_int64(t) = 0xffffffffffffffff - t` — the log key's sort trick
 *  that puts the newest `update_index` first within a ref's group. */
export const REVERSE_INT64_MAX = 0xffffffffffffffffn;

const LOG_KEY_UPDATE_INDEX_WIDTH = 8;
const LOG_KEY_SEPARATOR_WIDTH = 1;
const TZ_OFFSET_WIDTH = 2;

export interface ReftableLogRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly entry: { readonly kind: 'deletion' } | ({ readonly kind: 'entry' } & ReflogEntry);
}

export type InflateAt = (
  bytes: Uint8Array,
  offset: number,
  maxOutputBytes?: number,
) => Promise<{ readonly output: Uint8Array; readonly bytesConsumed: number }>;

export interface LoadedReftable extends Reftable {
  /** Inflated log-block payloads in file order. Empty when `footer.logPosition === 0`. */
  readonly logBlocks: readonly Uint8Array[];
}

/**
 * git's raw `sint16` `tz_offset` divergence from the shipped spec (S1): the
 * stored integer is the signed `±HHMM` offset itself (`230` for `+0230`,
 * `-800` for `-0800`), never minutes from GMT as the spec claims. Six
 * repositories built at distinct `GIT_*_DATE` offsets confirm this both
 * ways — magnitude zero-padded to four digits, sign from the integer's own
 * sign (`0` is always `+0000`).
 */
export function decodeTzOffset(raw: number): string {
  const sign = raw < 0 ? '-' : '+';
  const magnitude = Math.abs(raw).toString().padStart(4, '0');
  return `${sign}${magnitude}`;
}

/** Inverse of {@link decodeTzOffset}. `AuthorIdentity.timezoneOffset` is
 *  already validated `/^[+-]\d{4}$/` by the time it reaches here, so this is
 *  a trusted-input conversion, not a second validation pass. */
export function encodeTzOffset(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  return sign * Number(offset.slice(1));
}

/** Splits a decoded log key (`refname '\0' reverse_int64(update_index)`)
 *  back into the ref name and the actual (un-reversed) `update_index`. */
function splitLogKey(keyBytes: Uint8Array): {
  readonly name: RefName;
  readonly updateIndex: bigint;
} {
  const suffixWidth = LOG_KEY_SEPARATOR_WIDTH + LOG_KEY_UPDATE_INDEX_WIDTH;
  if (keyBytes.length < suffixWidth) {
    throw invalidReftable(
      'record-overrun',
      `log key of ${keyBytes.length} bytes is too short to hold the ${suffixWidth}-byte separator + reversed update_index suffix`,
    );
  }
  const nameBytes = keyBytes.subarray(0, keyBytes.length - suffixWidth);
  const view = new DataView(
    keyBytes.buffer,
    keyBytes.byteOffset + keyBytes.length - LOG_KEY_UPDATE_INDEX_WIDTH,
    LOG_KEY_UPDATE_INDEX_WIDTH,
  );
  const reversed = view.getBigUint64(0);
  return {
    name: decodeSafeRefName(nameBytes, 'reflog ref name'),
    updateIndex: REVERSE_INT64_MAX - reversed,
  };
}

/**
 * `log_data`: `old_id | new_id | varint(name_len) name | varint(email_len)
 * email | varint(time_seconds) | sint16(tz_offset) | varint(message_len)
 * message` — decodes the two ids plus the four fields `ReflogEntry.identity`
 * maps onto directly, and the trailing message.
 */
function decodeLogData(
  bytes: Uint8Array,
  offset: number,
  digestLength: number,
): {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly identity: AuthorIdentity;
  readonly message: string;
  readonly nextOffset: number;
} {
  // `readPrefixedName`'s own overflow-guard shape: bound a fixed-width read
  // against `bytes.length` BEFORE taking it, rather than letting a short
  // subarray reach `ObjectId.fromRaw` (which validates length, but too late
  // to carry a `ReftableCheck`) or a `DataView` read run past the buffer.
  const idsEnd = offset + 2 * digestLength;
  if (idsEnd > bytes.length) {
    throw invalidReftable(
      'record-overrun',
      `log record at byte ${offset} needs ${2 * digestLength} bytes for old_id + new_id, past the ${bytes.length}-byte payload`,
    );
  }
  const oldId = ObjectId.fromRaw(bytes.subarray(offset, offset + digestLength));
  const newIdOffset = offset + digestLength;
  const newId = ObjectId.fromRaw(bytes.subarray(newIdOffset, newIdOffset + digestLength));

  const { value: nameLen, nextOffset: afterNameLen } = readVarint(
    bytes,
    newIdOffset + digestLength,
  );
  const name = decode(bytes.subarray(afterNameLen, afterNameLen + nameLen));

  const { value: emailLen, nextOffset: afterEmailLen } = readVarint(bytes, afterNameLen + nameLen);
  const email = decode(bytes.subarray(afterEmailLen, afterEmailLen + emailLen));

  const { value: timestamp, nextOffset: afterTimestamp } = readVarint(
    bytes,
    afterEmailLen + emailLen,
  );
  if (afterTimestamp + TZ_OFFSET_WIDTH > bytes.length) {
    throw invalidReftable(
      'record-overrun',
      `log record tz_offset at byte ${afterTimestamp} runs past the ${bytes.length}-byte payload`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timezoneOffset = decodeTzOffset(view.getInt16(afterTimestamp));
  const afterTz = afterTimestamp + TZ_OFFSET_WIDTH;

  const { value: messageLen, nextOffset: afterMessageLen } = readVarint(bytes, afterTz);
  const message = decode(bytes.subarray(afterMessageLen, afterMessageLen + messageLen));

  return {
    oldId,
    newId,
    identity: { name, email, timestamp, timezoneOffset },
    message,
    nextOffset: afterMessageLen + messageLen,
  };
}

/** Decodes just the `log_record` key at `offset`: the shared
 *  prefix-compressed key cursor ({@link readPrefixedName}, reused verbatim
 *  from `reftable-block.ts`) plus the packed `log_type` tag — never the
 *  value that follows. The key-cursor half `walkLogBlockRecords` decides a
 *  `matches` filter from BEFORE choosing whether to materialise the value
 *  ({@link decodeLogData}) or merely skip past it ({@link skipLogData}). */
function decodeLogKey(
  bytes: Uint8Array,
  offset: number,
  priorKeyBytes: Uint8Array | undefined,
): {
  readonly keyBytes: Uint8Array;
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly logType: number;
  readonly afterKey: number;
} {
  const {
    nameBytes: keyBytes,
    packed,
    nextOffset: afterKey,
  } = readPrefixedName(bytes, offset, priorKeyBytes);
  const { name, updateIndex } = splitLogKey(keyBytes);
  return { keyBytes, name, updateIndex, logType: packed & LOG_TYPE_MASK, afterKey };
}

/**
 * `log_data`'s exact byte length, walked field by field via its own
 * varint-delimited lengths — WITHOUT decoding any of their content: no
 * `ObjectId` allocation for either id, no `TextDecoder` call for the name,
 * email or message. The key-cursor's "skip a non-matching entry" path,
 * paired with {@link decodeLogData}'s "materialise a matching one" — the
 * two are kept in exact lock-step field-by-field, since a drift between
 * them would silently miscount bytes and corrupt every record after it.
 */
function skipLogData(bytes: Uint8Array, offset: number, digestLength: number): number {
  let cursor = offset + 2 * digestLength;
  const { value: nameLen, nextOffset: afterNameLen } = readVarint(bytes, cursor);
  cursor = afterNameLen + nameLen;
  const { value: emailLen, nextOffset: afterEmailLen } = readVarint(bytes, cursor);
  cursor = afterEmailLen + emailLen;
  const { nextOffset: afterTimestamp } = readVarint(bytes, cursor);
  cursor = afterTimestamp + 2;
  const { value: messageLen, nextOffset: afterMessageLen } = readVarint(bytes, cursor);
  return afterMessageLen + messageLen;
}

/**
 * One log block's record area and restart array, resolved against the
 * block's OWN inflated payload. `recordsStart` is always `0` here: the
 * phantom 4-byte block header that the stored restart offsets are computed
 * against (S1-adjacent — see {@link LOG_BLOCK_HEADER_LENGTH}) is never
 * actually present in the inflated bytes.
 */
export interface LogBlockBounds {
  readonly recordsStart: number;
  readonly recordsEnd: number;
  readonly restartOffsets: ReadonlyArray<number>;
}

export function logBlockBounds(payload: Uint8Array): LogBlockBounds {
  if (payload.length < RESTART_COUNT_SIZE) {
    throw invalidReftable(
      'block-bounds',
      `log block payload of ${payload.length} bytes is too short to hold its own restart_count`,
    );
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const restartCount = view.getUint16(payload.length - RESTART_COUNT_SIZE);
  const restartArrayStart = payload.length - RESTART_COUNT_SIZE - restartCount * RESTART_ENTRY_SIZE;
  if (restartArrayStart < 0) {
    throw invalidReftable(
      'block-bounds',
      `log block declares restart_count ${restartCount}, overrunning its ${payload.length}-byte payload`,
    );
  }

  const restartOffsets: number[] = [];
  for (let i = 0; i < restartCount; i += 1) {
    restartOffsets.push(readUint24(view, restartArrayStart + i * RESTART_ENTRY_SIZE));
  }

  return { recordsStart: 0, recordsEnd: restartArrayStart, restartOffsets };
}

/**
 * Full forward scan of one inflated log block's records — never a binary
 * search: S3 means the log index is never consulted on read, so there is no
 * candidate block to narrow down to in the first place. `matches` decides,
 * from the KEY alone, whether a record is worth materialising in full
 * ({@link decodeLogData}) or only worth skipping past ({@link skipLogData})
 * — a name filter no longer pays for every OTHER ref's identity/message
 * decode just to discard it a moment later.
 *
 * No explicit forward-progress assertion here (unlike `walkBlockRecords`'s
 * and `findInBlock`'s own, in `reftable-block.ts`): every path bottoms out
 * in `readPrefixedName` (whose two varint reads each consume at least one
 * byte before its own now-bounds-checked suffix length is added) followed
 * by either nothing (deletion), `decodeLogData`, or `skipLogData` — the
 * latter two share the identical varint-walk shape, each consuming at least
 * one more byte per field — so `nextOffset` is provably `> cursor` on every
 * path a runtime guard here would be unreachable dead code, not a second
 * layer of defence.
 */
function* walkLogBlockRecords(
  payload: Uint8Array,
  digestLength: number,
  matches: (name: RefName) => boolean,
): Generator<ReftableLogRecord> {
  const bounds = logBlockBounds(payload);
  let cursor = bounds.recordsStart;
  let priorKeyBytes: Uint8Array | undefined;
  while (cursor < bounds.recordsEnd) {
    const { keyBytes, name, updateIndex, logType, afterKey } = decodeLogKey(
      payload,
      cursor,
      priorKeyBytes,
    );
    if (logType === LOG_TYPE_DELETION) {
      if (matches(name)) yield { name, updateIndex, entry: { kind: 'deletion' } };
      priorKeyBytes = keyBytes;
      cursor = afterKey;
      continue;
    }
    if (matches(name)) {
      const { oldId, newId, identity, message, nextOffset } = decodeLogData(
        payload,
        afterKey,
        digestLength,
      );
      yield { name, updateIndex, entry: { kind: 'entry', oldId, newId, identity, message } };
      cursor = nextOffset;
    } else {
      cursor = skipLogData(payload, afterKey, digestLength);
    }
    priorKeyBytes = keyBytes;
  }
}

const MATCH_ANY = (): boolean => true;

/** Every reflog record across every (pre-inflated) log block, in file
 *  (key-sorted) order — filtered to `name` when given. Synchronous: this is
 *  exactly what eager whole-stack loading buys. */
export function* iterateReftableLogs(
  table: LoadedReftable,
  name?: RefName,
): Iterable<ReftableLogRecord> {
  const matches = name === undefined ? MATCH_ANY : (candidate: RefName) => candidate === name;
  for (const payload of table.logBlocks) {
    yield* walkLogBlockRecords(payload, table.header.digestLength, matches);
  }
}

/** `header.headerLength` → footer byte length. Mirrors `reftable-format.ts`'s
 *  own version/layout pairing, which is not exported there — restated
 *  narrowly here rather than widening that module's surface for one field. */
const FOOTER_LENGTH_BY_HEADER_LENGTH: ReadonlyMap<24 | 28, 68 | 72> = new Map([
  [24, 68],
  [28, 72],
]);

/** The log section's exclusive upper bound: the log index position when one
 *  is present (S3: parsed into the footer, but never walked into), otherwise
 *  the footer's own start. */
function logSectionEnd(table: Reftable): number {
  if (table.footer.logIndexPosition !== 0) {
    if (table.footer.logIndexPosition > table._bytes.length) {
      throw invalidReftable(
        'block-bounds',
        `footer log_index_position ${table.footer.logIndexPosition} exceeds the table's ${table._bytes.length}-byte length`,
      );
    }
    return table.footer.logIndexPosition;
  }
  const footerLength = FOOTER_LENGTH_BY_HEADER_LENGTH.get(table.header.headerLength)!;
  return table._bytes.length - footerLength;
}

/**
 * Bounds `collectLogBlocks`'s eager whole-table inflation against a
 * decompression bomb (CWE-409), in two layers with distinct jobs:
 *
 * `maxBlockBytes` is checked against each block's own declared (plaintext,
 * pre-inflate) size — read straight from the block header's `uint24` field —
 * before that block is ever inflated. It must stay reachable: `uint24` alone
 * already ceilings a declared size at `0xFFFFFF - LOG_BLOCK_HEADER_LENGTH`
 * (~16.7 MiB), so a `maxBlockBytes` at or above that would never fire and
 * would be dead code. Kept well below that ceiling, it rejects an implausible
 * declared size cheaply, before spending any decompression work on it — real
 * git-produced reflog blocks are ~1KB, so this stays generous by three orders
 * of magnitude.
 *
 * Passing `declaredPayloadBytes` itself as `inflateAt`'s own output bound is
 * what makes the actual inflate call safe regardless of `maxBlockBytes`: the
 * compressor aborts incrementally, during decode, the moment cumulative
 * output would exceed what the block claimed, so no single block can ever
 * transiently allocate more than its own declared size — but that bound only
 * catches a block that UNDER-declares and then inflates past its own claim,
 * whereas `maxBlockBytes` rejects an absurd declared size outright, without
 * even starting to decode it. Neither layer is redundant with the other.
 *
 * `maxTableBytes` bounds the running total across every block this ONE
 * table's `tables.list` entry contributes — `loadReftableStack`'s
 * table-count ceiling (`load-reftable-stack.ts`) is what keeps the
 * STACK-wide total bounded in turn.
 */
export interface LogInflationBudget {
  readonly maxBlockBytes: number;
  readonly maxTableBytes: number;
}

const DEFAULT_LOG_INFLATION_BUDGET: LogInflationBudget = {
  maxBlockBytes: 8 * 1024 * 1024,
  maxTableBytes: 256 * 1024 * 1024,
};

/**
 * Inflates one log block, restating a decompression fault as a structured
 * reftable refusal. `DECOMPRESS_FAILED` is a `TsgitError`, but it carries no
 * `ReftableCheck`, so `invalidReftableCheck` cannot classify it and
 * `verifyOneTable` rethrows instead of recording ONE bad table — which
 * denies the whole ref-integrity audit over a single damaged table, the
 * opposite of the per-table tiering. Corrupt deflate bytes and a payload
 * that outruns its own declared size are both structural faults in the
 * table, so `'block-bounds'` is their check; the original reason is carried
 * through so the cause is not lost.
 */
async function inflateLogBlock(
  table: Reftable,
  offset: number,
  declaredPayloadBytes: number,
  inflateAt: InflateAt,
): Promise<{ readonly output: Uint8Array; readonly bytesConsumed: number }> {
  try {
    return await inflateAt(table._bytes, offset + LOG_BLOCK_HEADER_LENGTH, declaredPayloadBytes);
  } catch (err) {
    if (errorCodeOf(err) !== 'DECOMPRESS_FAILED') throw err;
    throw invalidReftable(
      'block-bounds',
      `log block at file offset ${offset} failed to inflate: ${reasonOf(err)}`,
    );
  }
}

/** The `data.code` of a `TsgitError`, or `undefined` for any other throw —
 *  narrowing without importing the error class into the domain codec. */
function errorCodeOf(err: unknown): string | undefined {
  const data = (err as { readonly data?: { readonly code?: unknown } } | null)?.data;
  return typeof data?.code === 'string' ? data.code : undefined;
}

function reasonOf(err: unknown): string {
  const data = (err as { readonly data?: { readonly reason?: unknown } } | null)?.data;
  return typeof data?.reason === 'string' ? data.reason : 'unknown cause';
}

async function collectLogBlocks(
  table: Reftable,
  inflateAt: InflateAt,
  budget: LogInflationBudget,
): Promise<readonly Uint8Array[]> {
  if (table.footer.logPosition === 0) {
    return [];
  }
  // Bounded BEFORE the loop below ever reads at this offset: an unvalidated
  // `logPosition` past the file's own length would otherwise either read
  // garbage as a block header (offset still inside `sectionEnd`, itself
  // derived from an equally unvalidated `logIndexPosition`) or, when
  // `sectionEnd` happens to fall short of it, silently produce zero log
  // blocks for a table that declares having log data — neither is a refusal.
  if (table.footer.logPosition > table._bytes.length) {
    throw invalidReftable(
      'block-bounds',
      `footer log_position ${table.footer.logPosition} exceeds the table's ${table._bytes.length}-byte length`,
    );
  }

  const sectionEnd = logSectionEnd(table);
  const blocks: Uint8Array[] = [];
  let offset = table.footer.logPosition;
  let totalInflatedBytes = 0;
  while (offset < sectionEnd) {
    // The guards above bound the two footer POSITIONS; this bounds the READ
    // they lead to. `sectionEnd` may legitimately equal the file length, so
    // an offset in the last three bytes still leaves no room for the 4-byte
    // header — bounding the positions alone cannot express that, and the
    // `readUint24` below would run past the DataView with a raw RangeError
    // that carries no ReftableCheck for the tiering to classify.
    if (offset + LOG_BLOCK_HEADER_LENGTH > table._bytes.length) {
      throw invalidReftable(
        'block-bounds',
        `log block at file offset ${offset} needs ${LOG_BLOCK_HEADER_LENGTH} header bytes, past the table's ${table._bytes.length}-byte length`,
      );
    }
    const declaredPayloadBytes = readUint24(table._view, offset + 1) - LOG_BLOCK_HEADER_LENGTH;
    // A `block_len` under the header's own 4 bytes makes this negative,
    // which would otherwise slip past the `> maxBlockBytes` check below (a
    // negative number is never greater than a positive budget) and reach
    // `inflateAt` with a negative output bound instead of a refusal.
    if (declaredPayloadBytes < 0) {
      throw invalidReftable(
        'block-bounds',
        `log block at file offset ${offset} declares block_len ${declaredPayloadBytes + LOG_BLOCK_HEADER_LENGTH}, shorter than the ${LOG_BLOCK_HEADER_LENGTH}-byte header it must contain`,
      );
    }
    if (declaredPayloadBytes > budget.maxBlockBytes) {
      throw invalidReftable(
        'block-bounds',
        `log block at file offset ${offset} declares ${declaredPayloadBytes} inflated bytes, exceeding the ${budget.maxBlockBytes}-byte per-block limit`,
      );
    }
    const { output, bytesConsumed } = await inflateLogBlock(
      table,
      offset,
      declaredPayloadBytes,
      inflateAt,
    );
    if (output.length !== declaredPayloadBytes) {
      throw invalidReftable(
        'block-bounds',
        `log block at file offset ${offset} inflated to ${output.length} bytes, not its declared ${declaredPayloadBytes}`,
      );
    }
    totalInflatedBytes += output.length;
    if (totalInflatedBytes > budget.maxTableBytes) {
      throw invalidReftable(
        'block-bounds',
        `table's log blocks inflated to ${totalInflatedBytes} bytes, exceeding the ${budget.maxTableBytes}-byte aggregate limit`,
      );
    }
    blocks.push(output);
    offset += LOG_BLOCK_HEADER_LENGTH + bytesConsumed;
  }
  return blocks;
}

/**
 * Parses `bytes`' header and footer via `parseReftable`, then eagerly
 * inflates every log block into `logBlocks` (file order), bounded by
 * `budget` (defaults to {@link DEFAULT_LOG_INFLATION_BUDGET}). Log blocks
 * are never padded or aligned — the next block's position always comes from
 * the inflater's own `bytesConsumed`, never from `header.blockSize` or from
 * a log block's own declared (and, uniquely among block types,
 * inflated-size-only) length.
 */
export async function loadReftable(
  bytes: Uint8Array,
  inflateAt: InflateAt,
  budget: LogInflationBudget = DEFAULT_LOG_INFLATION_BUDGET,
): Promise<LoadedReftable> {
  const table = parseReftable(bytes);
  const logBlocks = await collectLogBlocks(table, inflateAt, budget);
  return { ...table, logBlocks };
}

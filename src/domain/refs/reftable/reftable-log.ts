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
import { ObjectId, RefName } from '../../objects/index.js';
import type { ReflogEntry } from '../../reflog/reflog-entry.js';
import { invalidReftable } from '../error.js';
import { readPrefixedName } from './reftable-block.js';
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

export interface ReftableLogRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly entry: { readonly kind: 'deletion' } | ({ readonly kind: 'entry' } & ReflogEntry);
}

export type InflateAt = (
  bytes: Uint8Array,
  offset: number,
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
  const nameBytes = keyBytes.subarray(0, keyBytes.length - suffixWidth);
  const view = new DataView(
    keyBytes.buffer,
    keyBytes.byteOffset + keyBytes.length - LOG_KEY_UPDATE_INDEX_WIDTH,
    LOG_KEY_UPDATE_INDEX_WIDTH,
  );
  const reversed = view.getBigUint64(0);
  return { name: RefName.from(decode(nameBytes)), updateIndex: REVERSE_INT64_MAX - reversed };
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timezoneOffset = decodeTzOffset(view.getInt16(afterTimestamp));
  const afterTz = afterTimestamp + 2;

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

/** Decodes one `log_record` at `offset`: the shared prefix-compressed key
 *  cursor ({@link readPrefixedName}, reused verbatim from `reftable-block.ts`),
 *  then either nothing (a tombstone) or a full {@link decodeLogData}. */
function decodeLogRecord(
  bytes: Uint8Array,
  offset: number,
  priorKeyBytes: Uint8Array | undefined,
  digestLength: number,
): {
  readonly keyBytes: Uint8Array;
  readonly record: ReftableLogRecord;
  readonly nextOffset: number;
} {
  const {
    nameBytes: keyBytes,
    packed,
    nextOffset: afterKey,
  } = readPrefixedName(bytes, offset, priorKeyBytes);
  const { name, updateIndex } = splitLogKey(keyBytes);
  const logType = packed & LOG_TYPE_MASK;

  if (logType === LOG_TYPE_DELETION) {
    return {
      keyBytes,
      record: { name, updateIndex, entry: { kind: 'deletion' } },
      nextOffset: afterKey,
    };
  }

  const { oldId, newId, identity, message, nextOffset } = decodeLogData(
    bytes,
    afterKey,
    digestLength,
  );
  return {
    keyBytes,
    record: { name, updateIndex, entry: { kind: 'entry', oldId, newId, identity, message } },
    nextOffset,
  };
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
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const restartCount = view.getUint16(payload.length - RESTART_COUNT_SIZE);
  const restartArrayStart = payload.length - RESTART_COUNT_SIZE - restartCount * RESTART_ENTRY_SIZE;

  const restartOffsets: number[] = [];
  for (let i = 0; i < restartCount; i += 1) {
    restartOffsets.push(readUint24(view, restartArrayStart + i * RESTART_ENTRY_SIZE));
  }

  return { recordsStart: 0, recordsEnd: restartArrayStart, restartOffsets };
}

/**
 * Full forward scan of one inflated log block's records — never a binary
 * search: S3 means the log index is never consulted on read, so there is no
 * candidate block to narrow down to in the first place.
 *
 * No explicit forward-progress assertion here (unlike `walkBlockRecords`'s
 * and `findInBlock`'s own, in `reftable-block.ts`): every path through
 * `decodeLogRecord` bottoms out in `readPrefixedName`, whose two varint
 * reads each consume at least one byte before its own now-bounds-checked
 * suffix length is added, so `nextOffset` is provably `> cursor` for every
 * input this decoder can be handed — a runtime guard here would be
 * unreachable dead code, not a second layer of defence.
 */
function* walkLogBlockRecords(
  payload: Uint8Array,
  digestLength: number,
): Generator<ReftableLogRecord> {
  const bounds = logBlockBounds(payload);
  let cursor = bounds.recordsStart;
  let priorKeyBytes: Uint8Array | undefined;
  while (cursor < bounds.recordsEnd) {
    const { keyBytes, record, nextOffset } = decodeLogRecord(
      payload,
      cursor,
      priorKeyBytes,
      digestLength,
    );
    yield record;
    priorKeyBytes = keyBytes;
    cursor = nextOffset;
  }
}

/** Every reflog record across every (pre-inflated) log block, in file
 *  (key-sorted) order — filtered to `name` when given. Synchronous: this is
 *  exactly what eager whole-stack loading buys. */
export function* iterateReftableLogs(
  table: LoadedReftable,
  name?: RefName,
): Iterable<ReftableLogRecord> {
  for (const payload of table.logBlocks) {
    for (const record of walkLogBlockRecords(payload, table.header.digestLength)) {
      if (name === undefined || record.name === name) {
        yield record;
      }
    }
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
    return table.footer.logIndexPosition;
  }
  const footerLength = FOOTER_LENGTH_BY_HEADER_LENGTH.get(table.header.headerLength)!;
  return table._bytes.length - footerLength;
}

/**
 * Bounds `collectLogBlocks`'s eager whole-table inflation against a
 * decompression bomb (CWE-409): a handful of small zlib streams, each
 * expanding toward the compressor's own per-stream cap, retained all at
 * once. `maxBlockBytes` is checked against each block's own declared
 * (plaintext, pre-inflate) size before that block is ever inflated;
 * `maxTableBytes` bounds the running total across every block this ONE
 * table's `tables.list` entry contributes. Both are generous relative to
 * any git-produced reflog (the design's own measured blocks are ~1KB) —
 * `loadReftableStack`'s table-count ceiling (`load-reftable-stack.ts`) is
 * what keeps the STACK-wide total bounded in turn.
 */
export interface LogInflationBudget {
  readonly maxBlockBytes: number;
  readonly maxTableBytes: number;
}

const DEFAULT_LOG_INFLATION_BUDGET: LogInflationBudget = {
  maxBlockBytes: 64 * 1024 * 1024,
  maxTableBytes: 256 * 1024 * 1024,
};

async function collectLogBlocks(
  table: Reftable,
  inflateAt: InflateAt,
  budget: LogInflationBudget,
): Promise<readonly Uint8Array[]> {
  if (table.footer.logPosition === 0) {
    return [];
  }

  const sectionEnd = logSectionEnd(table);
  const blocks: Uint8Array[] = [];
  let offset = table.footer.logPosition;
  let totalInflatedBytes = 0;
  while (offset < sectionEnd) {
    const declaredPayloadBytes = readUint24(table._view, offset + 1) - LOG_BLOCK_HEADER_LENGTH;
    if (declaredPayloadBytes > budget.maxBlockBytes) {
      throw invalidReftable(
        'block-bounds',
        `log block at file offset ${offset} declares ${declaredPayloadBytes} inflated bytes, exceeding the ${budget.maxBlockBytes}-byte per-block limit`,
      );
    }
    const { output, bytesConsumed } = await inflateAt(
      table._bytes,
      offset + LOG_BLOCK_HEADER_LENGTH,
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

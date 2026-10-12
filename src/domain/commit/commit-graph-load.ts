/**
 * git's `load_commit_graph_one_fd_st` → `parse_commit_graph` refusals, in
 * the order git checks them: the first one a file trips is the one git's
 * loader prints. A file that passes every check here loads in git.
 */

/** Why git's loader refuses a commit-graph file — one variant per message it prints. */
export type CommitGraphLoadFailure =
  | { readonly kind: 'too-small' }
  | { readonly kind: 'signature'; readonly found: number }
  | { readonly kind: 'version'; readonly found: number }
  | { readonly kind: 'hash-version'; readonly found: number; readonly expected: number }
  | { readonly kind: 'too-small-for-chunks'; readonly chunkCount: number }
  | { readonly kind: 'early-terminator' }
  | { readonly kind: 'improper-offsets'; readonly offset: number; readonly next: number }
  | { readonly kind: 'duplicate-chunk'; readonly chunkId: number }
  | { readonly kind: 'final-chunk-id'; readonly chunkId: number }
  | {
      readonly kind: 'required-chunk';
      readonly chunk: RequiredGraphChunk;
      readonly problem: 'missing' | 'wrong-size' | 'out-of-order';
    }
  /** A refusal of tsgit's own parser past every check git makes; `reason` names it. */
  | { readonly kind: 'malformed'; readonly reason: string };

export type RequiredGraphChunk = 'oid-fanout' | 'oid-lookup' | 'commit-data';

const SIGNATURE = 0x43475048;
const GRAPH_VERSION = 1;
const SHA1_LENGTH = 20;
const HEADER_SIZE = 8;
const ROW_SIZE = 12;
const MIN_ROWS = 4;
const FANOUT_ENTRIES = 256;
const FANOUT_SIZE = FANOUT_ENTRIES * 4;
const COMMIT_DATA_FIXED_SIZE = 16;
const OIDF = 0x4f494446;
const OIDL = 0x4f49444c;
const CDAT = 0x43444154;

interface Chunk {
  readonly start: number;
  readonly size: number;
}

/** The refusal git's loader prints for `bytes`, or `undefined` when git loads the file. */
export function commitGraphLoadFailure(
  bytes: Uint8Array,
  hashLength: number,
): CommitGraphLoadFailure | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = headerFailure(bytes, view, hashLength);
  if (header !== undefined) return header;
  const table = readTable(view, bytes[6] as number, bytes.length - hashLength);
  if ('kind' in table) return table;
  return requiredChunksFailure(view, table, hashLength);
}

function headerFailure(
  bytes: Uint8Array,
  view: DataView,
  hashLength: number,
): CommitGraphLoadFailure | undefined {
  if (bytes.length < HEADER_SIZE + MIN_ROWS * ROW_SIZE + FANOUT_SIZE + hashLength) {
    return { kind: 'too-small' };
  }
  const signature = view.getUint32(0);
  if (signature !== SIGNATURE) return { kind: 'signature', found: signature };
  if (bytes[4] !== GRAPH_VERSION) return { kind: 'version', found: bytes[4] as number };
  const expected = hashLength === SHA1_LENGTH ? 1 : 2;
  if (bytes[5] !== expected) return { kind: 'hash-version', found: bytes[5] as number, expected };
  const chunkCount = bytes[6] as number;
  const needed = HEADER_SIZE + (chunkCount + 1) * ROW_SIZE + FANOUT_SIZE + hashLength;
  return bytes.length < needed ? { kind: 'too-small-for-chunks', chunkCount } : undefined;
}

const rowId = (view: DataView, row: number): number => view.getUint32(HEADER_SIZE + row * ROW_SIZE);

/** Chunk offsets are 64-bit; any high word puts the offset past every file this reads. */
const rowOffset = (view: DataView, row: number): number => {
  const at = HEADER_SIZE + row * ROW_SIZE + 4;
  return view.getUint32(at) * 0x100000000 + view.getUint32(at + 4);
};

/** git's `read_table_of_contents`, with the commit-graph's one-byte alignment. */
function readTable(
  view: DataView,
  chunkCount: number,
  dataEnd: number,
): ReadonlyMap<number, Chunk> | CommitGraphLoadFailure {
  const chunks = new Map<number, Chunk>();
  for (let row = 0; row < chunkCount; row += 1) {
    const id = rowId(view, row);
    if (id === 0) return { kind: 'early-terminator' };
    const offset = rowOffset(view, row);
    const next = rowOffset(view, row + 1);
    if (next < offset || next > dataEnd) return { kind: 'improper-offsets', offset, next };
    if (chunks.has(id)) return { kind: 'duplicate-chunk', chunkId: id };
    chunks.set(id, { start: offset, size: next - offset });
  }
  const final = rowId(view, chunkCount);
  return final === 0 ? chunks : { kind: 'final-chunk-id', chunkId: final };
}

const requiredFailure = (
  chunk: RequiredGraphChunk,
  problem: 'missing' | 'wrong-size' | 'out-of-order',
): CommitGraphLoadFailure => ({ kind: 'required-chunk', chunk, problem });

function requiredChunksFailure(
  view: DataView,
  table: ReadonlyMap<number, Chunk>,
  hashLength: number,
): CommitGraphLoadFailure | undefined {
  const fanout = table.get(OIDF);
  if (fanout === undefined) return requiredFailure('oid-fanout', 'missing');
  if (fanout.size !== FANOUT_SIZE) return requiredFailure('oid-fanout', 'wrong-size');
  if (!fanoutAscends(view, fanout.start)) return requiredFailure('oid-fanout', 'out-of-order');
  const commitCount = view.getUint32(fanout.start + FANOUT_SIZE - 4);
  return (
    entriesFailure(table.get(OIDL), hashLength, commitCount, 'oid-lookup') ??
    entriesFailure(table.get(CDAT), hashLength + COMMIT_DATA_FIXED_SIZE, commitCount, 'commit-data')
  );
}

function fanoutAscends(view: DataView, start: number): boolean {
  for (let bucket = 1; bucket < FANOUT_ENTRIES; bucket += 1) {
    const at = start + bucket * 4;
    if (view.getUint32(at - 4) > view.getUint32(at)) return false;
  }
  return true;
}

/** git sizes these chunks by whole entries, so a ragged tail still loads. */
function entriesFailure(
  chunk: Chunk | undefined,
  entrySize: number,
  commitCount: number,
  name: RequiredGraphChunk,
): CommitGraphLoadFailure | undefined {
  if (chunk === undefined) return requiredFailure(name, 'missing');
  if (Math.floor(chunk.size / entrySize) !== commitCount)
    return requiredFailure(name, 'wrong-size');
  return undefined;
}

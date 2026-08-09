/**
 * Shared multi-pack-index crafting + filesystem helpers for the midx-axis
 * interop suites (`midx-interop.test.ts`, and its `fsck` sibling). Lifted out
 * so the two suites cannot drift on the one byte recipe that must stay
 * identical: copying instead of sharing would let a byte-level tweak in one
 * suite silently stop matching the other's fixtures.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped) — these
 * helpers write on-disk midx bytes and belong with their integration peers,
 * same rationale as `interop-helpers.ts` and `pack-fixture-helpers.ts`.
 *
 * SHA-1 hard-coded at `DIGEST_LENGTH = 20` because the `.idx` reader/writer
 * both fix a 20-byte digest (see `pack-fixture-helpers.ts`'s own opening
 * comment) — this suite never constructs a SHA-256 repository, so the midx
 * trailer here is always re-hashed with SHA-1, whatever a row's mutation
 * claims the `hashVersion` byte says.
 */
import { createHash } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { lookupMultiPackIndex, parseMultiPackIndex } from '../../src/domain/storage/index.js';
import { git, runGit } from './interop-helpers.js';

// ---------------------------------------------------------------------------
// Constants + byte-layout primitives — mirrors the header/chunk-table shape
// `src/domain/storage/midx.ts` reads, kept local so a fixture can be crafted
// without depending on the parser's internals beyond its public field offsets.
// ---------------------------------------------------------------------------

export const DIGEST_LENGTH = 20;

const HEADER_SIZE = 12;
const CHUNK_ROW_SIZE = 12;

function sha1(bytes: Uint8Array): Buffer {
  return createHash('sha1').update(bytes).digest();
}

function readUint64BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset) * 0x100000000 + buf.readUInt32BE(offset + 4);
}

function writeUint64BE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32BE(Math.floor(value / 0x100000000), offset);
  buf.writeUInt32BE(value >>> 0, offset + 4);
}

/**
 * The chunk table row (id + offset) whose 4-byte ascii id matches — never a
 * chunk's DATA offset (`parseMultiPackIndex` already exposes those). Used by
 * rows that clobber a chunk's identity rather than its body.
 */
export function chunkTableRowOffset(bytes: Buffer, id: string): number {
  const numChunks = bytes.readUInt8(6);
  for (let i = 0; i <= numChunks; i += 1) {
    const rowStart = HEADER_SIZE + i * CHUNK_ROW_SIZE;
    if (bytes.subarray(rowStart, rowStart + 4).toString('ascii') === id) return rowStart;
  }
  throw new Error(`midx-fixture-helpers: chunk ${id} not found in a ${numChunks}-chunk table`);
}

/** Re-stamps the trailer over `[0, len - DIGEST_LENGTH)` with SHA-1 — a no-op
 *  when the buffer is too short to hold a trailer at all (a deliberately
 *  truncated fixture has nothing to stamp). */
function restampMidxTrailer(bytes: Buffer): Buffer {
  if (bytes.length <= DIGEST_LENGTH) return bytes;
  const trailerStart = bytes.length - DIGEST_LENGTH;
  sha1(bytes.subarray(0, trailerStart)).copy(bytes, trailerStart);
  return bytes;
}

/** The pack a midx assigns `oid` to, read back from the bytes themselves —
 *  never assumed from pack-name or write order, since canonical git's
 *  duplicate tie-break is not itself pinned here. */
function assignedPackName(bytes: Buffer, oid: string): string {
  const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
  const entry = lookupMultiPackIndex(parsed, oid as ObjectId);
  if (entry === undefined) {
    throw new Error(`assignedPackName: ${oid} is not present in this midx`);
  }
  const name = parsed.packNames[entry.packIndex];
  if (name === undefined) {
    throw new Error(`assignedPackName: pack index ${entry.packIndex} has no PNAM entry`);
  }
  return name.slice(0, -'.idx'.length);
}

// ---------------------------------------------------------------------------
// git-invocation helpers — writing the midx itself is git's job, never
// tsgit's (§Out of scope: no write path).
// ---------------------------------------------------------------------------

export function midxPaths(dir: string): {
  readonly flat: string;
  readonly chainDir: string;
  readonly chainFile: string;
} {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  return {
    flat: path.join(packDir, 'multi-pack-index'),
    chainDir: path.join(packDir, 'multi-pack-index.d'),
    chainFile: path.join(packDir, 'multi-pack-index.d', 'multi-pack-index-chain'),
  };
}

/** `git multi-pack-index write` — the flat form. */
export function writeMultiPackIndex(dir: string): void {
  git(dir, 'multi-pack-index', 'write');
}

/**
 * `git multi-pack-index write --incremental`, called `appends` times in a
 * row. Each call only picks up packs the chain does not already cover, so
 * the caller must lay down a new pack (or pack pair) between two rows of a
 * multi-layer chain — this helper does not add packs itself.
 */
export function writeMidxChain(dir: string, appends: number): void {
  for (let i = 0; i < appends; i += 1) {
    git(dir, 'multi-pack-index', 'write', '--incremental');
  }
}

/** The chain manifest's lowercase-hex digests, base layer first — the
 *  trailing newline (and any blank line it produces) is dropped. */
export function readChainDigests(dir: string): ReadonlyArray<string> {
  const { chainFile } = midxPaths(dir);
  const text = readFileSync(chainFile, 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

/** One chain layer's on-disk path, named by its own trailer digest. */
export function chainLayerPath(dir: string, digest: string): string {
  return path.join(midxPaths(dir).chainDir, `multi-pack-index-${digest}.midx`);
}

/** Drops every `.rev` file under the pack directory — the reverse-index axis
 *  a fixture never intends to exercise, called once a fixture is built and
 *  before it is handed to a row for mutation. */
export async function removeRevFiles(dir: string): Promise<void> {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const entries = await readdir(packDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.rev'))
      .map((entry) => rm(path.join(packDir, entry), { force: true })),
  );
}

// ---------------------------------------------------------------------------
// Mutation — the shared home for BOTH disciplines a lied fixture cost a row
// once: chain layers are git-written `0444`, so every mutation chmods its
// target writable first; and a failed write propagates rather than being
// swallowed, because a silently-unwritten mutation measures a HEALTHY repo
// and reports it as whatever tier the row expected.
// ---------------------------------------------------------------------------

export type MidxMutation = (bytes: Buffer) => Buffer;

/**
 * Reads `path`, applies `op`, re-stamps the trailer, and writes the result
 * back — throwing if any step fails rather than returning silently. Callers
 * never need their own `chmod`: this is the one place a midx artefact is
 * ever mutated in either interop suite.
 */
export function mutateMidxOrThrow(filePath: string, op: MidxMutation): void {
  chmodSync(filePath, 0o644);
  const before = readFileSync(filePath);
  const mutated = op(Buffer.from(before));
  const restamped = restampMidxTrailer(mutated);
  writeFileSync(filePath, restamped);
  const after = readFileSync(filePath);
  if (after.length !== restamped.length || !after.equals(restamped)) {
    throw new Error(`mutateMidxOrThrow: write to ${filePath} did not land as written`);
  }
}

/**
 * Rebuilds a valid flat midx with a fifth `LOFF` chunk of `count` 8-byte
 * entries, and OOFF entry 0's offset word replaced by an indirection into
 * `row` of that chunk (`0x80000000 | row`). `row < count` produces a VALID,
 * round-trippable large-offset indirection (object 0's true small offset is
 * preserved in `LOFF[row]`); `row >= count` produces the out-of-range shape
 * Pin F/O28 pin. Everything before the old trailer that is not the chunk
 * table or OOFF's mutated entry is copied byte-for-byte, so the only thing
 * different from the input is exactly what the caller asked for.
 */
export function craftLoffMidx(
  bytes: Buffer,
  opts: { readonly row: number; readonly count: number },
): Buffer {
  const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
  const oldNumChunks = bytes.readUInt8(6);
  const oldTableRows = oldNumChunks + 1;
  const oldTableEnd = HEADER_SIZE + oldTableRows * CHUNK_ROW_SIZE;
  const oldTrailerStart = bytes.length - DIGEST_LENGTH;
  const body = bytes.subarray(oldTableEnd, oldTrailerStart);

  const newTableRows = oldTableRows + 1;
  const newTableEnd = HEADER_SIZE + newTableRows * CHUNK_ROW_SIZE;
  const shift = newTableEnd - oldTableEnd;

  const loffStart = newTableEnd + body.length;
  const newTrailerStart = loffStart + opts.count * 8;
  const out = Buffer.alloc(newTrailerStart + DIGEST_LENGTH);

  bytes.copy(out, 0, 0, HEADER_SIZE);
  out.writeUInt8(oldNumChunks + 1, 6);

  // The real chunks (every old row except the id=0 sentinel) keep their
  // table index and id; only their offset shifts by the new row's width.
  for (let i = 0; i < oldTableRows - 1; i += 1) {
    const oldRowStart = HEADER_SIZE + i * CHUNK_ROW_SIZE;
    const newRowStart = HEADER_SIZE + i * CHUNK_ROW_SIZE;
    bytes.copy(out, newRowStart, oldRowStart, oldRowStart + 4);
    writeUint64BE(out, newRowStart + 4, readUint64BE(bytes, oldRowStart + 4) + shift);
  }
  const loffRowStart = HEADER_SIZE + (oldTableRows - 1) * CHUNK_ROW_SIZE;
  out.write('LOFF', loffRowStart, 'ascii');
  writeUint64BE(out, loffRowStart + 4, loffStart);
  const sentinelRowStart = HEADER_SIZE + oldTableRows * CHUNK_ROW_SIZE;
  writeUint64BE(out, sentinelRowStart + 4, newTrailerStart);

  body.copy(out, newTableEnd);

  const newOoffStart = parsed.objectOffsetsOffset + shift;
  const entryOffsetField = newOoffStart + 4;
  const trueOffset = out.readUInt32BE(entryOffsetField);
  if (opts.row < opts.count) writeUint64BE(out, loffStart + opts.row * 8, trueOffset);
  out.writeUInt32BE((0x80000000 | opts.row) >>> 0, entryOffsetField);

  return restampMidxTrailer(out);
}

// ---------------------------------------------------------------------------
// Fixture recipes — `BASE`, `DUP`, `CHAIN`, per §Pinned matrices' method.
// Every builder is a fresh, cheap repo: no row ever mutates a shared one.
// ---------------------------------------------------------------------------

/** Every fixture builder writes under `baseDir` (a caller-owned root, already
 *  tracked by the caller's own cleanup — e.g. `midx-interop.test.ts`'s
 *  `roots` array), so removing `baseDir` recursively sweeps every fixture
 *  this module ever created; no separate tracking is needed here. */
async function freshRepo(baseDir: string, slug: string): Promise<string> {
  const dir = path.join(baseDir, slug);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

async function commitFile(dir: string, name: string, content: string): Promise<string> {
  await writeFile(path.join(dir, name), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `add ${name}`);
  return git(dir, 'rev-parse', `HEAD:${name}`).trim();
}

/** `git repack -dq` with every existing pack `.keep`-protected, so the newly
 *  committed object(s) land in a brand-new pack of their own. */
function repackIntoNewPack(dir: string): void {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const existing = readdirSync(packDir);
  for (const entry of existing.filter((name) => name.endsWith('.pack'))) {
    const keepPath = path.join(packDir, `${entry.slice(0, -'.pack'.length)}.keep`);
    writeFileSync(keepPath, '');
  }
  git(dir, 'repack', '-dq');
}

/**
 * Feeds `oid` alone to `git pack-objects` over stdin, producing a second,
 * independent pack containing just that one object — the same content
 * `git repack` already packed once, deliberately duplicated. A byte-for-byte
 * COPY of the whole sole pack (git's own de-dup content, just renamed) was
 * tried first and rejected: `git multi-pack-index write --incremental`
 * detects the fully-redundant pack pair and silently collapses the very next
 * incremental write into a flat file instead of stacking a layer — a
 * heuristic this fixture must not trip. A single duplicated blob does not.
 */
function duplicateOidIntoNewPack(dir: string, oid: string): void {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  runGit(['-C', dir, 'pack-objects', '--quiet', path.join(packDir, 'pack-manual')], {
    input: `${oid}\n`,
  });
}

export interface BaseFixture {
  readonly dir: string;
  /** One blob oid per pack, in pack-build order. */
  readonly packedOids: readonly [string, string, string];
  readonly looseOid: string;
}

/**
 * `BASE` — 3 packs, 9 packed objects, 1 unreferenced loose blob, one blob per
 * pack, flat midx. Each commit lands in its own pack via `repack -adq` for
 * the first, then `.keep`-guarded `repack -dq` for the rest.
 */
export async function buildBaseFixture(baseDir: string, slug: string): Promise<BaseFixture> {
  const dir = await freshRepo(baseDir, slug);
  const oid1 = await commitFile(dir, 'a.txt', 'alpha\n');
  git(dir, 'repack', '-adq');
  const oid2 = await commitFile(dir, 'b.txt', 'bravo\n');
  repackIntoNewPack(dir);
  const oid3 = await commitFile(dir, 'c.txt', 'charlie\n');
  repackIntoNewPack(dir);
  writeMultiPackIndex(dir);
  const looseOid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
    input: 'unreferenced loose blob\n',
  }).trim();
  await removeRevFiles(dir);

  return { dir, packedOids: [oid1, oid2, oid3], looseOid };
}

export interface DupFixture {
  readonly dir: string;
  /** The blob present in both packs. */
  readonly dupOid: string;
  /** The pack the flat midx actually assigns the duplicate to. */
  readonly assignedPack: string;
  /** The sibling pack the midx did NOT assign the duplicate to. */
  readonly otherPack: string;
  /** An unreferenced loose blob — the §D4.5 cross-tool proof every Tier-A row needs. */
  readonly looseOid: string;
}

/**
 * `DUP` — 2 packs, one blob (`dup.txt`'s content) independently present in
 * both — the first pack via an ordinary `repack`, the second via
 * `duplicateOidIntoNewPack`. The midx's actual assignment for the marker
 * blob is read back afterward (never assumed), because canonical git's
 * duplicate tie-break order is not itself pinned here.
 */
export async function buildDupFixture(baseDir: string, slug: string): Promise<DupFixture> {
  const dir = await freshRepo(baseDir, slug);
  const dupOid = await commitFile(dir, 'dup.txt', 'duplicate content\n');
  git(dir, 'repack', '-adq');
  duplicateOidIntoNewPack(dir, dupOid);
  writeMultiPackIndex(dir);
  const looseOid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
    input: 'unreferenced loose blob\n',
  }).trim();
  await removeRevFiles(dir);

  const flatBytes = await readFile(midxPaths(dir).flat);
  const assignedPack = assignedPackName(flatBytes, dupOid);
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const otherIdx = (await readdir(packDir)).find(
    (entry) => entry.endsWith('.idx') && entry.slice(0, -'.idx'.length) !== assignedPack,
  );
  if (otherIdx === undefined) {
    throw new Error('buildDupFixture: could not identify the non-assigned pack');
  }

  return { dir, dupOid, assignedPack, otherPack: otherIdx.slice(0, -'.idx'.length), looseOid };
}

export interface ChainFixture {
  readonly dir: string;
  readonly dupOid: string;
  readonly assignedPack: string;
  readonly otherPack: string;
  /** Base-first layer digests, as recorded in the chain manifest. */
  readonly layerDigests: readonly [string, string];
  /** An unreferenced loose blob — the §D4.5 cross-tool proof every Tier-A row needs. */
  readonly looseOid: string;
}

/**
 * `CHAIN` — the `DUP` shape, written incrementally in two layers: layer 1
 * covers both `DUP` packs, layer 2 covers a third, unrelated pack appended
 * afterward.
 */
export async function buildChainFixture(baseDir: string, slug: string): Promise<ChainFixture> {
  const dir = await freshRepo(baseDir, slug);
  const dupOid = await commitFile(dir, 'dup.txt', 'duplicate content\n');
  git(dir, 'repack', '-adq');
  duplicateOidIntoNewPack(dir, dupOid);
  writeMidxChain(dir, 1);

  await commitFile(dir, 'third.txt', 'third pack content\n');
  repackIntoNewPack(dir);
  writeMidxChain(dir, 1);
  const looseOid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
    input: 'unreferenced loose blob\n',
  }).trim();
  await removeRevFiles(dir);

  const digests = readChainDigests(dir);
  if (digests.length !== 2) {
    throw new Error(`buildChainFixture: expected a 2-layer chain, got ${digests.length}`);
  }
  const [layer1Digest, layer2Digest] = digests as [string, string];

  const layer1Bytes = await readFile(chainLayerPath(dir, layer1Digest));
  const assignedPack = assignedPackName(layer1Bytes, dupOid);
  const layer1Parsed = parseMultiPackIndex(layer1Bytes, DIGEST_LENGTH);
  const otherName = layer1Parsed.packNames.find(
    (name) => name.slice(0, -'.idx'.length) !== assignedPack,
  );
  if (otherName === undefined) {
    throw new Error('buildChainFixture: could not identify the non-assigned dup pack');
  }

  return {
    dir,
    dupOid,
    assignedPack,
    otherPack: otherName.slice(0, -'.idx'.length),
    layerDigests: [layer1Digest, layer2Digest],
    looseOid,
  };
}

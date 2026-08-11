/**
 * Shared byte-recipe + filesystem helpers for the `.rev`/`.bitmap` `fsck`
 * interop suite (`rev-bitmap-fsck-interop.test.ts`). Lifted out for the same
 * reason `midx-fixture-helpers.ts` is: a byte-level tweak made in the test
 * file and not here would silently stop matching the fixture a future
 * sibling suite (unit or interop) builds against.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped) — these
 * helpers write on-disk pack/rev-index/bitmap bytes and belong with their
 * integration peers, same rationale as `interop-helpers.ts`,
 * `pack-fixture-helpers.ts` and `midx-fixture-helpers.ts`.
 *
 * SHA-1 hard-coded at `DIGEST_LENGTH = 20` — every fixture here is a plain
 * `--object-format=sha1` repository (Pin G's SHA-256 twin is out of this
 * part's scope), so every trailer restamped here is re-hashed with SHA-1
 * regardless of what a row's own mutation claims a `hashId` byte says.
 */
import { createHash } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { disableAutoMaintenance, git } from './interop-helpers.js';

export const DIGEST_LENGTH = 20;

function sha1(bytes: Uint8Array): Buffer {
  return createHash('sha1').update(bytes).digest();
}

function packDirOf(dir: string): string {
  return path.join(dir, '.git', 'objects', 'pack');
}

// ---------------------------------------------------------------------------
// Restamping — recompute a trailer over `[0, len - DIGEST_LENGTH)`. The SAME
// rule for both artefacts (Pin H's `.rev` trailer and Pin J's `.bitmap`
// trailer are both "digest of everything before the last 20 bytes"), kept as
// two named exports so a row reads as "restamp THIS kind of file" rather than
// a generic byte operation.
// ---------------------------------------------------------------------------

function restampTrailer(bytes: Buffer): Buffer {
  if (bytes.length <= DIGEST_LENGTH) return bytes;
  const trailerStart = bytes.length - DIGEST_LENGTH;
  sha1(bytes.subarray(0, trailerStart)).copy(bytes, trailerStart);
  return bytes;
}

/**
 * Recomputes a `.rev` file's own trailing digest — the control every
 * RESTAMPED mutation row composes to isolate a structural fault from a
 * checksum failure (Pin H). Without this, every mutation row would read as
 * "checksum failure" and the matrix would be uninterpretable.
 */
export function restampRevIndex(bytes: Buffer): Buffer {
  return restampTrailer(bytes);
}

/** Same rule, for a `.bitmap` (pack or midx) — its own fsck obligation IS
 *  this one comparison (Pin J rule 1), so restamping after a structural
 *  mutation reproduces the exact "clean" verdict git gives it. */
export function restampBitmap(bytes: Buffer): Buffer {
  return restampTrailer(bytes);
}

// ---------------------------------------------------------------------------
// Mutation — pack files land mode `0444`; every mutation chmods its target
// writable FIRST, and throws on a failed write rather than returning
// silently. A mutation that silently no-ops makes the whole row read as a
// false exit 0 — this exact mistake produced a bogus matrix earlier in this
// project and only a re-probe caught it.
//
// Deliberately does NOT restamp on the caller's behalf (unlike
// `mutateMidxOrThrow`, which always does): roughly half of this suite's rows
// want the trailer left broken on purpose. Restamping is the CALLER's
// choice, composed inside `op` via `restampRevIndex`/`restampBitmap`.
// ---------------------------------------------------------------------------

export type ByteMutation = (bytes: Buffer) => Buffer;

export function mutateOrThrow(filePath: string, op: ByteMutation): void {
  chmodSync(filePath, 0o644);
  const before = readFileSync(filePath);
  const mutated = op(Buffer.from(before));
  writeFileSync(filePath, mutated);
  const after = readFileSync(filePath);
  if (after.length !== mutated.length || !after.equals(mutated)) {
    throw new Error(`mutateOrThrow: write to ${filePath} did not land as written`);
  }
}

// ---------------------------------------------------------------------------
// Artefact-path helpers
// ---------------------------------------------------------------------------

export interface PackArtefactPaths {
  readonly pack: string;
  readonly idx: string;
  readonly rev: string;
  readonly bitmap: string;
}

/** Paths for an explicitly-named pack — used by the multi-pack fixtures,
 *  where "the sole pack" is ambiguous. */
export function packArtefactPathsNamed(dir: string, name: string): PackArtefactPaths {
  const packDir = packDirOf(dir);
  return {
    pack: path.join(packDir, `${name}.pack`),
    idx: path.join(packDir, `${name}.idx`),
    rev: path.join(packDir, `${name}.rev`),
    bitmap: path.join(packDir, `${name}.bitmap`),
  };
}

/** Paths for the fixture's SOLE pack — throws if the pack directory does not
 *  hold exactly one `.idx`. */
export function packArtefactPaths(dir: string): PackArtefactPaths {
  const packDir = packDirOf(dir);
  const idxNames = readdirSync(packDir).filter((name) => name.endsWith('.idx'));
  const [soleIdxName] = idxNames;
  if (soleIdxName === undefined || idxNames.length !== 1) {
    throw new Error(
      `packArtefactPaths: expected exactly one .idx under ${packDir}, found ${idxNames.length}`,
    );
  }
  return packArtefactPathsNamed(dir, soleIdxName.slice(0, -'.idx'.length));
}

function packNamesOf(dir: string): string[] {
  return readdirSync(packDirOf(dir))
    .filter((name) => name.endsWith('.pack'))
    .map((name) => name.slice(0, -'.pack'.length));
}

// ---------------------------------------------------------------------------
// Fixture recipes
// ---------------------------------------------------------------------------

async function freshRepo(baseDir: string, slug: string): Promise<string> {
  const dir = path.join(baseDir, slug);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  disableAutoMaintenance(dir);
  return dir;
}

async function commitFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
  message: string,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
}

/** Guards every existing `.pack` with a `.keep` so the next `repack -dq`
 *  leaves it (and its `.rev`/`.bitmap` siblings) alone and routes only the
 *  newly-committed object(s) into a fresh pack — the same trick
 *  `midx-fixture-helpers.ts`'s `repackIntoNewPack` uses. */
function keepExistingPacks(dir: string): void {
  const packDir = packDirOf(dir);
  for (const name of packNamesOf(dir)) {
    writeFileSync(path.join(packDir, `${name}.keep`), '');
  }
}

// Commit 1 puts two files at the root (root tree v1, 2 blobs). Commit 2 adds
// five files under a new subdirectory, changing the root tree (v2, since git
// never rewrites a tree in place) and adding one new subtree — 3 trees total
// (root v1, root v2, sub), 7 blobs, 2 commits: 12 objects, matching the
// design's own fixture shape (Pin B/C).
const ROOT_FILES = { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' } as const;
const SUB_FILES = {
  'sub/c.txt': 'charlie\n',
  'sub/d.txt': 'delta\n',
  'sub/e.txt': 'echo\n',
  'sub/f.txt': 'foxtrot\n',
  'sub/g.txt': 'golf\n',
} as const;

export interface BaseFixture {
  readonly dir: string;
}

/** BASE — 2 commits / 3 trees / 7 blobs = 12 objects in one pack, via
 *  `git repack -adq` (which writes `.rev` by default — Pin A). */
export async function buildBaseFixture(baseDir: string, slug: string): Promise<BaseFixture> {
  const dir = await freshRepo(baseDir, slug);
  await commitFiles(dir, ROOT_FILES, 'root files');
  await commitFiles(dir, SUB_FILES, 'subdirectory files');
  git(dir, 'repack', '-adq');
  return { dir };
}

/** Same shape as `buildBaseFixture`, plus `--write-bitmap-index` — one pack
 *  carrying its own `.idx`, `.pack`, `.rev` AND `.bitmap`. */
export async function buildBitmapFixture(baseDir: string, slug: string): Promise<BaseFixture> {
  const dir = await freshRepo(baseDir, slug);
  await commitFiles(dir, ROOT_FILES, 'root files');
  await commitFiles(dir, SUB_FILES, 'subdirectory files');
  git(dir, 'repack', '-adq', '--write-bitmap-index');
  return { dir };
}

export interface TwoPackFixture {
  readonly dir: string;
  readonly packNames: readonly [string, string];
}

/** Two packs, neither midx nor bitmap: commit 1 repacked alone, commit 2
 *  routed into a second pack via the `.keep` guard. Used by the rows that
 *  need multi-pack composition without a multi-pack-index in the picture. */
export async function buildTwoPackFixture(baseDir: string, slug: string): Promise<TwoPackFixture> {
  const dir = await freshRepo(baseDir, slug);
  await commitFiles(dir, ROOT_FILES, 'root files');
  git(dir, 'repack', '-adq');
  keepExistingPacks(dir);
  await commitFiles(dir, SUB_FILES, 'subdirectory files');
  git(dir, 'repack', '-dq');
  const [first, second] = packNamesOf(dir);
  if (first === undefined || second === undefined) {
    throw new Error('buildTwoPackFixture: expected exactly two packs');
  }
  return { dir, packNames: [first, second] };
}

export interface MidxBitmapFixture {
  readonly dir: string;
  readonly flatMidxPath: string;
  readonly midxBitmapPath: string;
  /** The pack that carries its own on-disk `.bitmap` (built via
   *  `--write-bitmap-index` before the midx write — the "pack bitmap" Pin K's
   *  X8 targets, distinct from the midx bitmap X0/X1/X2/X4/X5/X7/X10 target). */
  readonly bitmapPackName: string;
  /** The sibling pack with no bitmap of its own. */
  readonly plainPackName: string;
}

function midxBitmapNameFromBytes(bytes: Uint8Array): string {
  const trailer = bytes.subarray(bytes.length - DIGEST_LENGTH);
  return `multi-pack-index-${Buffer.from(trailer).toString('hex')}.bitmap`;
}

/**
 * Two packs (pack bitmap on the first, via `repack --write-bitmap-index`;
 * the second added afterward and `.keep`-guarded out of that repack) plus a
 * flat multi-pack-index with its own bitmap, via
 * `git multi-pack-index write --bitmap` — the shape Pin K's X0 control
 * names: "midx + midx bitmap + pack bitmap".
 */
export async function buildMidxBitmapFixture(
  baseDir: string,
  slug: string,
): Promise<MidxBitmapFixture> {
  const dir = await freshRepo(baseDir, slug);
  await commitFiles(dir, ROOT_FILES, 'root files');
  git(dir, 'repack', '-adq', '--write-bitmap-index');
  const [bitmapPackName] = packNamesOf(dir);
  if (bitmapPackName === undefined) {
    throw new Error('buildMidxBitmapFixture: no pack after the first repack');
  }
  keepExistingPacks(dir);
  await commitFiles(dir, SUB_FILES, 'subdirectory files');
  git(dir, 'repack', '-dq');
  git(dir, 'multi-pack-index', 'write', '--bitmap');

  const plainPackName = packNamesOf(dir).find((name) => name !== bitmapPackName);
  if (plainPackName === undefined) {
    throw new Error('buildMidxBitmapFixture: could not identify the second pack');
  }
  const packDir = packDirOf(dir);
  const flatMidxPath = path.join(packDir, 'multi-pack-index');
  const midxBitmapPath = path.join(packDir, midxBitmapNameFromBytes(readFileSync(flatMidxPath)));
  return { dir, flatMidxPath, midxBitmapPath, bitmapPackName, plainPackName };
}

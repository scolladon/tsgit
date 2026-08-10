/**
 * Fixture recipes for the walk-closure interop suite
 * (`rev-bitmap-closure-interop.test.ts`) and, per its own header, the
 * bitmap-closure suite that extends it later. Each fixture is built once
 * per test file in a shared `beforeAll`, so the recipes live here rather
 * than inline — matching `rev-bitmap-fixture-helpers.ts`'s own rationale.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped) — these
 * helpers spawn `git` and write on-disk repositories, and belong with their
 * integration peers.
 *
 * **The load-bearing property.** Every fixture used for a have-bearing query
 * (`--not`) repeats blob content across the have boundary: some file's
 * content at one point in history is byte-identical to that same file's
 * content at another point, straddling wherever a `not` boundary lands. On a
 * fixture where content never repeats, the walk tier's own over-report
 * (§ the closure engine's own module doc) is never exercised — the walk and
 * the exact set difference coincide, and a superset assertion degenerates
 * into an equality that would pass for the wrong reason.
 *
 * F2 is built via `git fast-import` — 400 real commits over individual
 * `git commit` invocations is too slow for a test suite. The stream is
 * written to a throwaway file OUTSIDE the fixture repository and piped into
 * `git fast-import` from a file descriptor, with every author/committer
 * timestamp fixed in the stream itself, so the fixture (and every oid it
 * produces) is reproducible from one run to the next.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { git, runGitEnv } from './interop-helpers.js';
import {
  DIGEST_LENGTH,
  mutateOrThrow,
  type PackArtefactPaths,
  packArtefactPaths,
  restampBitmap,
} from './rev-bitmap-fixture-helpers.js';

const AUTHOR = 'Ada <ada@example.com>';
const BASE_TIMESTAMP = 1_700_000_000;

// F2 — the 400-commit fixture. Each commit writes ONE never-before-used file
// under `unique/` (so the boundary walk's "reachable only after the
// boundary" side has real, exclusive content) AND rewrites the root-level
// `shared.txt` to one of `F2_SHARED_VARIANTS` recurring contents (so some of
// those values straddle any `--not` boundary — the property above).
const F2_COMMITS = 400;
const F2_SHARED_VARIANTS = 5;

// F5 — the same shape, flattened (no `unique/` subdirectory) and smaller, so
// its ~367-object closure is small enough to reason about by hand.
const F5_COMMITS = 120;
const F5_SHARED_VARIANTS = 7;

// F4 — the merge fixture. `main` and `topic` each touch only their OWN file
// (`a.txt` / `b.txt`) after diverging at `root`, so the merge is a clean
// auto-merge and `root` — reachable from both sides — is the shared-content
// boundary case a linear fixture can never exercise (§ `--not topic`'s own
// row: excluding `topic` must also exclude `root`, even though `root` is
// ALSO an ancestor of `main`).
const F4_MAIN_COMMITS = 59;
const F4_TOPIC_COMMITS = 15;

function sharedVariant(index: number, variantCount: number): string {
  return `shared-variant-${index % variantCount}\n`;
}

async function freshRepo(baseDir: string, slug: string): Promise<string> {
  const dir = path.join(baseDir, slug);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * Writes `streamContent` to a throwaway file OUTSIDE `dir`, pipes it into
 * `git fast-import` from a file descriptor (never buffered through the
 * child's `input` option — a real pipe, matching the recipe the design
 * calls for), then deletes the throwaway file regardless of outcome.
 */
async function runFastImport(dir: string, streamContent: string): Promise<void> {
  const streamPath = path.join(
    os.tmpdir(),
    `tsgit-closure-fixture-${path.basename(dir)}-${process.pid}.fi`,
  );
  await writeFile(streamPath, streamContent);
  try {
    const fd = openSync(streamPath, 'r');
    try {
      const result = spawnSync('git', ['-C', dir, 'fast-import', '--quiet'], {
        env: runGitEnv(),
        stdio: [fd, 'ignore', 'inherit'],
      });
      if (result.status !== 0) {
        throw new Error(`git fast-import exited with status ${String(result.status)}`);
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    await rm(streamPath, { force: true });
  }
}

interface StreamCommitSpec {
  readonly timestamp: number;
  readonly message: string;
  readonly changes: string;
}

function blobRecord(mark: number, content: string): string {
  return `blob\nmark :${mark}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
}

function commitRecord(spec: StreamCommitSpec): string {
  let record = 'commit refs/heads/main\n';
  record += `author ${AUTHOR} ${spec.timestamp} +0000\n`;
  record += `committer ${AUTHOR} ${spec.timestamp} +0000\n`;
  record += `data ${Buffer.byteLength(spec.message)}\n${spec.message}`;
  record += spec.changes;
  return record;
}

/**
 * F2's own stream: 400 commits, each pairing one never-reused blob (under
 * `unique/`, mark `2i+1`) with one of `F2_SHARED_VARIANTS` recurring
 * `shared.txt` contents (mark `2i+2`), followed by an annotated tag on the
 * final commit — F2's one branch, one tag shape.
 */
function buildF2Stream(): string {
  let stream = '';
  for (let i = 0; i < F2_COMMITS; i += 1) {
    const uniqueMark = i * 2 + 1;
    const sharedMark = i * 2 + 2;
    stream += blobRecord(uniqueMark, `unique-${i}\n`);
    stream += blobRecord(sharedMark, sharedVariant(i, F2_SHARED_VARIANTS));
    stream += commitRecord({
      timestamp: BASE_TIMESTAMP + i,
      message: `commit ${i}\n`,
      changes: `M 100644 :${uniqueMark} unique/u${i}.txt\nM 100644 :${sharedMark} shared.txt\n`,
    });
  }
  const tagMessage = 'release v1\n';
  stream += 'tag v1\n';
  stream += 'from refs/heads/main\n';
  stream += `tagger ${AUTHOR} ${BASE_TIMESTAMP + F2_COMMITS} +0000\n`;
  stream += `data ${Buffer.byteLength(tagMessage)}\n${tagMessage}`;
  return stream;
}

/** F5's own stream: the same recurring-content shape as F2, flattened (no
 *  subdirectory) and with a wider variant cycle, over fewer commits. */
function buildF5Stream(): string {
  let stream = '';
  for (let i = 0; i < F5_COMMITS; i += 1) {
    const uniqueMark = i * 2 + 1;
    const sharedMark = i * 2 + 2;
    stream += blobRecord(uniqueMark, `unique-${i}\n`);
    stream += blobRecord(sharedMark, sharedVariant(i, F5_SHARED_VARIANTS));
    stream += commitRecord({
      timestamp: BASE_TIMESTAMP + i,
      message: `commit ${i}\n`,
      changes: `M 100644 :${uniqueMark} u${i}.txt\nM 100644 :${sharedMark} shared.txt\n`,
    });
  }
  return stream;
}

export interface ClosureFixture {
  readonly dir: string;
}

/** F2 — 400 commits / one annotated tag, `git repack -adq
 *  --write-bitmap-index`. See the module doc for the recurring-content
 *  property this fixture exists to carry. */
export async function buildF2ClosureFixture(
  baseDir: string,
  slug: string,
): Promise<ClosureFixture> {
  const dir = await freshRepo(baseDir, slug);
  await runFastImport(dir, buildF2Stream());
  git(dir, 'checkout', '-f', 'main');
  git(dir, 'repack', '-adq', '--write-bitmap-index');
  return { dir };
}

/** F5 — 120 commits, flattened, `git repack -adq --write-bitmap-index`. */
export async function buildF5ClosureFixture(
  baseDir: string,
  slug: string,
): Promise<ClosureFixture> {
  const dir = await freshRepo(baseDir, slug);
  await runFastImport(dir, buildF5Stream());
  git(dir, 'checkout', '-f', 'main');
  git(dir, 'repack', '-adq', '--write-bitmap-index');
  return { dir };
}

/**
 * Appends ONE plain (non-fast-import) commit on top of an already-repacked
 * F2 fixture, rewriting `shared.txt` to a content never used by any of the
 * 400 recurring variants. Left loose (no repack after), for the loose-object
 * row: exactly 3 new objects (the commit, the changed root tree, and the one
 * new blob) — `unique/`'s own subtree is untouched, since this commit never
 * touches it.
 */
export async function addLooseCommitAboveF2(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'shared.txt'), 'shared-final\n');
  git(dir, 'add', 'shared.txt');
  git(dir, 'commit', '-q', '-m', 'loose commit above F2');
}

/**
 * F4 — 76 commits including one real merge: `root` seeds `a.txt`/`b.txt`,
 * `main` (`F4_MAIN_COMMITS` commits) rewrites only `a.txt`, `topic`
 * (`F4_TOPIC_COMMITS` commits, forked from `root`) rewrites only `b.txt`,
 * then `topic` merges into `main`. `git repack -adq --write-bitmap-index`.
 * Plain `git commit` throughout — 76 commits is fast enough without
 * `fast-import`, and the merge itself needs a real working tree.
 */
export async function buildF4ClosureFixture(
  baseDir: string,
  slug: string,
): Promise<ClosureFixture> {
  const dir = await freshRepo(baseDir, slug);

  await writeFile(path.join(dir, 'a.txt'), 'a0\n');
  await writeFile(path.join(dir, 'b.txt'), 'b0\n');
  git(dir, 'add', 'a.txt', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'root');
  git(dir, 'branch', 'topic');

  for (let i = 1; i <= F4_MAIN_COMMITS; i += 1) {
    await writeFile(path.join(dir, 'a.txt'), `a${i}\n`);
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', `main ${i}`);
  }

  git(dir, 'checkout', '-q', 'topic');
  for (let j = 1; j <= F4_TOPIC_COMMITS; j += 1) {
    await writeFile(path.join(dir, 'b.txt'), `b${j}\n`);
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', `topic ${j}`);
  }

  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', 'topic', '-m', 'merge topic');

  git(dir, 'repack', '-adq', '--write-bitmap-index');
  return { dir };
}

// ---------------------------------------------------------------------------
// F3 — F2 plus 5 more commits repacked incrementally into a second pack,
// then `git multi-pack-index write --bitmap`: 2 packs, 1 pack bitmap (the
// FIRST pack's, written before the extra commits existed), 1 midx bitmap
// (covering both packs) — the artefact-preference and completeness
// fixture.
// ---------------------------------------------------------------------------

const F3_EXTRA_COMMITS = 5;

function packDirOf(dir: string): string {
  return path.join(dir, '.git', 'objects', 'pack');
}

function packNamesOf(dir: string): string[] {
  return readdirSync(packDirOf(dir))
    .filter((name) => name.endsWith('.pack'))
    .map((name) => name.slice(0, -'.pack'.length));
}

/** Derives a flat multi-pack-index's own bitmap filename from its trailer —
 *  git names it `multi-pack-index-<hex of the midx's own checksum>.bitmap`,
 *  the same rule `rev-bitmap-fixture-helpers.ts`'s `buildMidxBitmapFixture`
 *  uses internally, duplicated here (not imported) since it is private
 *  there — each fixture-helpers file owns its own copy of this shape, same
 *  as `packDirOf`/`packNamesOf` above. */
function midxBitmapNameFromBytes(bytes: Uint8Array): string {
  const trailer = bytes.subarray(bytes.length - DIGEST_LENGTH);
  return `multi-pack-index-${Buffer.from(trailer).toString('hex')}.bitmap`;
}

export interface F3ClosureFixture extends ClosureFixture {
  /** The FIRST pack's own name — carries the pack bitmap written BEFORE the
   *  5 extra commits existed, so it indexes only F2's 1606 objects. */
  readonly bitmapPackName: string;
  /** The SECOND pack's own name — the 5 extra commits' 15 objects, `.keep`-
   *  guarded out of the first repack and never given a bitmap of its own. */
  readonly plainPackName: string;
  readonly flatMidxPath: string;
  readonly midxBitmapPath: string;
}

/**
 * F3 — F2 (400 commits, repacked with `--write-bitmap-index`) plus 5 more
 * plain commits, each rewriting ONE never-reused root file (commit + a new
 * root tree + one new blob — 3 new objects apiece, 15 total), `.keep`-guarded
 * into a SECOND pack via an incremental `git repack -dq`, then
 * `git multi-pack-index write --bitmap`. The `.keep` guard on the FIRST
 * pack is what keeps it — and its own bitmap — untouched by the incremental
 * repack: without it, `-dq` would fold both packs back into one and the
 * completeness rows this fixture exists for would prove nothing (the second
 * pack would never end up "genuinely uncovered by the first bitmap").
 */
export async function buildF3ClosureFixture(
  baseDir: string,
  slug: string,
): Promise<F3ClosureFixture> {
  const dir = await freshRepo(baseDir, slug);
  await runFastImport(dir, buildF2Stream());
  git(dir, 'checkout', '-f', 'main');
  git(dir, 'repack', '-adq', '--write-bitmap-index');
  const [bitmapPackName] = packNamesOf(dir);
  if (bitmapPackName === undefined) {
    throw new Error('buildF3ClosureFixture: no pack after the first repack');
  }
  const packDir = packDirOf(dir);
  for (const name of packNamesOf(dir)) {
    writeFileSync(path.join(packDir, `${name}.keep`), '');
  }

  for (let i = 0; i < F3_EXTRA_COMMITS; i += 1) {
    await writeFile(path.join(dir, `f3-extra-${i}.txt`), `f3-extra-${i}\n`);
    git(dir, 'add', `f3-extra-${i}.txt`);
    git(dir, 'commit', '-q', '-m', `f3 extra ${i}`);
  }
  git(dir, 'repack', '-dq');
  git(dir, 'multi-pack-index', 'write', '--bitmap');

  const plainPackName = packNamesOf(dir).find((name) => name !== bitmapPackName);
  if (plainPackName === undefined) {
    throw new Error('buildF3ClosureFixture: could not identify the second pack');
  }
  const flatMidxPath = path.join(packDir, 'multi-pack-index');
  const midxBitmapPath = path.join(packDir, midxBitmapNameFromBytes(readFileSync(flatMidxPath)));
  return { dir, bitmapPackName, plainPackName, flatMidxPath, midxBitmapPath };
}

/**
 * Clears a bitmap's option-flags word (offset 6, 2 bytes) and restamps.
 * Canonical git REQUIRES `BITMAP_OPT_FULL_DAG` — the same requirement
 * tsgit's own `parsePackBitmap` enforces by refusing the artefact — and
 * ABORTS with a `BUG:` assertion (exit 134) the instant it LOADS a bitmap
 * missing that flag. Two bitmaps can be present at once (a pack's own and a
 * midx's own); git aborts if and only if the ONE THIS FUNCTION MUTATED is
 * the one it opened — the only clean way, from outside the process, to
 * prove WHICH artefact git chose. The artefact-preference rows depend on it.
 */
export function clearFullDagFlagAndRestamp(bytes: Buffer): Buffer {
  bytes.writeUInt16BE(0, 6);
  return restampBitmap(bytes);
}

// ---------------------------------------------------------------------------
// F6 — the range-validation family's own fixture: 40 commits / 120 objects,
// one pack with a bitmap whose first per-commit entry header is rewritten
// to an out-of-range position and whose trailer is then restamped: the
// checksum is VALID (unlike every other degradation fixture, whose
// restamped mutation is structural) and the fault is a VALUE — the
// range-validation family's own difficulty.
// ---------------------------------------------------------------------------

const F6_COMMITS = 40;
const F6_OUT_OF_RANGE_POSITION = 999_999;

/**
 * One EWAH stream descriptor's own byte length: `bitSize`(4) + `wordCount`(4)
 * + `wordCount` 64-bit words (8 bytes apiece) + the trailing `rlwPosition`
 * word(4). Mirrors `domain/storage/ewah.ts`'s own layout, recomputed here
 * from raw bytes so the entry-header offset below is COMPUTED, never
 * hard-coded against this fixture's own byte count.
 */
function ewahStreamByteLength(bytes: Buffer, at: number): number {
  const wordCount = bytes.readUInt32BE(at + 4);
  return 4 + 4 + 8 * wordCount + 4;
}

/**
 * Walks past the 12-byte header, the embedded `DIGEST_LENGTH`-byte checksum,
 * and the four type streams (commits, trees, blobs, tags, in that order) to
 * the first per-commit entry header's own byte offset — `domain/storage/
 * bitmap.ts`'s `entriesOffset`, reconstructed here from the bytes themselves
 * rather than a fixture-specific constant, since the streams' own declared
 * word counts (and so this offset) depend on exactly which objects this
 * fixture's 40 commits touch.
 */
function firstEntryHeaderOffset(bytes: Buffer): number {
  let at = 12 + DIGEST_LENGTH;
  for (let stream = 0; stream < 4; stream += 1) {
    at += ewahStreamByteLength(bytes, at);
  }
  return at;
}

export interface F6ClosureFixture extends ClosureFixture {
  readonly bitmap: PackArtefactPaths;
  /** The COMPUTED byte offset the mutation below rewrote — surfaced so a row
   *  can assert it is positive rather than trusting the mutation blindly. */
  readonly entryHeaderOffset: number;
}

/**
 * F6 — 40 commits, one file rewritten each time (commit + a new root tree +
 * one new blob, 3 new objects per commit — 120 total), one pack with
 * `--write-bitmap-index`. The first per-commit entry header's `position`
 * field is rewritten to `999999` (a position 120 objects can never reach),
 * THEN the trailer is restamped — a two-step mutation through
 * `mutateOrThrow`, because a silently no-op write on a `0444` file would
 * make every row in the family read as a false pass. Restamping alone, with
 * no position rewrite, is the earlier `.rev`/`.bitmap` interop suite's own
 * control (`bitmap-restamp-control` in `rev-bitmap-fsck-interop.test.ts`) —
 * without it present, this family proves nothing (the module doc above
 * states why).
 */
export async function buildF6ClosureFixture(
  baseDir: string,
  slug: string,
): Promise<F6ClosureFixture> {
  const dir = await freshRepo(baseDir, slug);
  for (let i = 0; i < F6_COMMITS; i += 1) {
    await writeFile(path.join(dir, 'f6.txt'), `f6-${i}\n`);
    git(dir, 'add', 'f6.txt');
    git(dir, 'commit', '-q', '-m', `f6 commit ${i}`);
  }
  git(dir, 'repack', '-adq', '--write-bitmap-index');

  const bitmap = packArtefactPaths(dir);
  let entryHeaderOffset = -1;
  mutateOrThrow(bitmap.bitmap, (bytes) => {
    entryHeaderOffset = firstEntryHeaderOffset(bytes);
    bytes.writeUInt32BE(F6_OUT_OF_RANGE_POSITION, entryHeaderOffset);
    return bytes;
  });
  mutateOrThrow(bitmap.bitmap, (bytes) => restampBitmap(bytes));

  return { dir, bitmap, entryHeaderOffset };
}

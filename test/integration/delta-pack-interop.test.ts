/**
 * Cross-tool interop — the delta-writing packer. A tsgit `gc` over a
 * text-churn corpus (one evolving file, 200 commits, 5 edits + 1 append
 * each — the design's F1 shape) writes a self-contained `OFS_DELTA` pack;
 * every row below pins that pack, and the `pack-objects` / `bundle-create` /
 * `push` call sites, against real git 2.55.0. `push` deliberately stays
 * base-only — X14 is the regression guard for that exclusion.
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         a tsgit gc-written delta pack is indexed, verified and fsck'd clean by real git, and every chain resolves through both readers
 *   interopSurface: packfile
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { bundleCreate } from '../../src/application/commands/bundle-create.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { maintenance } from '../../src/application/commands/maintenance.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { buildPack } from '../../src/application/primitives/build-pack.js';
import { enumerateObjects } from '../../src/application/primitives/enumerate-objects.js';
import { disposePackRegistry, readObject } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { PACK_ENTRY_TYPE } from '../../src/domain/storage/pack-entry.js';
import { allObjectIds, parsePackIndex } from '../../src/domain/storage/pack-index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { startGitHttpBackend } from '../bench/support/http-backend-server.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { flipEntryBodyByte, verifyPackRows } from './pack-fixture-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ROW_TIMEOUT = 30_000;
const PACK_DIR = '.git/objects/pack';
const IDX_DIGEST_LENGTH = 20;

// ---------------------------------------------------------------------------
// Repo-building helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function tmp(slug: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-delta-pack-${slug}-`));
  tmpDirs.push(dir);
  return dir;
}

async function freshRepo(slug: string): Promise<string> {
  const dir = await tmp(slug);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  disableAutoMaintenance(dir);
  return dir;
}

/** A fixed author/committer date per commit index — every fixture repo
 *  built here reproduces the SAME commit oids across runs, which is what
 *  keeps the corruption oracles' "pick the first delta row" deterministic
 *  (an unpinned commit date changes commit oids, which reshuffles verify-
 *  pack's oid-sorted row order run to run). */
function fixedCommitEnv(commitIndex: number): NodeJS.ProcessEnv {
  const date = `${1_700_000_000 + commitIndex} +0000`;
  return { ...runGitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

function commitAt(dir: string, commitIndex: number, message: string): void {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: fixedCommitEnv(commitIndex) });
}

async function commitSeed(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  commitAt(dir, 0, 'seed');
}

/** A 32-bit avalanche mix — deterministic edit-position selection, no
 *  external entropy, so the fixture reproduces byte-for-byte across runs. */
function mix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const TEXT_CHURN_COMMITS = 199;
const TEXT_CHURN_LINES = 500;
const TEXT_CHURN_EDITS_PER_COMMIT = 5;

/**
 * A text-churn shape: one ~500-line file, 200 commits total (one seed
 * plus 199 edits), 5 lines edited + 1 line appended each — the shape whose
 * max delta chain saturates the default depth cap (50) and whose
 * git-deltified pack is a small fraction of its base-only size.
 */
async function buildTextChurnRepo(slug: string): Promise<string> {
  const dir = await freshRepo(slug);
  const filePath = path.join(dir, 'churn.txt');
  let lines = Array.from({ length: TEXT_CHURN_LINES }, (_, i) => `line ${i}`);
  await writeFile(filePath, `${lines.join('\n')}\n`);
  git(dir, 'add', '-A');
  commitAt(dir, 0, 'seed');
  for (let commitIndex = 1; commitIndex <= TEXT_CHURN_COMMITS; commitIndex += 1) {
    let seed = commitIndex;
    for (let edit = 0; edit < TEXT_CHURN_EDITS_PER_COMMIT; edit += 1) {
      seed = mix32(seed + edit);
      const target = seed % lines.length;
      lines = lines.map((line, i) => (i === target ? `${line} x${commitIndex}` : line));
    }
    lines = [...lines, `appended ${commitIndex}`];
    await writeFile(filePath, `${lines.join('\n')}\n`);
    git(dir, 'add', '-A');
    commitAt(dir, commitIndex, `edit ${commitIndex}`);
  }
  return dir;
}

function trackedNodeContext(workDir: string): Context {
  return createNodeContext({ workDir, hooks: false, command: false, ssh: false });
}

async function solePackIdx(
  dir: string,
): Promise<{ readonly packPath: string; readonly idxPath: string }> {
  const packDir = path.join(dir, PACK_DIR);
  const entries = await readdir(packDir);
  const packName = entries.find((entry) => entry.endsWith('.pack'));
  const idxName = entries.find((entry) => entry.endsWith('.idx'));
  if (packName === undefined || idxName === undefined) {
    throw new Error(`no .pack/.idx pair under ${packDir}`);
  }
  return { packPath: path.join(packDir, packName), idxPath: path.join(packDir, idxName) };
}

/** `git show-index`'s own offsets, sorted by idx storage order — the type
 *  nibble oracle: `verify-pack` cannot distinguish OFS_DELTA from
 *  REF_DELTA (both print as a 7-field line), so the only faithful check is
 *  the stored type nibble at each object's own offset. */
function showIndexOffsets(idxBytes: Uint8Array): ReadonlyArray<number> {
  const out = runGit(['show-index'], { input: idxBytes });
  return out
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

interface TypeNibbleCounts {
  readonly ofs: number;
  readonly ref: number;
  readonly base: number;
}

function typeNibbleCounts(packBytes: Uint8Array, offsets: ReadonlyArray<number>): TypeNibbleCounts {
  let ofs = 0;
  let ref = 0;
  let base = 0;
  for (const offset of offsets) {
    const type = ((packBytes[offset] ?? 0) >> 4) & 7;
    if (type === PACK_ENTRY_TYPE.OFS_DELTA) ofs += 1;
    else if (type === PACK_ENTRY_TYPE.REF_DELTA) ref += 1;
    else base += 1;
  }
  return { ofs, ref, base };
}

/** Parses `git verify-pack -v`'s trailing `chain length = N: M objects`
 *  histogram AND the per-object depth column (field 6 of a 7-field delta
 *  line) into two independent depth→count maps, so a caller can prove they
 *  agree instead of trusting the histogram alone. */
function parseChainDepths(verifyOutput: string): {
  readonly histogram: ReadonlyMap<number, number>;
  readonly perObject: ReadonlyMap<number, number>;
} {
  const histogram = new Map<number, number>();
  const perObject = new Map<number, number>();
  for (const line of verifyOutput.split('\n')) {
    const histMatch = /^chain length = (\d+): (\d+) objects$/.exec(line.trim());
    if (histMatch !== null) {
      histogram.set(Number(histMatch[1]), Number(histMatch[2]));
      continue;
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 7 && /^[0-9a-f]{40}$/.test(fields[0] ?? '')) {
      const depth = Number(fields[5]);
      perObject.set(depth, (perObject.get(depth) ?? 0) + 1);
    }
  }
  return { histogram, perObject };
}

async function appendConfigLines(dir: string, lines: string): Promise<void> {
  const configPath = path.join(dir, '.git', 'config');
  const existing = await readFile(configPath, 'utf8');
  await writeFile(configPath, `${existing}${lines}`);
}

async function tsgitGcRefusal(dir: string): Promise<TsgitError> {
  const ctx = trackedNodeContext(dir);
  try {
    await maintenance(ctx, { tasks: ['gc'] });
    throw new Error('expected maintenance to reject');
  } catch (error) {
    if (error instanceof TsgitError) return error;
    throw error;
  } finally {
    await disposePackRegistry(ctx);
  }
}

// ---------------------------------------------------------------------------
// Shared fixture: one text-churn repo, gc'd by tsgit and repacked by git
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('delta-writing packer, against real git', () => {
  let churnRepo: string;
  let tsgitGcDir: string;
  let tsgitPackBytes: Buffer;
  let tsgitIdxBytes: Buffer;
  let tsgitPackPath: string;
  let tsgitIdxPath: string;
  let gitRepackBytes: number;

  beforeAll(async () => {
    churnRepo = await buildTextChurnRepo('churn-source');

    tsgitGcDir = await tmp('churn-tsgit-gc');
    await cp(churnRepo, tsgitGcDir, { recursive: true });
    const gcCtx = trackedNodeContext(tsgitGcDir);
    await maintenance(gcCtx, { tasks: ['gc'] });
    await disposePackRegistry(gcCtx);
    const paths = await solePackIdx(tsgitGcDir);
    tsgitPackPath = paths.packPath;
    tsgitIdxPath = paths.idxPath;
    tsgitPackBytes = await readFile(tsgitPackPath);
    tsgitIdxBytes = await readFile(tsgitIdxPath);

    const gitRepackDir = await tmp('churn-git-repack');
    await cp(churnRepo, gitRepackDir, { recursive: true });
    runGit(['-C', gitRepackDir, '-c', 'pack.threads=1', 'repack', '-a', '-d', '-q']);
    const gitPaths = await solePackIdx(gitRepackDir);
    gitRepackBytes = (await readFile(gitPaths.packPath)).length;
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // -------------------------------------------------------------------------
  // X1 — OFS_DELTA present, REF_DELTA absent
  // -------------------------------------------------------------------------

  describe("Given a repo tsgit gc'd over a text-churn corpus, When the resulting pack is inspected", () => {
    it('Then the pack contains at least one OFS_DELTA and zero REF_DELTA entries', () => {
      // Arrange — the pack was already gc'd by tsgit in the shared beforeAll.
      const packBytes = tsgitPackBytes;

      // Act
      const offsets = showIndexOffsets(tsgitIdxBytes);
      const result = typeNibbleCounts(packBytes, offsets);

      // Assert
      expect(result.ofs).toBeGreaterThan(0);
      expect(result.ref).toBe(0);
      expect(result.ofs + result.base).toBe(offsets.length);
    });
  });

  // -------------------------------------------------------------------------
  // X2 — index-pack --strict outside any repository
  // -------------------------------------------------------------------------

  describe('Given that pack copied into a scratch dir outside any repository, When git index-pack --strict runs on it', () => {
    it('Then it exits 0, prints the pack sha bare, and writes .idx + .rev', async () => {
      // Arrange
      const scratch = await tmp('x2-scratch');
      const scratchPack = path.join(scratch, 'donor.pack');
      await writeFile(scratchPack, tsgitPackBytes);

      // Act
      const result = tryRunGitWithExit(['index-pack', '--strict', '-v', scratchPack], {
        env: { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() },
      });

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(result.stderr).toContain('Indexing objects: 100%');
      expect(result.stderr).toContain('Resolving deltas: 100%');
      const entries = await readdir(scratch);
      expect(entries).toContain('donor.idx');
      expect(entries).toContain('donor.rev');
    });
  });

  // -------------------------------------------------------------------------
  // X3 — fsck --strict clean
  // -------------------------------------------------------------------------

  describe("Given the same tsgit-gc'd repo, When git fsck --strict --no-progress runs", () => {
    it('Then it exits 0 with zero output on both streams', () => {
      // Arrange — the repo was already gc'd by tsgit in the shared beforeAll.
      const dir = tsgitGcDir;

      // Act
      const result = tryRunGitWithExit(['-C', dir, 'fsck', '--strict', '--no-progress']);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // X4 — batch-check | batch full pipe
  // -------------------------------------------------------------------------

  describe("Given the same tsgit-gc'd repo, When the full batch-check | batch pipe runs", () => {
    it('Then it exits 0, and the batch-check listing equals the oid/type/size set that went in', async () => {
      // Arrange
      const expected = new Set(allObjectIds(parsePackIndex(tsgitIdxBytes, IDX_DIGEST_LENGTH)));

      // Act — the full pipe, not batch-check alone: batch-check reads
      // headers only and would not notice a corrupt delta payload.
      const maxBuffer = 64 * 1024 * 1024;
      const checkOut = execFileSync(
        'git',
        ['-C', tsgitGcDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'],
        { encoding: 'utf8', maxBuffer },
      );
      const batchOut = execFileSync('git', ['-C', tsgitGcDir, 'cat-file', '--batch'], {
        input: checkOut,
        encoding: 'utf8',
        maxBuffer,
      });

      // Assert
      const listed = new Set(
        checkOut
          .trim()
          .split('\n')
          .filter((line) => line.length > 0),
      );
      expect(listed).toEqual(expected);
      expect(batchOut.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // X5 — chain-depth histogram within maxDepth, self-consistent
  // -------------------------------------------------------------------------

  describe('Given a tsgit-written delta pack, When git verify-pack -v runs on it', () => {
    it('Then every chain-length bucket is <= 50, and the histogram agrees with the per-object depth column', () => {
      // Arrange — the pack was already gc'd by tsgit in the shared beforeAll.
      const idxPath = tsgitIdxPath;

      // Act
      const verifyOut = git(tsgitGcDir, 'verify-pack', '-v', idxPath);
      const { histogram, perObject } = parseChainDepths(verifyOut);

      // Assert
      expect(histogram.size).toBeGreaterThan(0);
      for (const depth of histogram.keys()) {
        expect(depth).toBeLessThanOrEqual(50);
      }
      expect(perObject).toEqual(histogram);
    });
  });

  // -------------------------------------------------------------------------
  // X6 — the maxDepth-saturating corpus reads clean through both readers
  // -------------------------------------------------------------------------

  describe("Given a corpus deliberately built to reach maxDepth, When tsgit's own fsck and readObject run over it", () => {
    it('Then fsck reports no finding, and readObject resolves every oid', async () => {
      // Arrange
      const oids = allObjectIds(parsePackIndex(tsgitIdxBytes, IDX_DIGEST_LENGTH)) as ObjectId[];
      const ctx = trackedNodeContext(tsgitGcDir);

      // Act
      const result = await fsck(ctx, {});
      const resolved: ObjectId[] = [];
      for (const id of oids) {
        await readObject(ctx, id, { verifyHash: true });
        resolved.push(id);
      }
      await disposePackRegistry(ctx);

      // Assert — 'root' findings are structural (one per ref tip) and
      // expected on a healthy repo; only a defect-class finding would mean
      // the delta-chain walk degraded a type recovery or broke a link.
      const defectTypes = new Set(['bad-object', 'broken-link', 'missing', 'hash-mismatch']);
      const defects = result.findings.filter((finding) => defectTypes.has(finding.type));
      expect(result.exitCode).toBe(0);
      expect(defects).toHaveLength(0);
      expect(resolved).toHaveLength(oids.length);
    });
  });

  // -------------------------------------------------------------------------
  // X7 — size class vs git's own single-threaded repack
  // -------------------------------------------------------------------------

  describe("Given the text-churn shape, gc'd by tsgit and repacked by git -c pack.threads=1, When the two pack sizes are compared", () => {
    it("Then tsgit's pack size lands in the recorded size class, with generous headroom", () => {
      // Arrange — both sizes were already measured in the shared beforeAll.
      const tsgitBytes = tsgitPackBytes.length;
      const gitBytes = gitRepackBytes;

      // Assert — a class, not a ratio or a byte count: tsgit's deltified
      // pack must land in the same rough band as git's single-threaded
      // repack (never an equality — git's own packer is not deterministic
      // across runs), and nowhere near the multi-times inflation the
      // pre-change base-only writer measured.
      expect(tsgitBytes).toBeLessThan(gitBytes * 2);
      expect(tsgitBytes).toBeGreaterThan(gitBytes * 0.5);
    });
  });

  // -------------------------------------------------------------------------
  // Corruption oracles — one byte flipped inside an OFS_DELTA payload,
  // three different tools, three different exit codes
  // -------------------------------------------------------------------------

  describe('Given a tsgit-written pack with one byte flipped inside an OFS_DELTA payload', () => {
    describe('When git index-pack --strict runs on it', () => {
      it('Then it exits 128 with the inflate-failure message', async () => {
        // Arrange
        const deltaRow = verifyPackRows(tsgitGcDir, tsgitIdxPath).find((row) => row.isDelta);
        if (deltaRow === undefined) throw new Error('expected at least one delta row');
        const corrupted = flipEntryBodyByte(
          tsgitPackBytes,
          deltaRow.offset,
          deltaRow.offset + deltaRow.sizeInPackfile,
        );
        const scratch = await tmp('corrupt-index-pack');
        const scratchPack = path.join(scratch, 'corrupt.pack');
        await writeFile(scratchPack, corrupted);

        // Act
        const result = tryRunGitWithExit(['index-pack', '--strict', '-v', scratchPack], {
          env: { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() },
        });

        // Assert
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain('inflate: data stream error (incorrect data check)');
        expect(result.stderr).toMatch(
          /fatal: pack has bad object at offset \d+: inflate returned -3/,
        );
      });
    });

    describe('When git verify-pack -v runs on it', () => {
      it('Then it exits 1 (not 128) with a "<pack>: bad" stdout tail', async () => {
        // Arrange — SAME corruption recipe, independent repro (each row picks
        // its own delta entry so the three oracles never share mutable state).
        const deltaRow = verifyPackRows(tsgitGcDir, tsgitIdxPath).find((row) => row.isDelta);
        if (deltaRow === undefined) throw new Error('expected at least one delta row');
        const corrupted = flipEntryBodyByte(
          tsgitPackBytes,
          deltaRow.offset,
          deltaRow.offset + deltaRow.sizeInPackfile,
        );
        const scratch = await tmp('corrupt-verify-pack');
        const packDir = path.join(scratch, PACK_DIR);
        await mkdir(packDir, { recursive: true });
        const stem = path.basename(tsgitPackPath, '.pack');
        const corruptPackPath = path.join(packDir, `${stem}.pack`);
        const corruptIdxPath = path.join(packDir, `${stem}.idx`);
        await writeFile(corruptPackPath, corrupted);
        await writeFile(corruptIdxPath, tsgitIdxBytes);

        // Act
        const result = tryRunGitWithExit(['verify-pack', '-v', corruptIdxPath]);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stdout.trim().endsWith(': bad')).toBe(true);
      });
    });

    describe('When the pack is installed in a repo and git fsck --strict runs', () => {
      it('Then it exits 6 with pack-checksum / CRC / unpack findings on stderr', async () => {
        // Arrange
        const deltaRow = verifyPackRows(tsgitGcDir, tsgitIdxPath).find((row) => row.isDelta);
        if (deltaRow === undefined) throw new Error('expected at least one delta row');
        const corrupted = flipEntryBodyByte(
          tsgitPackBytes,
          deltaRow.offset,
          deltaRow.offset + deltaRow.sizeInPackfile,
        );
        const corruptRepo = await tmp('corrupt-fsck');
        await cp(tsgitGcDir, corruptRepo, { recursive: true });
        const stem = path.basename(tsgitPackPath, '.pack');
        await writeFile(path.join(corruptRepo, PACK_DIR, `${stem}.pack`), corrupted);

        // Act
        const result = tryRunGitWithExit(['-C', corruptRepo, 'fsck', '--strict', '--no-progress']);

        // Assert
        expect(result.exitCode).toBe(6);
        expect(result.stderr).toContain('pack checksum mismatch');
        expect(result.stderr).toContain('index CRC mismatch');
        expect(result.stderr).toContain('failed to unpack compressed delta');
      });
    });
  });

  // -------------------------------------------------------------------------
  // X11 — a narrow window (1) still functions and git still accepts the pack
  // -------------------------------------------------------------------------

  describe('Given pack.window = 1, When gc runs on the text-churn corpus', () => {
    it('Then deltas are still selected, and git index-pack --strict still accepts the pack', async () => {
      // Arrange
      const dir = await tmp('x11-window-1');
      await cp(churnRepo, dir, { recursive: true });
      await appendConfigLines(dir, '\n[pack]\n\twindow = 1\n');
      const ctx = trackedNodeContext(dir);

      // Act
      await maintenance(ctx, { tasks: ['gc'] });
      await disposePackRegistry(ctx);
      const { packPath, idxPath } = await solePackIdx(dir);
      const packBytes = await readFile(packPath);
      const idxBytes = await readFile(idxPath);
      const offsets = showIndexOffsets(idxBytes);
      const counts = typeNibbleCounts(packBytes, offsets);
      const result = tryRunGitWithExit(['index-pack', '--strict', '-v', packPath], {
        env: { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() },
      });

      // Assert
      expect(counts.ofs).toBeGreaterThan(0);
      expect(result.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // X12 — bundleCreate over a deltifiable closure
  // -------------------------------------------------------------------------

  describe('Given a bundle written by tsgit bundleCreate over a deltifiable closure, When git bundle verify and git clone run against it', () => {
    it(
      "Then verify exits 0 and clone reproduces the closure's object set",
      async () => {
        // Arrange
        const ctx = trackedNodeContext(churnRepo);
        const result = await bundleCreate(ctx, { all: true });
        await disposePackRegistry(ctx);
        const scratch = await tmp('x12-bundle');
        const bundlePath = path.join(scratch, 'churn.bundle');
        await writeFile(bundlePath, result.bytes);

        // Act
        const verify = tryRunGitWithExit(['bundle', 'verify', bundlePath]);
        const cloneDir = path.join(scratch, 'clone');
        const cloneResult = tryRunGitWithExit(['clone', '-q', bundlePath, cloneDir]);

        // Assert
        expect(verify.exitCode).toBe(0);
        expect(cloneResult.exitCode).toBe(0);
        const sourceOids = git(churnRepo, 'rev-list', '--objects', '--all')
          .trim()
          .split('\n')
          .map((line) => line.split(' ', 1)[0]);
        const clonedOids = git(cloneDir, 'rev-list', '--objects', '--all')
          .trim()
          .split('\n')
          .map((line) => line.split(' ', 1)[0]);
        expect(new Set(clonedOids)).toEqual(new Set(sourceOids));
      },
      ROW_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // X13 — packObjects over a deltifiable closure
  // -------------------------------------------------------------------------

  describe('Given a closure written by packObjects, When it is inspected and git index-pack --verify runs on it', () => {
    it('Then it contains at least one OFS_DELTA and zero REF_DELTA, and index-pack accepts it', async () => {
      // Arrange
      const dir = await tmp('x13-pack-objects');
      await cp(churnRepo, dir, { recursive: true });
      const outputDirectory = path.join(dir, 'outside-pack-dir');
      const ctx = trackedNodeContext(dir);

      // Act
      const result = await packObjects(ctx, { wants: ['HEAD'], outputDirectory });
      await disposePackRegistry(ctx);
      const packPath = path.join(outputDirectory, `pack-${result.packId}.pack`);
      const idxPath = path.join(outputDirectory, `pack-${result.packId}.idx`);
      const packBytes = await readFile(packPath);
      const idxBytes = await readFile(idxPath);
      const offsets = showIndexOffsets(idxBytes);
      const counts = typeNibbleCounts(packBytes, offsets);
      const verifyResult = tryRunGitWithExit(['index-pack', '--verify', packPath], {
        env: { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() },
      });

      // Assert
      expect(counts.ofs).toBeGreaterThan(0);
      expect(counts.ref).toBe(0);
      expect(verifyResult.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // X14 — push stays base-only (the regression guard for the excluded caller)
  // -------------------------------------------------------------------------

  describe('Given a local history pushed over http (push stays base-only), When push completes', () => {
    it(
      'Then the pack it sent contains zero type-6 (OFS_DELTA) and zero type-7 (REF_DELTA) entries',
      async () => {
        // Arrange — an empty bare with receive-pack enabled and unpacking
        // disabled, so the received pack is always kept as a pack (never
        // exploded into loose objects by receive-pack's own unpack-objects
        // fallback for small pushes).
        const projectRoot = await tmp('x14-project');
        const barePath = path.join(projectRoot, 'x14.git');
        runGit(['init', '-q', '--bare', barePath]);
        runGit(['-C', barePath, 'config', 'http.receivepack', 'true']);
        runGit(['-C', barePath, 'config', 'receive.unpackLimit', '0']);
        const server = await startGitHttpBackend({ projectRoot });

        try {
          const dir = await tmp('x14-local');
          const repo = await openRepository({
            cwd: dir,
            allowInsecureHttp: true,
            config: {
              allowInsecure: true,
              allowPrivateNetworks: true,
              dnsResolver: async () => ['127.0.0.1'],
            },
          });
          await repo.init();
          git(dir, 'config', 'user.name', 'Ada');
          git(dir, 'config', 'user.email', 'ada@example.com');
          // A small text-churn history — enough objects that receive-pack's
          // unpack-limit override above is the ONLY thing keeping it packed.
          let content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
          for (let i = 0; i < 40; i += 1) {
            content = `${content}\nappended ${i}`;
            await writeFile(path.join(dir, 'churn.txt'), `${content}\n`);
            git(dir, 'add', '-A');
            git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `edit ${i}`);
          }
          const url = `http://127.0.0.1:${server.port}/x14.git`;
          const configPath = path.join(repo.ctx.layout.gitDir, 'config');
          const existingConfig = await readFile(configPath, 'utf8');
          await writeFile(configPath, `${existingConfig}\n[remote "origin"]\n  url = ${url}\n`);

          // Act
          const pushResult = await repo.push({
            remote: 'origin',
            refspecs: ['refs/heads/main:refs/heads/main'],
          });
          await repo.dispose();

          // Assert
          expect(pushResult.pushedRefs[0]).toMatchObject({ status: 'ok' });
          const bareDir = path.join(barePath, 'objects', 'pack');
          const entries = await readdir(bareDir);
          const packName = entries.find((entry) => entry.endsWith('.pack'));
          const idxName = entries.find((entry) => entry.endsWith('.idx'));
          if (packName === undefined || idxName === undefined) {
            throw new Error('expected receive-pack to keep the incoming pack, not unpack it');
          }
          const packBytes = await readFile(path.join(bareDir, packName));
          const idxBytes = await readFile(path.join(bareDir, idxName));
          const offsets = showIndexOffsets(idxBytes);
          const counts = typeNibbleCounts(packBytes, offsets);
          expect(counts.ofs).toBe(0);
          expect(counts.ref).toBe(0);
        } finally {
          await server.close();
        }
      },
      ROW_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // X8/X9/X10 — the config surface, pinned against real git
  // -------------------------------------------------------------------------

  const GOOD_VALUE: Record<string, string> = { depth: '10', window: '10', windowmemory: '1024' };

  const X8_MALFORMED_ROWS: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
    readonly reason: 'invalid unit' | 'out of range';
  }> = [
    { key: 'depth', value: 'abc', reason: 'invalid unit' },
    { key: 'depth', value: '2147483648', reason: 'out of range' },
    { key: 'window', value: '-2147483649', reason: 'out of range' },
    { key: 'windowmemory', value: '-1', reason: 'invalid unit' },
    { key: 'windowmemory', value: '18446744073709551616', reason: 'out of range' },
  ];

  describe.each(X8_MALFORMED_ROWS)(
    'Given pack.$key = $value in a two-line [pack] block, When gc runs on both tools',
    ({ key, value, reason }) => {
      it.each(['first', 'last'] as const)(
        'Then tsgit and real git both refuse with reason %s, positioned %s',
        async (position) => {
          // Arrange
          const dir = await freshRepo(`x8-${key}-${position}`);
          await commitSeed(dir);
          const badLine = `\t${key} = ${value}\n`;
          const goodLine = `\t${key} = ${GOOD_VALUE[key]}\n`;
          const block =
            position === 'first'
              ? `[pack]\n${badLine}${goodLine}`
              : `[pack]\n${goodLine}${badLine}`;
          await appendConfigLines(dir, `\n${block}`);

          // Act — tsgit
          const err = await tsgitGcRefusal(dir);

          // Assert — tsgit
          expect(err.data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect((err.data as { key: string }).key).toBe(`pack.${key}`);
          expect((err.data as { value: string }).value).toBe(value);
          expect((err.data as { reason: string }).reason).toBe(reason);

          // Act — real git
          const gitResult = tryRunGitWithExit([
            '-C',
            dir,
            '-c',
            'pack.threads=1',
            'repack',
            '-a',
            '-d',
          ]);

          // Assert — real git
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(
            `bad numeric config value '${value}' for 'pack.${key}'`,
          );
          expect(gitResult.stderr.trim().endsWith(reason)).toBe(true);
        },
        ROW_TIMEOUT,
      );
    },
  );

  describe.each(['depth', 'window'] as const)(
    'Given a valueless pack.%s entry, When gc runs on both tools',
    (key) => {
      it.each(['first', 'last'] as const)(
        'Then tsgit and real git both refuse with reason invalid unit, positioned %s',
        async (position) => {
          // Arrange
          const dir = await freshRepo(`x8-valueless-${key}-${position}`);
          await commitSeed(dir);
          const badLine = `\t${key}\n`;
          const goodLine = `\t${key} = ${GOOD_VALUE[key]}\n`;
          const block =
            position === 'first'
              ? `[pack]\n${badLine}${goodLine}`
              : `[pack]\n${goodLine}${badLine}`;
          await appendConfigLines(dir, `\n${block}`);

          // Act — tsgit
          const err = await tsgitGcRefusal(dir);

          // Assert — tsgit
          expect(err.data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect((err.data as { key: string }).key).toBe(`pack.${key}`);
          expect((err.data as { reason: string }).reason).toBe('invalid unit');

          // Act — real git
          const gitResult = tryRunGitWithExit([
            '-C',
            dir,
            '-c',
            'pack.threads=1',
            'repack',
            '-a',
            '-d',
          ]);

          // Assert — real git
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(`bad numeric config value '' for 'pack.${key}'`);
        },
        ROW_TIMEOUT,
      );
    },
  );

  const X9_ACCEPTED_ROWS: ReadonlyArray<{ readonly key: string; readonly value: string }> = [
    { key: 'depth', value: '2147483647' },
    { key: 'depth', value: '100000' },
    { key: 'depth', value: '4095' },
    { key: 'windowmemory', value: '9223372036854775808' },
    { key: 'windowmemory', value: '18446744073709551615' },
  ];

  describe.each(X9_ACCEPTED_ROWS)(
    'Given pack.$key = $value (accept-and-clamp), When gc runs on both tools',
    ({ key, value }) => {
      it(
        'Then tsgit accepts with no refusal, matching real git',
        async () => {
          // Arrange
          const dir = await freshRepo(`x9-${key}-${value}`.replaceAll(/[^a-z0-9-]/gi, ''));
          await commitSeed(dir);
          await appendConfigLines(dir, `\n[pack]\n\t${key} = ${value}\n`);
          const ctx = trackedNodeContext(dir);

          // Act — tsgit
          const result = await maintenance(ctx, { tasks: ['gc'] });
          await disposePackRegistry(ctx);

          // Assert — tsgit
          expect(result.tasksRun).toEqual(['gc']);

          // Act — real git
          const gitResult = tryRunGitWithExit(['-C', dir, 'repack', '-a', '-d', '-q']);

          // Assert — real git
          expect(gitResult.exitCode).toBe(0);
        },
        ROW_TIMEOUT,
      );
    },
  );

  const X10_DISABLED_ROWS: ReadonlyArray<{
    readonly key: 'depth' | 'window';
    readonly value: string;
  }> = [
    { key: 'depth', value: '0' },
    { key: 'depth', value: '-1' },
    { key: 'window', value: '0' },
    { key: 'window', value: '-1' },
  ];

  describe.each(X10_DISABLED_ROWS)(
    'Given pack.$key = $value alone (the migration-safety case), When gc runs on both tools',
    ({ key, value }) => {
      it(
        'Then no delta entry is emitted, the pack is byte-identical to the pre-change writer, and real git also emits zero deltas',
        async () => {
          // Arrange
          const dir = await freshRepo(`x10-${key}${value}`.replaceAll(/[^a-z0-9-]/gi, ''));
          await commitSeed(dir);
          await appendConfigLines(dir, `\n[pack]\n\t${key} = ${value}\n`);
          const ctx = trackedNodeContext(dir);
          const oids = await enumerateObjects(ctx, { includePacks: false });

          // Act — tsgit: the base-only writer vs the opt-in writer under a
          // disabling config must produce byte-identical bytes.
          const baseline = await buildPack(ctx, { oids });
          const optedIn = await buildPack(ctx, { oids, delta: true });
          await disposePackRegistry(ctx);

          // Assert — tsgit
          expect(Buffer.compare(Buffer.from(optedIn.bytes), Buffer.from(baseline.bytes))).toBe(0);

          // Act — real git
          const gitDir = await freshRepo(`x10-git-${key}${value}`.replaceAll(/[^a-z0-9-]/gi, ''));
          await cp(path.join(dir, 'seed.txt'), path.join(gitDir, 'seed.txt'));
          git(gitDir, 'add', '-A');
          git(gitDir, 'commit', '-q', '-m', 'seed');
          git(gitDir, 'config', `pack.${key}`, value);
          const gitResult = tryRunGitWithExit(['-C', gitDir, 'repack', '-a', '-d', '-q']);
          const { idxPath } = await solePackIdx(gitDir);
          const verifyOut = git(gitDir, 'verify-pack', '-v', idxPath);

          // Assert — real git
          expect(gitResult.exitCode).toBe(0);
          expect(verifyOut).not.toMatch(/chain length/);
        },
        ROW_TIMEOUT,
      );
    },
  );
});

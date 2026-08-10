/**
 * Cross-tool interop — `fsck`'s pack-accessibility reporting, pinned against
 * real git.
 *
 * A single seeded repo is repacked once; the resulting pack + idx bytes are
 * mutated per row (version restamped, header/index count disagreement,
 * corrupted signature, truncated, corrupted index, made unreadable, …) and
 * dropped into a fresh, cheap-to-create repo. Every row asserts both git's
 * observable outcome (exit code, and — where git prints one — the verdict
 * line reconstructed from the finding's own structured fields) and tsgit's
 * structured `FsckResult` from the identical on-disk state.
 *
 * @proves
 *   surface:        fsck.packAccessibility
 *   bucket:         cross-tool-interop
 *   unique:         fsck pack-accessibility findings and exit bits match canonical git
 *   interopSurface: fsck
 */
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding, FsckOptions } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import { parseIndex, serializeIndex } from '../../src/domain/git-index/index.js';
import { SHA1_CONFIG } from '../../src/domain/objects/hash-config.js';
import { parsePackEntryHeader } from '../../src/domain/storage/index.js';
import type { Context } from '../../src/ports/context.js';

import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import {
  corruptIdxSameLength,
  DIGEST_LENGTH,
  readSolePackPair,
  restampIdxForPack,
  restampPackVersion,
  setHeaderObjectCount,
  sha1,
  trailerOf,
  writeIdxOnly,
  writeLooseObject,
  writePack,
  writePackOnly,
} from './pack-fixture-helpers.js';

// Every context a row builds is disposed after the row — the packed-read rows
// open persistent FileHandles (pack.readSlice via the retention walk), and an
// undisposed registry surfaces as the GC-close warning the handle-lifecycle
// work treats as its leak oracle.
const liveContexts: Context[] = [];
function trackedNodeContext(workDir: string): Context {
  const ctx = createNodeContext({ workDir });
  liveContexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
});

const SETUP_TIMEOUT = 60_000;
const PACK_DIR = '.git/objects/pack';

// ---------------------------------------------------------------------------
// git-invocation helpers
// ---------------------------------------------------------------------------

function gitFsck(dir: string, ...flags: string[]): ReturnType<typeof tryRunGitWithExit> {
  return tryRunGitWithExit(['-C', dir, 'fsck', ...flags]);
}

/** Fixed author/committer date so two independently-built repos with the same
 * content produce byte-identical commit oids — required for the differential
 * rows, which compare findings across a pair of otherwise-isomorphic repos. */
const FIXED_COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

function commitSeed(dir: string): void {
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-m', 'seed'], { env: FIXED_COMMIT_ENV });
}

// ---------------------------------------------------------------------------
// Byte-crafting helpers this suite alone needs (not shared with the
// pack-version-header suite — see pack-fixture-helpers.ts for the recipes
// both suites share).
// ---------------------------------------------------------------------------

/** Overwrites the 4-byte `PACK` magic with `PACX` and re-fixes the trailer. */
function corruptSignature(packBytes: Uint8Array): Buffer {
  const buf = Buffer.from(packBytes);
  buf.write('PACX', 0, 'ascii');
  const trailerStart = buf.length - DIGEST_LENGTH;
  sha1(buf.subarray(0, trailerStart)).copy(buf, trailerStart);
  return buf;
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return needle === '' ? 0 : haystack.split(needle).length - 1;
}

/** git's reconstructed verdict for a pack-open-layer refusal. */
function packInaccessibleVerdict(pack: string): string {
  return `packfile ${PACK_DIR}/${pack}.pack cannot be accessed`;
}

/** git's reconstructed verdict for an index-layer refusal (first line). */
function packIndexNotOpenedVerdict(pack: string): string {
  return `packfile ${PACK_DIR}/${pack}.pack index not opened`;
}

/** git's reconstructed verdict for an index-layer refusal (second line). */
function revIndexUnusableVerdict(pack: string): string {
  return `unable to load rev-index for pack '${PACK_DIR}/${pack}.pack'`;
}

function findingsOfType<T extends FsckFinding['type']>(
  findings: ReadonlyArray<FsckFinding>,
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> {
  return findings.filter(
    (finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type,
  );
}

const PACK_FINDING_TYPES: ReadonlySet<FsckFinding['type']> = new Set([
  'pack-inaccessible',
  'pack-index-unusable',
  'pack-rev-index-unusable',
  'pack-rev-index-invalid',
  'pack-rev-index-position-mismatch',
]);

/** Findings unrelated to pack accessibility — the differential rows compare these across a pair of repos. */
function nonPackFindings(findings: ReadonlyArray<FsckFinding>): ReadonlyArray<FsckFinding> {
  return findings.filter((finding) => !PACK_FINDING_TYPES.has(finding.type));
}

// ---------------------------------------------------------------------------
// Fixture-repo factory
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

/** mkdtemps and git-inits a fresh, cheap repo; identity + signing are configured unconditionally. */
async function freshRepo(slug: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-pack-acc-${slug}-`));
  tmpDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

const SEED_FILES: ReadonlyArray<readonly [name: string, content: string]> = [
  ['a.txt', 'alpha\n'],
  ['b.txt', 'bravo\n'],
  ['c.txt', 'charlie\n'],
  ['d.txt', 'delta\n'],
  ['e.txt', 'echo\n'],
];

/** A fresh repo holding one crafted `.pack`/`.idx` pair and nothing else — the shape most rows need. */
async function bareTargetWithPack(
  slug: string,
  stem: string,
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
): Promise<string> {
  const dir = await freshRepo(slug);
  await writePack(dir, stem, packBytes, idxBytes);
  return dir;
}

/** A repo with one real commit whose reachable root tree is then deleted (no pack fault). */
async function buildDeletedTreeRepo(slug: string): Promise<string> {
  const dir = await freshRepo(slug);
  await writeFile(path.join(dir, 'a.txt'), 'alpha\n');
  commitSeed(dir);
  const treeSha = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
  const treePath = path.join(dir, '.git', 'objects', treeSha.slice(0, 2), treeSha.slice(2));
  await rm(treePath);
  return dir;
}

/** A repo with one real commit, repacked so its sole pack holds every reachable object. */
async function buildFullyPackedRepo(slug: string): Promise<string> {
  const dir = await freshRepo(slug);
  await writeFile(path.join(dir, 'a.txt'), 'alpha\n');
  commitSeed(dir);
  git(dir, 'repack', '-adq');
  return dir;
}

/** Restamps a repo's sole pack to header version 99 in place, deleting its `.rev` first. */
async function corruptSolePackToV99(dir: string): Promise<void> {
  const packDir = path.join(dir, PACK_DIR);
  const entries = await readdir(packDir);
  const packName = entries.find((entry) => entry.endsWith('.pack'));
  if (packName === undefined) throw new Error(`no .pack file found under ${packDir}`);
  const stem = packName.slice(0, -'.pack'.length);
  const packPath = path.join(packDir, packName);
  const idxPath = path.join(packDir, `${stem}.idx`);
  const revPath = path.join(packDir, `${stem}.rev`);

  const packBytes = await readFile(packPath);
  const idxBytes = await readFile(idxPath);
  await rm(revPath, { force: true });
  await chmod(packPath, 0o644);
  await chmod(idxPath, 0o644);

  const v99PackBytes = restampPackVersion(packBytes, 99);
  const v99IdxBytes = restampIdxForPack(idxBytes, trailerOf(v99PackBytes));
  await writeFile(packPath, v99PackBytes);
  await writeFile(idxPath, v99IdxBytes);
}

/**
 * Rewrites a repo's on-disk `.git/index` with its `TREE` (cache-tree)
 * extension removed, keeping every entry and every other extension
 * untouched. Round-trips through tsgit's own index parser/writer rather
 * than a raw byte splice — the trailing checksum still has to be
 * recomputed either way, and this reuses the parser this row exists to
 * exercise instead of duplicating its grammar.
 */
async function stripCacheTreeExtension(dir: string): Promise<void> {
  const indexFile = path.join(dir, '.git', 'index');
  const raw = await readFile(indexFile);
  const parsed = parseIndex(raw);
  const withoutCacheTree = {
    ...parsed,
    extensions: parsed.extensions.filter((ext) => ext.signature !== 'TREE'),
  };
  const body = serializeIndex(withoutCacheTree);
  const trailer = sha1(body);
  await writeFile(indexFile, Buffer.concat([body, trailer]));
}

/** Deletes a single loose object by its full hex oid. */
function removeLooseObject(dir: string, sha: string): Promise<void> {
  return rm(path.join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
}

/** A repo with one real commit under a distinct file-content prefix (never repacked). */
async function buildSeededRepo(slug: string, bodyPrefix: string): Promise<string> {
  const dir = await freshRepo(slug);
  await writeFile(path.join(dir, 'a.txt'), `${bodyPrefix}-alpha\n`);
  commitSeed(dir);
  return dir;
}

/** A repacked, header-version-99 pack built from its own distinct-content repo, plus the set of oids it alone carries. */
async function buildDonorV99Pack(
  slug: string,
  bodyPrefix: string,
): Promise<{
  readonly packBytes: Buffer;
  readonly idxBytes: Buffer;
  readonly objectIds: ReadonlySet<string>;
}> {
  const dir = await buildSeededRepo(slug, bodyPrefix);
  git(dir, 'repack', '-adq');
  const objectIds = new Set(
    git(dir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0),
  );
  const { packBytes, idxBytes } = await readSolePackPair(dir);
  const v99PackBytes = restampPackVersion(packBytes, 99);
  const v99IdxBytes = restampIdxForPack(idxBytes, trailerOf(v99PackBytes));
  return { packBytes: v99PackBytes, idxBytes: v99IdxBytes, objectIds };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('fsck pack-accessibility reporting, against real git', () => {
  let base = '';
  let basePackBytes: Buffer = Buffer.alloc(0);
  let baseIdxBytes: Buffer = Buffer.alloc(0);
  let objectCount = 0;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-pack-acc-base-'));
    git(base, 'init', '-q', '-b', 'main');
    git(base, 'config', 'user.name', 'Ada');
    git(base, 'config', 'user.email', 'ada@example.com');
    git(base, 'config', 'commit.gpgsign', 'false');

    for (const [name, content] of SEED_FILES) {
      await writeFile(path.join(base, name), content);
    }
    git(base, 'add', '-A');
    git(base, 'commit', '-m', 'seed');
    git(base, 'repack', '-adq');

    const solePack = await readSolePackPair(base);
    basePackBytes = solePack.packBytes;
    baseIdxBytes = solePack.idxBytes;
    objectCount = basePackBytes.readUInt32BE(8);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe('Given a healthy foreign pack, When fsck runs (row K-1)', () => {
    it('Then git exits 0 with no packfile line and fsck reports no pack finding', async () => {
      // Arrange
      const dir = await bareTargetWithPack('k1', 'good', basePackBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert
      expect(gitResult.exitCode).toBe(0);
      expect(gitResult.stderr).not.toContain('packfile');
      expect(result.exitCode).toBe(0);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(0);
    });
  });

  describe('Given a pack restamped to header version 3, When fsck runs (row K-2)', () => {
    it('Then both accept it: git exits 0 and fsck reports no pack finding', async () => {
      // Arrange
      const v3PackBytes = restampPackVersion(basePackBytes, 3);
      const v3IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v3PackBytes));
      const dir = await bareTargetWithPack('k2', 'good', v3PackBytes, v3IdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert
      expect(gitResult.exitCode).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(0);
    });
  });

  describe('Given a pack restamped to header version 99, When fsck runs (row K-3)', () => {
    it('Then both refuse it: git exits 4 with the verdict once, and fsck reports one finding with zero object findings from that pack', async () => {
      // Arrange
      const v99PackBytes = restampPackVersion(basePackBytes, 99);
      const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
      const dir = await bareTargetWithPack('k3', 'bad', v99PackBytes, v99IdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(4);
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit: one pack finding, and nothing else (the bad pack's own
      // objects never entered the universe)
      expect(result.exitCode).toBe(4);
      expect(result.findings).toHaveLength(1);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(1);
    });
  });

  describe('Given a pack whose header object count disagrees with its own index, When fsck runs (row K-4)', () => {
    it("Then git cites both counts and fsck's reason carries them", async () => {
      // Arrange
      const mismatchedPackBytes = setHeaderObjectCount(basePackBytes, objectCount + 1);
      const dir = await bareTargetWithPack('k4', 'bad', mismatchedPackBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(4);
      expect(gitResult.stderr).toContain(
        `claims to have ${objectCount + 1} objects while index indicates ${objectCount} objects`,
      );
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(4);
      const findings = findingsOfType(result.findings, 'pack-inaccessible');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.reason).toBe(
        `object count disagrees with index: pack ${objectCount + 1}, index ${objectCount}`,
      );
    });
  });

  describe('Given a pack whose signature is not "PACK", When fsck runs (row K-5)', () => {
    it('Then git cites the bad signature and fsck reports the invalid-magic reason', async () => {
      // Arrange
      const badSignatureBytes = corruptSignature(basePackBytes);
      const dir = await bareTargetWithPack('k5', 'bad', badSignatureBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(4);
      expect(gitResult.stderr).toContain('is not a GIT packfile');
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(4);
      const findings = findingsOfType(result.findings, 'pack-inaccessible');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.reason).toBe('invalid magic: expected 0x5041434b, got 0x50414358');
    });
  });

  describe('Given a pack truncated to 8 bytes, When fsck runs (row K-6)', () => {
    it('Then git cites too-short and fsck reports the truncated-header reason', async () => {
      // Arrange
      const truncatedBytes = basePackBytes.subarray(0, 8);
      const dir = await bareTargetWithPack('k6', 'bad', truncatedBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(4);
      expect(gitResult.stderr).toContain('far too short to be a packfile');
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(4);
      const findings = findingsOfType(result.findings, 'pack-inaccessible');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.reason).toBe('truncated: pack header requires 12 bytes');
    });
  });

  describe('Given a healthy pack file made unreadable via chmod 000, When fsck runs (row K-7, node tier only)', () => {
    it('Then git reports the verdict alone with no cause, and fsck reports one finding with a PERMISSION_DENIED reason', async () => {
      // Arrange
      const dir = await bareTargetWithPack('k7', 'bad', basePackBytes, baseIdxBytes);
      await chmod(path.join(dir, PACK_DIR, 'pack-bad.pack'), 0o000);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git: exactly one error line (the verdict), no cause line
      expect(gitResult.exitCode).toBe(4);
      const errorLines = gitResult.stderr.split('\n').filter((line) => line.startsWith('error:'));
      expect(errorLines).toHaveLength(1);
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(4);
      const findings = findingsOfType(result.findings, 'pack-inaccessible');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.reason).toBe('PERMISSION_DENIED');
    });
  });

  describe('Given an .idx corrupted to a same-length deterministic garbage stream, When fsck runs (row K-8)', () => {
    it('Then git exits 68 with both verdicts once, and fsck reports both index-layer findings', async () => {
      // Arrange
      const dir = await bareTargetWithPack(
        'k8',
        'bad',
        basePackBytes,
        corruptIdxSameLength(baseIdxBytes),
      );
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(68);
      expect(occurrences(gitResult.stderr, packIndexNotOpenedVerdict('pack-bad'))).toBe(1);
      expect(occurrences(gitResult.stderr, revIndexUnusableVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(68);
      expect(findingsOfType(result.findings, 'pack-index-unusable')).toHaveLength(1);
      expect(findingsOfType(result.findings, 'pack-rev-index-unusable')).toHaveLength(1);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(0);
    });
  });

  describe('Given an .idx truncated to 8 bytes, When fsck runs (row K-9)', () => {
    it('Then git exits 68 with both verdicts once, and fsck reports both index-layer findings', async () => {
      // Arrange
      const dir = await bareTargetWithPack('k9', 'bad', basePackBytes, baseIdxBytes.subarray(0, 8));
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(68);
      expect(occurrences(gitResult.stderr, packIndexNotOpenedVerdict('pack-bad'))).toBe(1);
      expect(occurrences(gitResult.stderr, revIndexUnusableVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(68);
      expect(findingsOfType(result.findings, 'pack-index-unusable')).toHaveLength(1);
      expect(findingsOfType(result.findings, 'pack-rev-index-unusable')).toHaveLength(1);
    });
  });

  describe('Given a healthy .idx made unreadable via chmod 000, When fsck runs (row K-10, node tier only)', () => {
    it('Then git reports both verdicts with no cause, and fsck reports both index-layer findings with a PERMISSION_DENIED reason', async () => {
      // Arrange
      const dir = await bareTargetWithPack('k10', 'bad', basePackBytes, baseIdxBytes);
      await chmod(path.join(dir, PACK_DIR, 'pack-bad.idx'), 0o000);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git: exactly two error lines (both verdicts), no cause line
      expect(gitResult.exitCode).toBe(68);
      const errorLines = gitResult.stderr.split('\n').filter((line) => line.startsWith('error:'));
      expect(errorLines).toHaveLength(2);
      expect(occurrences(gitResult.stderr, packIndexNotOpenedVerdict('pack-bad'))).toBe(1);
      expect(occurrences(gitResult.stderr, revIndexUnusableVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit
      expect(result.exitCode).toBe(68);
      const indexUnusable = findingsOfType(result.findings, 'pack-index-unusable');
      const revIndexUnusable = findingsOfType(result.findings, 'pack-rev-index-unusable');
      expect(indexUnusable).toHaveLength(1);
      expect(revIndexUnusable).toHaveLength(1);
      expect(indexUnusable[0]?.reason).toBe('PERMISSION_DENIED');
      expect(revIndexUnusable[0]?.reason).toBe('PERMISSION_DENIED');
    });
  });

  describe('Given an orphaned .idx with no sibling .pack, When fsck runs (row K-11)', () => {
    it('Then both are silent: git exits 0 and fsck reports no finding', async () => {
      // Arrange
      const dir = await freshRepo('k11');
      await writeIdxOnly(dir, 'orphan', baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert
      expect(gitResult.exitCode).toBe(0);
      expect(gitResult.stderr).not.toContain('packfile');
      expect(result.exitCode).toBe(0);
      expect(result.findings).toHaveLength(0);
    });
  });

  describe('Given an idx-less .pack with no sibling .idx, When fsck runs (row K-12)', () => {
    it('Then both are silent: git exits 0 and fsck reports no finding', async () => {
      // Arrange
      const dir = await freshRepo('k12');
      await writePackOnly(dir, 'no-pack', basePackBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert
      expect(gitResult.exitCode).toBe(0);
      expect(gitResult.stderr).not.toContain('packfile');
      expect(result.exitCode).toBe(0);
      expect(result.findings).toHaveLength(0);
    });
  });

  describe('Given two independently-unusable packs in the same repo, When fsck runs (row K-13)', () => {
    it('Then git reports each pack once and fsck reports two findings with bit 4 set once', async () => {
      // Arrange
      const dir = await freshRepo('k13');
      const v99PackBytes = restampPackVersion(basePackBytes, 99);
      const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
      const badSignatureBytes = corruptSignature(basePackBytes);
      await writePack(dir, 'aaa', v99PackBytes, v99IdxBytes);
      await writePack(dir, 'bbb', badSignatureBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git: each pack's own verdict occurs exactly once
      expect(gitResult.exitCode).toBe(4);
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-aaa'))).toBe(1);
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bbb'))).toBe(1);

      // Assert — tsgit: two findings, bit 4 set once (composed via OR)
      expect(result.exitCode).toBe(4);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(2);
    });
  });

  describe('Given a v99 pack and a healthy twin holding the same objects, When fsck runs (row K-14)', () => {
    it('Then git still reports the objects via the healthy twin, and fsck classifies them while reporting the bad pack', async () => {
      // Arrange
      const dir = await freshRepo('k14');
      const v99PackBytes = restampPackVersion(basePackBytes, 99);
      const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
      await writePack(dir, 'bad', v99PackBytes, v99IdxBytes);
      await writePack(dir, 'good', basePackBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git
      expect(gitResult.exitCode).toBe(4);
      expect(gitResult.stdout).toContain('dangling commit');
      expect(occurrences(gitResult.stderr, packInaccessibleVerdict('pack-bad'))).toBe(1);

      // Assert — tsgit: the objects are still classified AND the bad pack is reported
      expect(result.exitCode).toBe(4);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(1);
      expect(findingsOfType(result.findings, 'dangling').length).toBeGreaterThan(0);
    });
  });

  describe('Given a reachable tree deleted with and without an added foreign v99 pack, When fsck runs on each independently (row K-15)', () => {
    it('Then bit 4 is the only term the bad pack adds, on both tools independently', async () => {
      // Arrange
      const baselineDir = await buildDeletedTreeRepo('k15-baseline');
      const withPackDir = await buildDeletedTreeRepo('k15-with-pack');
      const v99PackBytes = restampPackVersion(basePackBytes, 99);
      const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
      await writePack(withPackDir, 'bad', v99PackBytes, v99IdxBytes);
      const gitBaseline = gitFsck(baselineDir);
      const gitWithPack = gitFsck(withPackDir);
      const sutBaseline = trackedNodeContext(baselineDir);
      const sutWithPack = trackedNodeContext(withPackDir);

      // Act
      const resultBaseline = await fsck(sutBaseline);
      const resultWithPack = await fsck(sutWithPack);

      // Assert — git: pinned absolute values (2|8 baseline, 2|4|8 with the pack)
      expect(gitBaseline.exitCode).toBe(10);
      expect(gitWithPack.exitCode).toBe(14);

      // Assert — tsgit: differential — bit 4 is the only added term, every
      // non-pack finding is unchanged, and the connectivity fault is present
      expect(resultWithPack.exitCode).toBe(resultBaseline.exitCode | 4);
      expect(findingsOfType(resultBaseline.findings, 'missing').length).toBeGreaterThan(0);
      expect(findingsOfType(resultBaseline.findings, 'broken-link').length).toBeGreaterThan(0);
      expect(nonPackFindings(resultWithPack.findings)).toEqual(
        nonPackFindings(resultBaseline.findings),
      );
      expect(findingsOfType(resultWithPack.findings, 'pack-inaccessible')).toHaveLength(1);
    });
  });

  describe("Given a v99 pack holding every one of the repo's own reachable objects with and without the fault, When fsck runs on each independently (row K-19)", () => {
    it('Then both tools exit 10 baseline and 14 with the bad pack — tsgit matches git absolutely, not just by the bit-4 delta', async () => {
      // Arrange — baseline: the sole pack removed entirely, so every reachable
      // object is simply absent; with-pack: the same pack, corrupted in place
      const baselineDir = await buildFullyPackedRepo('k19-baseline');
      await rm(path.join(baselineDir, PACK_DIR), { recursive: true, force: true });
      const withPackDir = await buildFullyPackedRepo('k19-with-pack');
      await corruptSolePackToV99(withPackDir);
      const gitBaseline = gitFsck(baselineDir);
      const gitWithPack = gitFsck(withPackDir);
      const sutBaseline = trackedNodeContext(baselineDir);
      const sutWithPack = trackedNodeContext(withPackDir);

      // Act
      const resultBaseline = await fsck(sutBaseline);
      const resultWithPack = await fsck(sutWithPack);

      // Assert — git: pinned absolute values (2|8 baseline, 2|4|8 with the pack)
      expect(gitBaseline.exitCode).toBe(10);
      expect(gitWithPack.exitCode).toBe(14);

      // Assert — tsgit matches git's own absolute exit on both sides (no
      // object resolves anywhere in either repo, so the missing-entry-point
      // bit fires on both; bit 4 is the only additional term the bad pack
      // itself adds), and missing findings are present on both
      expect(resultBaseline.exitCode).toBe(gitBaseline.exitCode);
      expect(resultWithPack.exitCode).toBe(gitWithPack.exitCode);
      const baselineMissing = findingsOfType(resultBaseline.findings, 'missing');
      const withPackMissing = findingsOfType(resultWithPack.findings, 'missing');
      expect(baselineMissing.length).toBeGreaterThan(0);
      expect(withPackMissing.length).toBe(baselineMissing.length);
      expect(findingsOfType(resultWithPack.findings, 'pack-inaccessible')).toHaveLength(1);
    });
  });

  describe('Given an index with entries but no cache-tree extension, every object then deleted, When fsck runs (row K-38)', () => {
    it('Then git omits the missing-entry-point bit entirely — there is no cache-tree to check — and tsgit matches exactly', async () => {
      // Arrange — a real commit (so the index carries entries), then its
      // cache-tree extension stripped from the on-disk index, then every
      // object deleted. Real git 2.55.0 does not run its cache-tree check
      // at all without the extension.
      const dir = await freshRepo('k38');
      await writeFile(path.join(dir, 'a.txt'), 'alpha\n');
      commitSeed(dir);
      const commitSha = git(dir, 'rev-parse', 'HEAD').trim();
      const treeSha = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
      const blobSha = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
      await stripCacheTreeExtension(dir);
      for (const sha of [commitSha, treeSha, blobSha]) {
        await removeLooseObject(dir, sha);
      }
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git: pinned absolute value (2 alone — no cache-tree, no check)
      expect(gitResult.exitCode).toBe(2);

      // Assert — tsgit matches exactly
      expect(result.exitCode).toBe(gitResult.exitCode);
    });
  });

  describe('Given an unreadable commit and blob beside a readable tree indexed by the cache-tree, When fsck runs (row K-39)', () => {
    it('Then git omits the missing-entry-point bit — the cache-tree only resolves the tree oid — and tsgit matches exactly', async () => {
      // Arrange — the cache-tree's own entry resolves fine (the tree is
      // untouched); the commit and blob are deleted so the connectivity
      // pass alone accounts for the non-zero exit.
      const dir = await freshRepo('k39');
      await writeFile(path.join(dir, 'a.txt'), 'alpha\n');
      commitSeed(dir);
      const commitSha = git(dir, 'rev-parse', 'HEAD').trim();
      const blobSha = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
      await removeLooseObject(dir, commitSha);
      await removeLooseObject(dir, blobSha);
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git: pinned absolute value (2 alone — missing commit; the
      // cache-tree's own tree oid still resolves)
      expect(gitResult.exitCode).toBe(2);

      // Assert — tsgit matches exactly
      expect(result.exitCode).toBe(gitResult.exitCode);
    });
  });

  describe('Given a pack that is both header-version-99 and index-corrupt on the same pack, When fsck runs (row K-16)', () => {
    it('Then the index-layer fault wins outright: git shows no version line and fsck reports only the index-layer findings', async () => {
      // Arrange
      const v99PackBytes = restampPackVersion(basePackBytes, 99);
      const dir = await bareTargetWithPack(
        'k16',
        'bad',
        v99PackBytes,
        corruptIdxSameLength(baseIdxBytes),
      );
      const gitResult = gitFsck(dir);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert — git: the index layer masks the pack-open fault entirely
      expect(gitResult.exitCode).toBe(68);
      expect(gitResult.stderr).not.toContain('is version 99');

      // Assert — tsgit: the precedence row — no pack-inaccessible finding
      // surfaces alongside the index-layer pair, despite both faults on one pack
      expect(result.exitCode).toBe(68);
      expect(findingsOfType(result.findings, 'pack-inaccessible')).toHaveLength(0);
      expect(findingsOfType(result.findings, 'pack-index-unusable')).toHaveLength(1);
      expect(findingsOfType(result.findings, 'pack-rev-index-unusable')).toHaveLength(1);
    });
  });

  describe('Given mode gating over a v99 pack and an index-corrupt pack, When fsck runs across modes (row K-17, exit axis)', () => {
    const MODE_GATING_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly repoShape: 'v99' | 'corrupt-idx';
      readonly gitFlags: readonly string[];
      readonly fsckOptions: FsckOptions;
      readonly expectedExit: number;
    }> = [
      {
        label: 'v99 pack, default',
        repoShape: 'v99',
        gitFlags: [],
        fsckOptions: {},
        expectedExit: 4,
      },
      {
        label: 'v99 pack, --connectivity-only',
        repoShape: 'v99',
        gitFlags: ['--connectivity-only'],
        fsckOptions: { connectivityOnly: true },
        expectedExit: 0,
      },
      {
        label: 'v99 pack, --no-full',
        repoShape: 'v99',
        gitFlags: ['--no-full'],
        fsckOptions: { full: false },
        expectedExit: 0,
      },
      {
        label: 'corrupt idx, default',
        repoShape: 'corrupt-idx',
        gitFlags: [],
        fsckOptions: {},
        expectedExit: 68,
      },
      {
        label: 'corrupt idx, --connectivity-only',
        repoShape: 'corrupt-idx',
        gitFlags: ['--connectivity-only'],
        fsckOptions: { connectivityOnly: true },
        expectedExit: 64,
      },
      {
        label: 'corrupt idx, --no-full',
        repoShape: 'corrupt-idx',
        gitFlags: ['--no-full'],
        fsckOptions: { full: false },
        expectedExit: 64,
      },
    ];

    it.each(MODE_GATING_ROWS)(
      'Then both tools exit $expectedExit for "$label"',
      async ({ repoShape, gitFlags, fsckOptions, expectedExit }) => {
        // Arrange
        const dir =
          repoShape === 'v99'
            ? await bareTargetWithPack(
                `k17-${expectedExit}-${gitFlags.join('') || 'default'}`,
                'bad',
                restampPackVersion(basePackBytes, 99),
                restampIdxForPack(baseIdxBytes, trailerOf(restampPackVersion(basePackBytes, 99))),
              )
            : await bareTargetWithPack(
                `k17-${expectedExit}-${gitFlags.join('') || 'default'}`,
                'bad',
                basePackBytes,
                corruptIdxSameLength(baseIdxBytes),
              );
        const gitResult = gitFsck(dir, ...gitFlags);
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, fsckOptions);

        // Assert
        expect(gitResult.exitCode).toBe(expectedExit);
        expect(result.exitCode).toBe(expectedExit);
      },
    );
  });

  describe('Given a v99 pack, When fsck runs with --strict (row K-18)', () => {
    it('Then bit 4 is unchanged on both tools', async () => {
      // Arrange
      const v99PackBytes = restampPackVersion(basePackBytes, 99);
      const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
      const dir = await bareTargetWithPack('k18', 'bad', v99PackBytes, v99IdxBytes);
      const gitResult = gitFsck(dir, '--strict');
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut, { strict: true });

      // Assert
      expect(gitResult.exitCode).toBe(4);
      expect(result.exitCode).toBe(4);
    });
  });

  describe('Given a v99 pack whose objects are readable through no other source (rows K-20, K-21)', () => {
    let targetDir = '';
    let donorObjectIds: ReadonlySet<string> = new Set();

    beforeAll(async () => {
      const donor = await buildDonorV99Pack('k20-donor', 'donor-content');
      targetDir = await buildSeededRepo('k20-target', 'target-content');
      await writePack(targetDir, 'bad', donor.packBytes, donor.idxBytes);
      donorObjectIds = donor.objectIds;
    }, SETUP_TIMEOUT);

    describe('When fsck runs with connectivityOnly (row K-20, findings axis)', () => {
      it('Then the dangling-unknown oid set matches exactly, sized off the donor pack itself', async () => {
        // Arrange
        const gitResult = gitFsck(targetDir, '--connectivity-only');
        const sut = trackedNodeContext(targetDir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert — git: exactly the donor's oids, no duplicates
        const gitDanglingIds = new Set(
          gitResult.stdout
            .split('\n')
            .filter((line) => line.startsWith('dangling unknown '))
            .map((line) => line.slice('dangling unknown '.length)),
        );
        expect(gitResult.exitCode).toBe(0);
        expect(gitDanglingIds.size).toBe(donorObjectIds.size);
        expect(gitDanglingIds).toEqual(donorObjectIds);

        // Assert — tsgit: the same oid set, as dangling/unknown findings
        const tsgitDanglingIds = new Set(
          findingsOfType(result.findings, 'dangling')
            .filter((finding) => finding.objectType === 'unknown')
            .map((finding) => finding.id),
        );
        expect(result.exitCode).toBe(0);
        expect(tsgitDanglingIds).toEqual(donorObjectIds);
      });
    });

    describe('When fsck runs with full:false (row K-21)', () => {
      it('Then neither tool reports anything for the pack', async () => {
        // Arrange
        const gitResult = gitFsck(targetDir, '--no-full');
        const sut = trackedNodeContext(targetDir);

        // Act
        const result = await fsck(sut, { full: false });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout).not.toContain('dangling');
        expect(result.exitCode).toBe(0);
        const danglingOrUnreachable = result.findings.filter(
          (finding) => finding.type === 'dangling' || finding.type === 'unreachable',
        );
        expect(danglingOrUnreachable).toHaveLength(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Loose-object axis (K-22 … K-37) — its own top-level describe: unlike K-1…K-21
// above, these repos have no packs at all (except the three rows that build
// one on purpose), so every cell is attributable to the one damaged loose
// object. git writes loose objects `0444`; `chmod u+w` before mutating any of
// them, or the row silently measures a healthy repo instead.
// ---------------------------------------------------------------------------

const PACK_HEADER_SIZE = 12;

/** Bytes that can never be a valid zlib stream: 0xff's top nibble (0xf) is not the deflate CMF value (8), so every adapter's inflate rejects it on the first byte. */
const NON_ZLIB_GARBAGE = Buffer.alloc(64, 0xff);

function looseObjectPath(dir: string, oid: string): string {
  return path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
}

/** `git hash-object -w --stdin` — writes a real loose object and returns its oid. Content may be binary (a `Uint8Array`, written verbatim); a plain string goes through as UTF-8. */
function hashObjectW(dir: string, content: string | Uint8Array): string {
  return runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();
}

/** `git mktree --stdin` — writes a tree object from `<mode> blob <oid>\t<name>\n` lines and returns its oid. Never referenced by any ref, so the tree itself stays dangling. */
function mktree(dir: string, entryLine: string): string {
  return runGit(['-C', dir, 'mktree'], { input: entryLine }).trim();
}

/** Deterministic 40-hex-char oid for a hand-crafted loose object whose path is never derived from its own content hash — fsck's loose-object discovery is a directory scan keyed on path alone (K-25's whole point). */
function syntheticOid(seed: string): string {
  return sha1(Buffer.from(seed)).toString('hex');
}

/** Deflates an already-assembled `<header>\0<body>` byte sequence the way git stores a loose object — for rows whose header is itself the fault under test (unrecoverable type, size disagreeing with body) and so cannot be produced through `git hash-object`. */
function craftedLooseBytes(header: string, body: Uint8Array): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${header}\0`, 'ascii'), Buffer.from(body)]));
}

/** Runs `fsck` and catches its rejection — every reject row (K-26, K-29, K-31, K-33) shares this shape, so each `it` body reads as arrangement, then one assertion on the caught cause. Rethrows anything that is not a `TsgitError` and fails the test if `fsck` resolves instead of rejecting. */
async function catchFsckRejection(ctx: Context, opts: FsckOptions): Promise<TsgitError> {
  try {
    await fsck(ctx, opts);
  } catch (error) {
    if (error instanceof TsgitError) return error;
    throw error;
  }
  throw new Error('expected fsck to reject, but it resolved');
}

/** One row of `git verify-pack -v` — oid, its exact byte span in the pack (`sizeInPackfile` at `offset`), and whether it is delta-encoded (a trailing depth + base-sha pair appears only for delta entries). */
interface VerifyPackRow {
  readonly oid: string;
  readonly sizeInPackfile: number;
  readonly offset: number;
  readonly isDelta: boolean;
}

function verifyPackRows(dir: string, idxPath: string): ReadonlyArray<VerifyPackRow> {
  const rows: VerifyPackRow[] = [];
  for (const line of git(dir, 'verify-pack', '-v', idxPath).split('\n')) {
    const fields = line.trim().split(/\s+/);
    const oid = fields[0];
    if (fields.length < 5 || oid === undefined || !/^[0-9a-f]{40}$/.test(oid)) continue;
    rows.push({
      oid,
      sizeInPackfile: Number(fields[3]),
      offset: Number(fields[4]),
      isDelta: fields.length >= 7,
    });
  }
  return rows;
}

/** Flips one byte inside an entry's compressed body — never its header — located via `parsePackEntryHeader`'s own `dataOffset`, so the corruption can only land past the type/size/base-link bytes the type-recovery walk still needs to read. */
function flipEntryBodyByte(packBytes: Buffer, entryOffset: number, entryEnd: number): Buffer {
  const buf = Buffer.from(packBytes);
  const header = parsePackEntryHeader(buf, entryOffset, SHA1_CONFIG);
  const mid = header.dataOffset + Math.floor((entryEnd - header.dataOffset) / 2);
  buf[mid] = (buf[mid] ?? 0) ^ 0xff;
  return buf;
}

/** Deterministic pseudo-random bytes (no external entropy) — large enough (~20 KiB) that `git pack-objects` always prefers a delta over storing the second blob whole. */
function pseudoRandomBytes(length: number, seed: number): Buffer {
  const buf = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    buf[i] = (state >>> 16) & 0xff;
  }
  return buf;
}

/** Packs a single blob into its own donor-only pack — nothing else to delta against, so the entry is always stored whole (K-34, K-35's shared base). */
async function buildSingleObjectPack(
  slug: string,
  content: string,
): Promise<{ readonly oid: string; readonly packBytes: Buffer; readonly idxBytes: Buffer }> {
  const donor = await freshRepo(`${slug}-donor`);
  const oid = hashObjectW(donor, content);
  const base = path.join(donor, PACK_DIR, `pack-${slug}`);
  runGit(['-C', donor, 'pack-objects', base], { input: `${oid}\n` });
  const { packBytes, idxBytes } = await readSolePackPair(donor);
  return { oid, packBytes, idxBytes };
}

/**
 * Two ~20 KiB blobs differing in three bytes, packed with `--no-reuse-delta`
 * so the second is always freshly delta-encoded against the first, then one
 * byte of the delta entry's own compressed body flipped (trailer left as-is —
 * `--connectivity-only` never checks it). `deltaBaseOffset` selects OFS_DELTA
 * over the default REF_DELTA (K-36 runs both encodings, per R13).
 */
async function buildDeltaPackPair(
  slug: string,
  deltaBaseOffset: boolean,
): Promise<{
  readonly corruptedOid: string;
  readonly packBytes: Buffer;
  readonly idxBytes: Buffer;
}> {
  const donor = await freshRepo(`${slug}-donor`);
  const baseBytes = pseudoRandomBytes(20_000, 0xc0ffee);
  const deltaBytes = Buffer.from(baseBytes);
  for (const i of [100, 8000, 16000]) deltaBytes[i] = ((deltaBytes[i] ?? 0) + 1) % 256;

  const baseOid = hashObjectW(donor, baseBytes);
  const deltaOid = hashObjectW(donor, deltaBytes);
  const base = path.join(donor, PACK_DIR, `pack-${slug}`);
  const flags = ['--window=250', '--depth=50', '--no-reuse-delta'];
  if (deltaBaseOffset) flags.push('--delta-base-offset');
  runGit(['-C', donor, 'pack-objects', ...flags, base], { input: `${baseOid}\n${deltaOid}\n` });

  const { packBytes, idxBytes } = await readSolePackPair(donor);
  const idxName = (await readdir(path.join(donor, PACK_DIR))).find((entry) =>
    entry.endsWith('.idx'),
  );
  if (idxName === undefined) throw new Error(`${slug}: no .idx produced`);
  const deltaRow = verifyPackRows(donor, path.join(donor, PACK_DIR, idxName)).find(
    (row) => row.isDelta,
  );
  if (deltaRow === undefined)
    throw new Error(`${slug}: pack-objects did not produce a delta entry`);

  const corruptedPackBytes = flipEntryBodyByte(
    packBytes,
    deltaRow.offset,
    deltaRow.offset + deltaRow.sizeInPackfile,
  );
  return { corruptedOid: deltaRow.oid, packBytes: corruptedPackBytes, idxBytes };
}

describe.skipIf(!GIT_AVAILABLE)(
  'fsck loose-object accessibility reporting, against real git',
  () => {
    afterAll(async () => {
      await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    describe('Given a chmod-000 loose object, unreferenced, When fsck runs with connectivityOnly (row K-22, node tier only)', () => {
      it('Then git exits 0 with dangling unknown once, and fsck reports one dangling finding typed unknown', async () => {
        // Arrange
        const dir = await freshRepo('k22');
        const oid = hashObjectW(dir, 'k22-content\n');
        await chmod(looseObjectPath(dir, oid), 0o000);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling unknown ${oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling');
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('unknown');
      });
    });

    describe('Given the same chmod-000 loose object, When fsck runs in default mode (row K-23)', () => {
      it('Then git computes no dangling/unreachable line for it even with the projection flags on, and fsck rejects with the pre-existing IO-fault gap', async () => {
        // Arrange — same fixture recipe as K-22, its own repo
        const dir = await freshRepo('k23');
        const oid = hashObjectW(dir, 'k23-content\n');
        await chmod(looseObjectPath(dir, oid), 0o000);
        const gitDefault = gitFsck(dir);
        const gitWithProjectionFlags = gitFsck(dir, '--dangling', '--unreachable');
        const sut = trackedNodeContext(dir);

        // Assert — git: unchanged by the projection flags (Pin P-a) — this is
        // what makes it a computation difference, not a print filter
        expect(gitDefault.exitCode).toBe(1);
        expect(gitWithProjectionFlags.exitCode).toBe(1);
        expect(gitWithProjectionFlags.stdout).not.toContain(`dangling ${oid}`);
        expect(gitWithProjectionFlags.stdout).not.toContain(`unreachable ${oid}`);

        // Act + Assert — tsgit: the pre-existing IO-fault gap (§D11.13) — an
        // unreadable loose object throws today in default mode instead of
        // resolving with a bad-object finding, unlike the decode-fault rows
        // below (K-27); either way there is no dangling/unreachable finding.
        const error = await catchFsckRejection(sut, {});
        expect(error.data.code).toBe('PERMISSION_DENIED');
      });
    });

    describe('Given a chmod-000 loose object that is reachable, When fsck runs with connectivityOnly (row K-24, node tier only)', () => {
      it('Then both are silent: git exits 0 with empty stdout, and fsck reports no finding for that object', async () => {
        // Arrange
        const dir = await freshRepo('k24');
        await writeFile(path.join(dir, 'reach.txt'), 'k24-content\n');
        commitSeed(dir);
        const oid = git(dir, 'rev-parse', 'HEAD:reach.txt').trim();
        await chmod(looseObjectPath(dir, oid), 0o000);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout).toBe('');
        expect(result.exitCode).toBe(0);
        expect(result.findings.some((finding) => 'id' in finding && finding.id === oid)).toBe(
          false,
        );
      });
    });

    describe('Given a loose object whose path does not match its content hash, When fsck runs with connectivityOnly (row K-25)', () => {
      it('Then both type it from the header alone: git exits 0 with dangling blob, and fsck reports one dangling finding typed blob', async () => {
        // Arrange — the object's real content hashes to a different oid than
        // the path it is filed under; connectivity-only reads the header and
        // never hashes the body, so it types the object anyway
        const dir = await freshRepo('k25');
        const content = Buffer.from('k25-mismatch-content\n');
        const oid = syntheticOid('k25-mismatch-target');
        await writeLooseObject(dir, oid, craftedLooseBytes(`blob ${content.length}`, content));
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling blob ${oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling');
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('blob');
      });
    });

    describe('Given an undecodable loose object, dangling, When fsck runs with connectivityOnly (row K-26)', () => {
      it('Then both reject: git exits 128 with empty stdout, and fsck rejects with a DECOMPRESS_FAILED cause', async () => {
        // Arrange
        const dir = await freshRepo('k26');
        const oid = syntheticOid('k26-garbage');
        await writeLooseObject(dir, oid, NON_ZLIB_GARBAGE);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Assert — git
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stdout).toBe('');

        // Act + Assert — tsgit
        const error = await catchFsckRejection(sut, { connectivityOnly: true });
        expect(error.data.code).toBe('DECOMPRESS_FAILED');
      });
    });

    describe('Given the same undecodable loose object, When fsck runs in default mode (row K-27)', () => {
      it('Then git exits 1, and fsck resolves with exit bit 1 and a bad-object finding — the mode boundary on the same bytes as K-26', async () => {
        // Arrange — same fixture recipe as K-26, its own repo
        const dir = await freshRepo('k27');
        const oid = syntheticOid('k27-garbage');
        await writeLooseObject(dir, oid, NON_ZLIB_GARBAGE);
        const gitResult = gitFsck(dir);
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(1);
        expect(result.exitCode).toBe(1);
        const badObject = findingsOfType(result.findings, 'bad-object').find(
          (finding) => finding.id === oid,
        );
        expect(badObject).toBeDefined();
      });
    });

    describe('Given a reachable undecodable object, When fsck runs with connectivityOnly (row K-28)', () => {
      it('Then both are fully silent: git exits 0 with empty stdout and stderr, and fsck resolves with no finding for that object', async () => {
        // Arrange
        const dir = await freshRepo('k28');
        await writeFile(path.join(dir, 'reach.txt'), 'k28-content\n');
        commitSeed(dir);
        const oid = git(dir, 'rev-parse', 'HEAD:reach.txt').trim();
        await chmod(looseObjectPath(dir, oid), 0o644);
        await writeFile(looseObjectPath(dir, oid), NON_ZLIB_GARBAGE);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout).toBe('');
        expect(gitResult.stderr).toBe('');
        expect(result.exitCode).toBe(0);
        expect(result.findings.some((finding) => 'id' in finding && finding.id === oid)).toBe(
          false,
        );
      });
    });

    describe('Given an unreachable undecodable object referenced by a readable dangling tree, When fsck runs with connectivityOnly (row K-29)', () => {
      it('Then both reject: git exits 128 with empty stdout, and fsck rejects with the same decode fault, scoped to the unreached set rather than the dangling subset', async () => {
        // Arrange — the corrupt blob has an in-edge from the tree, so it is
        // merely unreachable (not dangling); the tree itself stays dangling
        // and readable
        const dir = await freshRepo('k29');
        const blobOid = hashObjectW(dir, 'k29-content\n');
        mktree(dir, `100644 blob ${blobOid}\ttarget.txt\n`);
        await chmod(looseObjectPath(dir, blobOid), 0o644);
        await writeFile(looseObjectPath(dir, blobOid), NON_ZLIB_GARBAGE);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Assert — git
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stdout).toBe('');

        // Act + Assert — tsgit
        const error = await catchFsckRejection(sut, { connectivityOnly: true });
        expect(error.data.code).toBe('DECOMPRESS_FAILED');
      });
    });

    describe('Given an empty loose object, dangling, When fsck runs with connectivityOnly (row K-30)', () => {
      it('Then both resolve: git exits 0 with dangling unknown, and fsck reports one dangling finding typed unknown', async () => {
        // Arrange
        const dir = await freshRepo('k30');
        const oid = hashObjectW(dir, 'k30-content\n');
        await chmod(looseObjectPath(dir, oid), 0o644);
        await writeFile(looseObjectPath(dir, oid), new Uint8Array(0));
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling unknown ${oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling');
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('unknown');
      });
    });

    describe('Given a loose object with an unrecoverable header, When fsck runs with connectivityOnly (row K-31)', () => {
      it('Then both reject: git exits 128, and fsck rejects with an INVALID_OBJECT_HEADER cause', async () => {
        // Arrange
        const dir = await freshRepo('k31');
        const oid = syntheticOid('k31-widget');
        await writeLooseObject(dir, oid, craftedLooseBytes('widget 5', Buffer.from('abcde')));
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Assert — git
        expect(gitResult.exitCode).toBe(128);

        // Act + Assert — tsgit
        const error = await catchFsckRejection(sut, { connectivityOnly: true });
        expect(error.data.code).toBe('INVALID_OBJECT_HEADER');
      });
    });

    describe('Given a loose object whose header disagrees with its content size, When fsck runs with connectivityOnly (row K-32)', () => {
      it('Then both resolve, typed from the recovered header: git exits 0 with dangling blob, and fsck reports one dangling finding typed blob', async () => {
        // Arrange — pins the split as header-recovery, not error code: the
        // header parses fine, so nothing here aborts
        const dir = await freshRepo('k32');
        const oid = syntheticOid('k32-size-mismatch');
        await writeLooseObject(dir, oid, craftedLooseBytes('blob 99', Buffer.from('hi')));
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling blob ${oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling');
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('blob');
      });
    });

    describe('Given a healthy dangling object and an undecodable dangling object in the same repo, When fsck runs with connectivityOnly (row K-33)', () => {
      it('Then both withhold the whole report: git exits 128 with the healthy line absent from stdout, and fsck rejects', async () => {
        // Arrange
        const dir = await freshRepo('k33');
        const healthyOid = hashObjectW(dir, 'k33-healthy\n');
        const garbageOid = syntheticOid('k33-garbage');
        await writeLooseObject(dir, garbageOid, NON_ZLIB_GARBAGE);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Assert — git: an abort is the whole report withheld, not one finding
        // replaced by an error — the already-computed healthy line is absent
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stdout).toBe('');
        expect(gitResult.stdout).not.toContain(`dangling blob ${healthyOid}`);

        // Act + Assert — tsgit
        const error = await catchFsckRejection(sut, { connectivityOnly: true });
        expect(error.data.code).toBe('DECOMPRESS_FAILED');
      });
    });

    describe('Given a packed-only object with a corrupt entry body, When fsck runs with connectivityOnly (row K-34)', () => {
      it('Then both resolve, typed from the pack-entry header alone: git exits 0 with dangling blob, and fsck reports one dangling finding typed blob', async () => {
        // Arrange — a donor pack with one healthy entry, then one byte of its
        // own compressed body flipped; the idx keeps the original (now stale)
        // CRC, which connectivity-only never checks
        const donor = await buildSingleObjectPack('k34', 'k34-content\n');
        const corruptedPackBytes = flipEntryBodyByte(
          donor.packBytes,
          PACK_HEADER_SIZE,
          donor.packBytes.length - DIGEST_LENGTH,
        );
        const dir = await bareTargetWithPack('k34', 'corrupt', corruptedPackBytes, donor.idxBytes);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling blob ${donor.oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling').filter(
          (finding) => finding.id === donor.oid,
        );
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('blob');
      });
    });

    describe('Given a garbled loose copy shadowing a healthy packed copy, When fsck runs with connectivityOnly (row K-35)', () => {
      it('Then both resolve, served from the healthy pack: git exits 0 with dangling blob, and fsck reports one dangling finding typed blob', async () => {
        // Arrange
        const donor = await buildSingleObjectPack('k35', 'k35-content\n');
        const dir = await bareTargetWithPack('k35', 'healthy', donor.packBytes, donor.idxBytes);
        await writeLooseObject(dir, donor.oid, NON_ZLIB_GARBAGE);
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling blob ${donor.oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling').filter(
          (finding) => finding.id === donor.oid,
        );
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('blob');
      });
    });

    describe.each([
      { label: 'REF_DELTA', deltaBaseOffset: false },
      { label: 'OFS_DELTA', deltaBaseOffset: true },
    ])(
      'Given a packed delta entry ($label) with a corrupt body, When fsck runs with connectivityOnly (row K-36)',
      ({ label, deltaBaseOffset }) => {
        it('Then both resolve, typed by walking the delta base link: git exits 0 with dangling blob, and fsck reports one dangling finding typed blob', async () => {
          // Arrange
          const slug = `k36-${label.toLowerCase()}`;
          const built = await buildDeltaPackPair(slug, deltaBaseOffset);
          const dir = await bareTargetWithPack(slug, 'delta', built.packBytes, built.idxBytes);
          const gitResult = gitFsck(dir, '--connectivity-only');
          const sut = trackedNodeContext(dir);

          // Act
          const result = await fsck(sut, { connectivityOnly: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(occurrences(gitResult.stdout, `dangling blob ${built.corruptedOid}`)).toBe(1);
          expect(result.exitCode).toBe(0);
          const danglingFindings = findingsOfType(result.findings, 'dangling').filter(
            (finding) => finding.id === built.corruptedOid,
          );
          expect(danglingFindings).toHaveLength(1);
          expect(danglingFindings[0]?.objectType).toBe('blob');
        });
      },
    );

    describe('Given a valid header over an unparseable tree body, When fsck runs with connectivityOnly (row K-37)', () => {
      it('Then both resolve, typed from the header alone: git exits 0 with dangling tree, and fsck reports one dangling finding typed tree', async () => {
        // Arrange — git's own "too-short tree object" stderr is not compared
        // (verdict line only)
        const dir = await freshRepo('k37');
        const oid = syntheticOid('k37-tree-junk');
        await writeLooseObject(
          dir,
          oid,
          craftedLooseBytes('tree 4', Buffer.from([0x00, 0x01, 0x02, 0x03])),
        );
        const gitResult = gitFsck(dir, '--connectivity-only');
        const sut = trackedNodeContext(dir);

        // Act
        const result = await fsck(sut, { connectivityOnly: true });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(occurrences(gitResult.stdout, `dangling tree ${oid}`)).toBe(1);
        expect(result.exitCode).toBe(0);
        const danglingFindings = findingsOfType(result.findings, 'dangling');
        expect(danglingFindings).toHaveLength(1);
        expect(danglingFindings[0]?.objectType).toBe('tree');
      });
    });
  },
);

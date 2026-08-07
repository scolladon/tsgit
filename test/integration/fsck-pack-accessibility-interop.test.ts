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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding, FsckOptions } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
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
  writePack,
  writePackOnly,
} from './pack-fixture-helpers.js';

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const packxBytes = corruptSignature(basePackBytes);
      const dir = await bareTargetWithPack('k5', 'bad', packxBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      await writePackOnly(dir, 'nopack', basePackBytes);
      const gitResult = gitFsck(dir);
      const sut = createNodeContext({ workDir: dir });

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
      const packxBytes = corruptSignature(basePackBytes);
      await writePack(dir, 'aaa', v99PackBytes, v99IdxBytes);
      await writePack(dir, 'bbb', packxBytes, baseIdxBytes);
      const gitResult = gitFsck(dir);
      const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
      const sutBaseline = createNodeContext({ workDir: baselineDir });
      const sutWithPack = createNodeContext({ workDir: withPackDir });

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
    it('Then bit 4 is the only term the bad pack adds, and missing findings are present on both tools', async () => {
      // Arrange — baseline: the sole pack removed entirely, so every reachable
      // object is simply absent; with-pack: the same pack, corrupted in place
      const baselineDir = await buildFullyPackedRepo('k19-baseline');
      await rm(path.join(baselineDir, PACK_DIR), { recursive: true, force: true });
      const withPackDir = await buildFullyPackedRepo('k19-with-pack');
      await corruptSolePackToV99(withPackDir);
      const gitBaseline = gitFsck(baselineDir);
      const gitWithPack = gitFsck(withPackDir);
      const sutBaseline = createNodeContext({ workDir: baselineDir });
      const sutWithPack = createNodeContext({ workDir: withPackDir });

      // Act
      const resultBaseline = await fsck(sutBaseline);
      const resultWithPack = await fsck(sutWithPack);

      // Assert — git: pinned absolute values (2|8 baseline, 2|4|8 with the pack)
      expect(gitBaseline.exitCode).toBe(10);
      expect(gitWithPack.exitCode).toBe(14);

      // Assert — tsgit: differential, and missing findings are present on both
      expect(resultWithPack.exitCode).toBe(resultBaseline.exitCode | 4);
      const baselineMissing = findingsOfType(resultBaseline.findings, 'missing');
      const withPackMissing = findingsOfType(resultWithPack.findings, 'missing');
      expect(baselineMissing.length).toBeGreaterThan(0);
      expect(withPackMissing.length).toBe(baselineMissing.length);
      expect(findingsOfType(resultWithPack.findings, 'pack-inaccessible')).toHaveLength(1);
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
      const sut = createNodeContext({ workDir: dir });

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
        const sut = createNodeContext({ workDir: dir });

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
      const sut = createNodeContext({ workDir: dir });

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
        const sut = createNodeContext({ workDir: targetDir });

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
        const sut = createNodeContext({ workDir: targetDir });

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

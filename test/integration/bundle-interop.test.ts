/**
 * Cross-tool interop — bundle command. Builds repos via real git, then
 * runs bundleCreate / bundleVerify / bundleListHeads against the same repos
 * and proves that the structured result faithfully replicates what git produces.
 *
 * The library emits NO rendered strings — all assertions reconstruct
 * git's human output from structured fields and compare.
 *
 * @proves
 *   surface:        bundleCreate, bundleVerify, bundleListHeads
 *   bucket:         cross-tool-interop
 *   unique:         v2 header byte-golden parity vs real git; oid-sorted
 *                   prerequisite lines; multi-line-subject foldSubject prerequisite comment golden;
 *                   three-dot and criss-cross merge-base frontier parity;
 *                   object-closure set parity (prereq-blob exclusion verified);
 *                   cross-tool round-trips (tsgit→git, git→tsgit);
 *                   full-pack-parse corrupt-entry detection (trailer fixed,
 *                   inflate still fails — proves walkPackEntries runs);
 *                   refusal reconstruction vs git messages;
 *                   list-heads exact-name filter parity;
 *                   hash-algorithm field reconstruction
 *   interopSurface: bundleCreate, bundleVerify, bundleListHeads
 */

import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { BundleCreateOptions } from '../../src/application/commands/bundle-create.js';
import { bundleCreate } from '../../src/application/commands/bundle-create.js';
import { bundleListHeads } from '../../src/application/commands/bundle-list-heads.js';
import { bundleVerify } from '../../src/application/commands/bundle-verify.js';
import { verifyPackTrailer, walkPackEntries } from '../../src/application/primitives/fetch-pack.js';
import { parseBundleHeader } from '../../src/domain/bundle/index.js';
import { TsgitError } from '../../src/domain/error.js';
import type { RefName } from '../../src/domain/objects/object-id.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the text header portion (bytes before the embedded pack) from bundle bytes. */
const headerBytes = (bundleBytes: Uint8Array): Uint8Array => {
  const hdr = parseBundleHeader(bundleBytes, '<test>');
  return bundleBytes.subarray(0, hdr.packOffset);
};

type Ctx = Awaited<ReturnType<typeof createNodeContext>>;

/** Parse all object IDs from the pack embedded in a bundle. */
const packOids = async (ctx: Ctx, bundleBytes: Uint8Array): Promise<Set<string>> => {
  const hdr = parseBundleHeader(bundleBytes, '<test>');
  const pack = bundleBytes.subarray(hdr.packOffset);
  await verifyPackTrailer(pack, ctx);
  const entries = await walkPackEntries(ctx, pack);
  return new Set(entries.map((e) => e.id));
};

/** Run `git bundle create <bundleFile> <args>` and return the raw bundle bytes. */
const gitBundleCreate = (
  dir: string,
  bundleFile: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Uint8Array => {
  runGit(['-C', dir, 'bundle', 'create', bundleFile, ...args], { env });
  return new Uint8Array(readFileSync(bundleFile));
};

/**
 * Flip one byte deep in the first pack entry's compressed-data region, then
 * recompute the 20-byte SHA-1 trailer so verifyPackTrailer still passes.
 * walkPackEntries fails when it tries to inflate the corrupt entry, proving
 * that bundleVerify inflates every entry (not just the trailer).
 */
const corruptPackData = (bundleBytes: Uint8Array, packOffset: number): Uint8Array => {
  const result = new Uint8Array(bundleBytes);
  // Skip the 12-byte PACK header; offset 100 is well into the first entry's compressed data
  const flipAt = packOffset + 100;
  result[flipAt] = (result.at(flipAt) ?? 0) ^ 0xff;
  // Recompute the 20-byte SHA-1 trailer over the modified pack body
  const packBody = result.subarray(packOffset, result.length - 20);
  const newTrailer = createHash('sha1').update(Buffer.from(packBody)).digest();
  result.set(newTrailer, result.length - 20);
  return result;
};

/** Reconstruct the human-readable lines git bundle verify emits from structured fields. */
const reconstructVerifyLines = (
  result: Awaited<ReturnType<typeof bundleVerify>>,
): readonly string[] => {
  const lines: string[] = [];
  if (!result.recordsCompleteHistory) {
    const count = result.prerequisites.length;
    const noun = count === 1 ? 'this ref' : `these ${count} refs`;
    lines.push(`The bundle requires ${noun}:`);
    for (const p of result.prerequisites) {
      lines.push(`-${p.oid} ${p.comment}`);
    }
  } else {
    lines.push('The bundle records a complete history.');
  }
  lines.push(`The bundle uses this hash algorithm: ${result.hashAlgorithm}`);
  return lines;
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)('bundle interop', () => {
  let pair: PeerPair;
  let pairCriss: PeerPair;
  let cloneDir: string;
  /** Subdirectory within pair.peer for all bundle scratch files accessible via ctx. */
  let bundleDir: string;
  /** Subdirectory within pairCriss.peer for bundle scratch files accessible via crissCross ctx. */
  let bundleDirCriss: string;

  // Main repo OIDs resolved in beforeAll
  let firstOid: string;
  let secondOid: string;
  let mainOid: string;
  let tagV10Oid: string;

  // Criss-cross OIDs
  let ccAOid: string;
  let ccBOid: string;

  const buildCommitEnv = (): NodeJS.ProcessEnv => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: '2005-04-07T22:13:13 +0200',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: '2005-04-07T22:13:13 +0200',
  });

  beforeAll(async () => {
    pair = await makePeerPair('bundle');
    pairCriss = await makePeerPair('bundle-criss');
    cloneDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bundle-clone-'));
    // Bundle scratch dirs live inside peer so NodeFileSystem containment passes for ctx.
    bundleDir = path.join(pair.peer, 'bundles');
    bundleDirCriss = path.join(pairCriss.peer, 'bundles');
    await mkdir(bundleDir, { recursive: true });
    await mkdir(bundleDirCriss, { recursive: true });

    const env = runGitEnv();
    const commitEnv = buildCommitEnv();

    // ──────────────────────────────────────────────────────────────────
    // Main repo: first→second→third→fourth on main; feature diverges at first.
    // Annotated tag v1.0 at second; lightweight tag 'light' at fourth.
    // 'first' commit has a multi-line subject (to pin foldSubject prerequisite comment parity with git).
    // ──────────────────────────────────────────────────────────────────
    const dir = pair.peer;

    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env });

    // Commit 'first' — multi-line subject (verifies foldSubject parity with git's format_subject)
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    writeFileSync(path.join(dir, 'b.txt'), 'world\n');
    runGit(['-C', dir, 'add', '-A'], { env });
    runGit(
      [
        '-C',
        dir,
        'commit',
        '-m',
        'First line of subject\nSecond line of subject\n\nBody paragraph here',
      ],
      { env: commitEnv },
    );
    firstOid = runGit(['-C', dir, 'rev-parse', 'HEAD'], { env }).trim();

    // Branch 'feature' at 'first', one commit
    runGit(['-C', dir, 'checkout', '-b', 'feature'], { env });
    writeFileSync(path.join(dir, 'f.txt'), 'feature\n');
    runGit(['-C', dir, 'add', '-A'], { env });
    runGit(['-C', dir, 'commit', '-m', 'add feature file'], { env: commitEnv });

    // Back to main
    runGit(['-C', dir, 'checkout', 'main'], { env });

    // Commit 'second' — adds c.txt (a.txt and b.txt unchanged)
    writeFileSync(path.join(dir, 'c.txt'), 'second\n');
    runGit(['-C', dir, 'add', '-A'], { env });
    runGit(['-C', dir, 'commit', '-m', 'add second file'], { env: commitEnv });
    secondOid = runGit(['-C', dir, 'rev-parse', 'HEAD'], { env }).trim();

    // Annotated tag v1.0 at second
    runGit(['-C', dir, 'tag', '-a', 'v1.0', '-m', 'version 1.0'], { env: commitEnv });
    tagV10Oid = runGit(['-C', dir, 'rev-parse', 'refs/tags/v1.0'], { env }).trim();

    // Commit 'third' — adds d.txt
    writeFileSync(path.join(dir, 'd.txt'), 'third\n');
    runGit(['-C', dir, 'add', '-A'], { env });
    runGit(['-C', dir, 'commit', '-m', 'add third file'], { env: commitEnv });

    // Commit 'fourth' — modifies a.txt (proves prereq-blob exclusion in two-dot range)
    writeFileSync(path.join(dir, 'a.txt'), 'hello modified\n');
    runGit(['-C', dir, 'add', '-A'], { env });
    runGit(['-C', dir, 'commit', '-m', 'modify first file'], { env: commitEnv });
    mainOid = runGit(['-C', dir, 'rev-parse', 'HEAD'], { env }).trim();

    // Lightweight tag 'light' at HEAD (fourth)
    runGit(['-C', dir, 'tag', 'light'], { env });

    // ──────────────────────────────────────────────────────────────────
    // Criss-cross repo: O→A, O→B; M1=merge(A,B) on branch-a, M2=merge(B,A) on branch-b.
    // merge-base(M1, M2) = {A, B} — the two-merge-base (criss-cross) topology.
    // ──────────────────────────────────────────────────────────────────
    const ccDir = pairCriss.peer;

    runGit(['-C', ccDir, 'init', '-q', '-b', 'main'], { env });
    runGit(['-C', ccDir, 'config', 'user.name', 'Ada'], { env });
    runGit(['-C', ccDir, 'config', 'user.email', 'ada@example.com'], { env });
    runGit(['-C', ccDir, 'config', 'commit.gpgsign', 'false'], { env });
    runGit(['-C', ccDir, 'config', 'core.autocrlf', 'false'], { env });

    writeFileSync(path.join(ccDir, 'base.txt'), 'base\n');
    runGit(['-C', ccDir, 'add', '-A'], { env });
    runGit(['-C', ccDir, 'commit', '-m', 'O base'], { env: commitEnv });
    const ccOOid = runGit(['-C', ccDir, 'rev-parse', 'HEAD'], { env }).trim();

    // Branch-a: adds a.txt
    runGit(['-C', ccDir, 'checkout', '-b', 'branch-a'], { env });
    writeFileSync(path.join(ccDir, 'a.txt'), 'a\n');
    runGit(['-C', ccDir, 'add', '-A'], { env });
    runGit(['-C', ccDir, 'commit', '-m', 'A commit'], { env: commitEnv });
    ccAOid = runGit(['-C', ccDir, 'rev-parse', 'HEAD'], { env }).trim();

    // Branch-b: adds b.txt (from O, not from A)
    runGit(['-C', ccDir, 'checkout', '-b', 'branch-b', ccOOid], { env });
    writeFileSync(path.join(ccDir, 'b.txt'), 'b\n');
    runGit(['-C', ccDir, 'add', '-A'], { env });
    runGit(['-C', ccDir, 'commit', '-m', 'B commit'], { env: commitEnv });
    ccBOid = runGit(['-C', ccDir, 'rev-parse', 'HEAD'], { env }).trim();

    // M1 = merge branch-b into branch-a (parents: A, B)
    runGit(['-C', ccDir, 'checkout', 'branch-a'], { env });
    runGit(['-C', ccDir, 'merge', '--no-ff', '-m', 'M1 merge', 'branch-b'], {
      env: commitEnv,
    });

    // M2 = merge original A (ccAOid) into branch-b (parents: B, A)
    // Use the commit oid, not the branch name, so branch-a (now at M1) is not merged in
    runGit(['-C', ccDir, 'checkout', 'branch-b'], { env });
    runGit(['-C', ccDir, 'merge', '--no-ff', '-m', 'M2 merge', ccAOid], { env: commitEnv });
  }, 60_000);

  afterAll(async () => {
    await pair.dispose();
    await pairCriss.dispose();
    await rm(cloneDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 1: create header byte-golden parity vs real git
  // ─────────────────────────────────────────────────────────────────────

  describe('Given bundleCreate({ all: true }), When comparing to git bundle create --all', () => {
    it('Then the header bytes are byte-identical (refs sorted, HEAD last, annotated tag → tag-object oid)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin1-all.bundle');
      const gitBytes = gitBundleCreate(pair.peer, bundleFile, ['--all'], env);

      // Act
      const sut = await bundleCreate(ctx, { all: true });

      // Assert — headers byte-identical; annotated tag ref line carries tag-object oid
      expect(headerBytes(sut.bytes)).toEqual(headerBytes(gitBytes));
      const tagRef = sut.refs.find((r) => r.name === 'refs/tags/v1.0');
      expect(tagRef?.oid).toBe(tagV10Oid);
    });
  });

  const HEADER_BYTE_IDENTICAL_MATRIX: ReadonlyArray<{
    label: string;
    file: string;
    gitArgs: readonly string[];
    options: BundleCreateOptions;
  }> = [
    {
      label: 'single tip "refs/heads/main"',
      file: 'pin1-single.bundle',
      gitArgs: ['refs/heads/main'],
      options: { revs: [{ tip: 'refs/heads/main' }] },
    },
    {
      label: '{ branches: true }',
      file: 'pin1-branches.bundle',
      gitArgs: ['--branches'],
      options: { branches: true },
    },
    {
      label: '{ tags: true }',
      file: 'pin1-tags.bundle',
      gitArgs: ['--tags'],
      options: { tags: true },
    },
  ];

  describe('Given bundleCreate ref-selection variants, When comparing to the matching git bundle create flag', () => {
    it.each(HEADER_BYTE_IDENTICAL_MATRIX)(
      'Then the header bytes are byte-identical for $label',
      async ({ file, gitArgs, options }) => {
        // Arrange
        const ctx = createNodeContext({ workDir: pair.peer });
        const env = runGitEnv();
        const bundleFile = path.join(bundleDir, file);
        const gitBytes = gitBundleCreate(pair.peer, bundleFile, gitArgs, env);

        // Act
        const sut = await bundleCreate(ctx, options);

        // Assert
        expect(headerBytes(sut.bytes)).toEqual(headerBytes(gitBytes));
      },
    );
  });

  describe('Given bundleCreate two-dot range main~2..main, When comparing to git bundle create main~2..main', () => {
    it('Then the header bytes are byte-identical and prerequisites are oid-sorted', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin1-two-dot.bundle');
      const gitBytes = gitBundleCreate(pair.peer, bundleFile, ['main~2..main'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ range: ['main~2', 'main'] }],
      });

      // Assert — byte-identical headers; prerequisite is secondOid (= main~2)
      expect(headerBytes(sut.bytes)).toEqual(headerBytes(gitBytes));
      expect(sut.prerequisites).toHaveLength(1);
      expect(sut.prerequisites[0]?.oid).toBe(secondOid);
    });
  });

  describe('Given bundleCreate three-dot main...feature, When comparing to git bundle create main...feature', () => {
    it('Then header bytes are byte-identical to git and prerequisite comment is the folded first paragraph', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin1-three-dot.bundle');
      const gitBytes = gitBundleCreate(pair.peer, bundleFile, ['main...feature'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ symmetricRange: ['main', 'feature'] }],
      });

      // Assert — header bytes byte-identical; prerequisite comment matches git's format_subject (%s),
      // which folds the whole first paragraph into a single line joined with spaces
      expect(headerBytes(sut.bytes)).toEqual(headerBytes(gitBytes));
      expect(sut.prerequisites).toHaveLength(1);
      expect(sut.prerequisites[0]?.oid).toBe(firstOid);
      expect(sut.prerequisites[0]?.comment).toBe('First line of subject Second line of subject');
      // Ref parity: same ref names and OIDs
      const gitHdr = parseBundleHeader(gitBytes, '<git>');
      const gitRefs = gitHdr.refs.map((r) => `${r.name as string} ${r.oid as string}`);
      const tsRefs = sut.refs.map((r) => `${r.name as string} ${r.oid as string}`);
      expect(tsRefs).toEqual(gitRefs);
    });
  });

  describe('Given bundleCreate ^-exclusion form (main ^main~2), When comparing to git bundle create main ^main~2', () => {
    it('Then header bytes are byte-identical to both git and the two-dot form (A..B ≡ ^A B)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin1-exclude.bundle');
      const gitBytes = gitBundleCreate(pair.peer, bundleFile, ['main', '^main~2'], env);
      const twoDotFile = path.join(bundleDir, 'pin1-two-dot-eq.bundle');
      const gitTwoDot = gitBundleCreate(pair.peer, twoDotFile, ['main~2..main'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ tip: 'main' }, { exclude: 'main~2' }],
      });

      // Assert — byte-identical to git's exclude form AND to git's two-dot form
      expect(headerBytes(sut.bytes)).toEqual(headerBytes(gitBytes));
      expect(headerBytes(sut.bytes)).toEqual(headerBytes(gitTwoDot));
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 2: three-dot / merge-base prerequisite parity (oid-sorted)
  // ─────────────────────────────────────────────────────────────────────

  describe('Given bundleCreate three-dot main...feature, When inspecting prerequisite ordering', () => {
    it('Then prerequisites are oid-sorted ascending and match git', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin2-single-base.bundle');
      const gitBytes = gitBundleCreate(pair.peer, bundleFile, ['main...feature'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ symmetricRange: ['main', 'feature'] }],
      });

      // Assert — oid-sorted; matches git's header prerequisites
      const gitHdr = parseBundleHeader(gitBytes, '<git>');
      const gitPrereqs = gitHdr.prerequisites.map((p) => p.oid as string);
      const tsPrereqs = sut.prerequisites.map((p) => p.oid as string);
      expect(tsPrereqs).toEqual([...tsPrereqs].sort());
      expect(tsPrereqs).toEqual(gitPrereqs);
    });
  });

  describe('Given bundleCreate criss-cross branch-a...branch-b (two merge-bases), When comparing prerequisites to git', () => {
    it('Then both merge-base prerequisites are oid-sorted and match git exactly', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pairCriss.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDirCriss, 'pin2-criss.bundle');
      const gitBytes = gitBundleCreate(pairCriss.peer, bundleFile, ['branch-a...branch-b'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ symmetricRange: ['branch-a', 'branch-b'] }],
      });

      // Assert — two prerequisites (A and B commits), oid-sorted ascending
      const gitHdr = parseBundleHeader(gitBytes, '<git>');
      const gitPrereqs = gitHdr.prerequisites.map((p) => p.oid as string);
      const tsPrereqs = sut.prerequisites.map((p) => p.oid as string);
      expect(tsPrereqs).toHaveLength(2);
      expect(tsPrereqs).toEqual([...tsPrereqs].sort());
      expect(new Set(tsPrereqs)).toEqual(new Set([ccAOid, ccBOid]));
      expect(tsPrereqs).toEqual(gitPrereqs);
    });
  });

  describe('Given bundleCreate explicit-exclude form vs three-dot criss-cross, When comparing', () => {
    it('Then explicit ^A ^B yields byte-identical headers and the same oid-sorted prerequisites as branch-a...branch-b', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pairCriss.peer });

      // Act — symmetric-range form
      const threeDot = await bundleCreate(ctx, {
        revs: [{ symmetricRange: ['branch-a', 'branch-b'] }],
      });

      // Act — explicit-exclude form (manually passing the two merge-base oids)
      const explicitExclude = await bundleCreate(ctx, {
        revs: [{ tip: 'branch-a' }, { tip: 'branch-b' }, { exclude: ccAOid }, { exclude: ccBOid }],
      });

      // Assert — same sorted prerequisites and byte-identical headers
      const threePrereqs = threeDot.prerequisites.map((p) => p.oid as string);
      const explicitPrereqs = explicitExclude.prerequisites.map((p) => p.oid as string);
      expect(explicitPrereqs).toEqual(threePrereqs);
      expect(headerBytes(threeDot.bytes)).toEqual(headerBytes(explicitExclude.bytes));
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 3: object-closure set parity (proves prereq-blob exclusion)
  // ─────────────────────────────────────────────────────────────────────

  describe('Given bundleCreate({ all: true }), When comparing pack object ids to git', () => {
    it('Then the oid sets are equal', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin3-all.bundle');
      const gitBytes = gitBundleCreate(pair.peer, bundleFile, ['--all'], env);

      // Act
      const sut = await bundleCreate(ctx, { all: true });

      // Assert — same oid sets
      const tsOids = await packOids(ctx, sut.bytes);
      const gitOids = await packOids(ctx, gitBytes);
      expect(tsOids).toEqual(gitOids);
    });
  });

  describe('Given bundleCreate two-dot main~2..main, When examining the pack object ids', () => {
    it('Then prerequisite commits are absent from the pack (prereq-blob exclusion); git accepts the bundle', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin3-two-dot.bundle');
      // Create git's bundle to confirm git agrees on what objects go in (written but pack not
      // parsed by tsgit — git creates thin packs for range bundles, which walkPackEntries cannot
      // resolve since it only looks within the pack bytes, not the repo object store).
      gitBundleCreate(pair.peer, bundleFile, ['main~2..main'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ range: ['main~2', 'main'] }],
      });

      // Assert — prerequisite commits absent from tsgit's pack
      const tsOids = await packOids(ctx, sut.bytes);
      expect(tsOids.has(firstOid)).toBe(false);
      expect(tsOids.has(secondOid)).toBe(false);
      expect(tsOids.has(mainOid)).toBe(true);

      // Cross-tool: git verifies tsgit's bundle (proves the closure is correct)
      const tsBundleFile = path.join(bundleDir, 'pin3-two-dot-ts.bundle');
      await writeFile(tsBundleFile, sut.bytes);
      const gitVerify = tryRunGit(['-C', pair.peer, 'bundle', 'verify', tsBundleFile], { env });
      expect(gitVerify.ok).toBe(true);
    });
  });

  describe('Given bundleCreate criss-cross branch-a...branch-b, When examining the pack object ids', () => {
    it('Then merge-base commits are absent from the pack; git accepts the bundle', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pairCriss.peer });
      const env = runGitEnv();
      // Create git's bundle (thin pack — cannot be compared with walkPackEntries directly).
      const gitBundleFile = path.join(bundleDirCriss, 'pin3-criss.bundle');
      gitBundleCreate(pairCriss.peer, gitBundleFile, ['branch-a...branch-b'], env);

      // Act
      const sut = await bundleCreate(ctx, {
        revs: [{ symmetricRange: ['branch-a', 'branch-b'] }],
      });

      // Assert — merge-base commits absent from tsgit's pack
      const tsOids = await packOids(ctx, sut.bytes);
      expect(tsOids.has(ccAOid)).toBe(false);
      expect(tsOids.has(ccBOid)).toBe(false);

      // Cross-tool: git verifies tsgit's bundle
      const tsBundleFile = path.join(bundleDirCriss, 'pin3-criss-ts.bundle');
      await writeFile(tsBundleFile, sut.bytes);
      const gitVerify = tryRunGit(['-C', pairCriss.peer, 'bundle', 'verify', tsBundleFile], {
        env,
      });
      expect(gitVerify.ok).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 4: tsgit create → real git consumes (verify + clone)
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a bundle tsgit creates with { all: true }, When real git consumes it', () => {
    it('Then git bundle verify passes and git clone succeeds with matching HEAD', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const sut = await bundleCreate(ctx, { all: true });
      const bundleFile = path.join(bundleDir, 'pin4-roundtrip.bundle');
      await writeFile(bundleFile, sut.bytes);
      const cloneTarget = path.join(cloneDir, 'clone-all');

      // Act — git bundle verify
      const verifyResult = tryRunGit(['bundle', 'verify', bundleFile], { env: runGitEnv() });

      // Assert — git accepts the bundle
      expect(verifyResult.ok).toBe(true);

      // Act — git clone from bundle
      runGit(['clone', bundleFile, cloneTarget], { env: runGitEnv() });
      const cloneHead = runGit(['-C', cloneTarget, 'rev-parse', 'HEAD'], {
        env: runGitEnv(),
      }).trim();

      // Assert — cloned HEAD matches original repo HEAD
      expect(cloneHead).toBe(mainOid);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 5: real git creates → tsgit reads (verify + listHeads)
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a bundle real git creates with --all (complete history), When tsgit reads it', () => {
    it('Then bundleVerify result reconstructs git bundle verify output; recordsCompleteHistory is true', async () => {
      // Arrange — use --all so git's pack is self-contained (no thin-pack REF_DELTAs).
      // Range bundles (e.g. main~2..main) produce thin packs where delta bases reference
      // prerequisite objects outside the pack; walkPackEntries cannot resolve those since it only
      // searches within the supplied pack bytes, not the repo object store.
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin5-git-created.bundle');
      gitBundleCreate(pair.peer, bundleFile, ['--all'], env);

      // Act — tsgit reads git's bundle
      const sut = await bundleVerify(ctx, { path: bundleFile });

      // Act — git verifies the same bundle
      const gitResult = tryRunGit(['bundle', 'verify', bundleFile], { env });

      // Assert — git accepts the bundle
      expect(gitResult.ok).toBe(true);

      // Assert — reconstructed output lines appear in git's stdout
      const reconstructed = reconstructVerifyLines(sut);
      for (const line of reconstructed) {
        expect(gitResult.stdout).toContain(line);
      }

      // Assert — complete-history bundle: no prerequisites, all refs present
      expect(sut.recordsCompleteHistory).toBe(true);
      expect(sut.prerequisites).toHaveLength(0);
      expect(sut.prerequisitesPresent).toBe(true);
      expect(sut.refs.some((r) => r.name === 'refs/heads/main')).toBe(true);
    });
  });

  describe('Given a bundle with a prerequisite, When tsgit verifies in a repo lacking the objects', () => {
    it('Then prerequisitesPresent is false and the missing oid is listed', async () => {
      // Arrange — create incremental bundle in main repo
      const mainCtx = createNodeContext({ workDir: pair.peer });
      const sut = await bundleCreate(mainCtx, {
        revs: [{ range: ['main~2', 'main'] }],
      });
      const bundleFile = path.join(pair.ours, 'pin5-missing-prereq.bundle');
      await writeFile(bundleFile, sut.bytes);

      // Use the ours scratch dir (no git objects) as the context for verify
      const emptyCtx = createNodeContext({ workDir: pair.ours });

      // Act
      const result = await bundleVerify(emptyCtx, { path: bundleFile });

      // Assert — missing prerequisite reported as structured data
      expect(result.prerequisitesPresent).toBe(false);
      expect(result.missingPrerequisites as readonly string[]).toContain(secondOid);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 6: verify full-pack-parse detects a corrupt entry
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a bundle with a corrupt pack entry byte and a recomputed (valid) SHA-1 trailer', () => {
    it('Then bundleVerify throws DECOMPRESS_FAILED (pack-entry inflate failure)', async () => {
      // Arrange — valid bundle, then flip one byte in pack data and fix the trailer
      const ctx = createNodeContext({ workDir: pair.peer });
      const result = await bundleCreate(ctx, { all: true });
      const hdr = parseBundleHeader(result.bytes, '<test>');
      const corrupt = corruptPackData(result.bytes, hdr.packOffset);
      const bundleFile = path.join(bundleDir, 'pin6-corrupt.bundle');
      await writeFile(bundleFile, corrupt);

      // Act
      let caught: unknown;
      try {
        await bundleVerify(ctx, { path: bundleFile });
      } catch (err) {
        caught = err;
      }

      // Assert — a TsgitError is thrown; its code is DECOMPRESS_FAILED (inflate failure on corrupt entry byte)
      expect(caught).toBeInstanceOf(TsgitError);
      const code = (caught as TsgitError).data.code;
      expect(code).toBe('DECOMPRESS_FAILED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 7: refusal parity
  // ─────────────────────────────────────────────────────────────────────

  describe('Given no rev-args (empty selection), When bundleCreate is called', () => {
    it('Then BUNDLE_EMPTY { reason: no-refs } is thrown, reconstructing "Refusing to create empty bundle."', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });

      // Act
      let caught: unknown;
      try {
        await bundleCreate(ctx, {});
      } catch (err) {
        caught = err;
      }

      // Assert — BUNDLE_EMPTY with no-refs reason
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BUNDLE_EMPTY');
      expect((data as { code: 'BUNDLE_EMPTY'; reason: string }).reason).toBe('no-refs');

      // Reconstruct "Refusing to create empty bundle." from the error code.
      // Use a real file path (not /dev/null — macOS git tries to create a lock file next to
      // the target, which fails on device nodes before printing the refusal message).
      const reconstructed = 'Refusing to create empty bundle.';
      const emptyTarget = path.join(bundleDir, 'empty-will-fail.bundle');
      const gitResult = tryRunGit(['-C', pair.peer, 'bundle', 'create', emptyTarget], {
        env: runGitEnv(),
      });
      expect(gitResult.stderr).toContain(reconstructed);
    });
  });

  describe('Given a bare-rev tip (main~1, no full ref name), When bundleCreate is called', () => {
    it('Then BUNDLE_EMPTY { reason: no-refs } is thrown (bare rev yields no ref line)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });

      // Act
      let caught: unknown;
      try {
        await bundleCreate(ctx, { revs: [{ tip: 'main~1' }] });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BUNDLE_EMPTY');
      expect((data as { code: 'BUNDLE_EMPTY'; reason: string }).reason).toBe('no-refs');
    });
  });

  describe('Given an unknown ref tip, When bundleCreate is called', () => {
    it('Then a REVPARSE error propagates (reconstructing git "unknown revision" diagnostic)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });

      // Act
      let caught: unknown;
      try {
        await bundleCreate(ctx, { revs: [{ tip: 'nonexistent-ref-xyz' }] });
      } catch (err) {
        caught = err;
      }

      // Assert — a resolution error propagates, NOT BUNDLE_EMPTY
      expect(caught).toBeInstanceOf(TsgitError);
      const code = (caught as TsgitError).data.code;
      expect(['REVPARSE_UNRESOLVED', 'REVPARSE_AMBIGUOUS', 'OBJECT_NOT_FOUND']).toContain(code);
    });
  });

  describe('Given a missing bundle file path, When bundleVerify is called', () => {
    it('Then BUNDLE_READ_FAILED is thrown, reconstructing git "could not open" error', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const missingPath = path.join(bundleDir, 'does-not-exist.bundle');

      // Act
      let caught: unknown;
      try {
        await bundleVerify(ctx, { path: missingPath });
      } catch (err) {
        caught = err;
      }

      // Assert — BUNDLE_READ_FAILED with the path embedded
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BUNDLE_READ_FAILED');
      expect((data as { code: 'BUNDLE_READ_FAILED'; path: string }).path).toBe(missingPath);

      // Reconstruct git's "could not open '<path>'" from the structured path field
      const reconstructed = `could not open '${missingPath}'`;
      const gitResult = tryRunGit(['bundle', 'verify', missingPath], { env: runGitEnv() });
      expect(gitResult.ok).toBe(false);
      expect(gitResult.stderr).toContain(reconstructed);
    });
  });

  describe('Given an unreadable (chmod 000) bundle file, When bundleVerify is called', () => {
    it('Then BUNDLE_READ_FAILED is thrown; git also fails on the same file', async () => {
      // Arrange — write non-empty content so git must actually read the bytes.
      // An empty (0-byte) chmod-000 file may report "does not look like a bundle" on macOS
      // (open() returns fd with 0 bytes readable) rather than "could not open".
      const ctx = createNodeContext({ workDir: pair.peer });
      const lockedFile = path.join(bundleDir, 'locked.bundle');
      writeFileSync(lockedFile, 'placeholder content\n');
      chmodSync(lockedFile, 0o000);

      let caught: unknown;
      try {
        // Act
        await bundleVerify(ctx, { path: lockedFile });
      } catch (err) {
        caught = err;
      } finally {
        chmodSync(lockedFile, 0o644);
      }

      // Assert — tsgit throws BUNDLE_READ_FAILED
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('BUNDLE_READ_FAILED');

      // Git also fails on the locked file (exact message is platform-dependent for chmod-000)
      const gitResult = tryRunGit(['bundle', 'verify', lockedFile], { env: runGitEnv() });
      expect(gitResult.ok).toBe(false);
      expect(gitResult.stderr).toContain(lockedFile);
    });
  });

  const BAD_HEADER_MATRIX: ReadonlyArray<{
    label: string;
    file: string;
    setup: (targetPath: string) => Promise<void>;
  }> = [
    {
      label: 'directory path',
      file: 'a-directory',
      setup: async (targetPath) => {
        await mkdir(targetPath, { recursive: true });
      },
    },
    {
      label: 'plain-text (non-bundle) file',
      file: 'plain.txt',
      setup: async (targetPath) => {
        writeFileSync(targetPath, 'this is not a bundle file\n');
      },
    },
  ];

  describe('Given a bad-header path passed to bundleVerify (directory or plain-text file)', () => {
    it.each(BAD_HEADER_MATRIX)(
      'Then BUNDLE_BAD_HEADER is thrown, reconstructing git "does not look like" error for $label',
      async ({ file, setup }) => {
        // Arrange
        const ctx = createNodeContext({ workDir: pair.peer });
        const targetPath = path.join(bundleDir, file);
        await setup(targetPath);

        // Act
        let caught: unknown;
        try {
          await bundleVerify(ctx, { path: targetPath });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('BUNDLE_BAD_HEADER');

        const gitResult = tryRunGit(['bundle', 'verify', targetPath], { env: runGitEnv() });
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('does not look like a v2 or v3 bundle file');
      },
    );
  });

  describe('Given a hand-crafted # v3 git bundle file, When bundleVerify is called', () => {
    it('Then BUNDLE_UNSUPPORTED_VERSION { version: 3 } is thrown — intentional divergence from git 2.54.0', async () => {
      // Intentional divergence: git 2.54.0 successfully reads a forced v3-sha1 bundle
      // because it recognises @object-format=sha1 as a known capability. tsgit
      // deliberately refuses ALL v3 bundles at the parse layer to avoid silently
      // ignoring unknown future capability lines. This is NOT a faithfulness bug —
      // it is the documented, intentional policy for v3 support. git 2.54.0 accepting
      // a v3 bundle while tsgit refuses is the ONE sanctioned divergence.

      // Arrange — minimal syntactically plausible v3 header (no valid pack after it)
      const ctx = createNodeContext({ workDir: pair.peer });
      const v3Header = '# v3 git bundle\n@object-format=sha1\n\n';
      const v3File = path.join(bundleDir, 'v3.bundle');
      writeFileSync(v3File, Buffer.from(v3Header, 'utf8'));

      // Act
      let caught: unknown;
      try {
        await bundleVerify(ctx, { path: v3File });
      } catch (err) {
        caught = err;
      }

      // Assert — tsgit refuses with BUNDLE_UNSUPPORTED_VERSION { version: 3 }
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BUNDLE_UNSUPPORTED_VERSION');
      expect((data as { code: 'BUNDLE_UNSUPPORTED_VERSION'; version: number }).version).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 8: listHeads exact ref-name prefix filtering matches git
  // ─────────────────────────────────────────────────────────────────────

  describe('Given bundleListHeads with no filter', () => {
    it('Then all refs from the bundle header are returned in order', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const created = await bundleCreate(ctx, { all: true });
      const bundleFile = path.join(bundleDir, 'pin8.bundle');
      await writeFile(bundleFile, created.bytes);

      // Act
      const sut = await bundleListHeads(ctx, { path: bundleFile });

      // Assert — all refs returned in the same order as the bundle header
      const names = sut.refs.map((r) => r.name as string);
      const expected = created.refs.map((r) => r.name as string);
      expect(names).toEqual(expected);
    });
  });

  describe('Given bundleListHeads with exact full-name filter ["refs/tags/v1.0"]', () => {
    it('Then only refs/tags/v1.0 is returned (exact-match)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const created = await bundleCreate(ctx, { all: true });
      const bundleFile = path.join(bundleDir, 'pin8-filter.bundle');
      await writeFile(bundleFile, created.bytes);

      // Act
      const sut = await bundleListHeads(ctx, {
        path: bundleFile,
        names: ['refs/tags/v1.0' as RefName],
      });

      // Assert — exactly one ref
      expect(sut.refs).toHaveLength(1);
      expect(sut.refs[0]?.name).toBe('refs/tags/v1.0');
    });
  });

  describe('Given bundleListHeads with near-miss partial names ["v1.0", "tags/v1.0", "main"]', () => {
    it('Then no refs are returned (partial names do not match full ref names, matching git)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const created = await bundleCreate(ctx, { all: true });
      const bundleFile = path.join(bundleDir, 'pin8-near-miss.bundle');
      await writeFile(bundleFile, created.bytes);

      // Act
      const byShortTag = await bundleListHeads(ctx, {
        path: bundleFile,
        names: ['v1.0' as RefName],
      });
      const byPartialPath = await bundleListHeads(ctx, {
        path: bundleFile,
        names: ['tags/v1.0' as RefName],
      });
      const byBranchShort = await bundleListHeads(ctx, {
        path: bundleFile,
        names: ['main' as RefName],
      });

      // Assert — all near-miss filters return empty (full ref path required)
      expect(byShortTag.refs).toHaveLength(0);
      expect(byPartialPath.refs).toHaveLength(0);
      expect(byBranchShort.refs).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 9: hash-algorithm field
  // ─────────────────────────────────────────────────────────────────────

  describe('Given bundleVerify on a v2 git bundle', () => {
    it('Then hashAlgorithm is "sha1", reconstructing "The bundle uses this hash algorithm: sha1"', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const created = await bundleCreate(ctx, { branches: true });
      const bundleFile = path.join(bundleDir, 'pin9-hash.bundle');
      await writeFile(bundleFile, created.bytes);

      // Act
      const sut = await bundleVerify(ctx, { path: bundleFile });

      // Assert — structured field
      expect(sut.hashAlgorithm).toBe('sha1');

      // Reconstruct git's human-readable line from the structured field
      const reconstructed = `The bundle uses this hash algorithm: ${sut.hashAlgorithm}`;
      expect(reconstructed).toBe('The bundle uses this hash algorithm: sha1');

      // Verify git also emits this line
      const gitOut = tryRunGit(['bundle', 'verify', bundleFile], { env: runGitEnv() });
      expect(gitOut.stdout).toContain(reconstructed);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 10: tsgit verifies git-created incremental (thin) bundle
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a git-created incremental bundle (thin pack) with prerequisites present in the verifying repo', () => {
    it('Then tsgit bundleVerify succeeds with prerequisitesPresent:true and git also accepts the bundle', async () => {
      // Arrange — git creates an incremental bundle; its pack is thin (delta bases are
      // prerequisite objects outside the pack body). Verify against the full repo where
      // all prerequisite objects are present.
      const ctx = createNodeContext({ workDir: pair.peer });
      const env = runGitEnv();
      const bundleFile = path.join(bundleDir, 'pin10-thin-present.bundle');
      // main~2..main includes file modifications so git produces real deltas.
      gitBundleCreate(pair.peer, bundleFile, ['main~2..main'], env);

      // Act
      const sut = await bundleVerify(ctx, { path: bundleFile });

      // Assert — tsgit accepts the thin bundle
      expect(sut.prerequisitesPresent).toBe(true);
      expect(sut.missingPrerequisites).toHaveLength(0);
      expect(sut.recordsCompleteHistory).toBe(false);
      expect(sut.prerequisites).toHaveLength(1);
      expect(sut.prerequisites[0]?.oid as string).toBe(secondOid);

      // git also accepts the same bundle (verdicts match)
      const gitResult = tryRunGit(['-C', pair.peer, 'bundle', 'verify', bundleFile], { env });
      expect(gitResult.ok).toBe(true);
      // git prints hash algorithm line in its verify output (stdout or stderr)
      const gitOutput = gitResult.stdout + gitResult.stderr;
      expect(gitOutput).toContain('The bundle uses this hash algorithm: sha1');
    });
  });

  describe('Given a git-created incremental bundle (thin pack) with prerequisites absent from the verifying repo', () => {
    it('Then tsgit bundleVerify reports prerequisitesPresent:false with missing oids and git also refuses', async () => {
      // Arrange — create the incremental bundle in the full repo, then copy it
      // to an initialised-but-empty scratch repo so both tsgit and git can run
      // bundle verify from a valid (but object-less) git repository.
      const env = runGitEnv();
      const gitBundleFile = path.join(bundleDir, 'pin10-thin-absent-src.bundle');
      const bundleBytes = gitBundleCreate(pair.peer, gitBundleFile, ['main~2..main'], env);
      const bundleFile = path.join(pair.ours, 'pin10-thin-absent.bundle');
      await writeFile(bundleFile, bundleBytes);

      // Initialise pair.ours as a git repo so git bundle verify can run there
      runGit(['init', '-q', '-b', 'main', pair.ours], { env });
      const emptyCtx = createNodeContext({ workDir: pair.ours });

      // Act
      const result = await bundleVerify(emptyCtx, { path: bundleFile });

      // Assert — tsgit reports missing prerequisite
      expect(result.prerequisitesPresent).toBe(false);
      expect(result.missingPrerequisites.length).toBeGreaterThan(0);
      expect((result.missingPrerequisites as readonly string[]).includes(secondOid)).toBe(true);

      // git also refuses (missing prerequisites)
      const gitResult = tryRunGit(['-C', pair.ours, 'bundle', 'verify', bundleFile], { env });
      expect(gitResult.ok).toBe(false);
      expect(gitResult.stderr).toContain(secondOid);
    });
  });
});

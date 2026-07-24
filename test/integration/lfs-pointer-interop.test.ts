/**
 * Cross-tool interop — git-lfs pointer blob diff with no active filter driver.
 *
 * Builds one shared repository with canonical git (deterministic dates, signing
 * off, isolated HOME so NO global filter.lfs.* or diff.lfs.* driver engages).
 * Commits a sequence of pointer blobs and opens the SAME repo through
 * `openRepository` to prove tsgit's structured diff is byte-faithful to
 * filter-less git across the full matrix:
 *
 *   1. pointer ADD    — a 3-line pointer blob is a new `add` change;
 *   2. pointer MODIFY — oid+size bump is a text `modify` change;
 *   3. pointer→real   — path stops being lfs-tracked: `modify` whose new side
 *                       is the real content;
 *   4. declared-but-inert — `.gitattributes` names `diff=lfs` but no driver is
 *                       installed in the isolated HOME: git falls back to text
 *                       diff and tsgit matches.
 *
 * Each row reconstructs git's `--name-status` / `--numstat` / patch from the
 * structured `TreeDiff`/`StatTreeDiff` and compares to live `git diff` in the
 * isolated env. The library emits no rendered line; faithfulness is reconstructed
 * from the structured fields.
 *
 * Isolation is load-bearing: `runGit` from interop-helpers scrubs all `GIT_*`
 * env vars, points `HOME` at a non-existent path, and sets `GIT_CONFIG_NOSYSTEM=1`
 * — no global/system/XDG git config (and no git-lfs driver) engages.
 *
 * @proves
 *   surface:        diff
 *   bucket:         cross-tool-interop
 *   unique:         LFS pointer text diff matches filter-less git baseline (add / modify / pointer-to-real / declared-but-inert)
 *   interopSurface: diff
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { diff } from '../../src/application/commands/diff.js';
import type { StatTreeDiff, TreeDiff } from '../../src/domain/diff/index.js';
import { openRepository } from '../../src/index.node.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

/** Hand-authored v1 pointer blob — the three-line text format git-lfs writes. */
const LFS_POINTER_V1 =
  'version https://git-lfs.github.com/spec/v1\n' +
  'oid sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899\n' +
  'size 1024\n';

/** Second pointer (oid+size bump) for the modify case. */
const LFS_POINTER_V2 =
  'version https://git-lfs.github.com/spec/v1\n' +
  'oid sha256:ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100\n' +
  'size 2048\n';

/** Real file content that replaces a pointer (pointer→real case). */
const REAL_FILE_CONTENT = 'real binary-ish content\n';

/** `.gitattributes` that declares lfs tracking on `*.bin` paths. */
const GITATTRIBUTES_LFS = '*.bin filter=lfs diff=lfs -text\n';

/** Derive name-status-style strings from a TreeDiff or StatTreeDiff. */
const nameStatusFrom = (treeDiff: TreeDiff | StatTreeDiff): string[] =>
  treeDiff.changes.map((c) => {
    if (c.type === 'modify') return `M\t${c.path}`;
    if (c.type === 'add') return `A\t${c.newPath}`;
    if (c.type === 'delete') return `D\t${c.oldPath}`;
    if (c.type === 'rename') return `R100\t${c.oldPath}\t${c.newPath}`;
    if (c.type === 'copy') return `C100\t${c.oldPath}\t${c.newPath}`;
    return `T\t${c.path}`;
  });

/** Return the display path for a stat change. */
const statChangePath = (c: StatTreeDiff['changes'][number]): string => {
  if (c.type === 'rename' || c.type === 'copy') return c.newPath;
  if (c.type === 'add') return c.newPath;
  if (c.type === 'delete') return c.oldPath;
  return c.path;
};

/** True when both old and new modes are the same (add/delete have only one mode). */
const hasSameModes = (c: StatTreeDiff['changes'][number]): boolean => {
  if (c.type === 'add' || c.type === 'delete') return false;
  return c.oldMode === c.newMode;
};

/** Apply git's numstat omit rule: all-zero counts + same-mode changes are omitted. */
const numstatRowsFrom = (treeDiff: StatTreeDiff): string[] =>
  treeDiff.changes
    .filter((c) => !(c.added === 0 && c.deleted === 0 && !c.binary && hasSameModes(c)))
    .map((c) => {
      const p = statChangePath(c);
      if (c.binary) return `-\t-\t${p}`;
      return `${c.added}\t${c.deleted}\t${p}`;
    });

// --- Shared fixture repo ---

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;
let ctx: ReturnType<typeof createNodeContext>;

interface CommitPair {
  readonly from: string;
  readonly to: string;
}

let pointerAdd: CommitPair;
let pointerModify: CommitPair;
let pointerToReal: CommitPair;
let declaredButInert: CommitPair;

describe.skipIf(!GIT_AVAILABLE)('lfs pointer diff interop — filter-less git baseline', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-lfs-interop-')));
    runGit(['init', '-q', '-b', 'main', dir]);

    let epoch = 1_700_020_000;
    const nextEpoch = (): number => (epoch += 1);

    const doCommit = (message: string): string => {
      runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(nextEpoch()) });
      return git(dir, 'rev-parse', 'HEAD').trim();
    };

    // Seed commit — unrelated file so repo is non-empty before pointer add.
    await writeFile(path.join(dir, 'initial.txt'), 'initial content\n');
    git(dir, 'add', 'initial.txt');
    const c0 = doCommit('initial');

    // 1. pointer ADD — commit v1 pointer blob at data.bin (no .gitattributes).
    await writeFile(path.join(dir, 'data.bin'), LFS_POINTER_V1);
    git(dir, 'add', 'data.bin');
    const c1 = doCommit('pointer add');
    pointerAdd = { from: c0, to: c1 };

    // 2. pointer MODIFY — bump oid+size to v2.
    await writeFile(path.join(dir, 'data.bin'), LFS_POINTER_V2);
    git(dir, 'add', 'data.bin');
    const c2 = doCommit('pointer modify');
    pointerModify = { from: c1, to: c2 };

    // 3. pointer → real file — replace pointer blob with real content, still no filter.
    await writeFile(path.join(dir, 'data.bin'), REAL_FILE_CONTENT);
    git(dir, 'add', 'data.bin');
    const c3 = doCommit('pointer to real');
    pointerToReal = { from: c2, to: c3 };

    // 4. declared-but-inert — commit .gitattributes naming filter=lfs diff=lfs alongside
    //    a pointer at tracked.bin.  No driver is installed in the isolated HOME, so git
    //    falls back to built-in text diff and shows the pointer bytes as plain text.
    await writeFile(path.join(dir, 'tracked.bin'), LFS_POINTER_V1);
    await writeFile(path.join(dir, '.gitattributes'), GITATTRIBUTES_LFS);
    git(dir, 'add', 'tracked.bin');
    git(dir, 'add', '.gitattributes');
    const c4 = doCommit('inert: gitattributes + tracked pointer');
    declaredButInert = { from: c3, to: c4 };

    repo = await openRepository({ cwd: dir });
    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await repo.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given a commit that adds a git-lfs pointer blob at data.bin', () => {
    describe('When diff is called', () => {
      it('Then the structured change is type add for data.bin', async () => {
        // Arrange
        const { from, to } = pointerAdd;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        const dataBinChange = result.changes.find(
          (c) => c.type === 'add' && c.newPath === 'data.bin',
        );
        expect(dataBinChange).toBeDefined();
        expect(dataBinChange?.type).toBe('add');
      });
    });
  });

  // pointer-modify (oid+size bump) and pointer-to-real drive the identical
  // single-change assertion shape, differing only in the commit pair.
  const MODIFY_STRUCTURED_TYPE_MATRIX: ReadonlyArray<{
    label: string;
    fixture: () => CommitPair;
  }> = [
    { label: 'pointer modify (oid+size bump)', fixture: () => pointerModify },
    { label: 'pointer to real content', fixture: () => pointerToReal },
  ];

  describe('Given a commit that produces a single modify change (oid+size bump or pointer→real)', () => {
    describe('When diff is called', () => {
      it.each(MODIFY_STRUCTURED_TYPE_MATRIX)(
        'Then the structured change is type modify for data.bin ($label)',
        async ({ fixture }) => {
          // Arrange
          const { from, to } = fixture();

          // Act
          const result = await repo.diff({ from, to });

          // Assert
          expect(result.changes).toHaveLength(1);
          const change = result.changes[0];
          expect(change?.type).toBe('modify');
          if (change?.type !== 'modify') return;
          expect(change.path).toBe('data.bin');
        },
      );
    });
  });

  // add / modify / pointer-to-real each produce exactly one change, so
  // name-status and numstat compare directly without needing a sort.
  const SINGLE_CHANGE_MATRIX: ReadonlyArray<{ label: string; fixture: () => CommitPair }> = [
    { label: 'pointer add', fixture: () => pointerAdd },
    { label: 'pointer modify', fixture: () => pointerModify },
    { label: 'pointer to real', fixture: () => pointerToReal },
  ];

  describe('Given the three commit pairs that produce a single tree-diff change (add / modify / pointer-to-real)', () => {
    describe('When diff --name-status is compared to git', () => {
      it.each(SINGLE_CHANGE_MATRIX)(
        'Then name-status matches git diff --name-status ($label)',
        async ({ fixture }) => {
          // Arrange
          const { from, to } = fixture();
          const peer = git(dir, 'diff', '--no-ext-diff', '--name-status', from, to).trim();

          // Act
          const result = await repo.diff({ from, to });
          const ours = nameStatusFrom(result).join('\n');

          // Assert
          expect(ours).toBe(peer);
        },
      );
    });

    describe('When diff --numstat is compared to git', () => {
      it.each(SINGLE_CHANGE_MATRIX)(
        'Then numstat matches git diff --numstat ($label)',
        async ({ fixture }) => {
          // Arrange
          const { from, to } = fixture();
          const peer = git(dir, 'diff', '--no-ext-diff', '--numstat', from, to).trim();

          // Act
          const result = await diff(ctx, { from, to, withStat: true });
          const ours = numstatRowsFrom(result).join('\n');

          // Assert
          expect(ours).toBe(peer);
        },
      );
    });
  });

  // The reconstructed-patch oracle is identical across all four scenarios —
  // declared-but-inert included, since git's own patch output preserves path
  // order regardless of how many paths changed.
  const ALL_FIXTURES_MATRIX: ReadonlyArray<{ label: string; fixture: () => CommitPair }> = [
    ...SINGLE_CHANGE_MATRIX,
    {
      label: 'declared-but-inert (gitattributes + tracked pointer)',
      fixture: () => declaredButInert,
    },
  ];

  describe('Given all four pointer-diff commit pairs (add / modify / pointer-to-real / declared-but-inert)', () => {
    describe('When the reconstructed patch is compared to git diff --no-ext-diff', () => {
      it.each(ALL_FIXTURES_MATRIX)(
        'Then reconstructed patch matches git diff --no-ext-diff byte-for-byte ($label)',
        async ({ fixture }) => {
          // Arrange
          const { from, to } = fixture();
          const peer = git(dir, 'diff', '--no-ext-diff', '--no-color', from, to);

          // Act
          const treeDiff = await diff(ctx, { from, to });
          const result = await reconstructPatch(ctx, treeDiff);

          // Assert
          expect(result).toBe(peer);
        },
      );
    });
  });

  describe('Given a committed .gitattributes naming diff=lfs with no driver installed', () => {
    describe('When diff is called for the commit that adds .gitattributes and tracked.bin', () => {
      it('Then both .gitattributes and tracked.bin are add changes', async () => {
        // Arrange
        const { from, to } = declaredButInert;

        // Act
        const result = await repo.diff({ from, to });

        // Assert — git falls back to text diff; pointer bytes show as plain text
        const paths = result.changes
          .filter((c) => c.type === 'add')
          .map((c) => (c.type === 'add' ? c.newPath : ''))
          .sort();
        expect(paths).toEqual(['.gitattributes', 'tracked.bin']);
      });

      it('Then name-status matches git diff --name-status (A .gitattributes, A tracked.bin)', async () => {
        // Arrange
        const { from, to } = declaredButInert;
        const peer = git(dir, 'diff', '--no-ext-diff', '--name-status', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .sort()
          .join('\n');

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result).sort().join('\n');

        // Assert
        expect(ours).toBe(peer);
      });

      it('Then numstat matches git diff --numstat (pointer lines counted as text)', async () => {
        // Arrange
        const { from, to } = declaredButInert;
        const peer = git(dir, 'diff', '--no-ext-diff', '--numstat', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .sort()
          .join('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });
        const ours = numstatRowsFrom(result).sort().join('\n');

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

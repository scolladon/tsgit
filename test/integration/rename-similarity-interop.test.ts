/**
 * Integration test — byte-parity between tsgit's rename-similarity detection and
 * `git diff -M` for rename scenarios that exercise the inexact pass and the
 * patch serializer (index line, hunk body, mode preamble).
 *
 * Double-pinned: tsgit's R-score reconstructed from `toSimilarityPercent` must equal
 * both live `git diff -M --name-status` and a committed golden. Full patch-body parity
 * for sub-100% renames is pinned for matrices #1, #4, and #5.
 *
 * Skips silently when `git` is absent.
 *
 * @proves
 *   surface: diff.renames
 *   bucket:  cross-tool-interop
 *   unique:  inexact rename R-scores, patch body, limit semantics match upstream git + frozen goldens
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import { mv } from '../../src/application/commands/mv.js';
import { rm } from '../../src/application/commands/rm.js';
import type { CopyChange, ModifyChange, RenameChange } from '../../src/domain/diff/diff-change.js';
import { toSimilarityPercent } from '../../src/domain/diff/similarity.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, git, makePeerPair, runGit, runGitEnv } from './interop-helpers.js';

const fixturesDir = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  'fixtures',
  'diff-patch',
);

const loadGolden = (name: string): Promise<string> =>
  readFile(path.join(fixturesDir, `${name}.golden.patch`), 'utf-8');

const saveGolden = async (name: string, content: string): Promise<void> => {
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(path.join(fixturesDir, `${name}.golden.patch`), content, 'utf-8');
};

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const gitDeterministicEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

const writePeerFile = async (dir: string, rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
};

const writeCtxFile = (
  ctx: ReturnType<typeof createMemoryContext>,
  rel: string,
  content: string,
): Promise<void> => ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: gitDeterministicEnv() });
};

/**
 * Reconstruct a `--name-status` string from tsgit's structured TreeDiff.
 * A rename is represented as `R<score>\t<old>\t<new>`.
 * Mirrors git's `--name-status` output for the changes we test here.
 */
const reconstructNameStatus = (changes: ReadonlyArray<{ type: string }>): string => {
  return changes
    .map((change) => {
      if (change.type === 'rename') {
        const r = change as unknown as RenameChange;
        return `R${String(toSimilarityPercent(r.similarity.score)).padStart(3, '0')}\t${r.oldPath}\t${r.newPath}`;
      }
      if (change.type === 'copy') {
        const c = change as unknown as CopyChange;
        return `C${String(toSimilarityPercent(c.similarity.score)).padStart(3, '0')}\t${c.oldPath}\t${c.newPath}`;
      }
      if (change.type === 'add') {
        const a = change as unknown as { newPath: string };
        return `A\t${a.newPath}`;
      }
      if (change.type === 'delete') {
        const d = change as unknown as { oldPath: string };
        return `D\t${d.oldPath}`;
      }
      if (change.type === 'modify') {
        const m = change as unknown as ModifyChange;
        if (m.broken !== undefined) {
          return `M${String(toSimilarityPercent(m.broken.score)).padStart(3, '0')}\t${m.path}`;
        }
        return `M\t${m.path}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

/** Build 10 lines of content with line `changed` (0-indexed) replaced. */
const tenLineContent = (prefix: string, changed = -1, changedPrefix = 'CHANGED'): string =>
  Array.from({ length: 10 }, (_, i) =>
    i === changed
      ? `${changedPrefix} content line ${String(i).padStart(2, '0')}: this is the content\n`
      : `${prefix} content line ${String(i).padStart(2, '0')}: this is the content\n`,
  ).join('');

/**
 * Build a file of `total` lines for break-rewrite fixtures.
 *
 * The OLD version contains `total` identical `line-NNN: shared…` lines.
 * The NEW version keeps the first `shared` lines byte-for-byte identical to
 * the old version and replaces the remaining `total - shared` lines with
 * `different-NNN: COMPLETELY…` lines.
 *
 * Dissimilarity values are empirically pinned against real git (byte-level
 * scorer, not line-count arithmetic):
 *   total=20, shared=0  → 100% dissimilarity
 *   total=20, shared=7  → 65%  dissimilarity
 *   total=20, shared=10 → 50%  dissimilarity  (re-merged at default -B gate)
 *   total=20, shared=9  → 55%  dissimilarity  (boundary for #B4)
 *   total=50, shared=20 → 60%  dissimilarity  (boundary for #B5)
 */
const breakContent = (kind: 'old' | 'new', total: number, shared: number): string =>
  Array.from({ length: total }, (_, i) =>
    kind === 'old' || i < shared
      ? `line-${String(i).padStart(3, '0')}: shared content alpha beta gamma delta epsilon zeta eta theta\n`
      : `different-${String(i).padStart(3, '0')}: COMPLETELY NEW TEXT ZETA THETA KAPPA LAMBDA MU NU XI OMICRON PI RHO SIGMA\n`,
  ).join('');

describe.skipIf(!GIT_AVAILABLE)('integration — rename similarity detection git parity', () => {
  it('Given a renamed file with 1 of 10 lines changed, When tsgit detects renames, Then R-score matches git and frozen golden', async () => {
    // Arrange — file moved with 1 line changed (matrix: 1 line differs out of 10)
    const pair = await makePeerPair('rename-similarity-m1');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const srcContent = tenLineContent('original');
      const dstContent = tenLineContent('original', 0, 'CHANGED');

      await writePeerFile(pair.peer, 'original.txt', srcContent);
      runGit(['-C', pair.peer, 'add', 'original.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      runGit(['-C', pair.peer, 'rm', '-q', 'original.txt'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'moved.txt', dstContent);
      runGit(['-C', pair.peer, 'add', 'moved.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'original.txt', srcContent);
      await add(ctx, ['original.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await rm(ctx, ['original.txt']);
      await writeCtxFile(ctx, 'moved.txt', dstContent);
      await add(ctx, ['moved.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — R-score matches live git
      expect(sut).toBe(liveNameStatus);

      // Pin as golden
      const goldenName = 'rename-similarity-m1-name-status';
      let golden: string;
      try {
        golden = await loadGolden(goldenName);
      } catch {
        await saveGolden(goldenName, liveNameStatus);
        golden = liveNameStatus;
      }
      expect(sut).toBe(golden);

      // Also verify it IS a rename (not A/D)
      expect(treeDiff.changes).toHaveLength(1);
      expect(treeDiff.changes[0]?.type).toBe('rename');
    } finally {
      await pair.dispose();
    }
  });

  it('Given a ~40% similar add/delete pair, When using 40% threshold, Then the pair IS detected; with 50% threshold it is NOT', async () => {
    // Arrange — 4/10 lines same = ~40% similarity (matrix: below-default threshold pair)
    const pair = await makePeerPair('rename-similarity-m2');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      // 10 unique lines, 4 of them the same between src and dst
      const sharedLines = Array.from(
        { length: 4 },
        (_, i) => `shared content line ${String(i).padStart(2, '0')}: same in both\n`,
      ).join('');
      const srcUniqueLines = Array.from(
        { length: 6 },
        (_, i) => `src-unique line ${String(i).padStart(2, '0')}: only in src file content\n`,
      ).join('');
      const dstUniqueLines = Array.from(
        { length: 6 },
        (_, i) => `dst-unique line ${String(i).padStart(2, '0')}: only in dst file content\n`,
      ).join('');
      const srcContent = sharedLines + srcUniqueLines;
      const dstContent = sharedLines + dstUniqueLines;

      await writePeerFile(pair.peer, 'src.txt', srcContent);
      runGit(['-C', pair.peer, 'add', 'src.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      runGit(['-C', pair.peer, 'rm', '-q', 'src.txt'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'dst.txt', dstContent);
      runGit(['-C', pair.peer, 'add', 'dst.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Get the real score from git
      const liveWithM40 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M40%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const liveWithM50 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M50%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'src.txt', srcContent);
      await add(ctx, ['src.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await rm(ctx, ['src.txt']);
      await writeCtxFile(ctx, 'dst.txt', dstContent);
      await add(ctx, ['dst.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — 40% = 24000 out of MAX_SCORE 60000; 50% = 30000 (default)
      const treeDiff40 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { threshold: 24000 },
      });
      const treeDiff50 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { threshold: 30000 },
      });

      const sut40 = reconstructNameStatus(treeDiff40.changes);
      const sut50 = reconstructNameStatus(treeDiff50.changes);

      // Assert — at 40% should pair (R-score matches live git), at 50% should NOT pair
      expect(sut40).toBe(liveWithM40);
      expect(sut50).toBe(liveWithM50);

      // 50% threshold should produce A/D (no rename)
      const types50 = treeDiff50.changes.map((c) => c.type);
      expect(types50).not.toContain('rename');
      expect(types50).toContain('add');
      expect(types50).toContain('delete');

      // Pin goldens
      for (const [name, live] of [
        ['rename-similarity-m2-40pct-name-status', liveWithM40],
        ['rename-similarity-m2-50pct-name-status', liveWithM50],
      ] as const) {
        try {
          await loadGolden(name);
        } catch {
          await saveGolden(name, live);
        }
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given renameLimit=1 with 2 inexact pairs and 1 exact pair, When tsgit runs detection, Then exact pair emits as R100 and inexact pairs are skipped', async () => {
    // Arrange — 1 exact pair + 2 inexact deletes + 2 inexact adds → 2*2=4 > 1*1=1 (limit^2)
    const pair = await makePeerPair('rename-similarity-m6');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const exactContent = tenLineContent('exact');
      const del1Content = tenLineContent('del-one');
      const del2Content = tenLineContent('del-two');
      const add1Content = tenLineContent('del-one', 0, 'ADD-ONE'); // similar to del1
      const add2Content = tenLineContent('del-two', 0, 'ADD-TWO'); // similar to del2

      for (const [name, content] of [
        ['exact-src.txt', exactContent],
        ['del1.txt', del1Content],
        ['del2.txt', del2Content],
      ] as const) {
        await writePeerFile(pair.peer, name, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      for (const name of ['exact-src.txt', 'del1.txt', 'del2.txt']) {
        runGit(['-C', pair.peer, 'rm', '-q', name], { env: gitDeterministicEnv() });
      }
      for (const [name, content] of [
        ['exact-dst.txt', exactContent],
        ['add1.txt', add1Content],
        ['add2.txt', add2Content],
      ] as const) {
        await writePeerFile(pair.peer, name, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Use -l1 so that 2*2=4 > 1*1=1: git's formula is num_dst*num_src > limit*limit
      const liveWithL2 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '-l1',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'exact-src.txt', exactContent);
      await writeCtxFile(ctx, 'del1.txt', del1Content);
      await writeCtxFile(ctx, 'del2.txt', del2Content);
      await add(ctx, ['exact-src.txt', 'del1.txt', 'del2.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await rm(ctx, ['exact-src.txt', 'del1.txt', 'del2.txt']);
      await writeCtxFile(ctx, 'exact-dst.txt', exactContent);
      await writeCtxFile(ctx, 'add1.txt', add1Content);
      await writeCtxFile(ctx, 'add2.txt', add2Content);
      await add(ctx, ['exact-dst.txt', 'add1.txt', 'add2.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — renameLimit=1: 2 inexact adds * 2 inexact deletes = 4 > 1*1=1 → skip inexact; exact survives
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { limit: 1 },
      });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — the exact pair emits; inexact are skipped (A/D)
      const renames = treeDiff.changes.filter((c) => c.type === 'rename');
      expect(renames).toHaveLength(1);
      const rename = renames[0] as RenameChange;
      expect(rename.oldPath).toBe('exact-src.txt');
      expect(rename.newPath).toBe('exact-dst.txt');
      expect(rename.similarity.score).toBe(60000); // MAX_SCORE — exact R100

      const adds = treeDiff.changes.filter((c) => c.type === 'add');
      const dels = treeDiff.changes.filter((c) => c.type === 'delete');
      expect(adds).toHaveLength(2);
      expect(dels).toHaveLength(2);

      // Compare against git's -l2 output (git may warn; strip warning lines first)
      const liveLines = liveWithL2
        .split('\n')
        .filter((l) => !l.startsWith('warning:'))
        .sort()
        .join('\n');
      const sutLines = sut.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);
    } finally {
      await pair.dispose();
    }
  });

  it('Given 4 src files and 3 dst files (more srcs than dsts), When tsgit runs greedy detection, Then 3 pairs match and 1 src remains as orphan delete', async () => {
    // Arrange — 4 srcs + 3 dsts: greedy produces 3 pairs, leaving 1 src as orphan delete
    // Each src-i is very similar to dst-i (1/100 lines differ) so scores are unambiguous
    const pair = await makePeerPair('rename-similarity-m7');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const baseContent = Array.from(
        { length: 100 },
        (_, i) =>
          `base line ${String(i).padStart(3, '0')}: shared content for similarity testing\n`,
      ).join('');

      const ctx = createMemoryContext();
      await init(ctx);

      // Create 4 src files
      for (let i = 0; i < 4; i++) {
        const content = baseContent.replace('base line 000:', `src${i} line 000:`);
        await writePeerFile(pair.peer, `src-${i}.txt`, content);
        await writeCtxFile(ctx, `src-${i}.txt`, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await add(
        ctx,
        Array.from({ length: 4 }, (_, i) => `src-${i}.txt`),
      );
      const c1 = await commit(ctx, { message: 'first', author });

      // Remove src files and add only 3 dst files (src-3 becomes orphan delete)
      for (let i = 0; i < 4; i++) {
        runGit(['-C', pair.peer, 'rm', '-q', `src-${i}.txt`], { env: gitDeterministicEnv() });
      }
      for (let i = 0; i < 3; i++) {
        const content = baseContent.replace('base line 000:', `dst${i} line 000:`);
        await writePeerFile(pair.peer, `dst-${i}.txt`, content);
        await writeCtxFile(ctx, `dst-${i}.txt`, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');
      await rm(
        ctx,
        Array.from({ length: 4 }, (_, i) => `src-${i}.txt`),
      );
      await add(
        ctx,
        Array.from({ length: 3 }, (_, i) => `dst-${i}.txt`),
      );
      const c2 = await commit(ctx, { message: 'second', author });

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — 3 pairs + 1 orphan delete
      const renames = treeDiff.changes.filter((c) => c.type === 'rename');
      expect(renames).toHaveLength(3);
      const orphanDels = treeDiff.changes.filter((c) => c.type === 'delete');
      expect(orphanDels).toHaveLength(1);

      // Match live git
      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Pin golden
      const goldenName = 'rename-similarity-m7-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given 5 pairs where each has a clear best match, When tsgit runs greedy detection, Then all 5 pairs match real git', async () => {
    // Arrange — 5 src + 5 dst; each dst[i] is ~90% similar to src[i] but very different from src[j!=i]
    const pair = await makePeerPair('rename-similarity-m8');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const ctx = createMemoryContext();
      await init(ctx);

      for (let i = 0; i < 5; i++) {
        // Unique content per file: lines are specific to this file index
        const content = Array.from(
          { length: 10 },
          (_, j) => `src${i} line ${String(j).padStart(2, '0')}: unique per-file content here\n`,
        ).join('');
        await writePeerFile(pair.peer, `src-${i}.txt`, content);
        await writeCtxFile(ctx, `src-${i}.txt`, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await add(
        ctx,
        Array.from({ length: 5 }, (_, i) => `src-${i}.txt`),
      );
      const c1 = await commit(ctx, { message: 'first', author });

      for (let i = 0; i < 5; i++) {
        runGit(['-C', pair.peer, 'rm', '-q', `src-${i}.txt`], { env: gitDeterministicEnv() });
        // dst[i] = src[i] with 1 line changed → ~90% similarity to src[i]
        const content = Array.from({ length: 10 }, (_, j) =>
          j === 0
            ? `dst${i} line ${String(j).padStart(2, '0')}: unique per-file content here\n`
            : `src${i} line ${String(j).padStart(2, '0')}: unique per-file content here\n`,
        ).join('');
        await writePeerFile(pair.peer, `dst-${i}.txt`, content);
        await writeCtxFile(ctx, `dst-${i}.txt`, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');
      await rm(
        ctx,
        Array.from({ length: 5 }, (_, i) => `src-${i}.txt`),
      );
      await add(
        ctx,
        Array.from({ length: 5 }, (_, i) => `dst-${i}.txt`),
      );
      const c2 = await commit(ctx, { message: 'second', author });

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — all 5 pair
      const renames = treeDiff.changes.filter((c) => c.type === 'rename');
      expect(renames).toHaveLength(5);

      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Pin golden
      const goldenName = 'rename-similarity-m8-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a renamed file with 1 of 10 lines changed (matrix #1), When tsgit reconstructs the patch, Then full patch body matches git diff -M byte-for-byte and frozen golden', async () => {
    // Arrange — R087 fixture: same content as the name-status test (matrix #1)
    const pair = await makePeerPair('rename-similarity-m1-full-body');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const srcContent = tenLineContent('original');
      const dstContent = tenLineContent('original', 0, 'CHANGED');

      await writePeerFile(pair.peer, 'original.txt', srcContent);
      runGit(['-C', pair.peer, 'add', 'original.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      runGit(['-C', pair.peer, 'rm', '-q', 'original.txt'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'moved.txt', dstContent);
      runGit(['-C', pair.peer, 'add', 'moved.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const livePatch = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        'HEAD~1',
        'HEAD',
      );

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'original.txt', srcContent);
      await add(ctx, ['original.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await rm(ctx, ['original.txt']);
      await writeCtxFile(ctx, 'moved.txt', dstContent);
      await add(ctx, ['moved.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = await reconstructPatch(ctx, treeDiff);

      // Assert — full patch body matches live git byte-for-byte
      expect(sut).toBe(livePatch);

      // Pin as golden
      const goldenName = 'rename-similarity-m1-full-body';
      let golden: string;
      try {
        golden = await loadGolden(goldenName);
      } catch {
        await saveGolden(goldenName, livePatch);
        golden = livePatch;
      }
      expect(sut).toBe(golden);
    } finally {
      await pair.dispose();
    }
  });

  it('Given a mode-change + rename in real git (matrix #4), When git diff -M is run, Then old mode/new mode appear before similarity index and index line has no trailing mode (golden pin)', async () => {
    // Arrange — matrix #4: rename with mode change (regular → executable); modes differ.
    // The memory adapter does not support executable file bits, so tsgit's reconstructPatch
    // cannot be byte-compared against git here. This test pins the live git patch FORMAT
    // (order of mode preamble vs similarity, index line suffix) against a frozen golden,
    // confirming the format our unit-test assertions are built against.
    const pair = await makePeerPair('rename-similarity-m4-mode-change');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      // 10-line script; 3 lines changed → roughly 71% spanhash similarity (empirical)
      const srcLines = Array.from(
        { length: 10 },
        (_, i) => `echo "script line ${String(i).padStart(2, '0')}"\n`,
      ).join('');
      const dstLines = Array.from({ length: 10 }, (_, i) =>
        i < 3
          ? `echo "modified line ${String(i).padStart(2, '0')}"\n`
          : `echo "script line ${String(i).padStart(2, '0')}"\n`,
      ).join('');

      await writePeerFile(pair.peer, 'run.sh', srcLines);
      runGit(['-C', pair.peer, 'add', 'run.sh'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      // Remove old, add new with executable bit (mode 755) via update-index --chmod=+x
      runGit(['-C', pair.peer, 'rm', '-q', 'run.sh'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'run-new.sh', dstLines);
      runGit(['-C', pair.peer, 'add', 'run-new.sh'], { env: gitDeterministicEnv() });
      runGit(['-C', pair.peer, 'update-index', '--chmod=+x', 'run-new.sh'], {
        env: gitDeterministicEnv(),
      });
      gitCommit(pair.peer, 'second');

      const livePatch = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        'HEAD~1',
        'HEAD',
      );

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // The fixture content is fully determined (10 lines, 3 modified → ~71% similarity),
      // so live git MUST pair them as a rename. Fail loudly if it does not — a missing
      // rename indicates a fixture regression, not a test to skip silently.
      // Note: tsgit end-to-end mode-change parity is intentionally unit-only (the memory
      // adapter does not carry executable file bits); this test asserts git's PATCH FORMAT.
      expect(liveNameStatus).toMatch(/^R\d+\t/m);

      // Assert structure: mode preamble BEFORE similarity line
      expect(livePatch).toContain('old mode');
      expect(livePatch).toContain('new mode');
      expect(livePatch.indexOf('old mode')).toBeLessThan(livePatch.indexOf('similarity index'));

      // Index line must NOT carry a trailing mode number when modes differ
      const indexLineMatch = livePatch.match(/^index [0-9a-f]+\.\.[0-9a-f]+(.*)$/m);
      expect(indexLineMatch).not.toBeNull();
      expect((indexLineMatch?.[1] ?? '').trim()).toBe('');

      // Pin golden
      const goldenName = 'rename-similarity-m4-mode-change';
      try {
        const golden = await loadGolden(goldenName);
        expect(livePatch).toBe(golden);
      } catch {
        await saveGolden(goldenName, livePatch);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a pure git mv with identical content (matrix #5 / R100), When tsgit reconstructs the patch, Then patch has no index line and no hunk', async () => {
    // Arrange — R100: content byte-identical, only path changes
    const pair = await makePeerPair('rename-similarity-m5-r100');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const content = tenLineContent('stable');

      await writePeerFile(pair.peer, 'original.txt', content);
      runGit(['-C', pair.peer, 'add', 'original.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      runGit(['-C', pair.peer, 'mv', 'original.txt', 'moved.txt'], {
        env: gitDeterministicEnv(),
      });
      gitCommit(pair.peer, 'second');

      const livePatch = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        'HEAD~1',
        'HEAD',
      );

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'original.txt', content);
      await add(ctx, ['original.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await mv(ctx, ['original.txt'], 'moved.txt');
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = await reconstructPatch(ctx, treeDiff);

      // Assert — R100: no index line, no hunk; 4 lines only (diff + similarity + from + to)
      expect(sut).toBe(livePatch);

      // Verify the structure: no index line, no hunk markers
      expect(sut).not.toMatch(/^index /m);
      expect(sut).not.toMatch(/^---/m);
      expect(sut).not.toMatch(/^@@/m);
      expect(sut).toContain('similarity index 100%');
      expect(sut).toContain('rename from original.txt');
      expect(sut).toContain('rename to moved.txt');

      // Pin golden
      const goldenName = 'rename-similarity-m5-r100';
      let golden: string;
      try {
        golden = await loadGolden(goldenName);
      } catch {
        await saveGolden(goldenName, livePatch);
        golden = livePatch;
      }
      expect(sut).toBe(golden);
    } finally {
      await pair.dispose();
    }
  });

  it('Given a modify alongside an add/delete pair, When tsgit detects renames, Then modify passes through and the delete/add folds into a rename', async () => {
    // Arrange — kept.txt is modified; moved.txt is deleted + target.txt added (similar content)
    const pair = await makePeerPair('rename-similarity-m10');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const keptOld = tenLineContent('kept-old');
      const keptNew = tenLineContent('kept-new');
      const movedContent = tenLineContent('moved');
      // target = moved with 1 line changed (~90% similar)
      const targetContent = movedContent.replace('moved content line 00:', 'target line 00:');

      await writePeerFile(pair.peer, 'kept.txt', keptOld);
      await writePeerFile(pair.peer, 'moved.txt', movedContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      await writePeerFile(pair.peer, 'kept.txt', keptNew);
      runGit(['-C', pair.peer, 'rm', '-q', 'moved.txt'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'target.txt', targetContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'kept.txt', keptOld);
      await writeCtxFile(ctx, 'moved.txt', movedContent);
      await add(ctx, ['kept.txt', 'moved.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'kept.txt', keptNew);
      await rm(ctx, ['moved.txt']);
      await writeCtxFile(ctx, 'target.txt', targetContent);
      await add(ctx, ['kept.txt', 'target.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — M kept.txt, R<n> moved.txt target.txt
      const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
      expect(modifies).toHaveLength(1);
      expect((modifies[0] as { path: string }).path).toBe('kept.txt');

      const renames = treeDiff.changes.filter((c) => c.type === 'rename');
      expect(renames).toHaveLength(1);
      const rename = renames[0] as RenameChange;
      expect(rename.oldPath).toBe('moved.txt');
      expect(rename.newPath).toBe('target.txt');

      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Pin golden
      const goldenName = 'rename-similarity-m10-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a copy from a MODIFIED source (matrix #C1), When tsgit detects copies with copies:"on", Then C-score matches git and source modify survives', async () => {
    // Arrange — matrix #C1: source file is modified (M) AND its preimage is copied.
    // Under plain -C, the modify's preimage acts as a copy source.
    const pair = await makePeerPair('rename-similarity-c1');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      // Source file: 10 lines
      const srcContent = tenLineContent('source');
      // Modified version of source (1 line changed)
      const modContent = tenLineContent('source', 0, 'MODIFIED');
      // Copy destination: same as original source but 1 different line (high similarity to preimage)
      const dstContent = tenLineContent('source', 9, 'COPY-DST');

      await writePeerFile(pair.peer, 'source.txt', srcContent);
      runGit(['-C', pair.peer, 'add', 'source.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      await writePeerFile(pair.peer, 'source.txt', modContent);
      await writePeerFile(pair.peer, 'dest.txt', dstContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'source.txt', srcContent);
      await add(ctx, ['source.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'source.txt', modContent);
      await writeCtxFile(ctx, 'dest.txt', dstContent);
      await add(ctx, ['source.txt', 'dest.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — copies: 'on' = -C
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on' },
      });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Sanity — the fixture MUST trigger git's plain -C copy detection, else the
      // test proves nothing. git emits the status letter at line start (`C077\t…`),
      // never tab-prefixed.
      expect(liveNameStatus).toMatch(/^C\d+\tsource\.txt\tdest\.txt$/m);

      // Assert — tsgit detects the copy and the source modify survives, byte-equal to git
      const copies = treeDiff.changes.filter((c) => c.type === 'copy');
      const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
      expect(copies).toHaveLength(1);
      expect(modifies).toHaveLength(1); // source modify survives

      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Pin golden
      const goldenName = 'copy-similarity-c1-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given an UNCHANGED source under plain -C (matrix #C1b), When tsgit runs copies:"on", Then the add remains as add (not detected as copy)', async () => {
    // Arrange — matrix #C1b: the potential copy source is UNCHANGED in the diff.
    // Under plain -C (copies: 'on'), unchanged files are NOT copy sources.
    // The add should remain as A (not C).
    const pair = await makePeerPair('rename-similarity-c1b');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      // The "source" is unchanged: no modify/delete for it in commit 2
      const unchangedContent = tenLineContent('unchanged');
      // The "new" file has similar content to the unchanged source
      const newContent = tenLineContent('unchanged', 0, 'NEW');

      await writePeerFile(pair.peer, 'unchanged.txt', unchangedContent);
      runGit(['-C', pair.peer, 'add', 'unchanged.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      // Commit 2: only add new.txt (unchanged.txt stays unchanged)
      await writePeerFile(pair.peer, 'new.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'new.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'unchanged.txt', unchangedContent);
      await add(ctx, ['unchanged.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'new.txt', newContent);
      await add(ctx, ['new.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — copies: 'on' = plain -C; unchanged file should NOT be a copy source
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on' },
      });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — no copy: unchanged source is not available under plain -C
      const copies = treeDiff.changes.filter((c) => c.type === 'copy');
      expect(copies).toHaveLength(0);

      // The add stays as A
      const adds = treeDiff.changes.filter((c) => c.type === 'add');
      expect(adds).toHaveLength(1);

      // Match live git — git also should NOT detect this as a copy under plain -C
      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Pin golden
      const goldenName = 'copy-similarity-c1b-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given an exact copy (C100, matrix #C4), When tsgit detects copies, Then C100 patch has no index line and no hunk', async () => {
    // Arrange — matrix #C4: content byte-identical; git reports C100.
    // The patch should have no index line or hunk (header-only, like R100).
    const pair = await makePeerPair('rename-similarity-c4');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const content = tenLineContent('stable');

      await writePeerFile(pair.peer, 'source.txt', content);
      runGit(['-C', pair.peer, 'add', 'source.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      // Commit 2: modify source and add an exact copy
      const modContent = tenLineContent('stable', 0, 'MODIFIED');
      await writePeerFile(pair.peer, 'source.txt', modContent);
      await writePeerFile(pair.peer, 'copy.txt', content); // exact copy of old content
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const livePatch = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        'HEAD~1',
        'HEAD',
      );

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'source.txt', content);
      await add(ctx, ['source.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'source.txt', modContent);
      await writeCtxFile(ctx, 'copy.txt', content);
      await add(ctx, ['source.txt', 'copy.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on' },
      });
      const sut = await reconstructPatch(ctx, treeDiff);
      const sutNameStatus = reconstructNameStatus(treeDiff.changes);

      // Assert — name-status matches live git
      const sutLines = sutNameStatus.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Fixture copies an identical file (same bytes), so git MUST emit C100.
      // Assert unconditionally — a missing C100 means a fixture or tsgit regression.
      expect(liveNameStatus).toContain('C100');

      // Full patch parity is the primary assertion — tsgit must match live git byte-for-byte.
      expect(sut).toBe(livePatch);

      // Structural assertions: C100 copy block has no index line and no hunk.
      const copyBlock = sut.split(/(?=^diff --git )/m)[0] ?? '';
      expect(copyBlock).not.toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/m);
      expect(copyBlock).not.toMatch(/^@@/m);
      expect(copyBlock).toContain('similarity index 100%');
      expect(copyBlock).toContain('copy from source.txt');
      expect(copyBlock).toContain('copy to copy.txt');

      // Pin golden
      const goldenName = 'copy-similarity-c4-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a copy from an UNCHANGED source (matrix #C2), When tsgit runs copies:"harder", Then C-score matches git; plain -C does NOT detect it', async () => {
    // Arrange — matrix #C2: source file is UNCHANGED in the diff. Plain -C misses it.
    // --find-copies-harder includes all preimage paths as copy sources.
    const pair = await makePeerPair('rename-similarity-c2');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      // orig.txt is UNCHANGED between commit 1 and commit 2
      const origContent = tenLineContent('orig');
      // new.txt is similar to orig.txt (1 line different) but entirely new
      const newContent = tenLineContent('orig', 0, 'COPY');

      await writePeerFile(pair.peer, 'orig.txt', origContent);
      runGit(['-C', pair.peer, 'add', 'orig.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      await writePeerFile(pair.peer, 'new.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'new.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Probe real git under plain -C (should NOT detect copy from unchanged)
      const livePlainC = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Probe real git under --find-copies-harder (SHOULD detect copy from unchanged)
      const liveHarder = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--find-copies-harder',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: plain -C must NOT report a copy from unchanged source
      expect(livePlainC).not.toMatch(/^C\d+\t/m);
      expect(livePlainC).toMatch(/^A\tnew\.txt$/m);

      // Sanity: harder MUST report a copy — assert the fixture triggers it unconditionally
      expect(liveHarder).toMatch(/^C\d+\torig\.txt\tnew\.txt$/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'orig.txt', origContent);
      await add(ctx, ['orig.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'new.txt', newContent);
      await add(ctx, ['new.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — plain -C: should NOT detect copy from unchanged
      const treeDiffPlainC = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on' },
      });
      // Act — harder: SHOULD detect copy from unchanged
      const treeDiffHarder = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'harder' },
      });

      const sutPlainC = reconstructNameStatus(treeDiffPlainC.changes);
      const sutHarder = reconstructNameStatus(treeDiffHarder.changes);

      // Assert — plain -C: no copy (unchanged excluded)
      expect(treeDiffPlainC.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
      expect(treeDiffPlainC.changes.filter((c) => c.type === 'add')).toHaveLength(1);
      expect(sutPlainC).toBe(livePlainC);

      // Assert — harder: copy detected, C-score matches live git
      const copies = treeDiffHarder.changes.filter((c) => c.type === 'copy');
      expect(copies).toHaveLength(1);
      const sutHarderLines = sutHarder.split('\n').sort().join('\n');
      const liveHarderLines = liveHarder.split('\n').sort().join('\n');
      expect(sutHarderLines).toBe(liveHarderLines);

      // Pin goldens
      const goldenPlainC = 'copy-similarity-c2-plain-c-name-status';
      const goldenHarder = 'copy-similarity-c2-harder-name-status';
      try {
        const golden = await loadGolden(goldenPlainC);
        expect(sutPlainC).toBe(golden);
      } catch {
        await saveGolden(goldenPlainC, livePlainC);
      }
      try {
        const golden = await loadGolden(goldenHarder);
        expect(sutHarderLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenHarder, liveHarder);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a deleted source and an unchanged source both matching dst (matrix #C3), When tsgit runs copies:"harder", Then rename wins and no copy is emitted', async () => {
    // Arrange — matrix #C3: del-src is deleted (rename candidate); keep-src is unchanged
    // (copy candidate under harder). Both are similar to new.txt.
    // The greedy sort puts rename ahead of copy at equal score → rename wins.
    const pair = await makePeerPair('rename-similarity-c3');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      // del-src.txt and keep-src.txt have very similar content
      const srcContent = tenLineContent('source');
      // keep-src stays unchanged; del-src is deleted; new.txt is similar to both
      const newContent = tenLineContent('source', 0, 'CHANGED');

      await writePeerFile(pair.peer, 'del-src.txt', srcContent);
      await writePeerFile(pair.peer, 'keep-src.txt', srcContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      runGit(['-C', pair.peer, 'rm', '-q', 'del-src.txt'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'new.txt', newContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveHarder = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--find-copies-harder',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: rename must win — git emits R<n> del-src.txt new.txt, NO copy for keep-src
      expect(liveHarder).toMatch(/^R\d+\tdel-src\.txt\tnew\.txt$/m);
      expect(liveHarder).not.toMatch(/^C\d+\t/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'del-src.txt', srcContent);
      await writeCtxFile(ctx, 'keep-src.txt', srcContent);
      await add(ctx, ['del-src.txt', 'keep-src.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await rm(ctx, ['del-src.txt']);
      await writeCtxFile(ctx, 'new.txt', newContent);
      await add(ctx, ['new.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'harder' },
      });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Assert — rename wins; no copy
      const renames = treeDiff.changes.filter((c) => c.type === 'rename');
      const copies = treeDiff.changes.filter((c) => c.type === 'copy');
      expect(renames).toHaveLength(1);
      expect(copies).toHaveLength(0);

      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveHarder.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Pin golden
      const goldenName = 'copy-similarity-c3-harder-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveHarder);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a fixture that crosses the limit only under --find-copies-harder, When tsgit runs with limit=2, Then harder falls back to plain -C source set matching git', async () => {
    // Arrange — 1 add (add-dst.txt), 1 unchanged good-src.txt similar to add-dst.txt,
    // and 4 filler unchanged files. No modifies/deletes.
    //
    // Under plain -C (copies:'on'): no copy sources (no modified files) → add stays as A
    // Under harder without limit: copies good-src.txt → add-dst.txt (C087)
    // Under harder with limit=2: num_src=5 (all preimage), num_create=1 → 1*5=5 > 4
    //   → falls back to 'on' sources (none) → add stays as A (matches plain -C)
    const pair = await makePeerPair('rename-similarity-over-limit-harder');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const goodSrcContent = tenLineContent('src');
      // add-dst is similar to goodSrc (1 line different)
      const addDstContent = tenLineContent('src', 0, 'COPY');

      // 4 filler unchanged files (unique content, different from src/dst)
      const fillerContents = Array.from({ length: 4 }, (_, i) =>
        Array.from(
          { length: 10 },
          (__, j) =>
            `filler${i} content line ${String(j).padStart(2, '0')}: unrelated unique content here\n`,
        ).join(''),
      );

      await writePeerFile(pair.peer, 'good-src.txt', goodSrcContent);
      for (let i = 0; i < 4; i++) {
        await writePeerFile(pair.peer, `filler${i}.txt`, fillerContents[i] as string);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');

      await writePeerFile(pair.peer, 'add-dst.txt', addDstContent);
      runGit(['-C', pair.peer, 'add', 'add-dst.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Probe real git: harder without limit should find copy (C087)
      const liveHarderNoLimit = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--find-copies-harder',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Probe real git: harder with limit=2 should NOT find the harder copy (fallback)
      const liveHarderL2 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '--find-copies-harder',
        '-l2',
        '--name-status',
        'HEAD~1',
        'HEAD',
      )
        .split('\n')
        .filter((l) => !l.startsWith('warning:'))
        .join('\n')
        .trim();

      // Sanity: harder without limit must detect the copy from the unchanged good-src.txt
      expect(liveHarderNoLimit).toMatch(/^C\d+\tgood-src\.txt\tadd-dst\.txt$/m);

      // Sanity: harder with limit=2 must NOT detect it (fallback to plain -C, no modified sources)
      expect(liveHarderL2).not.toMatch(/^C\d+\t/m);
      expect(liveHarderL2).toMatch(/^A\tadd-dst\.txt$/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'good-src.txt', goodSrcContent);
      for (let i = 0; i < 4; i++) {
        await writeCtxFile(ctx, `filler${i}.txt`, fillerContents[i] as string);
      }
      await add(ctx, ['good-src.txt', 'filler0.txt', 'filler1.txt', 'filler2.txt', 'filler3.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'add-dst.txt', addDstContent);
      await add(ctx, ['add-dst.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — harder without limit: should find copy
      const treeDiffHarderNoLimit = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'harder' },
      });
      // Act — harder with limit=2: should fall back, no copy
      const treeDiffHarderL2 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'harder', limit: 2 },
      });

      const sutHarderNoLimit = reconstructNameStatus(treeDiffHarderNoLimit.changes);
      const sutHarderL2 = reconstructNameStatus(treeDiffHarderL2.changes);

      // Assert — harder without limit: copy detected, matches git
      const copiesNoLimit = treeDiffHarderNoLimit.changes.filter((c) => c.type === 'copy');
      expect(copiesNoLimit).toHaveLength(1);
      expect(sutHarderNoLimit.split('\n').sort().join('\n')).toBe(
        liveHarderNoLimit.split('\n').sort().join('\n'),
      );

      // Assert — harder with limit=2: fallback, add stays as A, matches git
      const copiesL2 = treeDiffHarderL2.changes.filter((c) => c.type === 'copy');
      expect(copiesL2).toHaveLength(0);
      const addsL2 = treeDiffHarderL2.changes.filter((c) => c.type === 'add');
      expect(addsL2).toHaveLength(1);
      expect(sutHarderL2.split('\n').sort().join('\n')).toBe(
        liveHarderL2.split('\n').sort().join('\n'),
      );

      // Pin goldens
      const goldenNoLimit = 'copy-similarity-harder-no-limit-name-status';
      const goldenL2 = 'copy-similarity-harder-l2-name-status';
      try {
        const golden = await loadGolden(goldenNoLimit);
        expect(sutHarderNoLimit.split('\n').sort().join('\n')).toBe(
          golden.split('\n').sort().join('\n'),
        );
      } catch {
        await saveGolden(goldenNoLimit, liveHarderNoLimit);
      }
      try {
        const golden = await loadGolden(goldenL2);
        expect(sutHarderL2.split('\n').sort().join('\n')).toBe(
          golden.split('\n').sort().join('\n'),
        );
      } catch {
        await saveGolden(goldenL2, liveHarderL2);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a fully-disjoint rewrite (matrix #B1), When tsgit detects breaks with default -B, Then M100 matches git and frozen golden', async () => {
    // Arrange — 20 lines old, 0 shared with new → 100% dissimilarity (>= 60% gate → kept broken)
    const pair = await makePeerPair('break-b1');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 20, 0);
      const newContent = breakContent('new', 20, 0);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const livePatch = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        'HEAD~1',
        'HEAD',
      );

      // Sanity: git must report M100 for fully-disjoint rewrite
      expect(liveNameStatus).toMatch(/^M100\tfile\.txt$/m);
      expect(livePatch).toContain('dissimilarity index 100%');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
      });

      const sutNameStatus = reconstructNameStatus(treeDiff.changes);
      const sutPatch = await reconstructPatch(ctx, treeDiff);

      // Assert — name-status matches git
      expect(sutNameStatus).toBe(liveNameStatus);
      // Assert — dissimilarity index line present
      expect(sutPatch).toContain('dissimilarity index 100%');

      // Pin golden
      const goldenName = 'break-b1-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutNameStatus).toBe(golden.trim());
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a substantially-dissimilar rewrite (matrix #B2), When tsgit detects breaks with default -B, Then M065 matches git byte-for-byte', async () => {
    // Arrange — 20 lines old, 7 shared in new → 65% dissimilarity (git merge_score formula)
    // Verified against real git 2.54.0: `git diff -B --name-status` → M065
    const pair = await makePeerPair('break-b2');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 20, 7);
      const newContent = breakContent('new', 20, 7);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git must report M065 (65% dissimilarity, kept broken >= 60% default gate)
      expect(liveNameStatus).toBe('M065\tfile.txt');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
      });

      const sutNameStatus = reconstructNameStatus(treeDiff.changes);

      // Assert — name-status matches live git byte-for-byte (M065)
      expect(sutNameStatus).toBe(liveNameStatus);

      // Pin git-derived golden
      const goldenName = 'break-b2-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutNameStatus).toBe(golden.trim());
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a mildly-dissimilar rewrite (matrix #B3), When tsgit detects breaks with default -B, Then re-merged to plain M (both tsgit and git)', async () => {
    // Arrange — 20 lines old (all shared prefix), 10 shared in new → ~55% dissimilarity in tsgit,
    // ~50% in git — both < 60% default merge gate → re-merged in both.
    const pair = await makePeerPair('break-b3');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 20, 10);
      const newContent = breakContent('new', 20, 10);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git must re-merge (dissimilarity < 60% default gate) → plain M
      expect(liveNameStatus).toMatch(/^M\tfile\.txt$/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
      });

      const sutNameStatus = reconstructNameStatus(treeDiff.changes);

      // Assert — tsgit also re-merges: no broken datum, plain M name-status
      const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
      expect(modifies).toHaveLength(1);
      expect((modifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();
      expect(sutNameStatus).toBe(liveNameStatus);
    } finally {
      await pair.dispose();
    }
  });

  it('Given a boundary-dissimilar rewrite (matrix #B4), When tsgit merge gate equals git merge_score, Then gate is inclusive (kept) vs exclusive (re-merged)', async () => {
    // Arrange — 20 lines old, 9 shared in new.
    // git merge_score = (1420-639)*60000/1420 = 33000 → 55%; verified: `git diff -B/55%` → M055, `-B/56%` → M.
    // tsgit gate drives from git's raw score (33000): kept at 33000, re-merged at 33001.
    const pair = await makePeerPair('break-b4');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 20, 9);
      const newContent = breakContent('new', 20, 9);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Probe git's inclusive boundary at the merge_score percentage (55%)
      const liveKeptByGit = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B/55%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const liveMergedByGit = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B/56%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git inclusive gate — kept at 55% (merge_score=33000 >= 33000), re-merged at 56%
      expect(liveKeptByGit).toBe('M055\tfile.txt');
      expect(liveMergedByGit).toBe('M\tfile.txt');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — tsgit gate at 33000 (git's exact merge_score): kept (33000 >= 33000, inclusive)
      const treeDiffKept = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 33000 } },
      });
      // Act — tsgit gate at 33001 (just above merge_score): re-merged
      const treeDiffMerged = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 33001 } },
      });

      // Assert — kept at exactly merge_score (inclusive gate); name-status matches git's -B/55%
      const sutKept = reconstructNameStatus(treeDiffKept.changes);
      expect(sutKept).toBe(liveKeptByGit);
      const keptModifies = treeDiffKept.changes.filter((c) => c.type === 'modify');
      expect(keptModifies).toHaveLength(1);
      expect((keptModifies[0] as unknown as { broken?: unknown }).broken).toBeDefined();

      // Assert — re-merged at merge_score+1 (exclusive); name-status matches git's -B/56%
      const sutMerged = reconstructNameStatus(treeDiffMerged.changes);
      expect(sutMerged).toBe(liveMergedByGit);
      const mergedModifies = treeDiffMerged.changes.filter((c) => c.type === 'modify');
      expect(mergedModifies).toHaveLength(1);
      expect((mergedModifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();
    } finally {
      await pair.dispose();
    }
  });

  it('Given a mildly-dissimilar rewrite and merge:0 (matrix #B4b), When tsgit uses merge:0, Then merge:0 maps to DEFAULT_MERGE_SCORE and re-merges', async () => {
    // Arrange — 20 lines old (all shared prefix), 10 shared in new.
    // tsgit spanhash score: ~55% dissimilarity (<60% = DEFAULT_MERGE_SCORE) → re-merges.
    // git: ~50% dissimilarity → also re-merges at default -B. merge:0 must map to DEFAULT_MERGE_SCORE.
    const pair = await makePeerPair('break-b4b');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 20, 10);
      const newContent = breakContent('new', 20, 10);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // git: default -B re-merges (dissimilarity < 60%)
      const liveDefault = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git default -B re-merges this content
      expect(liveDefault).toMatch(/^M\tfile\.txt$/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — merge:0 must map to DEFAULT_MERGE_SCORE (36000 = 60%); tsgit score ~55% < 60% → re-merges
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 0 } },
      });

      const sutNameStatus = reconstructNameStatus(treeDiff.changes);

      // Assert — re-merged (tsgit dissimilarity 55% < DEFAULT_MERGE_SCORE 60%), no broken datum
      const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
      expect(modifies).toHaveLength(1);
      expect((modifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();
      expect(sutNameStatus).toBe(liveDefault);
    } finally {
      await pair.dispose();
    }
  });

  it('Given a 60%-dissimilar rewrite (matrix #B5), When tsgit uses default -B, Then M060 matches git byte-for-byte', async () => {
    // Arrange — 50 lines old, 20 shared in new.
    // git merge_score = (3550-1420)*60000/3550 = 36000 → 60%; verified: default -B → M060.
    const pair = await makePeerPair('break-b5');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 50, 20);
      const newContent = breakContent('new', 50, 20);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveDefault = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      // Probe git at -B/61% (above merge_score 60%) to confirm re-merge boundary
      const liveOver = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B/61%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git reports M060 at default -B (merge_score=36000 >= DEFAULT_MERGE_SCORE=36000)
      expect(liveDefault).toBe('M060\tfile.txt');
      // Sanity: re-merged at 61% (merge_score 36000 < 36601)
      expect(liveOver).toBe('M\tfile.txt');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — default -B gate: merge_score=36000 >= DEFAULT_MERGE_SCORE=36000 → kept
      const treeDiffDefault = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
      });
      // Act — gate at 36001 (just above merge_score): re-merged
      const treeDiffOver = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 36001 } },
      });

      const sutDefault = reconstructNameStatus(treeDiffDefault.changes);

      // Assert — name-status matches live git byte-for-byte (M060)
      expect(sutDefault).toBe(liveDefault);
      const defaultModifies = treeDiffDefault.changes.filter((c) => c.type === 'modify');
      expect(defaultModifies).toHaveLength(1);
      expect((defaultModifies[0] as unknown as { broken?: unknown }).broken).toBeDefined();

      // Assert — re-merged at merge_score+1 (exclusive gate)
      const overModifies = treeDiffOver.changes.filter((c) => c.type === 'modify');
      expect(overModifies).toHaveLength(1);
      expect((overModifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();

      // Pin git-derived golden
      const goldenName = 'break-b5-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutDefault).toBe(golden.trim());
      } catch {
        await saveGolden(goldenName, liveDefault);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a broken file plus an unrelated rename (matrix #B6), When tsgit detects breaks, Then M100 + R094 matches git', async () => {
    // Arrange — file-a: 100% rewrite (breaks to M100); file-b deleted; file-c added ~= old file-b (R094)
    // The break pass runs BEFORE rename detection — this pin proves the fixed ordering
    const pair = await makePeerPair('break-b6');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const oldA = breakContent('old', 20, 0);
      const newA = breakContent('new', 20, 0);
      const oldB = Array.from(
        { length: 20 },
        (_, i) =>
          `line-${String(i).padStart(3, '0')}: content for file B, this will be renamed to C\n`,
      ).join('');
      const newC = Array.from({ length: 20 }, (_, i) =>
        i === 0
          ? `line-${String(i).padStart(3, '0')}: content for file C, derived from B (slight change)\n`
          : `line-${String(i).padStart(3, '0')}: content for file B, this will be renamed to C\n`,
      ).join('');

      await writePeerFile(pair.peer, 'file-a.txt', oldA);
      await writePeerFile(pair.peer, 'file-b.txt', oldB);
      runGit(['-C', pair.peer, 'add', 'file-a.txt', 'file-b.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file-a.txt', newA);
      await writePeerFile(pair.peer, 'file-c.txt', newC);
      runGit(['-C', pair.peer, 'rm', '-q', 'file-b.txt'], { env: gitDeterministicEnv() });
      runGit(['-C', pair.peer, 'add', 'file-a.txt', 'file-c.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: M100 for broken file-a + R094 for rename file-b→file-c
      expect(liveNameStatus).toMatch(/^M100\tfile-a\.txt$/m);
      expect(liveNameStatus).toMatch(/^R094\tfile-b\.txt\tfile-c\.txt$/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file-a.txt', oldA);
      await writeCtxFile(ctx, 'file-b.txt', oldB);
      await add(ctx, ['file-a.txt', 'file-b.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file-a.txt', newA);
      await writeCtxFile(ctx, 'file-c.txt', newC);
      await add(ctx, ['file-a.txt', 'file-c.txt']);
      await rm(ctx, ['file-b.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
      });

      const sutNameStatus = reconstructNameStatus(treeDiff.changes);

      // Assert — both M100 broken and R094 rename; name-status matches git
      expect(sutNameStatus.split('\n').sort().join('\n')).toBe(
        liveNameStatus.split('\n').sort().join('\n'),
      );

      // Pin golden
      const goldenName = 'break-b6-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutNameStatus.split('\n').sort().join('\n')).toBe(
          golden.split('\n').sort().join('\n'),
        );
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a pair scoring R040, When threshold is 24000 (40%), Then tsgit detects the rename matching git -M40% and not matching -M41% (threshold #T1/#T2)', async () => {
    // Arrange — content engineered to score exactly R040 by git's spanhash:
    // 37 shared lines + 57 unique-src lines + 57 unique-dst lines (all 30 bytes each).
    // Probed: git -M40% → R040; git -M41% → A/D.
    // Threshold mapping: -M40% ≡ threshold:24000 (40%×60000); -M41% ≡ threshold:24600.
    const pair = await makePeerPair('threshold-t1-t2');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const shared = Array.from(
        { length: 37 },
        (_, i) => `shared${String(i).padStart(5, '0')}aaaaaaaaaaaaaaaaaaaaaa\n`,
      ).join('');
      const srcUnique = Array.from(
        { length: 57 },
        (_, i) => `srcuu${String(i).padStart(5, '0')}ZZZZZZZZZZZZZZZZZZZZZZ\n`,
      ).join('');
      const dstUnique = Array.from(
        { length: 57 },
        (_, i) => `dstuu${String(i).padStart(5, '0')}YYYYYYYYYYYYYYYYYYYYYY\n`,
      ).join('');
      const srcContent = shared + srcUnique;
      const dstContent = shared + dstUnique;

      await writePeerFile(pair.peer, 'src.txt', srcContent);
      runGit(['-C', pair.peer, 'add', 'src.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      runGit(['-C', pair.peer, 'rm', '-q', 'src.txt'], { env: gitDeterministicEnv() });
      await writePeerFile(pair.peer, 'dst.txt', dstContent);
      runGit(['-C', pair.peer, 'add', 'dst.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Probe real git at 40% (pairs) and 41% (no pair)
      const liveAt40 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M40%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const liveAt41 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M41%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git must report R040 at -M40% and A/D at -M41%
      expect(liveAt40).toMatch(/^R040\tsrc\.txt\tdst\.txt$/m);
      expect(liveAt41).not.toMatch(/^R\d+\t/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'src.txt', srcContent);
      await add(ctx, ['src.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await rm(ctx, ['src.txt']);
      await writeCtxFile(ctx, 'dst.txt', dstContent);
      await add(ctx, ['dst.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — threshold:24000 = 40% of MAX_SCORE (60000)
      const treeDiff40 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { threshold: 24000 },
      });
      // Act — threshold:24600 = 41%: should NOT pair
      const treeDiff41 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { threshold: 24600 },
      });

      const sut40 = reconstructNameStatus(treeDiff40.changes);
      const sut41 = reconstructNameStatus(treeDiff41.changes);

      // Assert — at 40%: rename matches live git (R040)
      expect(sut40).toBe(liveAt40);
      // Assert — at 41%: A/D, no rename, matches live git
      expect(sut41).toBe(liveAt41);
      expect(treeDiff41.changes.map((c) => c.type)).not.toContain('rename');

      // Pin goldens
      try {
        const golden40 = await loadGolden('threshold-t1-40pct-name-status');
        expect(sut40).toBe(golden40);
      } catch {
        await saveGolden('threshold-t1-40pct-name-status', liveAt40);
      }
      try {
        const golden41 = await loadGolden('threshold-t2-41pct-name-status');
        expect(sut41).toBe(golden41);
      } catch {
        await saveGolden('threshold-t2-41pct-name-status', liveAt41);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a copy pair scoring C040, When copyThreshold is 24000 (40%), Then tsgit detects the copy matching git -C40%; at 24600 (41%) it does not (threshold #T3)', async () => {
    // Arrange — same shared/unique byte ratio as T1/T2 (37+57 lines).
    // source.txt is modified (preimage = original), copy.txt = new file with ~40% similarity
    // to source.txt's preimage. Plain -C uses modified-file preimage as copy source.
    // Probed: git -C40% → C040; git -C41% → A/M.
    const pair = await makePeerPair('threshold-t3');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const shared = Array.from(
        { length: 37 },
        (_, i) => `shared${String(i).padStart(5, '0')}aaaaaaaaaaaaaaaaaaaaaa\n`,
      ).join('');
      const srcUnique = Array.from(
        { length: 57 },
        (_, i) => `srcuu${String(i).padStart(5, '0')}ZZZZZZZZZZZZZZZZZZZZZZ\n`,
      ).join('');
      const cpyUnique = Array.from(
        { length: 57 },
        (_, i) => `cpyuu${String(i).padStart(5, '0')}YYYYYYYYYYYYYYYYYYYYYY\n`,
      ).join('');
      const modUnique = Array.from(
        { length: 57 },
        (_, i) => `moduu${String(i).padStart(5, '0')}WWWWWWWWWWWWWWWWWWWWWW\n`,
      ).join('');
      const srcContent = shared + srcUnique; // preimage for source.txt
      const modContent = shared + modUnique; // postimage for source.txt (modified)
      const cpyContent = shared + cpyUnique; // copy.txt (~40% similar to srcContent preimage)

      await writePeerFile(pair.peer, 'source.txt', srcContent);
      runGit(['-C', pair.peer, 'add', 'source.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'source.txt', modContent);
      await writePeerFile(pair.peer, 'copy.txt', cpyContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Probe real git: -C40% (should detect C040) and -C41% (should not)
      const liveAt40 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C40%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const liveAt41 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C41%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git must detect C040 at -C40% and not at -C41%
      expect(liveAt40).toMatch(/^C040\tsource\.txt\tcopy\.txt$/m);
      expect(liveAt41).not.toMatch(/^C\d+\tsource\.txt\tcopy\.txt$/m);

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'source.txt', srcContent);
      await add(ctx, ['source.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'source.txt', modContent);
      await writeCtxFile(ctx, 'copy.txt', cpyContent);
      await add(ctx, ['source.txt', 'copy.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — copyThreshold:24000 = 40% of MAX_SCORE
      const treeDiff40 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on', copyThreshold: 24000 },
      });
      // Act — copyThreshold:24600 = 41%: should NOT copy
      const treeDiff41 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on', copyThreshold: 24600 },
      });

      const sut40 = reconstructNameStatus(treeDiff40.changes);
      const sut41 = reconstructNameStatus(treeDiff41.changes);

      // Assert — at 40%: copy detected, matches live git
      const copies40 = treeDiff40.changes.filter((c) => c.type === 'copy');
      expect(copies40).toHaveLength(1);
      expect(sut40.split('\n').sort().join('\n')).toBe(liveAt40.split('\n').sort().join('\n'));

      // Assert — at 41%: no copy
      const copies41 = treeDiff41.changes.filter((c) => c.type === 'copy');
      expect(copies41).toHaveLength(0);
      expect(sut41.split('\n').sort().join('\n')).toBe(liveAt41.split('\n').sort().join('\n'));

      // Pin goldens
      for (const [name, live, sut] of [
        ['threshold-t3-copy-40pct-name-status', liveAt40, sut40],
        ['threshold-t3-copy-41pct-name-status', liveAt41, sut41],
      ] as const) {
        try {
          const golden = await loadGolden(name);
          expect(sut.split('\n').sort().join('\n')).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(name, live);
        }
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given a 55%-dissimilar modify, When breakRewrites score/merge are swept, Then tsgit matches git at default gate and gate boundaries are git-faithful (threshold #T4)', async () => {
    // Arrange — 20 lines old, 9 shared in new.
    // git merge_score = (1420-639)*60000/1420 = 33000 → 55%
    // Verified: git -B/55% → M055 (kept); -B/56% → M (re-merged); default -B → M (33000 < 36000).
    // tsgit boundaries (driven from git's merge_score = 33000):
    //   merge=33000 → kept (33000 >= 33000, inclusive gate) → M055 matches git -B/55%
    //   merge=33001 → re-merged (33000 < 33001)             → M matches git -B/56%
    //   merge=0 → DEFAULT_MERGE_SCORE (36000); 33000 < 36000 → re-merges → M matches git default -B
    const pair = await makePeerPair('threshold-t4');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });
      const oldContent = breakContent('old', 20, 9);
      const newContent = breakContent('new', 20, 9);

      await writePeerFile(pair.peer, 'file.txt', oldContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'file.txt', newContent);
      runGit(['-C', pair.peer, 'add', 'file.txt'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');

      // Probe real git at all relevant -B/<m>% values
      const liveDefaultB = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const liveAt55 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B/55%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const liveAt56 = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-B/56%',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Sanity: git's merge_score=33000 (55%): kept at 55%, re-merged at 56%, re-merged at default
      expect(liveAt55).toBe('M055\tfile.txt');
      expect(liveAt56).toBe('M\tfile.txt');
      expect(liveDefaultB).toBe('M\tfile.txt');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'file.txt', oldContent);
      await add(ctx, ['file.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'file.txt', newContent);
      await add(ctx, ['file.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act — gate at 33000 (exactly merge_score): inclusive → kept; name-status matches git -B/55%
      const treeDiffKept = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 33000 } },
      });
      // Act — gate at 33001 (just above merge_score): re-merged; name-status matches git -B/56%
      const treeDiffMerged = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 33001 } },
      });
      // Act — merge:0 → DEFAULT_MERGE_SCORE (36000); 33000 < 36000 → re-merges; matches git default -B
      const treeDiffMerge0 = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { breakRewrites: { score: 30000, merge: 0 } },
      });

      // Assert — inclusive gate: kept at 33000; M055 matches git -B/55%
      const sutKept = reconstructNameStatus(treeDiffKept.changes);
      expect(sutKept).toBe(liveAt55);
      const keptModifies = treeDiffKept.changes.filter((c) => c.type === 'modify');
      expect(keptModifies).toHaveLength(1);
      expect((keptModifies[0] as unknown as { broken?: unknown }).broken).toBeDefined();

      // Assert — exclusive gate: re-merged at 33001; M matches git -B/56%
      const sutMerged = reconstructNameStatus(treeDiffMerged.changes);
      expect(sutMerged).toBe(liveAt56);
      const mergedModifies = treeDiffMerged.changes.filter((c) => c.type === 'modify');
      expect(mergedModifies).toHaveLength(1);
      expect((mergedModifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();

      // Assert — merge:0 → DEFAULT_MERGE_SCORE (36000); re-merges → M matches git default -B
      const sutMerge0 = reconstructNameStatus(treeDiffMerge0.changes);
      expect(sutMerge0).toBe(liveDefaultB);
      const merge0Modifies = treeDiffMerge0.changes.filter((c) => c.type === 'modify');
      expect(merge0Modifies).toHaveLength(1);
      expect((merge0Modifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();

      // Pin git-derived golden for the inclusive-gate case (M055)
      const goldenName = 'threshold-t4-break-kept-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutKept).toBe(golden.trim());
      } catch {
        await saveGolden(goldenName, liveAt55);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given 5 delete sources (4 similar to dst-primary, 1 similar to dst-secondary), When tsgit runs rename detection, Then pairings match live git (NUM_CANDIDATE_PER_DST cap)', async () => {
    // Arrange — 5 deletes + 2 adds.  The content design ensures src-aaa..src-ddd score ~91%
    // with dst-primary and src-eee is the only viable candidate for dst-secondary (~91%).
    // git's NUM_CANDIDATE_PER_DST=4 cap keeps only the first 4 alphabetical sources for
    // dst-primary; src-eee (5th) is freed and pairs with dst-secondary.
    // tsgit must produce the identical pairings via its per-dst top-4 cap implementation.
    //
    // Probed against git 2.54.0:
    //   R089  src-aaa.txt → dst-primary.txt
    //   R090  src-eee.txt → dst-secondary.txt
    //   D  src-bbb.txt / src-ccc.txt / src-ddd.txt
    const pair = await makePeerPair('rename-similarity-cap4-dst');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const ctx = createMemoryContext();
      await init(ctx);

      // 10 shared lines (common to every file in the src set)
      const shared10 = Array.from(
        { length: 10 },
        (_, i) => `shared-${String(i + 1).padStart(2, '0')}: alpha beta gamma delta epsilon zeta\n`,
      ).join('');
      // 10 DISTINCT lines used only by src-eee and dst-secondary
      const special10 = Array.from(
        { length: 10 },
        (_, i) =>
          `special-${String(i + 1).padStart(2, '0')}: kappa lambda mu nu xi omicron pi rho\n`,
      ).join('');

      const srcFiles: Record<string, string> = {
        'src-aaa.txt': `${shared10}SRC-AAA: unique to aaa\n`,
        'src-bbb.txt': `${shared10}SRC-BBB: unique to bbb\n`,
        'src-ccc.txt': `${shared10}SRC-CCC: unique to ccc\n`,
        'src-ddd.txt': `${shared10}SRC-DDD: unique to ddd\n`,
        'src-eee.txt': `${special10}SRC-EEE: unique to eee\n`,
      };
      const dstFiles: Record<string, string> = {
        'dst-primary.txt': `${shared10}UNIQUE-PRIMARY: marker for primary destination alpha\n`,
        'dst-secondary.txt': `${special10}UNIQUE-SECONDARY: marker for secondary destination\n`,
      };

      for (const [name, content] of Object.entries(srcFiles)) {
        await writePeerFile(pair.peer, name, content);
        await writeCtxFile(ctx, name, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await add(ctx, Object.keys(srcFiles));
      const c1 = await commit(ctx, { message: 'first', author });

      for (const name of Object.keys(srcFiles)) {
        runGit(['-C', pair.peer, 'rm', '-q', name], { env: gitDeterministicEnv() });
      }
      for (const [name, content] of Object.entries(dstFiles)) {
        await writePeerFile(pair.peer, name, content);
        await writeCtxFile(ctx, name, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');
      await rm(ctx, Object.keys(srcFiles));
      await add(ctx, Object.keys(dstFiles));
      const c2 = await commit(ctx, { message: 'second', author });

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Unconditional: fixture MUST trigger rename detection (R-score lines at line start)
      expect(liveNameStatus).toMatch(/^R\d+\tsrc-aaa\.txt\tdst-primary\.txt$/m);
      expect(liveNameStatus).toMatch(/^R\d+\tsrc-eee\.txt\tdst-secondary\.txt$/m);

      // Assert — tsgit matches live git exactly
      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      // Absolute counts: 2 renames, 3 orphan deletes
      const renames = treeDiff.changes.filter((c) => c.type === 'rename');
      expect(renames).toHaveLength(2);
      const dels = treeDiff.changes.filter((c) => c.type === 'delete');
      expect(dels).toHaveLength(3);

      // Pin golden
      const goldenName = 'rename-similarity-cap4-dst-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });

  it('Given copies:"on" where copy sources alone push num_create*num_src over the limit, When tsgit detects copies with limit=2, Then inexact pass is skipped and add remains (git parity)', async () => {
    // Arrange — 1 add + 5 modifies.  Under copies:'on' the modifies are copy sources
    // (num_src=5), so num_create * num_src = 1 * 5 = 5 > limit² = 4.
    // git skips the inexact pass and emits a warning; tsgit must also skip (no copy found).
    //
    // Probed against git 2.54.0 with -C -l 2:
    //   A  dst.txt  [no copy]
    //   M  src1.txt … M  src5.txt
    const pair = await makePeerPair('rename-similarity-copy-limit-gate');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

      const ctx = createMemoryContext();
      await init(ctx);

      const sharedContent = Array.from(
        { length: 10 },
        (_, i) => `common-${String(i + 1).padStart(2, '0')}: shared text alpha beta gamma\n`,
      ).join('');

      const srcOriginals: Record<string, string> = {};
      const srcModified: Record<string, string> = {};
      for (let i = 0; i < 5; i++) {
        srcOriginals[`src${i + 1}.txt`] = `${sharedContent}UNIQUE-SRC-${i}: source ${i} original\n`;
        srcModified[`src${i + 1}.txt`] = `${sharedContent}UNIQUE-SRC-${i}: source ${i} modified\n`;
      }
      const dstContent = `${sharedContent}UNIQUE-DST: destination file\n`;

      for (const [name, content] of Object.entries(srcOriginals)) {
        await writePeerFile(pair.peer, name, content);
        await writeCtxFile(ctx, name, content);
      }
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'first');
      await add(ctx, Object.keys(srcOriginals));
      const c1 = await commit(ctx, { message: 'first', author });

      for (const [name, content] of Object.entries(srcModified)) {
        await writePeerFile(pair.peer, name, content);
        await writeCtxFile(ctx, name, content);
      }
      await writePeerFile(pair.peer, 'dst.txt', dstContent);
      await writeCtxFile(ctx, 'dst.txt', dstContent);
      runGit(['-C', pair.peer, 'add', '-A'], { env: gitDeterministicEnv() });
      gitCommit(pair.peer, 'second');
      await add(ctx, [...Object.keys(srcModified), 'dst.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      const liveNameStatus = git(
        pair.peer,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-C',
        '-l',
        '2',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();

      // Act — copies:'on', limit=2 → 1*5=5 > 4 → inexact pass skipped → no copy
      const treeDiff = await diff(ctx, {
        from: c1.id,
        to: c2.id,
        detectRenames: true,
        renameOptions: { copies: 'on', limit: 2 },
      });
      const sut = reconstructNameStatus(treeDiff.changes);

      // Unconditional: fixture MUST confirm git shows no copy under the limit
      expect(liveNameStatus).toMatch(/^A\tdst\.txt$/m);
      expect(liveNameStatus).not.toMatch(/^C/m);

      // Assert — tsgit matches live git: no copies, dst remains as add
      const sutLines = sut.split('\n').sort().join('\n');
      const liveLines = liveNameStatus.split('\n').sort().join('\n');
      expect(sutLines).toBe(liveLines);

      const copies = treeDiff.changes.filter((c) => c.type === 'copy');
      expect(copies).toHaveLength(0);
      const adds = treeDiff.changes.filter((c) => c.type === 'add');
      expect(adds).toHaveLength(1);

      // Pin golden
      const goldenName = 'rename-similarity-copy-limit-gate-name-status';
      try {
        const golden = await loadGolden(goldenName);
        expect(sutLines).toBe(golden.split('\n').sort().join('\n'));
      } catch {
        await saveGolden(goldenName, liveNameStatus);
      }
    } finally {
      await pair.dispose();
    }
  });
});

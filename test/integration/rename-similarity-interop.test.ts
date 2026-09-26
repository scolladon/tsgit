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
 *   interopSurface: diff
 */
import { mkdir, readFile, rm as rmDir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import { mv } from '../../src/application/commands/mv.js';
import { rm } from '../../src/application/commands/rm.js';
import type {
  CopyChange,
  DiffChange,
  ModifyChange,
  RenameChange,
} from '../../src/domain/diff/diff-change.js';
import { toSimilarityPercent } from '../../src/domain/diff/similarity.js';
import type { StatDiffChange, StatFields } from '../../src/domain/diff/stat-fields.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, git, makePeerPair, runGit, runGitEnv } from './interop-helpers.js';
import { buildRenameRow, type RenameRow, runRenameRow } from './rename-interop-rows.js';

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
  describe('Given a renamed file with 1 of 10 lines changed, When tsgit detects renames', () => {
    it('Then R-score matches git and frozen golden', async () => {
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Assert — R-score matches live git
        expect(result).toBe(liveNameStatus);

        // Pin as golden
        const goldenName = 'rename-similarity-m1-name-status';
        let golden: string;
        try {
          golden = await loadGolden(goldenName);
        } catch {
          await saveGolden(goldenName, liveNameStatus);
          golden = liveNameStatus;
        }
        expect(result).toBe(golden);

        // Also verify it IS a rename (not A/D)
        expect(treeDiff.changes).toHaveLength(1);
        expect(treeDiff.changes[0]?.type).toBe('rename');
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a ~40% similar add/delete pair, When using 40% threshold', () => {
    it('Then the pair IS detected; with 50% threshold it is NOT', async () => {
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

        const resultAt40 = reconstructNameStatus(treeDiff40.changes);
        const resultAt50 = reconstructNameStatus(treeDiff50.changes);

        // Assert — at 40% should pair (R-score matches live git), at 50% should NOT pair
        expect(resultAt40).toBe(liveWithM40);
        expect(resultAt50).toBe(liveWithM50);

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
  });

  describe('Given renameLimit=1 with 2 inexact pairs and 1 exact pair, When tsgit runs detection', () => {
    it('Then exact pair emits as R100 and inexact pairs are skipped', async () => {
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
        const result = reconstructNameStatus(treeDiff.changes);

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
        const resultLines = result.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given 4 src files and 3 dst files (more srcs than dsts), When tsgit runs greedy detection', () => {
    it('Then 3 pairs match and 1 src remains as orphan delete', async () => {
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Assert — 3 pairs + 1 orphan delete
        const renames = treeDiff.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(3);
        const orphanDels = treeDiff.changes.filter((c) => c.type === 'delete');
        expect(orphanDels).toHaveLength(1);

        // Match live git
        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Pin golden
        const goldenName = 'rename-similarity-m7-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given 5 pairs where each has a clear best match, When tsgit runs greedy detection', () => {
    it('Then all 5 pairs match real git', async () => {
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Assert — all 5 pair
        const renames = treeDiff.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(5);

        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Pin golden
        const goldenName = 'rename-similarity-m8-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a renamed file with 1 of 10 lines changed, When tsgit reconstructs the patch', () => {
    it('Then full patch body matches git diff -M byte-for-byte and frozen golden', async () => {
      // Arrange — the same content the name-status row uses
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
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert — full patch body matches live git byte-for-byte
        expect(result).toBe(livePatch);

        // Pin as golden
        const goldenName = 'rename-similarity-m1-full-body';
        let golden: string;
        try {
          golden = await loadGolden(goldenName);
        } catch {
          await saveGolden(goldenName, livePatch);
          golden = livePatch;
        }
        expect(result).toBe(golden);
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a mode-change + rename in real git, When git diff -M is run', () => {
    it('Then old mode/new mode appear before similarity index and index line has no trailing mode (golden pin)', async () => {
      // Arrange — rename with a mode change (regular → executable); the modes differ.
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
  });

  describe('Given a pure git mv with identical content, When tsgit reconstructs the patch', () => {
    it('Then patch has no index line and no hunk', async () => {
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
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert — R100: no index line, no hunk; 4 lines only (diff + similarity + from + to)
        expect(result).toBe(livePatch);

        // Verify the structure: no index line, no hunk markers
        expect(result).not.toMatch(/^index /m);
        expect(result).not.toMatch(/^---/m);
        expect(result).not.toMatch(/^@@/m);
        expect(result).toContain('similarity index 100%');
        expect(result).toContain('rename from original.txt');
        expect(result).toContain('rename to moved.txt');

        // Pin golden
        const goldenName = 'rename-similarity-m5-r100';
        let golden: string;
        try {
          golden = await loadGolden(goldenName);
        } catch {
          await saveGolden(goldenName, livePatch);
          golden = livePatch;
        }
        expect(result).toBe(golden);
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a modify alongside an add/delete pair, When tsgit detects renames', () => {
    it('Then modify passes through and the delete/add folds into a rename', async () => {
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Assert — M kept.txt, R<n> moved.txt target.txt
        const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        expect((modifies[0] as { path: string }).path).toBe('kept.txt');

        const renames = treeDiff.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        const rename = renames[0] as RenameChange;
        expect(rename.oldPath).toBe('moved.txt');
        expect(rename.newPath).toBe('target.txt');

        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Pin golden
        const goldenName = 'rename-similarity-m10-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a copy from a MODIFIED source, When tsgit detects copies with copies:"on"', () => {
    it('Then C-score matches git and source modify survives', async () => {
      // Arrange — the source file is modified (M) AND its preimage is copied.
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Sanity — the fixture MUST trigger git's plain -C copy detection, else the
        // test proves nothing. git emits the status letter at line start (`C077\t…`),
        // never tab-prefixed.
        expect(liveNameStatus).toMatch(/^C\d+\tsource\.txt\tdest\.txt$/m);

        // Assert — tsgit detects the copy and the source modify survives, byte-equal to git
        const copies = treeDiff.changes.filter((c) => c.type === 'copy');
        const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
        expect(copies).toHaveLength(1);
        expect(modifies).toHaveLength(1); // source modify survives

        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Pin golden
        const goldenName = 'copy-similarity-c1-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given an UNCHANGED source under plain -C, When tsgit runs copies:"on"', () => {
    it('Then the add remains as add (not detected as copy)', async () => {
      // Arrange — the potential copy source is UNCHANGED in the diff.
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Assert — no copy: unchanged source is not available under plain -C
        const copies = treeDiff.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(0);

        // The add stays as A
        const adds = treeDiff.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);

        // Match live git — git also should NOT detect this as a copy under plain -C
        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Pin golden
        const goldenName = 'copy-similarity-c1b-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given an exact copy (C100), When tsgit detects copies', () => {
    it('Then C100 patch has no index line and no hunk', async () => {
      // Arrange — content byte-identical; git reports C100.
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
        const result = await reconstructPatch(ctx, treeDiff);
        const resultNameStatus = reconstructNameStatus(treeDiff.changes);

        // Assert — name-status matches live git
        const resultLines = resultNameStatus.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Fixture copies an identical file (same bytes), so git MUST emit C100.
        // Assert unconditionally — a missing C100 means a fixture or tsgit regression.
        expect(liveNameStatus).toContain('C100');

        // Full patch parity is the primary assertion — tsgit must match live git byte-for-byte.
        expect(result).toBe(livePatch);

        // Structural assertions: C100 copy block has no index line and no hunk.
        const copyBlock = result.split(/(?=^diff --git )/m)[0] ?? '';
        expect(copyBlock).not.toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/m);
        expect(copyBlock).not.toMatch(/^@@/m);
        expect(copyBlock).toContain('similarity index 100%');
        expect(copyBlock).toContain('copy from source.txt');
        expect(copyBlock).toContain('copy to copy.txt');

        // Pin golden
        const goldenName = 'copy-similarity-c4-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a copy from an UNCHANGED source, When tsgit runs copies:"harder"', () => {
    it('Then C-score matches git; plain -C does NOT detect it', async () => {
      // Arrange — the source file is UNCHANGED in the diff. Plain -C misses it.
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

        const resultPlainC = reconstructNameStatus(treeDiffPlainC.changes);
        const resultHarder = reconstructNameStatus(treeDiffHarder.changes);

        // Assert — plain -C: no copy (unchanged excluded)
        expect(treeDiffPlainC.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(treeDiffPlainC.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(resultPlainC).toBe(livePlainC);

        // Assert — harder: copy detected, C-score matches live git
        const copies = treeDiffHarder.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        const resultHarderLines = resultHarder.split('\n').sort().join('\n');
        const liveHarderLines = liveHarder.split('\n').sort().join('\n');
        expect(resultHarderLines).toBe(liveHarderLines);

        // Pin goldens
        const goldenPlainC = 'copy-similarity-c2-plain-c-name-status';
        const goldenHarder = 'copy-similarity-c2-harder-name-status';
        try {
          const golden = await loadGolden(goldenPlainC);
          expect(resultPlainC).toBe(golden);
        } catch {
          await saveGolden(goldenPlainC, livePlainC);
        }
        try {
          const golden = await loadGolden(goldenHarder);
          expect(resultHarderLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenHarder, liveHarder);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a deleted source and an unchanged source both matching dst, When tsgit runs copies:"harder"', () => {
    it('Then rename wins and no copy is emitted', async () => {
      // Arrange — del-src is deleted (rename candidate); keep-src is unchanged
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Assert — rename wins; no copy
        const renames = treeDiff.changes.filter((c) => c.type === 'rename');
        const copies = treeDiff.changes.filter((c) => c.type === 'copy');
        expect(renames).toHaveLength(1);
        expect(copies).toHaveLength(0);

        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveHarder.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Pin golden
        const goldenName = 'copy-similarity-c3-harder-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveHarder);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a fixture that crosses the limit only under --find-copies-harder, When tsgit runs with limit=2', () => {
    it('Then harder falls back to plain -C source set matching git', async () => {
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
        await add(ctx, [
          'good-src.txt',
          'filler0.txt',
          'filler1.txt',
          'filler2.txt',
          'filler3.txt',
        ]);
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

        const resultHarderNoLimit = reconstructNameStatus(treeDiffHarderNoLimit.changes);
        const resultHarderL2 = reconstructNameStatus(treeDiffHarderL2.changes);

        // Assert — harder without limit: copy detected, matches git
        const copiesNoLimit = treeDiffHarderNoLimit.changes.filter((c) => c.type === 'copy');
        expect(copiesNoLimit).toHaveLength(1);
        expect(resultHarderNoLimit.split('\n').sort().join('\n')).toBe(
          liveHarderNoLimit.split('\n').sort().join('\n'),
        );

        // Assert — harder with limit=2: fallback, add stays as A, matches git
        const copiesL2 = treeDiffHarderL2.changes.filter((c) => c.type === 'copy');
        expect(copiesL2).toHaveLength(0);
        const addsL2 = treeDiffHarderL2.changes.filter((c) => c.type === 'add');
        expect(addsL2).toHaveLength(1);
        expect(resultHarderL2.split('\n').sort().join('\n')).toBe(
          liveHarderL2.split('\n').sort().join('\n'),
        );

        // Pin goldens
        const goldenNoLimit = 'copy-similarity-harder-no-limit-name-status';
        const goldenL2 = 'copy-similarity-harder-l2-name-status';
        try {
          const golden = await loadGolden(goldenNoLimit);
          expect(resultHarderNoLimit.split('\n').sort().join('\n')).toBe(
            golden.split('\n').sort().join('\n'),
          );
        } catch {
          await saveGolden(goldenNoLimit, liveHarderNoLimit);
        }
        try {
          const golden = await loadGolden(goldenL2);
          expect(resultHarderL2.split('\n').sort().join('\n')).toBe(
            golden.split('\n').sort().join('\n'),
          );
        } catch {
          await saveGolden(goldenL2, liveHarderL2);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a fully-disjoint rewrite, When tsgit detects breaks with default -B', () => {
    it('Then M100 matches git and frozen golden', async () => {
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

        const resultNameStatus = reconstructNameStatus(treeDiff.changes);
        const resultPatch = await reconstructPatch(ctx, treeDiff);

        // Assert — name-status matches git
        expect(resultNameStatus).toBe(liveNameStatus);
        // Assert — dissimilarity index line present
        expect(resultPatch).toContain('dissimilarity index 100%');

        // Pin golden
        const goldenName = 'break-b1-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultNameStatus).toBe(golden.trim());
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a substantially-dissimilar rewrite, When tsgit detects breaks with default -B', () => {
    it('Then M065 matches git byte-for-byte', async () => {
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

        const resultNameStatus = reconstructNameStatus(treeDiff.changes);

        // Assert — name-status matches live git byte-for-byte (M065)
        expect(resultNameStatus).toBe(liveNameStatus);

        // Pin git-derived golden
        const goldenName = 'break-b2-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultNameStatus).toBe(golden.trim());
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a mildly-dissimilar rewrite, When tsgit detects breaks with a merge-score gate variant', () => {
    it.each([
      { label: 'the explicit default gate (merge:36000)', merge: 36000 },
      { label: 'merge:0, which maps to DEFAULT_MERGE_SCORE', merge: 0 },
    ])('Then $label re-merges to plain M (both tsgit and git)', async ({ merge }) => {
      // Arrange — 20 lines old (all shared prefix), 10 shared in new → ~55% dissimilarity in tsgit,
      // ~50% in git — both < 60% default merge gate → re-merged in both.
      const pair = await makePeerPair('break-b3-b4b');
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
          renameOptions: { breakRewrites: { score: 30000, merge } },
        });

        const resultNameStatus = reconstructNameStatus(treeDiff.changes);

        // Assert — tsgit also re-merges: no broken datum, plain M name-status
        const modifies = treeDiff.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        expect((modifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();
        expect(resultNameStatus).toBe(liveNameStatus);
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a 60%-dissimilar rewrite, When tsgit uses default -B', () => {
    it('Then M060 matches git byte-for-byte', async () => {
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

        const resultDefault = reconstructNameStatus(treeDiffDefault.changes);

        // Assert — name-status matches live git byte-for-byte (M060)
        expect(resultDefault).toBe(liveDefault);
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
          expect(resultDefault).toBe(golden.trim());
        } catch {
          await saveGolden(goldenName, liveDefault);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a broken file plus an unrelated rename, When tsgit detects breaks', () => {
    it('Then M100 + R094 matches git', async () => {
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
        runGit(['-C', pair.peer, 'add', 'file-a.txt', 'file-b.txt'], {
          env: gitDeterministicEnv(),
        });
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'file-a.txt', newA);
        await writePeerFile(pair.peer, 'file-c.txt', newC);
        runGit(['-C', pair.peer, 'rm', '-q', 'file-b.txt'], { env: gitDeterministicEnv() });
        runGit(['-C', pair.peer, 'add', 'file-a.txt', 'file-c.txt'], {
          env: gitDeterministicEnv(),
        });
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

        const resultNameStatus = reconstructNameStatus(treeDiff.changes);

        // Assert — both M100 broken and R094 rename; name-status matches git
        expect(resultNameStatus.split('\n').sort().join('\n')).toBe(
          liveNameStatus.split('\n').sort().join('\n'),
        );

        // Pin golden
        const goldenName = 'break-b6-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultNameStatus.split('\n').sort().join('\n')).toBe(
            golden.split('\n').sort().join('\n'),
          );
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a pair scoring R040, When threshold is 24000 (40%)', () => {
    it('Then tsgit detects the rename matching git -M40% and not matching -M41% (threshold #T1/#T2)', async () => {
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

        const resultAt40 = reconstructNameStatus(treeDiff40.changes);
        const resultAt41 = reconstructNameStatus(treeDiff41.changes);

        // Assert — at 40%: rename matches live git (R040)
        expect(resultAt40).toBe(liveAt40);
        // Assert — at 41%: A/D, no rename, matches live git
        expect(resultAt41).toBe(liveAt41);
        expect(treeDiff41.changes.map((c) => c.type)).not.toContain('rename');

        // Pin goldens
        try {
          const golden40 = await loadGolden('threshold-t1-40pct-name-status');
          expect(resultAt40).toBe(golden40);
        } catch {
          await saveGolden('threshold-t1-40pct-name-status', liveAt40);
        }
        try {
          const golden41 = await loadGolden('threshold-t2-41pct-name-status');
          expect(resultAt41).toBe(golden41);
        } catch {
          await saveGolden('threshold-t2-41pct-name-status', liveAt41);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a copy pair scoring C040, When threshold is 24000 (40%)', () => {
    it('Then tsgit detects the copy matching git -C40%; at 24600 (41%) it does not (threshold #T3)', async () => {
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

        // Act — threshold:24000 = 40% of MAX_SCORE
        const treeDiff40 = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          detectRenames: true,
          renameOptions: { copies: 'on', threshold: 24000 },
        });
        // Act — threshold:24600 = 41%: should NOT copy
        const treeDiff41 = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          detectRenames: true,
          renameOptions: { copies: 'on', threshold: 24600 },
        });

        const resultAt40 = reconstructNameStatus(treeDiff40.changes);
        const resultAt41 = reconstructNameStatus(treeDiff41.changes);

        // Assert — at 40%: copy detected, matches live git
        const copies40 = treeDiff40.changes.filter((c) => c.type === 'copy');
        expect(copies40).toHaveLength(1);
        expect(resultAt40.split('\n').sort().join('\n')).toBe(
          liveAt40.split('\n').sort().join('\n'),
        );

        // Assert — at 41%: no copy
        const copies41 = treeDiff41.changes.filter((c) => c.type === 'copy');
        expect(copies41).toHaveLength(0);
        expect(resultAt41.split('\n').sort().join('\n')).toBe(
          liveAt41.split('\n').sort().join('\n'),
        );

        // Pin goldens
        for (const [name, live, result] of [
          ['threshold-t3-copy-40pct-name-status', liveAt40, resultAt40],
          ['threshold-t3-copy-41pct-name-status', liveAt41, resultAt41],
        ] as const) {
          try {
            const golden = await loadGolden(name);
            expect(result.split('\n').sort().join('\n')).toBe(golden.split('\n').sort().join('\n'));
          } catch {
            await saveGolden(name, live);
          }
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given a 55%-dissimilar modify, When breakRewrites score/merge are swept', () => {
    it('Then tsgit matches git at default gate and gate boundaries are git-faithful (threshold #T4)', async () => {
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
        const resultKept = reconstructNameStatus(treeDiffKept.changes);
        expect(resultKept).toBe(liveAt55);
        const keptModifies = treeDiffKept.changes.filter((c) => c.type === 'modify');
        expect(keptModifies).toHaveLength(1);
        expect((keptModifies[0] as unknown as { broken?: unknown }).broken).toBeDefined();

        // Assert — exclusive gate: re-merged at 33001; M matches git -B/56%
        const resultMerged = reconstructNameStatus(treeDiffMerged.changes);
        expect(resultMerged).toBe(liveAt56);
        const mergedModifies = treeDiffMerged.changes.filter((c) => c.type === 'modify');
        expect(mergedModifies).toHaveLength(1);
        expect((mergedModifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();

        // Assert — merge:0 → DEFAULT_MERGE_SCORE (36000); re-merges → M matches git default -B
        const resultMerge0 = reconstructNameStatus(treeDiffMerge0.changes);
        expect(resultMerge0).toBe(liveDefaultB);
        const merge0Modifies = treeDiffMerge0.changes.filter((c) => c.type === 'modify');
        expect(merge0Modifies).toHaveLength(1);
        expect((merge0Modifies[0] as unknown as { broken?: unknown }).broken).toBeUndefined();

        // Pin git-derived golden for the inclusive-gate case (M055)
        const goldenName = 'threshold-t4-break-kept-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultKept).toBe(golden.trim());
        } catch {
          await saveGolden(goldenName, liveAt55);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given bridge-plus-S5 fixture with -M1% threshold, When tsgit runs rename detection', () => {
    it('Then pairings match live git (NUM_CANDIDATE_PER_DST=4 cap is outcome-determining)', async () => {
      // Arrange — 5 deletes + 6 adds with threshold=1% (600/60000).
      //
      // Without cap (=1000): s5.txt pairs with d1.txt (score 31% > d2's 15%), d2.txt UNMATCHED.
      // With cap=4:          s5.txt pairs with d2.txt (score 15%),            d1.txt UNMATCHED.
      //
      // Content design (line-fraction similarity):
      //   COMMON  = 20 lines shared by b1..b4, d1, d3..d6
      //   EXTRAi  = 4 lines shared only by bi and d(i+2)  (bridge pair)
      //   S5D1    = 10 lines shared only by s5 and d1
      //   S5D2    = 2 lines shared only by s5 and d2
      //
      //   Spanhash scores: d1←bi≈65%, d3←b1≈96%, d1←s5≈31%, d2←s5≈15%
      //
      //   Cap mechanism: b1..b4 fill d1's 4 slots (each at 65%).
      //     s5@31% is 5th and NOT strictly better → evicted from d1's matrix.
      //     Bridge dests d3..d6 score 96% with bi → consumed by greedy before d1←bi.
      //     d1 has no remaining viable candidates → d1 UNMATCHED.
      //     s5 pairs with d2 (only option left above threshold).
      //
      // Probed against git 2.54.0 with -M1%:
      //   R015  s5.txt → d2.txt
      //   R096  b1.txt → d3.txt
      //   R096  b2.txt → d4.txt
      //   R096  b3.txt → d5.txt
      //   R096  b4.txt → d6.txt
      //   A     d1.txt
      const pair = await makePeerPair('rename-similarity-cap4-dst');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer], { env: gitDeterministicEnv() });

        const ctx = createMemoryContext();
        await init(ctx);

        const makeBlock = (prefix: string, count: number): string =>
          Array.from(
            { length: count },
            (_, i) =>
              `${prefix}-${String(i + 1).padStart(2, '0')}: content alpha beta gamma delta epsilon zeta\n`,
          ).join('');

        const COMMON = makeBlock('common', 20);
        const EXTRA1 = makeBlock('extra-B1', 4);
        const EXTRA2 = makeBlock('extra-B2', 4);
        const EXTRA3 = makeBlock('extra-B3', 4);
        const EXTRA4 = makeBlock('extra-B4', 4);
        const S5D1 = makeBlock('s5-d1', 10);
        const S5D2 = makeBlock('s5-d2', 2);

        const srcFiles: Record<string, string> = {
          'b1.txt': `${COMMON}${EXTRA1}unique-B1: marker only in B1 alpha beta gamma delta\n`,
          'b2.txt': `${COMMON}${EXTRA2}unique-B2: marker only in B2 alpha beta gamma delta\n`,
          'b3.txt': `${COMMON}${EXTRA3}unique-B3: marker only in B3 alpha beta gamma delta\n`,
          'b4.txt': `${COMMON}${EXTRA4}unique-B4: marker only in B4 alpha beta gamma delta\n`,
          's5.txt': `${S5D1}${S5D2}unique-S5: marker only in S5 alpha beta gamma delta\n`,
        };
        const dstFiles: Record<string, string> = {
          'd1.txt': `${COMMON}${S5D1}unique-D1: marker only in D1 alpha beta gamma delta\n`,
          'd2.txt': `${S5D2}unique-D2: marker only in D2 alpha beta gamma delta\n`,
          'd3.txt': `${COMMON}${EXTRA1}unique-D3: marker only in D3 alpha beta gamma delta\n`,
          'd4.txt': `${COMMON}${EXTRA2}unique-D4: marker only in D4 alpha beta gamma delta\n`,
          'd5.txt': `${COMMON}${EXTRA3}unique-D5: marker only in D5 alpha beta gamma delta\n`,
          'd6.txt': `${COMMON}${EXTRA4}unique-D6: marker only in D6 alpha beta gamma delta\n`,
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

        // Use -M1% (threshold=1% of MAX_SCORE) to make the cap outcome-determining.
        // At the default 50% threshold, d1←s5 (31%) and d2←s5 (15%) are both below
        // the threshold and s5 would not appear in any rename matrix regardless of cap.
        const threshold1pct = Math.trunc(60000 / 100); // 600 = 1% of MAX_SCORE
        const liveNameStatus = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-M1%',
          '--name-status',
          'HEAD~1',
          'HEAD',
        ).trim();

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          detectRenames: true,
          renameOptions: { threshold: threshold1pct },
        });
        const result = reconstructNameStatus(treeDiff.changes);

        // Unconditional: live git MUST show the cap=4-determined pairing
        expect(liveNameStatus).toMatch(/^R\d+\ts5\.txt\td2\.txt$/m);
        expect(liveNameStatus).toMatch(/^A\td1\.txt$/m);

        // Assert — tsgit matches live git exactly
        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        // Absolute counts: 5 renames (b1→d3, b2→d4, b3→d5, b4→d6, s5→d2), 1 unmatched add (d1)
        const renames = treeDiff.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(5);
        const unmatched = treeDiff.changes.filter((c) => c.type === 'add');
        expect(unmatched).toHaveLength(1);
        const d1Add = unmatched.find((a) => a.type === 'add' && a.newPath === 'd1.txt');
        expect(d1Add).toBeDefined();

        // Pin golden
        const goldenName = 'rename-similarity-cap4-dst-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });

  describe('Given copies:"on" where copy sources alone push num_create*num_src over the limit, When tsgit detects copies with limit=2', () => {
    it('Then inexact pass is skipped and add remains (git parity)', async () => {
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
          srcOriginals[`src${i + 1}.txt`] =
            `${sharedContent}UNIQUE-SRC-${i}: source ${i} original\n`;
          srcModified[`src${i + 1}.txt`] =
            `${sharedContent}UNIQUE-SRC-${i}: source ${i} modified\n`;
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
        const result = reconstructNameStatus(treeDiff.changes);

        // Unconditional: fixture MUST confirm git shows no copy under the limit
        expect(liveNameStatus).toMatch(/^A\tdst\.txt$/m);
        expect(liveNameStatus).not.toMatch(/^C/m);

        // Assert — tsgit matches live git: no copies, dst remains as add
        const resultLines = result.split('\n').sort().join('\n');
        const liveLines = liveNameStatus.split('\n').sort().join('\n');
        expect(resultLines).toBe(liveLines);

        const copies = treeDiff.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(0);
        const adds = treeDiff.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);

        // Pin golden
        const goldenName = 'rename-similarity-copy-limit-gate-name-status';
        try {
          const golden = await loadGolden(goldenName);
          expect(resultLines).toBe(golden.split('\n').sort().join('\n'));
        } catch {
          await saveGolden(goldenName, liveNameStatus);
        }
      } finally {
        await pair.dispose();
      }
    });
  });
});

/**
 * name_score matrix tie-break interop: `git diff -M` (some rows also `-C`)
 * breaks an equal-score tie between inexact candidates on a matching
 * basename (`score_compare` / `record_if_better`), never on build order.
 *
 * Content follows the shared "body"/"edit window" convention: a line-per-row
 * body of uniform-length lines so the spanhash scorer's percentage is a
 * simple function of how many lines were replaced — independent of WHICH
 * lines, letting several distinct sources tie at the same score.
 */
const NAME_SCORE_BODY_LINES = 20;
const NAME_SCORE_WIDE_LINES = 100;
const NAME_SCORE_WINDOW_61_PERCENT = 39;
const NAME_SCORE_WINDOW_52_PERCENT = 48;
const NAME_SCORE_WINDOW_STRIDE = 12;

const nameScoreBody = (): string =>
  `${Array.from(
    { length: NAME_SCORE_BODY_LINES },
    (_, i) => `body line ${String(i).padStart(2, '0')}`,
  ).join('\n')}\n`;

const nameScoreBodyPlus = (extra: string): string => `${nameScoreBody()}${extra}\n`;

const nameScoreWideBody = (): string =>
  `${Array.from(
    { length: NAME_SCORE_WIDE_LINES },
    (_, i) => `body line ${String(i).padStart(3, '0')}`,
  ).join('\n')}\n`;

/** Replaces a contiguous `count`-line window starting at `offset` (wrapping)
 *  with edited lines; the REST stays byte-identical to `nameScoreWideBody()`.
 *  Because only the edited-line COUNT drives the spanhash score, not which
 *  lines, every offset at the same `count` ties at the same percentage. */
const nameScoreEditWindow = (offset: number, count: number): string =>
  `${Array.from({ length: NAME_SCORE_WIDE_LINES }, (_, i) => {
    const inWindow = (i - offset + NAME_SCORE_WIDE_LINES) % NAME_SCORE_WIDE_LINES < count;
    const label = inWindow ? 'edit' : 'body';
    return `${label} line ${String(i).padStart(3, '0')}`;
  }).join('\n')}\n`;

const TMP_PREFIX = 'tsgit-rename-name-score-';
const SETUP_TIMEOUT = 60_000;

const NAME_SCORE_ROWS: ReadonlyArray<RenameRow> = [
  {
    label:
      'two sources sharing a blob, only one basename-matching — the match wins the tie (D Aaa ; R097 Foo→Foo)',
    before: [
      { path: 'a/Aaa.cls-meta.xml', content: nameScoreBody() },
      { path: 'a/Foo.cls-meta.xml', content: nameScoreBody() },
    ],
    after: [{ path: 'b/Foo.cls-meta.xml', content: nameScoreBodyPlus('extra') }],
  },
  {
    label:
      'the same tie under -C — name_score still resolves it in the matrix (D Aaa ; R097 Foo→Foo)',
    before: [
      { path: 'a/Aaa.cls-meta.xml', content: nameScoreBody() },
      { path: 'a/Foo.cls-meta.xml', content: nameScoreBody() },
    ],
    after: [{ path: 'b/Foo.cls-meta.xml', content: nameScoreBodyPlus('extra') }],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      'must-stay: 3 identical same-named sources map 1:1 onto 3 edited same-named destinations (R097 x3)',
    before: [
      { path: 'a/One/Foo.meta', content: nameScoreBody() },
      { path: 'a/Two/Foo.meta', content: nameScoreBody() },
      { path: 'a/Three/Foo.meta', content: nameScoreBody() },
    ],
    after: [
      { path: 'b/One/Foo.meta', content: nameScoreBodyPlus('extra') },
      { path: 'b/Two/Foo.meta', content: nameScoreBodyPlus('spare') },
      { path: 'b/Three/Foo.meta', content: nameScoreBodyPlus('bonus') },
    ],
  },
  {
    label:
      'two DISTINCT sources tied by score, only the second basename-matches (D Aaa ; R052 Foo→Foo)',
    before: [
      { path: 'a/Aaa.xml', content: nameScoreEditWindow(0, NAME_SCORE_WINDOW_52_PERCENT) },
      { path: 'a/Foo.xml', content: nameScoreEditWindow(50, NAME_SCORE_WINDOW_52_PERCENT) },
    ],
    after: [{ path: 'b/Foo.xml', content: nameScoreWideBody() }],
  },
  {
    label:
      '5 equal-score sources beyond the top-4 cap, only the 5th basename-matches — it still wins the slot (4x D ; R061 E→E)',
    before: [
      { path: 'a/A.c', content: nameScoreEditWindow(0, NAME_SCORE_WINDOW_61_PERCENT) },
      {
        path: 'a/B.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE, NAME_SCORE_WINDOW_61_PERCENT),
      },
      {
        path: 'a/C.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE * 2, NAME_SCORE_WINDOW_61_PERCENT),
      },
      {
        path: 'a/D.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE * 3, NAME_SCORE_WINDOW_61_PERCENT),
      },
      {
        path: 'a/E.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE * 4, NAME_SCORE_WINDOW_61_PERCENT),
      },
    ],
    after: [{ path: 'b/E.c', content: nameScoreWideBody() }],
  },
  {
    label: 'the same 5-way tie under -C — the cap still keeps the basename match (4x D ; R061 E→E)',
    before: [
      { path: 'a/A.c', content: nameScoreEditWindow(0, NAME_SCORE_WINDOW_61_PERCENT) },
      {
        path: 'a/B.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE, NAME_SCORE_WINDOW_61_PERCENT),
      },
      {
        path: 'a/C.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE * 2, NAME_SCORE_WINDOW_61_PERCENT),
      },
      {
        path: 'a/D.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE * 3, NAME_SCORE_WINDOW_61_PERCENT),
      },
      {
        path: 'a/E.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE * 4, NAME_SCORE_WINDOW_61_PERCENT),
      },
    ],
    after: [{ path: 'b/E.c', content: nameScoreWideBody() }],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label: '2 equal-score sources, only the second basename-matches (D A ; R061 B→B)',
    before: [
      { path: 'a/A.c', content: nameScoreEditWindow(0, NAME_SCORE_WINDOW_61_PERCENT) },
      {
        path: 'a/B.c',
        content: nameScoreEditWindow(NAME_SCORE_WINDOW_STRIDE, NAME_SCORE_WINDOW_61_PERCENT),
      },
    ],
    after: [{ path: 'b/B.c', content: nameScoreWideBody() }],
  },
];

const nameScoreFixtures = new Map<string, { readonly dir: string }>();

function nameScoreFixtureOf(label: string): { readonly dir: string } {
  const found = nameScoreFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('name_score matrix tie-break interop', () => {
  beforeAll(async () => {
    for (const row of NAME_SCORE_ROWS) {
      nameScoreFixtures.set(row.label, await buildRenameRow(row, TMP_PREFIX));
    }
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of nameScoreFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising the name_score matrix tie-break', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(NAME_SCORE_ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = nameScoreFixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

/**
 * Use-count labelling interop: `git diff -C` labels a pair by how many times
 * its source is used (`--rename_used`), not by which pass produced it — a
 * single content-identical exact fold and an inexact match onto the SAME
 * source resolve to copy/rename purely by final destination-path order. The
 * rename-limit gate counts every registered source once, gitlinks included,
 * even though a gitlink can never be content-scored.
 */
const USE_COUNT_TMP_PREFIX = 'tsgit-rename-use-count-';
const USE_COUNT_SETUP_TIMEOUT = 60_000;
const USE_COUNT_GITLINK_OID = '3'.repeat(40);

/** Lines shared between C20's modify source and its exact/inexact destinations. */
const C20_SHARED_LINES = Array.from(
  { length: 17 },
  (_, i) => `c20-shared-${String(i).padStart(2, '0')}: alpha beta gamma delta\n`,
);

const USE_COUNT_ROWS: ReadonlyArray<RenameRow> = [
  {
    label:
      '-C: one delete scores 95% against one add and 85% against another — copy the higher score, rename the lower (C095 Foo→Bar ; R085 Foo→Baz)',
    before: [{ path: 'a/Foo.meta', content: tenLineContent('foo') }],
    after: [
      { path: 'b/Bar.meta', content: tenLineContent('foo', 0) },
      { path: 'b/Baz.meta', content: tenLineContent('foo', 0, 'CHANGED CHANGED CHANGED') },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      '-C: one delete pairs exactly with one add and inexactly with another — the exact pair is the rename, last in path order (C090 Foo→Bar ; R100 Foo→Baz)',
    before: [{ path: 'a/Foo.meta', content: tenLineContent('foo') }],
    after: [
      { path: 'b/Bar.meta', content: tenLineContent('foo', 0) },
      { path: 'b/Baz.meta', content: tenLineContent('foo') },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label: '-C -l1: one delete, one 90%-similar add — the 1x1 limit fits (R090)',
    before: [{ path: 'a/Foo.meta', content: tenLineContent('foo') }],
    after: [{ path: 'b/Bar.meta', content: tenLineContent('foo', 0) }],
    gitFlags: ['-C', '-l1'],
    renameOptions: { copies: 'on', limit: 1 },
  },
  {
    label:
      '-l1: an unrelated deleted gitlink still counts toward the rename-limit source count, forcing the inexact pass to skip (D Foo ; D sub ; A Bar)',
    before: [
      { path: 'a/Foo.meta', content: tenLineContent('foo') },
      { path: 'a/sub', content: USE_COUNT_GITLINK_OID, kind: 'gitlink' },
    ],
    after: [{ path: 'b/Bar.meta', content: tenLineContent('foo', 0) }],
    gitFlags: ['-l1'],
    renameOptions: { limit: 1 },
  },
  {
    label:
      '-C: a modified source scores higher than a deleted source against the same add — pass 1 pairs only the deleted source (design row C19: M a/M ; R<score> a/D→b/N)',
    before: [
      { path: 'a/M.meta', content: `${tenLineContent('c19')}extra-tail-line: zzz\n` },
      {
        path: 'a/D.meta',
        content: tenLineContent('c19').replace(
          'c19 content line 00: this is the content\n',
          'DIFFERENT-line-0\n',
        ),
      },
    ],
    after: [
      { path: 'a/M.meta', content: 'completely different modified content\n' },
      { path: 'b/N.meta', content: tenLineContent('c19') },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      '-C: an exact-copy add exhausts the modified source before a second, inexact add is scored — the deleted source wins the second despite a lower score (design row C20: C100 M→N1 ; R<score> D→N2)',
    before: [
      {
        path: 'a/M.meta',
        content: [
          ...C20_SHARED_LINES,
          ...Array.from({ length: 3 }, (_, i) => `c20-mod-only-${i}: epsilon zeta\n`),
        ].join(''),
      },
      {
        path: 'a/D.meta',
        content: [
          ...C20_SHARED_LINES.slice(0, 16),
          ...Array.from({ length: 4 }, (_, i) => `c20-d-only-${i}: iota kappa\n`),
        ].join(''),
      },
    ],
    after: [
      { path: 'a/M.meta', content: 'c20 modify new content\n' },
      {
        path: 'b/N1.meta',
        content: [
          ...C20_SHARED_LINES,
          ...Array.from({ length: 3 }, (_, i) => `c20-mod-only-${i}: epsilon zeta\n`),
        ].join(''),
      },
      {
        path: 'b/N2.meta',
        content: [
          ...C20_SHARED_LINES,
          ...Array.from({ length: 3 }, (_, i) => `c20-n2-only-${i}: eta theta\n`),
        ].join(''),
      },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
];

const useCountFixtures = new Map<string, { readonly dir: string }>();

function useCountFixtureOf(label: string): { readonly dir: string } {
  const found = useCountFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('use-count labelling and gitlink-counted limit interop', () => {
  beforeAll(async () => {
    for (const row of USE_COUNT_ROWS) {
      useCountFixtures.set(row.label, await buildRenameRow(row, USE_COUNT_TMP_PREFIX));
    }
  }, USE_COUNT_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of useCountFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising use-count labelling or the gitlink-counted limit', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(USE_COUNT_ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = useCountFixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

/**
 * `-B` write back interop: git's `diffcore-rename.c:1669` drops a broken
 * delete once its add half pairs elsewhere (S2), and otherwise rejoins the
 * halves into one modify while counting the rejoin as one more use of the
 * delete-half's source (K1, K2) — before use-count labelling runs. Fixtures
 * are kept >= 500 bytes so Part 11's byte-size guard still leaves them broken.
 * S0/S1 pin `should_break`'s own guards: an empty source or a pair under
 * MINIMUM_BREAK_SIZE (400 bytes) never breaks at all, so the write-back rules
 * above never get a chance to run; K3 pins that an unrelated exact rename
 * keeps working alongside a broken modify once those guards are in place.
 */
const WRITE_BACK_TMP_PREFIX = 'tsgit-rename-write-back-';
const WRITE_BACK_SETUP_TIMEOUT = 60_000;

/** Unrelated content for K3's exact-rename pair — distinct from m.txt's
 *  break content, so z.txt/q.txt never scores against m.txt. */
const K3_UNRELATED_CONTENT = Array.from(
  { length: 20 },
  (_, i) => `z-line-${String(i).padStart(3, '0')}: unrelated marker alpha beta\n`,
).join('');

const WRITE_BACK_ROWS: ReadonlyArray<RenameRow> = [
  {
    label:
      '-B: a rewritten m.txt whose old content pairs exactly with an unrelated add — the rejoin counts as a use, so the pairing is a copy, not a rename (design row K1: M100 m ; C100 m→q)',
    before: [{ path: 'm.txt', content: breakContent('old', 40, 0) }],
    after: [
      { path: 'm.txt', content: breakContent('new', 40, 0) },
      { path: 'q.txt', content: breakContent('old', 40, 0) },
    ],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
  {
    label:
      '-B: a rewritten m.txt whose old content near-matches (one extra line) an unrelated add — the rejoin still counts as a use, so the inexact pairing is a copy (design row K2: M100 m ; C099 m→q)',
    before: [{ path: 'm.txt', content: breakContent('old', 40, 0) }],
    after: [
      { path: 'm.txt', content: breakContent('new', 40, 0) },
      { path: 'q.txt', content: `${breakContent('old', 40, 0)}extra-tail-line-only-in-q\n` },
    ],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
  {
    label:
      '-B: a/s fully rewritten to match deleted a/d exactly — write back drops the broken delete because its add half paired, whatever its own use count (design row S2: R100 a/d→a/s)',
    before: [
      { path: 'a/s', content: breakContent('old', 20, 0) },
      { path: 'a/d', content: breakContent('new', 40, 0) },
    ],
    after: [{ path: 'a/s', content: breakContent('new', 40, 0) }],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
  {
    label:
      '-B: an empty a/e rewritten to match a deleted a/d exactly — the empty-source guard means the modify never breaks, so the pairing S2 would otherwise make never happens (design row S0: D a/d ; M a/e)',
    before: [
      { path: 'a/e', content: '' },
      { path: 'a/d', content: breakContent('new', 40, 0) },
    ],
    after: [{ path: 'a/e', content: breakContent('new', 40, 0) }],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
  {
    label:
      '-B: a small a/s fully rewritten to match a small deleted a/d exactly — both sides sit under MINIMUM_BREAK_SIZE, so the modify never breaks (design row S1: D a/d ; M a/s)',
    before: [
      { path: 'a/s', content: breakContent('old', 3, 0) },
      { path: 'a/d', content: breakContent('new', 3, 0) },
    ],
    after: [{ path: 'a/s', content: breakContent('new', 3, 0) }],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
  {
    label:
      '-B: a rewritten m.txt with no rename candidate of its own, alongside an unrelated exact-rename pair — the broken modify and the rename never interact (design row K3, must stay: M100 m ; R100 z→q)',
    before: [
      { path: 'm.txt', content: breakContent('old', 40, 0) },
      { path: 'z.txt', content: K3_UNRELATED_CONTENT },
    ],
    after: [
      { path: 'm.txt', content: breakContent('new', 40, 0) },
      { path: 'q.txt', content: K3_UNRELATED_CONTENT },
    ],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
];

const writeBackFixtures = new Map<string, { readonly dir: string }>();

function writeBackFixtureOf(label: string): { readonly dir: string } {
  const found = writeBackFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('-B write back interop', () => {
  beforeAll(async () => {
    for (const row of WRITE_BACK_ROWS) {
      writeBackFixtures.set(row.label, await buildRenameRow(row, WRITE_BACK_TMP_PREFIX));
    }
  }, WRITE_BACK_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of writeBackFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising -B write back (a broken delete drop or a rejoin)', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(WRITE_BACK_ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = writeBackFixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

/**
 * Non-regular files leave similarity scoring: a symlink or gitlink is never
 * an inexact-matrix candidate on either side, exact-only as a copy source,
 * and still eligible to break under `-B`.
 */
const NON_REGULAR_TMP_PREFIX = 'tsgit-rename-non-regular-';
const NON_REGULAR_SETUP_TIMEOUT = 60_000;

// Symlink targets stay well under the OS symlink length limit (unlike
// `breakContent`'s ~1.3 KB, which overflows it) — 540 bytes, fully disjoint,
// clears the default break-attempt gate.
const SYMLINK_OLD_TARGET = 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(27);
const SYMLINK_NEW_TARGET = 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(27);
// Same 540-byte length, only the trailing 5 bytes differ — well below the gate.
const SYMLINK_SMALL_RETARGET = `${SYMLINK_OLD_TARGET.slice(0, -5)}eeee\n`;

const NON_REGULAR_ROWS: ReadonlyArray<RenameRow> = [
  {
    label:
      'N1: deleted symlink target equals a new regular file — cross-kind identical content never pairs (D a/link ; A b/file)',
    before: [{ path: 'a/link', content: 'shared-target-value', kind: 'symlink' }],
    after: [{ path: 'b/file', content: 'shared-target-value' }],
  },
  {
    label: 'N1c: N1 under -C — still stays D ; A',
    before: [{ path: 'a/link', content: 'shared-target-value-c', kind: 'symlink' }],
    after: [{ path: 'b/file', content: 'shared-target-value-c' }],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      'N2: symlink to symlink, 280-byte target plus 1 char — same non-regular kind on both sides still never scores (D ; A)',
    before: [{ path: 'a/link', content: 'a'.repeat(280), kind: 'symlink' }],
    after: [{ path: 'b/link', content: `${'a'.repeat(280)}b`, kind: 'symlink' }],
  },
  {
    label: 'N3: regular deleted, similar symlink added — destination-side filter (D ; A)',
    before: [{ path: 'a/reg', content: tenLineContent('n3') }],
    after: [{ path: 'b/link', content: tenLineContent('n3', 0), kind: 'symlink' }],
  },
  {
    label:
      'N4: -C modified symlink whose OLD target equals a regular add — the copy source is exact-only (M a/link ; A b/file)',
    before: [{ path: 'a/link', content: 'old-target-n4', kind: 'symlink' }],
    after: [
      { path: 'a/link', content: 'new-target-n4', kind: 'symlink' },
      { path: 'b/file', content: 'old-target-n4' },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      'N5: -C -C unchanged symlink; regular add matches its target — an unchanged non-regular source never scores (A b/file)',
    before: [{ path: 'a/link', content: 'unchanged-target-n5', kind: 'symlink' }],
    after: [
      { path: 'a/link', content: 'unchanged-target-n5', kind: 'symlink' },
      { path: 'b/file', content: 'unchanged-target-n5' },
    ],
    gitFlags: ['-C', '-C'],
    renameOptions: { copies: 'harder' },
  },
  {
    label:
      'N5r: -C -C unchanged regular; symlink add carries its content — destination-side filter on an unchanged source (A b/link)',
    before: [{ path: 'a/reg', content: 'unchanged-content-n5r' }],
    after: [
      { path: 'a/reg', content: 'unchanged-content-n5r' },
      { path: 'b/link', content: 'unchanged-content-n5r', kind: 'symlink' },
    ],
    gitFlags: ['-C', '-C'],
    renameOptions: { copies: 'harder' },
  },
  {
    label:
      'N6b: -M -B fully-retargeted symlink; regular add matches its OLD target — broken halves rejoin instead of cross-pairing (M100 a/link ; A b/file)',
    before: [{ path: 'a/link', content: SYMLINK_OLD_TARGET, kind: 'symlink' }],
    after: [
      { path: 'a/link', content: SYMLINK_NEW_TARGET, kind: 'symlink' },
      { path: 'b/file', content: SYMLINK_OLD_TARGET },
    ],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
  {
    label:
      'N6 (must stay): -M -B, a small symlink retarget stays a plain modify, never broken (M a/link)',
    before: [{ path: 'a/link', content: SYMLINK_OLD_TARGET, kind: 'symlink' }],
    after: [{ path: 'a/link', content: SYMLINK_SMALL_RETARGET, kind: 'symlink' }],
    gitFlags: ['-B'],
    renameOptions: { breakRewrites: { score: 30000, merge: 36000 } },
  },
];

const nonRegularFixtures = new Map<string, { readonly dir: string }>();

function nonRegularFixtureOf(label: string): { readonly dir: string } {
  const found = nonRegularFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('non-regular files leave similarity scoring interop', () => {
  beforeAll(async () => {
    for (const row of NON_REGULAR_ROWS) {
      nonRegularFixtures.set(row.label, await buildRenameRow(row, NON_REGULAR_TMP_PREFIX));
    }
  }, NON_REGULAR_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of nonRegularFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising a non-regular (symlink) side of the rename/copy pools', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(NON_REGULAR_ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = nonRegularFixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

/**
 * `-B` breaks every file↔symlink type change unconditionally (rows N7b–N7n):
 * the halves feed the rename/copy matrix exactly like a broken modify's, a
 * paired add half replaces the type change entirely, and an unpaired one
 * rejoins into a kept-broken type change. A gitlink-involving type change
 * never breaks (row G3), and a broken pair anywhere in the diff switches off
 * the `-M` basename pass just as a broken modify does (row B3t).
 */
const TYPE_CHANGE_TMP_PREFIX = 'tsgit-rename-type-change-break-';
const TYPE_CHANGE_SETUP_TIMEOUT = 60_000;
const TYPE_CHANGE_BREAK_OPTS = { breakRewrites: { score: 30000, merge: 36000 } };
const TYPE_CHANGE_GITLINK_OID = '9'.repeat(40);

const tcRegular = (label: string): string =>
  Array.from({ length: 10 }, (_, i) => `${label} regular content line ${i}\n`).join('');
const tcNearMatch = (content: string): string => `${content}extra unique tail line only here\n`;
const tcSymlink = (label: string): string => `symlink-target-${label}`;

const B3_BASELINE = Array.from(
  { length: 20 },
  (_, i) => `body line ${i}: shared baseline for the basename regression probe\n`,
).join('');
const b3Edited = (edited: number): string =>
  Array.from({ length: 20 }, (_, i) =>
    i < edited
      ? `edited line ${i}: replaces the shared baseline for the basename regression probe\n`
      : `body line ${i}: shared baseline for the basename regression probe\n`,
  ).join('');

const TYPE_CHANGE_ROWS: ReadonlyArray<RenameRow> = [
  {
    label: 'N7 (must stay): a plain symlink→regular type change with no -B (T a/p)',
    before: [{ path: 'a/p', content: tcSymlink('n7'), kind: 'symlink' }],
    after: [{ path: 'a/p', content: tcRegular('n7') }],
  },
  {
    label: 'N7b: -M -B breaks a symlink→regular type change unconditionally (T100 a/p)',
    before: [{ path: 'a/p', content: tcSymlink('n7b'), kind: 'symlink' }],
    after: [{ path: 'a/p', content: tcRegular('n7b') }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7s: N7b where both sides are the SAME blob — breaks before the same-oid check (T100 a/p)',
    before: [{ path: 'a/p', content: 'shared-blob-for-n7s', kind: 'symlink' }],
    after: [{ path: 'a/p', content: 'shared-blob-for-n7s' }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7d: regular→symlink a/p; an add matches its OLD content exactly (T100 a/p ; C100 a/p→b/q)',
    before: [{ path: 'a/p', content: tcRegular('n7d') }],
    after: [
      { path: 'a/p', content: tcSymlink('n7d'), kind: 'symlink' },
      { path: 'b/q', content: tcRegular('n7d') },
    ],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7c: N7d under -C -B — the broken type change registers once, not also as a modified copy source (T100 a/p ; C100 a/p→b/q)',
    before: [{ path: 'a/p', content: tcRegular('n7c') }],
    after: [
      { path: 'a/p', content: tcSymlink('n7c'), kind: 'symlink' },
      { path: 'b/q', content: tcRegular('n7c') },
    ],
    gitFlags: ['-C', '-B'],
    renameOptions: { copies: 'on', ...TYPE_CHANGE_BREAK_OPTS },
  },
  {
    label:
      'N7e: N7d where the add near-matches (one extra line) instead of exact (T100 a/p ; C0nn a/p→b/q)',
    before: [{ path: 'a/p', content: tcRegular('n7e') }],
    after: [
      { path: 'a/p', content: tcSymlink('n7e'), kind: 'symlink' },
      { path: 'b/q', content: tcNearMatch(tcRegular('n7e')) },
    ],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7m: N7d with two identical adds under -M (one use per source: T100 a/p ; C100 a/p→b/q ; A b/r)',
    before: [{ path: 'a/p', content: tcRegular('n7m') }],
    after: [
      { path: 'a/p', content: tcSymlink('n7m'), kind: 'symlink' },
      { path: 'b/q', content: tcRegular('n7m') },
      { path: 'b/r', content: tcRegular('n7m') },
    ],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label: 'N7dn: N7d fixture under -M only, no -B — the type change never splits (T a/p ; A b/q)',
    before: [{ path: 'a/p', content: tcRegular('n7dn') }],
    after: [
      { path: 'a/p', content: tcSymlink('n7dn'), kind: 'symlink' },
      { path: 'b/q', content: tcRegular('n7dn') },
    ],
  },
  {
    label:
      'N7f: symlink→regular a/p; a deleted file matches its NEW content exactly — the pairing replaces the type change (R100 a/old→a/p)',
    before: [
      { path: 'a/p', content: tcSymlink('n7f'), kind: 'symlink' },
      { path: 'a/old', content: tcRegular('n7f-new') },
    ],
    after: [{ path: 'a/p', content: tcRegular('n7f-new') }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label: 'N7j: N7f where the deleted file near-matches instead of exact (R0nn a/old→a/p)',
    before: [
      { path: 'a/p', content: tcSymlink('n7j'), kind: 'symlink' },
      { path: 'a/old', content: tcNearMatch(tcRegular('n7j-new')) },
    ],
    after: [{ path: 'a/p', content: tcRegular('n7j-new') }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label: 'N7fn: N7f fixture under -M only, no -B — both halves stay separate (D a/old ; T a/p)',
    before: [
      { path: 'a/p', content: tcSymlink('n7fn'), kind: 'symlink' },
      { path: 'a/old', content: tcRegular('n7fn-new') },
    ],
    after: [{ path: 'a/p', content: tcRegular('n7fn-new') }],
  },
  {
    label:
      'N7g: regular→symlink a/p; a deleted symlink matches its NEW target exactly — symlinks pair exactly only (R100 a/s→a/p)',
    before: [
      { path: 'a/p', content: tcRegular('n7g') },
      { path: 'a/s', content: tcSymlink('n7g'), kind: 'symlink' },
    ],
    after: [{ path: 'a/p', content: tcSymlink('n7g'), kind: 'symlink' }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7h: N7g plus an add matching the type change OLD content — both halves pair independently (R100 a/s→a/p ; R100 a/p→b/q)',
    before: [
      { path: 'a/p', content: tcRegular('n7h') },
      { path: 'a/s', content: tcSymlink('n7h'), kind: 'symlink' },
    ],
    after: [
      { path: 'a/p', content: tcSymlink('n7h'), kind: 'symlink' },
      { path: 'b/q', content: tcRegular('n7h') },
    ],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7k: two type changes swap content — a/p regular→symlink, a/r symlink→regular (R100 a/r→a/p ; R100 a/p→a/r)',
    before: [
      { path: 'a/p', content: tcRegular('n7k') },
      { path: 'a/r', content: tcSymlink('n7k'), kind: 'symlink' },
    ],
    after: [
      { path: 'a/p', content: tcSymlink('n7k'), kind: 'symlink' },
      { path: 'a/r', content: tcRegular('n7k') },
    ],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N7kn: N7k fixture under -M only, no -B — both type changes stay separate (T a/p ; T a/r)',
    before: [
      { path: 'a/p', content: tcRegular('n7kn') },
      { path: 'a/r', content: tcSymlink('n7kn'), kind: 'symlink' },
    ],
    after: [
      { path: 'a/p', content: tcSymlink('n7kn'), kind: 'symlink' },
      { path: 'a/r', content: tcRegular('n7kn') },
    ],
  },
  {
    label:
      'N7n: regular→symlink a/p; an unrelated deleted regular file shares the symlink target STRING, cross-mode — neither half pairs (D a/d ; T100 a/p)',
    before: [
      { path: 'a/p', content: tcRegular('n7n') },
      { path: 'a/d', content: tcSymlink('n7n') },
    ],
    after: [{ path: 'a/p', content: tcSymlink('n7n'), kind: 'symlink' }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'N8 (must stay, -C): a regular→symlink type change lends its OLD content as a copy source (T ; C100 a/p→b/q)',
    before: [{ path: 'a/p', content: tcRegular('n8') }],
    after: [
      { path: 'a/p', content: tcSymlink('n8'), kind: 'symlink' },
      { path: 'b/q', content: tcRegular('n8') },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label: 'G3 (must stay): a gitlink→regular type change never breaks under -B (T a/sub)',
    before: [{ path: 'a/sub', content: TYPE_CHANGE_GITLINK_OID, kind: 'gitlink' }],
    after: [{ path: 'a/sub', content: tcRegular('g3') }],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
  {
    label:
      'B3t (must stay): a broken type change disables the -M basename pass — the highest raw score wins over the basename match (D foo.c ; R0nn bar.c→foo.c ; T100 t)',
    before: [
      { path: 'a/foo.c', content: b3Edited(4) },
      { path: 'a/bar.c', content: b3Edited(1) },
      { path: 't', content: tcSymlink('b3t'), kind: 'symlink' },
    ],
    after: [
      { path: 'b/foo.c', content: B3_BASELINE },
      { path: 't', content: tcRegular('b3t') },
    ],
    gitFlags: ['-B'],
    renameOptions: TYPE_CHANGE_BREAK_OPTS,
  },
];

const typeChangeFixtures = new Map<string, { readonly dir: string }>();

function typeChangeFixtureOf(label: string): { readonly dir: string } {
  const found = typeChangeFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('-B type-change break interop', () => {
  beforeAll(async () => {
    for (const row of TYPE_CHANGE_ROWS) {
      typeChangeFixtures.set(row.label, await buildRenameRow(row, TYPE_CHANGE_TMP_PREFIX));
    }
  }, TYPE_CHANGE_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of typeChangeFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising a file↔symlink type change under -B', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(TYPE_CHANGE_ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = typeChangeFixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given N7b (a broken symlink→regular type change), When the patch and numstat are reconstructed', () => {
    it('Then both match git diff --no-ext-diff -p -M -B byte-for-byte', async () => {
      // Arrange — 20 new lines, a 1-line-equivalent old symlink target: an
      // unambiguous numstat independent of the shared row's own content.
      const row: RenameRow = {
        label: 'N7b patch/numstat probe',
        before: [{ path: 'a/p', content: 'n7b-patch-symlink-target', kind: 'symlink' }],
        after: [
          {
            path: 'a/p',
            content: Array.from({ length: 20 }, (_, i) => `n7b patch content line ${i}\n`).join(''),
          },
        ],
        gitFlags: ['-B'],
        renameOptions: TYPE_CHANGE_BREAK_OPTS,
      };
      const { dir } = await buildRenameRow(row, TYPE_CHANGE_TMP_PREFIX);
      try {
        const livePatch = git(
          dir,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-M',
          '-B',
          'HEAD~1',
          'HEAD',
        );
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const treeDiff = await diff(ctx, {
          from: 'HEAD~1',
          to: 'HEAD',
          recursive: true,
          detectRenames: true,
          renameOptions: TYPE_CHANGE_BREAK_OPTS,
        });
        const resultPatch = await reconstructPatch(ctx, treeDiff);
        const statDiff = await diff(ctx, {
          from: 'HEAD~1',
          to: 'HEAD',
          recursive: true,
          detectRenames: true,
          renameOptions: TYPE_CHANGE_BREAK_OPTS,
          withStat: true,
        });

        // Assert — the patch is byte-identical whether or not -B kept the type change broken
        expect(resultPatch).toBe(livePatch);
        expect(statDiff.changes).toHaveLength(1);
        const [statChange] = statDiff.changes;
        expect(statChange?.type).toBe('type-change');
        expect(statChange?.added).toBe(20);
        expect(statChange?.deleted).toBe(1);
      } finally {
        await rmDir(dir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * `-M`'s basename pre-pass (`find_basename_matches`): a delete and an add
 * sharing a UNIQUE basename pair before the ordinary matrix ever runs, even
 * when a differently-named delete scores higher against that same add. It
 * runs only under plain `-M` — copies off, and no broken pair anywhere in
 * the diff (row below reuses `-B` to prove a break switches it off).
 */
const BASENAME_PASS_TMP_PREFIX = 'tsgit-rename-basename-pass-';
const BASENAME_PASS_SETUP_TIMEOUT = 60_000;
const BASENAME_PASS_BREAK_OPTS = { breakRewrites: { score: 30000, merge: 36000 } };

const COMPANION_BASELINE = Array.from(
  { length: 20 },
  (_, i) => `meta line ${i}: shared boilerplate for the basename regression probe\n`,
).join('');
const companionEdited = (edited: number): string =>
  Array.from({ length: 20 }, (_, i) =>
    i < edited
      ? `meta-edited line ${i}: replaces the shared boilerplate for the basename regression probe\n`
      : `meta line ${i}: shared boilerplate for the basename regression probe\n`,
  ).join('');

const BASENAME_PASS_ROWS: ReadonlyArray<RenameRow> = [
  {
    label:
      'a same-basename inexact delete outscored by a differently-named delete for the same add — the basename match wins (D bar.c ; R0nn foo.c→foo.c)',
    before: [
      { path: 'a/foo.c', content: b3Edited(4) },
      { path: 'a/bar.c', content: b3Edited(1) },
    ],
    after: [{ path: 'b/foo.c', content: B3_BASELINE }],
  },
  {
    label:
      'two components moving directory, each with a primary and a companion file: only the one keeping its basename survives the move for BOTH files, despite the other component scoring higher on both (D Aaa.cls ; D Aaa.cls-meta.xml ; R0nn Foo.cls→Foo.cls ; R0nn Foo.cls-meta.xml→Foo.cls-meta.xml)',
    before: [
      { path: 'a/classes/Aaa.cls', content: b3Edited(1) },
      { path: 'a/classes/Foo.cls', content: b3Edited(4) },
      { path: 'a/classes/Aaa.cls-meta.xml', content: companionEdited(1) },
      { path: 'a/classes/Foo.cls-meta.xml', content: companionEdited(4) },
    ],
    after: [
      { path: 'b/classes/Foo.cls', content: B3_BASELINE },
      { path: 'b/classes/Foo.cls-meta.xml', content: COMPANION_BASELINE },
    ],
  },
  {
    label:
      'must stay: -M -B with a fully rewritten unrelated file — a break anywhere in the diff disables the basename pass, so the higher-scoring but differently-named delete wins the matrix instead (R0nn bar.c→foo.c ; M100 m.txt)',
    before: [
      { path: 'a/foo.c', content: b3Edited(4) },
      { path: 'a/bar.c', content: b3Edited(1) },
      { path: 'm.txt', content: breakContent('old', 40, 0) },
    ],
    after: [
      { path: 'b/foo.c', content: B3_BASELINE },
      { path: 'm.txt', content: breakContent('new', 40, 0) },
    ],
    gitFlags: ['-B'],
    renameOptions: BASENAME_PASS_BREAK_OPTS,
  },
];

const basenamePassFixtures = new Map<string, { readonly dir: string }>();

function basenamePassFixtureOf(label: string): { readonly dir: string } {
  const found = basenamePassFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('-M basename pre-pass interop', () => {
  beforeAll(async () => {
    for (const row of BASENAME_PASS_ROWS) {
      basenamePassFixtures.set(row.label, await buildRenameRow(row, BASENAME_PASS_TMP_PREFIX));
    }
  }, BASENAME_PASS_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of basenamePassFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair where a delete shares its destination basename uniquely', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(BASENAME_PASS_ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = basenamePassFixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

/**
 * `-B` alone, with rename/copy detection off (`--no-renames -B`): every
 * break-attempt/keep-broken gate still applies, but nothing the break pass
 * produces is ever registered or paired — not even an exact content match.
 */
const NO_RENAME_BREAK_TMP_PREFIX = 'tsgit-rename-no-rename-break-';
const NO_RENAME_BREAK_SETUP_TIMEOUT = 60_000;
const NO_RENAME_BREAK_OPTS = { breakRewrites: { score: 30000, merge: 36000 } };

const NO_RENAME_UNRELATED_CONTENT = Array.from(
  { length: 20 },
  (_, i) => `unrelated-line-${String(i).padStart(3, '0')}: shared between the delete and the add\n`,
).join('');

const NO_RENAME_BREAK_ROWS: ReadonlyArray<RenameRow> = [
  {
    label:
      'a rewritten m.txt alongside an unrelated add matching its OLD content and an unrelated identical delete/add pair, under --no-renames -B: nothing pairs, not even exactly (M100 m ; A q ; A y ; D z)',
    before: [
      { path: 'm.txt', content: breakContent('old', 40, 0) },
      { path: 'z.txt', content: NO_RENAME_UNRELATED_CONTENT },
    ],
    after: [
      { path: 'm.txt', content: breakContent('new', 40, 0) },
      { path: 'q.txt', content: breakContent('old', 40, 0) },
      { path: 'y.txt', content: NO_RENAME_UNRELATED_CONTENT },
    ],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: NO_RENAME_BREAK_OPTS,
  },
  {
    label:
      'a partially-rewritten file under --no-renames -B: the break-attempt gate still fires and the modify stays kept-broken',
    before: [{ path: 'm.txt', content: breakContent('old', 20, 7) }],
    after: [{ path: 'm.txt', content: breakContent('new', 20, 7) }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: NO_RENAME_BREAK_OPTS,
  },
  {
    label:
      'the same partially-rewritten file under --no-renames -B with a higher merge gate: the pair re-merges to a plain modify',
    before: [{ path: 'm.txt', content: breakContent('old', 20, 7) }],
    after: [{ path: 'm.txt', content: breakContent('new', 20, 7) }],
    detectRenames: false,
    gitFlags: ['-B50%/70%'],
    renameOptions: { breakRewrites: { score: 30000, merge: 42000 } },
  },
  {
    label:
      'a symlink→regular type change under --no-renames -B: the type change still breaks unconditionally',
    before: [{ path: 'p', content: tcSymlink('no-rename-b'), kind: 'symlink' }],
    after: [{ path: 'p', content: tcRegular('no-rename-b') }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: NO_RENAME_BREAK_OPTS,
  },
  {
    label:
      'an empty file rewritten and a small file rewritten, both under MINIMUM_BREAK_SIZE guards, under --no-renames -B: neither ever breaks (M e ; M s)',
    before: [
      { path: 'e', content: '' },
      { path: 's', content: breakContent('old', 3, 0) },
    ],
    after: [
      { path: 'e', content: breakContent('new', 40, 0) },
      { path: 's', content: breakContent('new', 3, 0) },
    ],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: NO_RENAME_BREAK_OPTS,
  },
  {
    label:
      'an unrelated delete and add sharing identical content under --no-renames -B: no pairing at all, not even exact (D ; A)',
    before: [{ path: 'z.txt', content: 'identical shared content for the no-pairing check' }],
    after: [{ path: 'y.txt', content: 'identical shared content for the no-pairing check' }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: NO_RENAME_BREAK_OPTS,
  },
];

const noRenameBreakFixtures = new Map<string, { readonly dir: string }>();

function noRenameBreakFixtureOf(label: string): { readonly dir: string } {
  const found = noRenameBreakFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('-B break detection without rename detection interop', () => {
  beforeAll(async () => {
    for (const row of NO_RENAME_BREAK_ROWS) {
      noRenameBreakFixtures.set(row.label, await buildRenameRow(row, NO_RENAME_BREAK_TMP_PREFIX));
    }
  }, NO_RENAME_BREAK_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of noRenameBreakFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising -B with rename detection off', () => {
    describe('When diff is called without detectRenames', () => {
      it.each(NO_RENAME_BREAK_ROWS)(
        'Then name-status matches live git for: $label',
        async (row) => {
          // Arrange
          const { dir } = noRenameBreakFixtureOf(row.label);

          // Act
          const { ours, peer } = await runRenameRow(row, dir);

          // Assert
          expect(ours).toBe(peer);
        },
      );
    });
  });
});

/**
 * A kept-broken modify's `--numstat` counts the WHOLE file on each side
 * (git's `complete_rewrite`), never the line diff and never dropped by a
 * whitespace-ignore mode. `runRenameRow` has no `withStat`, so this section
 * calls `diff()` itself and reconstructs numstat locally, comparing against
 * live `git diff --numstat -B`.
 */
const REWRITE_NUMSTAT_TMP_PREFIX = 'tsgit-rewrite-numstat-';
const REWRITE_NUMSTAT_SETUP_TIMEOUT = 60_000;

interface RewriteNumstatRow extends RenameRow {
  readonly ignoreWhitespace?: 'all';
}

const wsRewriteLine = (i: number, gap: string): string =>
  `word${i}a${gap}word${i}b${gap}word${i}c${gap}word${i}d${gap}word${i}e${gap}word${i}f${gap}word${i}g${gap}word${i}h\n`;

/** 40 lines whose words are separated by `gap` — comparing `wsRewrite(' ')` to
 *  `wsRewrite('  ')` differs only in whitespace AMOUNT, which
 *  `ignoreWhitespace: 'all'` erases entirely but a kept-broken rewrite's
 *  numstat does not. */
const wsRewrite = (gap: string): string =>
  Array.from({ length: 40 }, (_, i) => wsRewriteLine(i, gap)).join('');

/** A deterministic 0..126-byte sequence with a forced NUL at index 10 (well
 *  inside the binary-detection window), single-byte-safe under UTF-8 so the
 *  bytes `git`/tsgit each read back are exactly the ones generated here. */
const pseudoRandomBinary = (seed: number, length: number): string => {
  let state = seed;
  const bytes = Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return (state % 127) + 1;
  });
  bytes[10] = 0;
  return String.fromCharCode(...bytes);
};

function numstatCounts(change: StatFields): string {
  return change.binary ? '-\t-' : `${change.added}\t${change.deleted}`;
}

function numstatPath(change: DiffChange): string {
  switch (change.type) {
    case 'add':
      return change.newPath;
    case 'delete':
      return change.oldPath;
    case 'modify':
    case 'type-change':
      return change.path;
    case 'rename':
    case 'copy':
      return `${change.oldPath} => ${change.newPath}`;
  }
}

function numstatFrom(changes: ReadonlyArray<StatDiffChange>): string {
  return changes.map((change) => `${numstatCounts(change)}\t${numstatPath(change)}`).join('\n');
}

function gitPeerNumstat(dir: string, row: RewriteNumstatRow): string {
  const flags = row.gitFlags ?? [];
  const renameFlag = row.detectRenames === false ? '--no-renames' : '-M';
  return git(
    dir,
    'diff',
    '--no-ext-diff',
    '--numstat',
    renameFlag,
    ...flags,
    'HEAD~1',
    'HEAD',
  ).trim();
}

async function runNumstatRow(
  row: RewriteNumstatRow,
  dir: string,
): Promise<{ readonly ours: string; readonly peer: string }> {
  const ctx = createNodeContext({ workDir: dir });
  const peer = gitPeerNumstat(dir, row);
  const result = await diff(ctx, {
    from: 'HEAD~1',
    to: 'HEAD',
    recursive: true,
    withStat: true,
    ...(row.detectRenames !== false ? { detectRenames: true } : {}),
    ...(row.renameOptions !== undefined ? { renameOptions: row.renameOptions } : {}),
    ...(row.ignoreWhitespace !== undefined ? { ignoreWhitespace: row.ignoreWhitespace } : {}),
  });
  return { ours: numstatFrom(result.changes), peer };
}

const REWRITE_NUMSTAT_BREAK_OPTS = { breakRewrites: { score: 30000, merge: 36000 } };
const REWRITE_NUMSTAT_ANY_BREAK_OPTS = { breakRewrites: { score: 1, merge: 1 } };

const REWRITE_NUMSTAT_ROWS: ReadonlyArray<RewriteNumstatRow> = [
  {
    label: 'a partially-rewritten file kept broken counts the whole file on each side',
    before: [{ path: 'm.txt', content: breakContent('old', 40, 15) }],
    after: [{ path: 'm.txt', content: breakContent('new', 40, 15) }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: REWRITE_NUMSTAT_BREAK_OPTS,
  },
  {
    label: 'the same partially-rewritten file re-merged counts only the real line diff',
    before: [{ path: 'm.txt', content: breakContent('old', 40, 15) }],
    after: [{ path: 'm.txt', content: breakContent('new', 40, 15) }],
    detectRenames: false,
    gitFlags: ['-B50%/70%'],
    renameOptions: { breakRewrites: { score: 30000, merge: 42000 } },
  },
  {
    label:
      'a kept-broken rewrite whose new side ends without a final LF counts its incomplete last line',
    before: [{ path: 'm.txt', content: breakContent('old', 40, 0) }],
    after: [{ path: 'm.txt', content: breakContent('new', 30, 0).slice(0, -1) }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: REWRITE_NUMSTAT_ANY_BREAK_OPTS,
  },
  {
    label: 'a kept-broken whitespace-only rewrite counts the whole file (no -w on either side)',
    before: [{ path: 'm.txt', content: wsRewrite(' ') }],
    after: [{ path: 'm.txt', content: wsRewrite('  ') }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: REWRITE_NUMSTAT_ANY_BREAK_OPTS,
  },
  {
    label:
      'the same kept-broken whitespace-only rewrite still counts the whole file under -w (never dropped)',
    before: [{ path: 'm.txt', content: wsRewrite(' ') }],
    after: [{ path: 'm.txt', content: wsRewrite('  ') }],
    detectRenames: false,
    gitFlags: ['-B', '-w'],
    renameOptions: REWRITE_NUMSTAT_ANY_BREAK_OPTS,
    ignoreWhitespace: 'all',
  },
  {
    label: 'a kept-broken rewrite between two random binary blobs reports "- -"',
    before: [{ path: 'm.txt', content: pseudoRandomBinary(1, 2000) }],
    after: [{ path: 'm.txt', content: pseudoRandomBinary(2, 2000) }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: REWRITE_NUMSTAT_ANY_BREAK_OPTS,
  },
  {
    label:
      'a kept-broken rewrite to an empty file counts zero added and the old line count deleted',
    before: [{ path: 'm.txt', content: breakContent('old', 40, 0) }],
    after: [{ path: 'm.txt', content: '' }],
    detectRenames: false,
    gitFlags: ['-B'],
    renameOptions: REWRITE_NUMSTAT_ANY_BREAK_OPTS,
  },
  {
    label:
      'a kept-broken modify alongside an unrelated exact rename, under -M -B, counts the whole file for the modify and zero for the rename',
    before: [
      { path: 'm.txt', content: breakContent('old', 40, 0) },
      { path: 'z.txt', content: NO_RENAME_UNRELATED_CONTENT },
    ],
    after: [
      { path: 'm.txt', content: breakContent('new', 40, 0) },
      { path: 'q.txt', content: breakContent('old', 40, 0) },
      { path: 'y.txt', content: NO_RENAME_UNRELATED_CONTENT },
    ],
    gitFlags: ['-B'],
    renameOptions: REWRITE_NUMSTAT_BREAK_OPTS,
  },
];

const rewriteNumstatFixtures = new Map<string, { readonly dir: string }>();

function rewriteNumstatFixtureOf(label: string): { readonly dir: string } {
  const found = rewriteNumstatFixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('kept-broken rewrite numstat interop', () => {
  beforeAll(async () => {
    for (const row of REWRITE_NUMSTAT_ROWS) {
      rewriteNumstatFixtures.set(row.label, await buildRenameRow(row, REWRITE_NUMSTAT_TMP_PREFIX));
    }
  }, REWRITE_NUMSTAT_SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of rewriteNumstatFixtures.values()) {
      await rmDir(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising -B numstat with a kept-broken modify', () => {
    describe('When diff is called with withStat:true', () => {
      it.each(REWRITE_NUMSTAT_ROWS)('Then numstat matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = rewriteNumstatFixtureOf(row.label);

        // Act
        const { ours, peer } = await runNumstatRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});

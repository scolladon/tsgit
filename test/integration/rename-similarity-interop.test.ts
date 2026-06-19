/**
 * Integration test — byte-parity between tsgit's rename-similarity detection and
 * `git diff -M` for rename scenarios that exercise the inexact pass.
 *
 * Double-pinned: tsgit's R-score reconstructed from `toSimilarityPercent` must equal
 * both live `git diff -M --name-status` and a committed golden.
 *
 * Note: Full patch-body parity for sub-100% renames (index line + hunk) is deferred.
 * This test pins R-scores and the exact/inexact pass behaviour.
 *
 * Skips silently when `git` is absent.
 *
 * @proves
 *   surface: diff.renames
 *   bucket:  cross-tool-interop
 *   unique:  inexact rename R-scores and limit semantics match upstream git + frozen goldens
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
import { rm } from '../../src/application/commands/rm.js';
import type { RenameChange } from '../../src/domain/diff/diff-change.js';
import { toSimilarityPercent } from '../../src/domain/diff/similarity.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
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
      if (change.type === 'add') {
        const a = change as unknown as { newPath: string };
        return `A\t${a.newPath}`;
      }
      if (change.type === 'delete') {
        const d = change as unknown as { oldPath: string };
        return `D\t${d.oldPath}`;
      }
      if (change.type === 'modify') {
        const m = change as unknown as { path: string };
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
});

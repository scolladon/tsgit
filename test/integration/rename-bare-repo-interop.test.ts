/**
 * Integration test — byte-parity between tsgit's rename/break-rewrite
 * detection and `git diff -M`/`-B` when run against a BARE repository (no
 * work tree). Pins the fix for `buildSimilarityContentKindResolver`, which
 * used to throw `WORK_TREE_REQUIRED` the moment a bare-repo diff attempted
 * to fingerprint its first path.
 *
 * Skips silently when `git` is absent.
 *
 * @proves
 *   surface: diff.renames
 *   bucket:  cross-tool-interop
 *   unique:  bare-repository rename/break scoring never throws and matches upstream git
 *   interopSurface: diff
 */
import { mkdtemp, rm as rmDir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopyChange, ModifyChange, RenameChange } from '../../src/domain/diff/diff-change.js';
import { toSimilarityPercent } from '../../src/domain/diff/similarity.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const gitDeterministicEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

const commitDeterministic = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: gitDeterministicEnv() });
};

/** Reconstruct a `--name-status` row string from tsgit's structured TreeDiff
 *  — mirrors the reconstruction pinned in rename-similarity-interop.test.ts. */
const reconstructNameStatus = (changes: ReadonlyArray<{ type: string }>): string =>
  changes
    .map((change) => {
      if (change.type === 'rename') {
        const r = change as unknown as RenameChange;
        return `R${String(toSimilarityPercent(r.similarity.score)).padStart(3, '0')}\t${r.oldPath}\t${r.newPath}`;
      }
      if (change.type === 'copy') {
        const c = change as unknown as CopyChange;
        return `C${String(toSimilarityPercent(c.similarity.score)).padStart(3, '0')}\t${c.oldPath}\t${c.newPath}`;
      }
      if (change.type === 'add') return `A\t${(change as unknown as { newPath: string }).newPath}`;
      if (change.type === 'delete')
        return `D\t${(change as unknown as { oldPath: string }).oldPath}`;
      if (change.type === 'modify') {
        const m = change as unknown as ModifyChange;
        return m.broken !== undefined
          ? `M${String(toSimilarityPercent(m.broken.score)).padStart(3, '0')}\t${m.path}`
          : `M\t${m.path}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

/** 50 lines total, the first `shared` byte-for-byte identical, the rest
 *  replaced — the B5 fixture pinned in similarity.test.ts (git 2.54.0:
 *  `git diff -B --name-status` → M060 for shared=20). */
const makeBreakContent = (kind: 'old' | 'new', total: number, shared: number): string => {
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    lines.push(
      kind === 'old' || i < shared
        ? `line-${String(i).padStart(3, '0')}: shared content alpha beta gamma delta epsilon zeta eta theta\n`
        : `different-${String(i).padStart(3, '0')}: COMPLETELY NEW TEXT ZETA THETA KAPPA LAMBDA MU NU XI OMICRON PI RHO SIGMA\n`,
    );
  }
  return lines.join('');
};

describe.skipIf(!GIT_AVAILABLE)('Given a bare repository (no work tree)', () => {
  let root: string;
  let bareDir: string;
  let baseSha: string;
  let renameSha: string;
  let breakSha: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bare-rename-interop-'));
    const src = path.join(root, 'src');
    runGit(['init', '-q', '-b', 'main', src], { env: runGitEnv() });
    git(src, 'config', 'user.name', 'Ada');
    git(src, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(src);

    await writeFile(path.join(src, 'old.txt'), makeBreakContent('old', 50, 20));
    git(src, 'add', '.');
    commitDeterministic(src, 'base');
    baseSha = git(src, 'rev-parse', 'HEAD').trim();

    // Rename branch: old.txt -> renamed.txt, minor edit (stays similar enough for -M).
    git(src, 'checkout', '-q', '-b', 'rename-branch');
    git(src, 'mv', 'old.txt', 'renamed.txt');
    await writeFile(path.join(src, 'renamed.txt'), makeBreakContent('old', 50, 49));
    git(src, 'add', '.');
    commitDeterministic(src, 'rename');
    renameSha = git(src, 'rev-parse', 'HEAD').trim();

    // Break branch, off base: same path, rewritten past the break threshold.
    git(src, 'checkout', '-q', baseSha);
    git(src, 'checkout', '-q', '-b', 'break-branch');
    await writeFile(path.join(src, 'old.txt'), makeBreakContent('new', 50, 20));
    git(src, 'add', '.');
    commitDeterministic(src, 'rewrite');
    breakSha = git(src, 'rev-parse', 'HEAD').trim();

    bareDir = path.join(root, 'bare.git');
    runGit(['clone', '-q', '--bare', src, bareDir], { env: runGitEnv() });
    disableAutoMaintenance(bareDir);
  }, 30_000);

  afterAll(async () => {
    if (root !== undefined) await rmDir(root, { recursive: true, force: true });
  });

  describe('When diffing a rename pair with -M', () => {
    it('Then tsgit matches git diff --name-status (no WORK_TREE_REQUIRED)', async () => {
      // Arrange
      const golden = git(
        bareDir,
        'diff',
        '--no-ext-diff',
        '-M',
        '--name-status',
        baseSha,
        renameSha,
      ).trim();
      const sut = await openRepository({ gitDir: bareDir });

      try {
        // Act
        const result = await sut.diff({ from: baseSha, to: renameSha, detectRenames: true });

        // Assert
        expect(reconstructNameStatus(result.changes)).toBe(golden);
      } finally {
        await sut.dispose();
      }
    });
  });

  describe('When diffing a break-rewrite pair with -B', () => {
    it('Then tsgit matches git diff --name-status (no WORK_TREE_REQUIRED)', async () => {
      // Arrange
      const golden = git(
        bareDir,
        'diff',
        '--no-ext-diff',
        '-B',
        '--name-status',
        baseSha,
        breakSha,
      ).trim();
      const sut = await openRepository({ gitDir: bareDir });

      try {
        // Act
        const result = await sut.diff({
          from: baseSha,
          to: breakSha,
          renameOptions: { breakRewrites: { score: 0, merge: 0 } },
        });

        // Assert
        expect(reconstructNameStatus(result.changes)).toBe(golden);
      } finally {
        await sut.dispose();
      }
    });
  });
});

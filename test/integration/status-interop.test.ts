/**
 * Cross-tool interop — `status` staged column. Builds repos with canonical git
 * (isolated env, signing off), then reconstructs `git status --porcelain` from
 * tsgit's two structured columns (`indexChanges` = staged X, `workingTreeChanges`
 * = working-tree Y + untracked) and asserts it equals real `git status
 * --porcelain --no-renames`.
 *
 * `--no-renames` isolates the columns tsgit models: like the existing
 * working-tree column, the staged column performs no rename detection, so the
 * comparison is against git's non-rename output. Faithfulness is pinned on the
 * DATA (which path, which column, which kind) — the XY letters are reconstructed
 * here from the structured fields; the library emits no status string.
 *
 * @proves
 *   surface:        status
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's status columns reconstruct canonical `git status --porcelain`
 *   interopSurface: status
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type ChangeKind,
  type StatusResult,
  status as statusCmd,
} from '../../src/application/commands/status.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
let clock = 1_700_000_000;
const createdDirs: string[] = [];

const datedEnv = (): NodeJS.ProcessEnv => {
  clock += 60;
  return {
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'A U Thor',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_NAME: 'A U Thor',
    GIT_COMMITTER_EMAIL: 'author@example.com',
    GIT_COMMITTER_DATE: `${clock} +0000`,
  };
};

/** Fresh repo with a committed `a.txt` + `b.txt` base; returns dir + tsgit ctx. */
const baseRepo = async (slug: string): Promise<{ dir: string; ctx: Context }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-status-${slug}-`));
  createdDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'a.txt'), 'a\n');
  await writeFile(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env: datedEnv() });
  return { dir, ctx: createNodeContext({ workDir: dir }) };
};

const initOnly = async (slug: string): Promise<{ dir: string; ctx: Context }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-status-${slug}-`));
  createdDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  return { dir, ctx: createNodeContext({ workDir: dir }) };
};

const code = (kind: ChangeKind): string =>
  kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : kind === 'modified' ? 'M' : '?';

/** Reconstruct `git status --porcelain` from tsgit's two columns. */
const reconstruct = (s: StatusResult): string => {
  const staged = new Map(s.indexChanges.map((c) => [c.path, c.kind]));
  const worktree = new Map(
    s.workingTreeChanges.filter((c) => c.kind !== 'untracked').map((c) => [c.path, c.kind]),
  );
  const trackedPaths = [...new Set([...staged.keys(), ...worktree.keys()])].sort();
  const trackedLines = trackedPaths.map((p) => {
    const sk = staged.get(p);
    const wk = worktree.get(p);
    return `${sk === undefined ? ' ' : code(sk)}${wk === undefined ? ' ' : code(wk)} ${p}`;
  });
  const untrackedLines = s.workingTreeChanges
    .filter((c) => c.kind === 'untracked')
    .map((c) => c.path)
    .sort()
    .map((p) => `?? ${p}`);
  const lines = [...trackedLines, ...untrackedLines];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

const gitPorcelain = (dir: string): string => git(dir, 'status', '--porcelain', '--no-renames');

afterAll(async () => {
  await Promise.all(createdDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!GIT_AVAILABLE)('status interop — staged column', () => {
  it(
    'Then a staged add reconstructs git status --porcelain',
    async () => {
      // Arrange — stage a new file without committing.
      const { dir, ctx } = await baseRepo('add');
      await writeFile(path.join(dir, 'c.txt'), 'c\n');
      git(dir, 'add', 'c.txt');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged modify reconstructs git status --porcelain',
    async () => {
      // Arrange — restage a.txt with new content; working tree matches index.
      const { dir, ctx } = await baseRepo('modify');
      await writeFile(path.join(dir, 'a.txt'), 'changed\n');
      git(dir, 'add', 'a.txt');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged delete (removed from index and disk) reconstructs git',
    async () => {
      // Arrange
      const { dir, ctx } = await baseRepo('delete');
      git(dir, 'rm', '-q', 'a.txt');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a cached delete (kept on disk) reconstructs git D + ??',
    async () => {
      // Arrange — `rm --cached` leaves the file on disk → staged delete + untracked.
      const { dir, ctx } = await baseRepo('cached');
      git(dir, 'rm', '-q', '--cached', 'a.txt');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged-then-worktree modify reconstructs git MM',
    async () => {
      // Arrange — stage one change, then edit on disk again.
      const { dir, ctx } = await baseRepo('mm');
      await writeFile(path.join(dir, 'a.txt'), 'staged\n');
      git(dir, 'add', 'a.txt');
      await writeFile(path.join(dir, 'a.txt'), 'worktree\n');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then an unborn HEAD with staged files reconstructs git (all A)',
    async () => {
      // Arrange — stage files with no commit yet.
      const { dir, ctx } = await initOnly('unborn');
      await writeFile(path.join(dir, 'a.txt'), 'a\n');
      await writeFile(path.join(dir, 'z.txt'), 'z\n');
      git(dir, 'add', '-A');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a clean tree reconstructs git (empty)',
    async () => {
      // Arrange
      const { dir, ctx } = await baseRepo('clean');

      // Act / Assert
      const sut = await statusCmd(ctx);
      expect(sut.clean).toBe(true);
      expect(reconstruct(sut)).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged type change reconstructs git (file becomes a symlink)',
    async () => {
      // Arrange — replace a regular file with a symlink and stage it. git reports
      // `T` in porcelain; tsgit collapses it to `modified` (M), so this is asserted
      // structurally, not by byte-equal porcelain.
      const { dir, ctx } = await baseRepo('typechange');
      await rm(path.join(dir, 'a.txt'));
      await symlink('elsewhere', path.join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');

      // Act
      const sut = await statusCmd(ctx);

      // Assert — staged column carries a.txt as modified; git agrees a change is
      // staged (its porcelain X is `T`, our coarse projection is `M`).
      expect(sut.indexChanges).toEqual([{ kind: 'modified', path: 'a.txt' }]);
      expect(git(dir, 'status', '--porcelain', '--no-renames')).toMatch(/^T. a\.txt$/m);
    },
    SETUP_TIMEOUT,
  );
});

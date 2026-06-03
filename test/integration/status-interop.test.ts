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
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type ChangeKind,
  type ConflictKind,
  type StatusResult,
  status as statusCmd,
} from '../../src/application/commands/status.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

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

/**
 * A repo mid-merge with four unmerged states: `both-mod.txt` (UU), `both-add.txt`
 * (AA), `them-del.txt` (we modify, they delete → UD), `us-del.txt` (we delete,
 * they modify → DU). git writes the conflicted index; tsgit reads it.
 */
const conflictRepo = async (slug: string): Promise<{ dir: string; ctx: Context }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-status-${slug}-`));
  createdDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'both-mod.txt'), 'base\n');
  await writeFile(path.join(dir, 'them-del.txt'), 'base\n');
  await writeFile(path.join(dir, 'us-del.txt'), 'base\n');
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env: datedEnv() });

  git(dir, 'checkout', '-q', '-b', 'feature');
  await writeFile(path.join(dir, 'both-mod.txt'), 'theirs\n');
  await rm(path.join(dir, 'them-del.txt'));
  await writeFile(path.join(dir, 'us-del.txt'), 'theirs\n');
  await writeFile(path.join(dir, 'both-add.txt'), 'theirs\n');
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'feature'], { env: datedEnv() });

  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, 'both-mod.txt'), 'ours\n');
  await writeFile(path.join(dir, 'them-del.txt'), 'ours\n');
  await rm(path.join(dir, 'us-del.txt'));
  await writeFile(path.join(dir, 'both-add.txt'), 'ours\n');
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'main'], { env: datedEnv() });

  tryRunGit(['-C', dir, 'merge', 'feature'], { env: datedEnv() });
  return { dir, ctx: createNodeContext({ workDir: dir }) };
};

const code = (kind: ChangeKind): string => {
  if (kind === 'added') return 'A';
  if (kind === 'deleted') return 'D';
  if (kind === 'type-changed') return 'T';
  if (kind === 'modified' || kind === 'mode-changed') return 'M';
  return '?';
};

// git's unmerged `XY` is a function of which stages are present (the same mapping
// `classifyUnmerged` encodes); reconstruct it from the structured conflict state.
const CONFLICT_XY: Record<ConflictKind, string> = {
  'both-modified': 'UU',
  'both-added': 'AA',
  'both-deleted': 'DD',
  'added-by-us': 'AU',
  'added-by-them': 'UA',
  'deleted-by-us': 'DU',
  'deleted-by-them': 'UD',
};

/** Reconstruct `git status --porcelain` from tsgit's structured columns. */
const reconstruct = (s: StatusResult): string => {
  const staged = new Map(s.indexChanges.map((c) => [c.path, c.kind]));
  const worktree = new Map(
    s.workingTreeChanges.filter((c) => c.kind !== 'untracked').map((c) => [c.path, c.kind]),
  );
  const unmerged = new Map(s.unmerged.map((u) => [u.path, u.kind]));
  const trackedPaths = [
    ...new Set([...staged.keys(), ...worktree.keys(), ...unmerged.keys()]),
  ].sort();
  const trackedLines = trackedPaths.map((p) => {
    const conflict = unmerged.get(p);
    if (conflict !== undefined) return `${CONFLICT_XY[conflict]} ${p}`;
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
    'Then a staged type change reconstructs git status --porcelain (T)',
    async () => {
      // Arrange — replace a regular file with a symlink and stage it; worktree
      // then matches the index, so git reports `T ` (staged only).
      const { dir, ctx } = await baseRepo('typechange');
      await rm(path.join(dir, 'a.txt'));
      await symlink('elsewhere', path.join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');

      // Act / Assert — byte-equal, no longer a structural-only carve-out.
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged mode change reconstructs git status --porcelain (M)',
    async () => {
      // Arrange — flip the exec bit and stage it (same blob). With core.fileMode
      // on, git reports `M ` (staged only); tsgit's staged column is `mode-changed`.
      const { dir, ctx } = await baseRepo('mode-change');
      git(dir, 'config', 'core.fileMode', 'true');
      await chmod(path.join(dir, 'a.txt'), 0o755);
      git(dir, 'add', 'a.txt');

      // Act / Assert
      expect(reconstruct(await statusCmd(ctx))).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a conflicted merge reconstructs git status --porcelain (UU/AA/UD/DU)',
    async () => {
      // Arrange — a real git merge conflict exercising four unmerged states. git
      // writes stages 1/2/3; tsgit reads that index and reconstructs the U-codes.
      const { dir, ctx } = await conflictRepo('unmerged');

      // Act
      const sut = await statusCmd(ctx);

      // Assert — byte-equal unmerged reporting, and the repo is not clean.
      expect(reconstruct(sut)).toBe(gitPorcelain(dir));
      expect(sut.clean).toBe(false);
    },
    SETUP_TIMEOUT,
  );
});

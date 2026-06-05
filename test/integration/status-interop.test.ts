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
import type { FilePath } from '../../src/domain/objects/index.js';
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
  return 'M'; // 'modified' | 'mode-changed'
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

/** Reconstruct `git status --porcelain` (v1) from tsgit's structured columns. */
const reconstruct = (s: StatusResult): string => {
  const staged = new Map<FilePath, ChangeKind>();
  const worktree = new Map<FilePath, ChangeKind>();
  for (const c of s.changes) {
    if (c.staged !== undefined) staged.set(c.path, c.staged);
    if (c.unstaged !== undefined) worktree.set(c.path, c.unstaged);
  }
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
  const untrackedLines = [...s.untracked].sort().map((p) => `?? ${p}`);
  const lines = [...trackedLines, ...untrackedLines];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

const gitPorcelain = (dir: string): string => git(dir, 'status', '--porcelain', '--no-renames');

const ZERO_OID = '0'.repeat(40);

/**
 * Reconstruct `git status --porcelain=v2`'s ordinary (`1`) + untracked (`?`) lines
 * from the change endpoints — `1 <XY> N... <mH> <mI> <mW> <hH> <hI> <path>`. An
 * unchanged side is `.`; an absent side is `000000` / 40 zeros. Pins the new
 * blob-side modes and oids byte-for-byte. Conflicted (`u`) lines are out of scope.
 */
const reconstructV2 = (s: StatusResult): string => {
  const changedLines = s.changes.map((c) => {
    const x = c.staged === undefined ? '.' : code(c.staged);
    const y = c.unstaged === undefined ? '.' : code(c.unstaged);
    const mH = c.head?.mode ?? '000000';
    const mI = c.index?.mode ?? '000000';
    const mW = c.worktree?.mode ?? '000000';
    const hH = c.head?.id ?? ZERO_OID;
    const hI = c.index?.id ?? ZERO_OID;
    return `1 ${x}${y} N... ${mH} ${mI} ${mW} ${hH} ${hI} ${c.path}`;
  });
  const untrackedLines = [...s.untracked].sort().map((p) => `? ${p}`);
  const lines = [...changedLines, ...untrackedLines];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

const gitPorcelainV2 = (dir: string): string =>
  git(dir, 'status', '--porcelain=v2', '--no-renames');

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

describe.skipIf(!GIT_AVAILABLE)('status interop — porcelain v2 endpoints', () => {
  it(
    'Then mixed staged/unstaged changes reconstruct git status --porcelain=v2 (modes + oids)',
    async () => {
      // Arrange — base has a/b/d/e; drive each into a distinct XY state so one
      // repo exercises every endpoint shape: staged add, staged modify, unstaged
      // modify, MM, staged delete, unstaged delete, and an untracked file.
      const { dir, ctx } = await baseRepo('v2-mixed');
      await writeFile(path.join(dir, 'd.txt'), 'd\n');
      await writeFile(path.join(dir, 'e.txt'), 'e\n');
      git(dir, 'add', '-A');
      runGit(['-C', dir, 'commit', '-q', '-m', 'more'], { env: datedEnv() });

      await writeFile(path.join(dir, 'a.txt'), 'a-staged\n'); // staged modify (M.)
      git(dir, 'add', 'a.txt');
      await writeFile(path.join(dir, 'b.txt'), 'b-worktree\n'); // unstaged modify (.M)
      await writeFile(path.join(dir, 'c.txt'), 'c\n'); // staged add (A.)
      git(dir, 'add', 'c.txt');
      await writeFile(path.join(dir, 'd.txt'), 'd-staged\n'); // MM
      git(dir, 'add', 'd.txt');
      await writeFile(path.join(dir, 'd.txt'), 'd-worktree\n');
      git(dir, 'rm', '-q', 'e.txt'); // staged delete (D )
      await writeFile(path.join(dir, 'u.txt'), 'u\n'); // untracked (?)

      // Act
      const sut = await statusCmd(ctx);

      // Assert — byte-equal ordinary + untracked v2 lines (modes mH/mI/mW, oids hH/hI).
      expect(reconstructV2(sut)).toBe(gitPorcelainV2(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged symlink type change reconstructs git v2 (mode 100644→120000)',
    async () => {
      // Arrange — replace a regular file with a symlink and stage it (worktree
      // matches index → `T.`); pins mH=100644, mI=mW=120000.
      const { dir, ctx } = await baseRepo('v2-type');
      await rm(path.join(dir, 'a.txt'));
      await symlink('elsewhere', path.join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');

      // Act / Assert
      expect(reconstructV2(await statusCmd(ctx))).toBe(gitPorcelainV2(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a staged exec-mode change reconstructs git v2 (mode 100644→100755, same oid)',
    async () => {
      // Arrange — flip the exec bit and stage it (same blob → `M.`); pins
      // mH=100644, mI=mW=100755 with hH==hI.
      const { dir, ctx } = await baseRepo('v2-mode');
      git(dir, 'config', 'core.fileMode', 'true');
      await chmod(path.join(dir, 'a.txt'), 0o755);
      git(dir, 'add', 'a.txt');

      // Act / Assert
      expect(reconstructV2(await statusCmd(ctx))).toBe(gitPorcelainV2(dir));
    },
    SETUP_TIMEOUT,
  );

  it(
    'Then a clean tree reconstructs git v2 (empty)',
    async () => {
      // Arrange
      const { dir, ctx } = await baseRepo('v2-clean');

      // Act / Assert
      expect(reconstructV2(await statusCmd(ctx))).toBe(gitPorcelainV2(dir));
    },
    SETUP_TIMEOUT,
  );
});

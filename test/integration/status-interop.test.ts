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
  type UnmergedEntry,
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

/** Byte-order comparator for the tracked section (git sorts `1`/`u` lines together). */
const byPath = (a: { path: string }, b: { path: string }): number => {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
};

/**
 * Reconstruct an unmerged `u` line — `u <XY> N... <m1> <m2> <m3> <mW> <h1> <h2>
 * <h3> <path>`. The stage modes/oids come from `base`/`ours`/`theirs`; `mW` from
 * the worktree side (`000000` when the conflicted file is absent on disk).
 */
const unmergedV2Line = (u: UnmergedEntry): string => {
  const m1 = u.base?.mode ?? '000000';
  const m2 = u.ours?.mode ?? '000000';
  const m3 = u.theirs?.mode ?? '000000';
  const mW = u.worktree?.mode ?? '000000';
  const h1 = u.base?.id ?? ZERO_OID;
  const h2 = u.ours?.id ?? ZERO_OID;
  const h3 = u.theirs?.id ?? ZERO_OID;
  return `u ${CONFLICT_XY[u.kind]} N... ${m1} ${m2} ${m3} ${mW} ${h1} ${h2} ${h3} ${u.path}`;
};

/**
 * Reconstruct `git status --porcelain=v2`'s ordinary (`1`), unmerged (`u`), and
 * untracked (`?`) lines from the structured fields. Ordinary line:
 * `1 <XY> N... <mH> <mI> <mW> <hH> <hI> <path>` (unchanged side `.`; absent side
 * `000000` / 40 zeros). Ordinary and unmerged lines are interleaved in byte-path
 * order (git emits the tracked section sorted together); untracked `?` lines
 * follow. Pins every changed-entry mode/oid — including the conflicted `mW` — byte
 * for byte.
 */
const reconstructV2 = (s: StatusResult): string => {
  const ordinary = s.changes.map((c) => {
    const x = c.staged === undefined ? '.' : code(c.staged);
    const y = c.unstaged === undefined ? '.' : code(c.unstaged);
    const mH = c.head?.mode ?? '000000';
    const mI = c.index?.mode ?? '000000';
    const mW = c.worktree?.mode ?? '000000';
    const hH = c.head?.id ?? ZERO_OID;
    const hI = c.index?.id ?? ZERO_OID;
    return { path: c.path, line: `1 ${x}${y} N... ${mH} ${mI} ${mW} ${hH} ${hI} ${c.path}` };
  });
  const unmerged = s.unmerged.map((u) => ({ path: u.path, line: unmergedV2Line(u) }));
  const trackedLines = [...ordinary, ...unmerged].sort(byPath).map((t) => t.line);
  const untrackedLines = [...s.untracked].sort().map((p) => `? ${p}`);
  const lines = [...trackedLines, ...untrackedLines];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

const gitPorcelainV2 = (dir: string): string =>
  git(dir, 'status', '--porcelain=v2', '--no-renames');

afterAll(async () => {
  await Promise.all(createdDirs.map((d) => rm(d, { recursive: true, force: true })));
});

interface StatusScenario {
  readonly label: string;
  readonly slug: string;
  readonly arrange: (slug: string) => Promise<{ dir: string; ctx: Context }>;
  readonly expectedClean?: boolean;
}

// Each scenario reconstructs `git status --porcelain` (v1) from tsgit's staged
// column; the same journey/oracle, differing only in how the row's Arrange
// drives the repo into its target state.
const STATUS_PORCELAIN_V1_MATRIX: ReadonlyArray<StatusScenario> = [
  {
    label: 'a staged add',
    slug: 'add',
    // Stage a new file without committing.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      await writeFile(path.join(dir, 'c.txt'), 'c\n');
      git(dir, 'add', 'c.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a staged modify',
    slug: 'modify',
    // Restage a.txt with new content; working tree matches index.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      await writeFile(path.join(dir, 'a.txt'), 'changed\n');
      git(dir, 'add', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a staged delete (removed from index and disk)',
    slug: 'delete',
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      git(dir, 'rm', '-q', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a cached delete (kept on disk, git D + ??)',
    slug: 'cached',
    // `rm --cached` leaves the file on disk → staged delete + untracked.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      git(dir, 'rm', '-q', '--cached', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a staged-then-worktree modify (MM)',
    slug: 'mm',
    // Stage one change, then edit on disk again.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      await writeFile(path.join(dir, 'a.txt'), 'staged\n');
      git(dir, 'add', 'a.txt');
      await writeFile(path.join(dir, 'a.txt'), 'worktree\n');
      return { dir, ctx };
    },
  },
  {
    label: 'an unborn HEAD with staged files (all A)',
    slug: 'unborn',
    // Stage files with no commit yet.
    arrange: async (slug) => {
      const { dir, ctx } = await initOnly(slug);
      await writeFile(path.join(dir, 'a.txt'), 'a\n');
      await writeFile(path.join(dir, 'z.txt'), 'z\n');
      git(dir, 'add', '-A');
      return { dir, ctx };
    },
  },
  {
    label: 'a clean tree (empty)',
    slug: 'clean',
    arrange: (slug) => baseRepo(slug),
    expectedClean: true,
  },
  {
    label: 'a staged type change (T)',
    slug: 'typechange',
    // Replace a regular file with a symlink and stage it; worktree then
    // matches the index, so git reports `T ` (staged only).
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      await rm(path.join(dir, 'a.txt'));
      await symlink('elsewhere', path.join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a staged mode change (M)',
    slug: 'mode-change',
    // Flip the exec bit and stage it (same blob). With core.fileMode on, git
    // reports `M ` (staged only); tsgit's staged column is `mode-changed`.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      git(dir, 'config', 'core.fileMode', 'true');
      await chmod(path.join(dir, 'a.txt'), 0o755);
      git(dir, 'add', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a conflicted merge (UU/AA/UD/DU)',
    slug: 'unmerged',
    // A real git merge conflict exercising four unmerged states. git writes
    // stages 1/2/3; tsgit reads that index and reconstructs the U-codes.
    arrange: (slug) => conflictRepo(slug),
    expectedClean: false,
  },
];

// Each scenario reconstructs `git status --porcelain=v2` from tsgit's
// structured fields (modes/oids for ordinary lines, m1..mW/h1..h3 for
// unmerged lines); same journey/oracle across ordinary and unmerged rows.
const STATUS_PORCELAIN_V2_MATRIX: ReadonlyArray<StatusScenario> = [
  {
    label: 'mixed staged/unstaged changes (modes + oids)',
    slug: 'v2-mixed',
    // base has a/b/d/e; drive each into a distinct XY state so one repo
    // exercises every endpoint shape: staged add, staged modify, unstaged
    // modify, MM, staged delete, unstaged delete, and an untracked file.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
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
      return { dir, ctx };
    },
  },
  {
    label: 'a staged symlink type change (mode 100644→120000)',
    slug: 'v2-type',
    // Replace a regular file with a symlink and stage it (worktree matches
    // index → `T.`); pins mH=100644, mI=mW=120000.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      await rm(path.join(dir, 'a.txt'));
      await symlink('elsewhere', path.join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a staged exec-mode change (mode 100644→100755, same oid)',
    slug: 'v2-mode',
    // Flip the exec bit and stage it (same blob → `M.`); pins mH=100644,
    // mI=mW=100755 with hH==hI.
    arrange: async (slug) => {
      const { dir, ctx } = await baseRepo(slug);
      git(dir, 'config', 'core.fileMode', 'true');
      await chmod(path.join(dir, 'a.txt'), 0o755);
      git(dir, 'add', 'a.txt');
      return { dir, ctx };
    },
  },
  {
    label: 'a clean tree (empty)',
    slug: 'v2-clean',
    arrange: (slug) => baseRepo(slug),
  },
  {
    label: 'a conflicted merge (u-lines, mW present)',
    slug: 'v2-unmerged',
    // UU/AA/UD/DU, each conflicted file left on disk → mW = 100644.
    arrange: (slug) => conflictRepo(slug),
  },
  {
    label: 'a conflicted file removed from disk (mW=000000)',
    slug: 'v2-unmerged-absent',
    // Drop one conflicted file from the working tree so its mW flips to
    // 000000 while its stage blobs (m1/m2/m3, h1/h2/h3) stay put.
    arrange: async (slug) => {
      const { dir, ctx } = await conflictRepo(slug);
      await rm(path.join(dir, 'both-mod.txt'));
      return { dir, ctx };
    },
  },
];

describe.skipIf(!GIT_AVAILABLE)('status interop — staged column', () => {
  it.each(STATUS_PORCELAIN_V1_MATRIX)(
    'Then $label reconstructs git status --porcelain',
    async ({ slug, arrange, expectedClean }) => {
      // Arrange
      const { dir, ctx } = await arrange(slug);

      // Act
      const sut = await statusCmd(ctx);

      // Assert
      if (expectedClean !== undefined) expect(sut.clean).toBe(expectedClean);
      expect(reconstruct(sut)).toBe(gitPorcelain(dir));
    },
    SETUP_TIMEOUT,
  );
});

describe.skipIf(!GIT_AVAILABLE)('status interop — porcelain v2', () => {
  it.each(STATUS_PORCELAIN_V2_MATRIX)(
    'Then $label reconstructs git status --porcelain=v2',
    async ({ slug, arrange }) => {
      // Arrange
      const { dir, ctx } = await arrange(slug);

      // Act / Assert
      expect(reconstructV2(await statusCmd(ctx))).toBe(gitPorcelainV2(dir));
    },
    SETUP_TIMEOUT,
  );
});

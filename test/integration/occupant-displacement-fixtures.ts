/** History, occupant and outcome builders shared by the occupant-displacement interop suites. */
import {
  chmodSync,
  cpSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { TsgitError } from '../../src/domain/error.js';
import { runGit, runGitEnv } from './interop-helpers.js';

export const SYMLINK_MODE = '120000';
export const REGULAR_MODE = '100644';
export const GITLINK_MODE = '160000';
export const GITLINK_OID = '1111111111111111111111111111111111111111';
export const OCCUPANT = 'occupant\n';
export const UNTRACKED = 'untracked\n';
export const DANGLING_TARGET = 'nowhere';

export const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

export interface TreeEntry {
  readonly mode: string;
  readonly content: string;
  readonly path: string;
}

export const regular = (entryPath: string, content = 'v2\n'): TreeEntry => ({
  mode: REGULAR_MODE,
  content,
  path: entryPath,
});
export const symlink = (entryPath: string, target = 't-v2'): TreeEntry => ({
  mode: SYMLINK_MODE,
  content: target,
  path: entryPath,
});
/** A gitlink's `content` is the commit id it pins. */
export const gitlink = (entryPath: string, commit = GITLINK_OID): TreeEntry => ({
  mode: GITLINK_MODE,
  content: commit,
  path: entryPath,
});

/**
 * Whether the index file was rewritten is judged by inode AND ctime: ext4 hands a freed inode
 * straight back to the next `index.lock`, so the inode alone reads a rewrite as untouched.
 */
export const indexIdentity = (dir: string): string => {
  const stat = statSync(path.join(dir, '.git', 'index'), { bigint: true });
  return `${stat.ino}:${stat.ctimeNs}`;
};

export const commitOn = (
  dir: string,
  entries: ReadonlyArray<TreeEntry>,
  parent?: string,
): string => {
  runGit(['-C', dir, 'read-tree', '--empty']);
  for (const entry of entries) {
    const oid =
      entry.mode === GITLINK_MODE
        ? entry.content
        : runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: entry.content }).trim();
    runGit([
      '-C',
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `${entry.mode},${oid},${entry.path}`,
    ]);
  }
  const tree = runGit(['-C', dir, 'write-tree']).trim();
  const parents = parent === undefined ? [] : ['-p', parent];
  return runGit(['-C', dir, 'commit-tree', tree, ...parents, '-m', 'seed'], {
    env: COMMIT_ENV,
  }).trim();
};

export const KEEP = regular('keep', 'keep\n');

/** `main` holds `keep` and the tracked entries; `t` is its child and holds `keep` and the due entries. */
export const buildHistory = (
  dir: string,
  due: ReadonlyArray<TreeEntry>,
  tracked: ReadonlyArray<TreeEntry> = [],
): void => {
  const main = commitOn(dir, [KEEP, ...tracked]);
  const target = commitOn(dir, [KEEP, ...due], main);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/t', target]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

export type Occupant = (dir: string) => void;

/** The work tree gives up the tracked path (and its leading directory) before the occupant takes its place. */
export const replacing =
  (trackedPath: string, occupant: Occupant): Occupant =>
  (dir) => {
    rmSync(path.join(dir, trackedPath.split('/')[0] ?? trackedPath), {
      recursive: true,
      force: true,
    });
    occupant(dir);
  };
export const emptyDirectoryAt =
  (rel: string): Occupant =>
  (dir) =>
    mkdirSync(path.join(dir, rel), { recursive: true });

export const fileAt =
  (rel: string): Occupant =>
  (dir) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), OCCUPANT);
  };
export const danglingLinkAt =
  (rel: string): Occupant =>
  (dir) =>
    symlinkSync(DANGLING_TARGET, path.join(dir, rel));
export const directoryHolding =
  (rel: string, child: string): Occupant =>
  (dir) => {
    mkdirSync(path.join(dir, rel), { recursive: true });
    writeFileSync(path.join(dir, rel, child), UNTRACKED);
  };
/** A symlink at `rel` whose target holds a file at `child`: content is reachable through the link. */
export const linkToContent =
  (rel: string, holder: string, child: string): Occupant =>
  (dir) => {
    directoryHolding(holder, child)(dir);
    symlinkSync(holder, path.join(dir, rel));
  };
/** A symlink at `rel` to a regular file: the tracked child cannot be reached through it. */
export const linkToFile =
  (rel: string, holder: string): Occupant =>
  (dir) => {
    writeFileSync(path.join(dir, holder), OCCUPANT);
    rmSync(path.join(dir, rel), { recursive: true, force: true });
    symlinkSync(holder, path.join(dir, rel));
  };
/** The tracked directory moved to `holder` (same inodes) and a symlink to it left at `rel`. */
export const movedBehindLink =
  (rel: string, holder: string): Occupant =>
  (dir) => {
    renameSync(path.join(dir, rel), path.join(dir, holder));
    symlinkSync(holder, path.join(dir, rel));
  };
/** The tracked directory copied to `holder` (new inodes) and a symlink to the copy left at `rel`. */
export const copiedBehindLink =
  (rel: string, holder: string): Occupant =>
  (dir) => {
    cpSync(path.join(dir, rel), path.join(dir, holder), { recursive: true });
    rmSync(path.join(dir, rel), { recursive: true, force: true });
    symlinkSync(holder, path.join(dir, rel));
  };
/** The index trusts `rel` is unchanged (assume-unchanged) before the occupant takes its place. */
export const assumingUnchanged =
  (rel: string, occupant: Occupant): Occupant =>
  (dir) => {
    runGit(['-C', dir, 'update-index', '--assume-unchanged', rel]);
    occupant(dir);
  };
export const ignoring =
  (pattern: string, occupant: Occupant): Occupant =>
  (dir) => {
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), `${pattern}\n`);
    occupant(dir);
  };

/** `rel` rewritten with `content`, leaving whatever stat the write gives it. */
export const fileWith =
  (rel: string, content: string): Occupant =>
  (dir) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
const FIVE_SECONDS_MS = 5_000;
const TEN_SECONDS_MS = 10_000;
const EXECUTABLE_PERMISSIONS = 0o755;
/** `rel` keeps its content but its mtime moves forward, so the index no longer matches its stat. */
export const touchedAt =
  (rel: string): Occupant =>
  (dir) => {
    const later = new Date(Date.now() + FIVE_SECONDS_MS);
    lutimesSync(path.join(dir, rel), later, later);
  };
export const chmodAt =
  (rel: string): Occupant =>
  (dir) =>
    chmodSync(path.join(dir, rel), EXECUTABLE_PERMISSIONS);
export const linkAt =
  (rel: string, target: string): Occupant =>
  (dir) => {
    rmSync(path.join(dir, rel), { recursive: true, force: true });
    symlinkSync(target, path.join(dir, rel));
  };
/** The index marks `rel` skip-worktree before the occupant takes its place. */
export const skipWorktreeAt =
  (rel: string, occupant: Occupant): Occupant =>
  (dir) => {
    runGit(['-C', dir, 'update-index', '--skip-worktree', rel]);
    occupant(dir);
  };

const blobOf = (dir: string, content: string): string =>
  runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

const stagedLines = (dir: string, rel: string, stages: ReadonlyArray<1 | 2 | 3>): string =>
  stages
    .map((stage) => `${REGULAR_MODE} ${blobOf(dir, `stage ${stage}\n`)} ${stage}\t${rel}\n`)
    .join('');

const CONFLICTED = 'conflicted\n';
/** `rel` is conflicted in the index (stages 1-3) with a conflicted work file. */
export const unmergedAt =
  (rel: string): Occupant =>
  (dir) => {
    runGit(['-C', dir, 'update-index', '--index-info'], {
      input: `0 ${'0'.repeat(40)}\t${rel}\n${stagedLines(dir, rel, [1, 2, 3])}`,
    });
    fileWith(rel, CONFLICTED)(dir);
  };
/** `rel` is conflicted in the index (stages 2-3 only, as an add/add) with a conflicted work file. */
export const unmergedAbsentAt =
  (rel: string): Occupant =>
  (dir) => {
    runGit(['-C', dir, 'update-index', '--index-info'], {
      input: stagedLines(dir, rel, [2, 3]),
    });
    fileWith(rel, CONFLICTED)(dir);
  };

const trackedPaths = (dir: string): string[] =>
  runGit(['-C', dir, 'ls-files', '-z'])
    .split('\0')
    .filter((rel) => rel !== '');

const isPresent = (full: string): boolean => {
  try {
    return !lstatSync(full).isDirectory();
  } catch {
    return false;
  }
};

/** Back-dates every tracked work file and refreshes the index, so no entry is racily clean. */
export const settleIndex = (dir: string): void => {
  const past = new Date(Date.now() - TEN_SECONDS_MS);
  for (const rel of trackedPaths(dir)) {
    const full = path.join(dir, rel);
    if (isPresent(full)) lutimesSync(full, past, past);
  }
  runGit(['-C', dir, 'update-index', '-q', '--refresh']);
};

export interface FileIdentity {
  readonly ino: number;
  readonly mtimeMs: number;
}

export const statSnapshot = (dir: string): Map<string, FileIdentity> => {
  const snapshot = new Map<string, FileIdentity>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) continue;
    const { ino, mtimeMs } = lstatSync(full);
    snapshot.set(rel, { ino, mtimeMs });
  }
  return snapshot;
};

/** Paths present both before and after whose inode or mtime moved: the work file was rewritten. */
export const rewrittenPaths = (
  before: ReadonlyMap<string, FileIdentity>,
  after: ReadonlyMap<string, FileIdentity>,
): string[] =>
  [...before.keys()]
    .filter((rel) => {
      const now = after.get(rel);
      const then = before.get(rel);
      return now !== undefined && (now.ino !== then?.ino || now.mtimeMs !== then?.mtimeMs);
    })
    .sort();

const DEBUG_FIELD = /(ino|size): (\d+)|mtime: (\d+):/g;

interface CachedStat {
  ino: number;
  size: number;
  mtimeSeconds: number;
}

const cachedStatsOf = (dir: string): Map<string, CachedStat> => {
  const stats = new Map<string, CachedStat>();
  let current: string | undefined;
  let cached: CachedStat | undefined;
  for (const line of runGit(['-C', dir, 'ls-files', '--debug']).split('\n')) {
    if (line !== '' && !line.startsWith(' ')) {
      current = line;
      cached = { ino: 0, size: 0, mtimeSeconds: 0 };
      stats.set(current, cached);
      continue;
    }
    for (const [, key, value, mtime] of line.matchAll(DEBUG_FIELD)) {
      if (cached === undefined) continue;
      if (key === 'ino') cached.ino = Number(value);
      else if (key === 'size') cached.size = Number(value);
      else cached.mtimeSeconds = Number(mtime);
    }
  }
  return stats;
};

/** Tracked paths whose cached ino, size or mtime second no longer match the work file (git would rehash them). */
export const staleEntries = (dir: string): string[] => {
  const stale: string[] = [];
  for (const [rel, cached] of cachedStatsOf(dir)) {
    const full = path.join(dir, rel);
    if (!isPresent(full)) {
      stale.push(rel);
      continue;
    }
    const now = lstatSync(full);
    if (
      now.ino !== cached.ino ||
      now.size !== cached.size ||
      Math.floor(now.mtimeMs / 1000) !== cached.mtimeSeconds
    ) {
      stale.push(rel);
    }
  }
  return stale.sort();
};

const OWNER_EXECUTE = 0o100;
/** listing(dir) with an `(+x)` suffix on executable regular files. */
export const modeListing = (dir: string): string[] =>
  listing(dir).map((line) => {
    const rel = line.split('=')[0] ?? line;
    const full = path.join(dir, rel);
    const executable = line.includes('=') && (lstatSync(full).mode & OWNER_EXECUTE) !== 0;
    return executable ? `${line}(+x)` : line;
  });

export const flagListing = (dir: string): string => runGit(['-C', dir, 'ls-files', '-v']);

export interface Outcome {
  readonly refused: boolean;
  readonly crash?: string;
  readonly localChanges: ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
}

export const OK: Outcome = { refused: false, localChanges: [], untracked: [] };
export const refusedUntracked = (...paths: ReadonlyArray<string>): Outcome => ({
  refused: true,
  localChanges: [],
  untracked: paths,
});

export const refusedLocal = (...paths: ReadonlyArray<string>): Outcome => ({
  refused: true,
  localChanges: paths,
  untracked: [],
});

export const LOCAL_CHANGES_HEADER = /local changes/;
export const UNTRACKED_HEADER = /untracked/;

/** Reads the refusal class and paths git prints; `lose-untracked` is tsgit's `untracked` (ratified equivalence). */
export const outcomeOfGitStderr = (stderr: string): Outcome => {
  const localChanges: string[] = [];
  const untracked: string[] = [];
  let bucket: string[] | undefined;
  for (const line of stderr.split('\n')) {
    if (line.startsWith('\t')) bucket?.push(line.slice(1));
    else if (LOCAL_CHANGES_HEADER.test(line)) bucket = localChanges;
    else if (UNTRACKED_HEADER.test(line)) bucket = untracked;
  }
  return { refused: true, localChanges, untracked };
};

export type DirtyRefusalCode = 'WORKING_TREE_DIRTY' | 'CHECKOUT_OVERWRITE_DIRTY';

/** A refusal other than the dirty one is a crash: it carries its code and no paths. */
export const outcomeOfTsgitRefusal = (err: unknown, dirtyCode: DirtyRefusalCode): Outcome => {
  if (!(err instanceof TsgitError)) throw err;
  const data = err.data;
  if (data.code !== dirtyCode) {
    return { refused: true, crash: data.code, localChanges: [], untracked: [] };
  }
  return { refused: true, localChanges: data.localChanges, untracked: data.untracked };
};

export const tsgitOutcomeOf = async (
  run: () => Promise<unknown>,
  dirtyCode: DirtyRefusalCode,
): Promise<Outcome> => {
  try {
    await run();
    return OK;
  } catch (err) {
    return outcomeOfTsgitRefusal(err, dirtyCode);
  }
};

export const gitOutcomeOfExit = (
  result: { exitCode: number; stderr: string },
  refusedExit: number,
  classify: (stderr: string) => Outcome,
): Outcome => {
  if (result.exitCode === 0) return OK;
  if (result.exitCode !== refusedExit) {
    throw new Error(`unexpected exit ${result.exitCode}: ${result.stderr}`);
  }
  return classify(result.stderr);
};

export const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.parentPath.includes(`${path.sep}.git`) && entry.name !== '.git')
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      const rel = path.relative(dir, full);
      if (lstatSync(full).isSymbolicLink()) return `${rel}@->${readlinkSync(full)}`;
      return entry.isDirectory() ? `${rel}/` : `${rel}=${readFileSync(full, 'utf8')}`;
    })
    .sort();

export const indexState = (dir: string): string[] => [
  runGit(['-C', dir, 'ls-files', '-s']),
  runGit(['-C', dir, 'ls-files', '-t']),
];

export const v1 = (entryPath: string): TreeEntry => regular(entryPath, 'v1\n');
export const link1 = (entryPath: string): TreeEntry => symlink(entryPath, 't-v1');

export interface MergeFamilyRow {
  readonly id: string;
  readonly tracked: ReadonlyArray<TreeEntry>;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly git: Outcome;
  readonly commands: ReadonlyArray<'cherry-pick' | 'stash apply' | 'stash pop'>;
}

const EVERY_COMMAND = ['cherry-pick', 'stash apply', 'stash pop'] as const;

/** The occupant rows the merge family weighs before it writes; git's outcome is pinned per row. */
export const MERGE_FAMILY_ROWS: ReadonlyArray<MergeFamilyRow> = [
  {
    id: 'S1/add',
    tracked: [],
    due: [regular('d/x')],
    occupant: fileAt('d'),
    git: refusedUntracked('d'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S1/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', fileAt('d')),
    git: refusedLocal('d/x'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3a/add',
    tracked: [],
    due: [regular('d/x')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3d/add',
    tracked: [],
    due: [symlink('d/l')],
    occupant: fileAt('d'),
    git: refusedUntracked('d'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3d/update',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', fileAt('d')),
    git: refusedLocal('d/l'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3g/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', linkToContent('d', 'held', 'x')),
    git: refusedLocal('d/x'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3h/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: linkToFile('d', 'held'),
    git: refusedLocal('d/x'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3i/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: movedBehindLink('d', 'held'),
    git: OK,
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3j/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: copiedBehindLink('d', 'held'),
    git: refusedLocal('d/x'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'D5/delete',
    tracked: [v1('d/x')],
    due: [],
    occupant: replacing('d/x', linkToContent('d', 'held', 'x')),
    git: refusedLocal('d/x'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'S3e/add',
    tracked: [],
    due: [symlink('d/l')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'D1/delete',
    tracked: [v1('d/x')],
    due: [],
    occupant: replacing('d/x', fileAt('d')),
    git: refusedLocal('d/x'),
    commands: EVERY_COMMAND,
  },
  {
    id: 'I1/add',
    tracked: [],
    due: [regular('d/x')],
    occupant: ignoring('d', fileAt('d')),
    git: OK,
    commands: ['cherry-pick'],
  },
  {
    id: 'I4/add',
    tracked: [],
    due: [symlink('d/l')],
    occupant: ignoring('d', fileAt('d')),
    git: OK,
    commands: ['cherry-pick'],
  },
  {
    id: 'I2/add',
    tracked: [],
    due: [regular('f')],
    occupant: ignoring('f/u', directoryHolding('f', 'u')),
    git: OK,
    commands: EVERY_COMMAND,
  },
  {
    id: 'I6/add',
    tracked: [],
    due: [regular('f')],
    occupant: ignoring('f', fileAt('f')),
    git: OK,
    commands: ['cherry-pick', 'stash apply'],
  },
  {
    id: 'I7/add',
    tracked: [],
    due: [regular('f')],
    occupant: ignoring('f', danglingLinkAt('f')),
    git: OK,
    commands: ['cherry-pick'],
  },
];

/** Runs a git command that refuses with `refusalStatus` and reads the refusal's classes and paths. */
export const runGitOutcome = (
  dir: string,
  args: ReadonlyArray<string>,
  refusalStatus: number,
): Outcome => {
  try {
    runGit(['-C', dir, ...args]);
    return OK;
  } catch (err) {
    const { status, stderr } = err as { status: number | null; stderr: Buffer };
    if (status !== refusalStatus) throw err;
    return outcomeOfGitStderr(stderr.toString());
  }
};

/** A merge-family stop whose conflicted path sits one directory down, so a replaced `d` obstructs its restoration. */
export const NESTED_CONFLICT = {
  base: [v1('d/x')],
  main: [regular('d/x', 'm\n')],
  theirs: [regular('d/x', 't\n')],
};

export const NESTED_OCCUPANTS: ReadonlyArray<readonly [string, Occupant]> = [
  ['an untracked file d', replacing('d/x', fileAt('d'))],
  ['an ignored file d', replacing('d/x', ignoring('d', fileAt('d')))],
  ['a symlink d', replacing('d/x', (dir) => symlinkSync('nowhere', path.join(dir, 'd')))],
  ['a directory d holding an untracked file', replacing('d/x', directoryHolding('d', 'u'))],
  [
    'a directory d holding an ignored file',
    replacing('d/x', ignoring('d/u', directoryHolding('d', 'u'))),
  ],
];

const stagedAt =
  (rel: string, content: string): Occupant =>
  (dir) => {
    fileWith(rel, content)(dir);
    runGit(['-C', dir, 'add', rel]);
  };

export interface WorkTreeShape {
  readonly tracked: ReadonlyArray<TreeEntry>;
  readonly plant: Occupant;
}

export const WORK_TREE_SHAPES: Readonly<Record<string, WorkTreeShape>> = {
  C: { tracked: [v1('f')], plant: () => undefined },
  E: { tracked: [v1('f')], plant: fileWith('f', 'edited\n') },
  T: { tracked: [v1('f')], plant: touchedAt('f') },
  M: { tracked: [v1('f')], plant: chmodAt('f') },
  Dw: { tracked: [v1('f')], plant: (dir) => rmSync(path.join(dir, 'f')) },
  AU: { tracked: [v1('f')], plant: assumingUnchanged('f', fileWith('f', 'edited\n')) },
  SW: { tracked: [v1('f')], plant: skipWorktreeAt('f', fileWith('f', 'edited\n')) },
  S3a: { tracked: [v1('a/payload')], plant: replacing('a/payload', danglingLinkAt('a')) },
  S3g: { tracked: [v1('a/payload')], plant: copiedBehindLink('a', 'held') },
  S3i: { tracked: [v1('a/payload')], plant: movedBehindLink('a', 'held') },
  S1: { tracked: [v1('d/x')], plant: replacing('d/x', fileAt('d')) },
  S2: { tracked: [v1('f')], plant: replacing('f', directoryHolding('f', 'u')) },
  S2e: { tracked: [v1('f')], plant: replacing('f', emptyDirectoryAt('f')) },
  S3b: { tracked: [v1('f')], plant: replacing('f', danglingLinkAt('f')) },
  LF: { tracked: [v1('f'), v1('g')], plant: linkAt('f', 'g') },
  S3f: { tracked: [link1('l')], plant: replacing('l', fileWith('l', 't-v1')) },
  S3c: { tracked: [link1('l')], plant: replacing('l', directoryHolding('l', 'u')) },
  S3d: { tracked: [link1('d/l')], plant: replacing('d/l', fileAt('d')) },
  LR: { tracked: [link1('l')], plant: linkAt('l', 'elsewhere') },
  GL: { tracked: [gitlink('s')], plant: () => undefined },
  GLf: { tracked: [gitlink('s')], plant: replacing('s', fileAt('s')) },
  ST: { tracked: [v1('f')], plant: stagedAt('f', 'staged\n') },
  SA: { tracked: [v1('f')], plant: stagedAt('n', 'new\n') },
  SD: { tracked: [v1('f')], plant: (dir) => void runGit(['-C', dir, 'rm', '-q', 'f']) },
  SDk: {
    tracked: [v1('f')],
    plant: (dir) => void runGit(['-C', dir, 'rm', '-q', '--cached', 'f']),
  },
  U: { tracked: [v1('f')], plant: fileWith('u', 'untracked\n') },
  UM: { tracked: [v1('f')], plant: unmergedAt('f') },
  UMn: { tracked: [v1('f')], plant: unmergedAbsentAt('n') },
};

export interface Observed {
  readonly work: string[];
  readonly index: string[];
  readonly flags: string;
  readonly stale: string[];
  readonly rewritten: string[];
}

export const observe = (dir: string, before: ReadonlyMap<string, FileIdentity>): Observed => ({
  work: modeListing(dir),
  index: indexState(dir),
  flags: flagListing(dir),
  stale: staleEntries(dir),
  rewritten: rewrittenPaths(before, statSnapshot(dir)),
});

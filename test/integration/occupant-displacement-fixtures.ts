/** History, occupant and outcome builders shared by the occupant-displacement interop suites. */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
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
export const gitlink = (entryPath: string): TreeEntry => ({
  mode: GITLINK_MODE,
  content: '',
  path: entryPath,
});

export const commitOn = (
  dir: string,
  entries: ReadonlyArray<TreeEntry>,
  parent?: string,
): string => {
  runGit(['-C', dir, 'read-tree', '--empty']);
  for (const entry of entries) {
    const oid =
      entry.mode === GITLINK_MODE
        ? GITLINK_OID
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
export const ignoring =
  (pattern: string, occupant: Occupant): Occupant =>
  (dir) => {
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), `${pattern}\n`);
    occupant(dir);
  };

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

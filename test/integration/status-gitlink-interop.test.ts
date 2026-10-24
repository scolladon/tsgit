/**
 * Cross-tool interop — `status` over a tracked gitlink compares the submodule's checked-out
 * HEAD with the recorded commit, as git does. Compared with `git status --porcelain=v2 -uall`.
 *
 * @proves
 *   surface:        status
 *   bucket:         cross-tool-interop
 *   unique:         status compares a gitlink with its submodule HEAD and never refreshes it as git does
 *   interopSurface: status
 */

import { constants, existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { commit } from '../../src/application/commands/commit.js';
import { type ChangedPath, status } from '../../src/application/commands/status.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import {
  GIT_AVAILABLE,
  makeFifo,
  makeSparseFile,
  NON_BLOCKING_TIMEOUT_MS,
  OVERSIZED_GITFILE_BYTES,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const REFUSED_EXIT = 128;
const MIB = 1 << 20;
const PINNED_DATE = '@1700000000 +0000';
const SETTLE_MS = 1_100;
const ABSENT_MODE = '000000';
const ABSENT_ID = '0'.repeat(40);
const NO_CHANGE = '.';
const SUBMODULE = 'sub';
const NOT_A_SUBMODULE = 'N...';

type Setup = (repo: string) => Promise<void>;

const roots: string[] = [];

const pinnedEnv = () => ({
  ...runGitEnv(),
  GIT_AUTHOR_DATE: PINNED_DATE,
  GIT_COMMITTER_DATE: PINNED_DATE,
});

const gitIn = (repo: string, ...args: string[]): string =>
  runGit(
    [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { env: pinnedEnv() },
  );

const commitIn = (repo: string, message: string): void => {
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', message);
};

const sub = (repo: string, ...rest: string[]): string => path.join(repo, SUBMODULE, ...rest);
const moduleDir = (repo: string): string => path.join(repo, '.git', 'modules', SUBMODULE);

const buildFixture = async (root: string): Promise<string> => {
  const upstream = path.join(root, 'up');
  const superproject = path.join(root, 'fixture');
  for (const repo of [upstream, superproject]) {
    runGit(['init', '-q', '-b', 'main', repo]);
  }
  await writeFile(path.join(upstream, 'u'), 'u\n');
  gitIn(upstream, 'add', 'u');
  commitIn(upstream, 'up');
  await writeFile(path.join(superproject, 'k'), 'k\n');
  gitIn(superproject, 'add', 'k');
  commitIn(superproject, 'k');
  gitIn(superproject, 'submodule', 'add', '-q', upstream, SUBMODULE);
  commitIn(superproject, 'sub');
  return superproject;
};

const moved: Setup = async (repo) => commitIn(sub(repo), 'z');

const emptied: Setup = async (repo) => {
  await rm(sub(repo), { recursive: true });
  await mkdir(sub(repo));
};

const gitRemoved: Setup = async (repo) => {
  await rm(sub(repo, '.git'));
};

const embedded: Setup = async (repo) => {
  await rm(sub(repo, '.git'));
  await rename(moduleDir(repo), sub(repo, '.git'));
  gitIn(
    repo,
    'config',
    '--file',
    path.join(sub(repo, '.git'), 'config'),
    '--unset',
    'core.worktree',
  );
};

const fetchedFromUnrelated: Setup = async (repo) => {
  const other = `${repo}-other`;
  runGit(['init', '-q', '-b', 'main', other]);
  commitIn(other, 'other');
  gitIn(sub(repo), 'fetch', '-q', other, 'main');
  gitIn(sub(repo), 'checkout', '-q', '--detach', 'FETCH_HEAD');
};

const replacedByFile =
  (mode: number): Setup =>
  async (repo) => {
    await rm(sub(repo), { recursive: true });
    await writeFile(sub(repo), 'f\n');
    await chmod(sub(repo), mode);
  };

const editedUpstreamFile: Setup = async (repo) => writeFile(sub(repo, 'u'), 'edited\n');

const untrackedFile: Setup = async (repo) => writeFile(sub(repo, 'n'), 'n\n');

const orphanBranch: Setup = async (repo) => {
  gitIn(sub(repo), 'checkout', '-q', '--orphan', 'o');
};

const NESTED = 'in';

/** `sub` records a commit that holds the nested submodule `sub/in`, then `sub/in` moves. */
const nestedMoved: Setup = async (repo) => {
  const upstream = path.join(path.dirname(repo), 'nested-up');
  if (!existsSync(upstream)) {
    runGit(['init', '-q', '-b', 'main', upstream]);
    commitIn(upstream, 'in');
  }
  gitIn(sub(repo), 'submodule', 'add', '-q', upstream, NESTED);
  commitIn(sub(repo), 'nest');
  gitIn(repo, 'add', SUBMODULE);
  commitIn(repo, 'record');
  commitIn(sub(repo, NESTED), 'z');
};

const compose =
  (...steps: Setup[]): Setup =>
  async (repo) => {
    for (const step of steps) await step(repo);
  };

const flagged =
  (flag: string): Setup =>
  async (repo) => {
    gitIn(repo, 'update-index', flag, SUBMODULE);
  };

const ignoredUntracked: Setup = async (repo) => {
  await writeFile(sub(repo, 'n'), 'n\n');
  await mkdir(path.join(moduleDir(repo), 'info'), { recursive: true });
  await writeFile(path.join(moduleDir(repo), 'info', 'exclude'), 'n\n');
};

const stagedMoved: Setup = async (repo) => {
  await moved(repo);
  gitIn(repo, 'add', SUBMODULE);
};

const stagedDeletion: Setup = async (repo) => {
  gitIn(repo, 'rm', '-q', '--cached', SUBMODULE);
};

const DIRECTORY = 'd';

const underDirectory: Setup = async (repo) => {
  await mkdir(path.join(repo, DIRECTORY));
  gitIn(repo, 'mv', SUBMODULE, `${DIRECTORY}/${SUBMODULE}`);
  commitIn(repo, 'move');
};

const regularUnderDirectory: Setup = async (repo) => {
  await mkdir(path.join(repo, DIRECTORY));
  await writeFile(path.join(repo, DIRECTORY, 'f'), 'f\n');
  gitIn(repo, 'add', `${DIRECTORY}/f`);
  commitIn(repo, 'regular');
};

/** The directory moves out of the repository and a symlink to it takes its place. */
const linkedAway: Setup = async (repo) => {
  const away = `${repo}-away`;
  await rename(path.join(repo, DIRECTORY), away);
  await symlink(away, path.join(repo, DIRECTORY));
};

const writtenDotGit =
  (body: string): Setup =>
  async (repo) => {
    await rm(sub(repo, '.git'));
    await writeFile(sub(repo, '.git'), body);
  };

const sparseDotGit =
  (size: number): Setup =>
  async (repo) => {
    await rm(sub(repo, '.git'));
    makeSparseFile(sub(repo, '.git'), size);
  };

const emptyDirectoryDotGit: Setup = async (repo) => {
  await rm(sub(repo, '.git'));
  await mkdir(sub(repo, '.git'));
};

const moduleHeadGarbage: Setup = async (repo) =>
  writeFile(path.join(moduleDir(repo), 'HEAD'), 'garbage');

const moduleObjectsRemoved: Setup = async (repo) =>
  rm(path.join(moduleDir(repo), 'objects'), { recursive: true });

const FORMAT_REFUSALS: ReadonlyArray<{
  readonly title: string;
  readonly config: ReadonlyArray<readonly [string, string]>;
  readonly gitMessage: string;
  readonly data: unknown;
}> = [
  {
    title: 'repositoryformatversion 2',
    config: [['core.repositoryformatversion', '2']],
    gitMessage: 'Expected git repo version <= 1, found 2',
    data: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 2 },
  },
  {
    title: 'an unknown extension',
    config: [
      ['core.repositoryformatversion', '1'],
      ['extensions.something', 'true'],
    ],
    gitMessage: 'unknown repository extension found:',
    data: {
      code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
      extensions: ['something'],
      version: 1,
    },
  },
];

const gitmodulesPath = (repo: string): string => path.join(repo, '.gitmodules');

const gitmodulesIgnoring =
  (value: string): Setup =>
  async (repo) => {
    gitIn(repo, 'config', '--file', gitmodulesPath(repo), `submodule.${SUBMODULE}.ignore`, value);
  };

const stagedGitmodules =
  (value: string): Setup =>
  async (repo) => {
    await gitmodulesIgnoring(value)(repo);
    gitIn(repo, 'add', '.gitmodules');
  };

const committedGitmodules =
  (value: string): Setup =>
  async (repo) => {
    await stagedGitmodules(value)(repo);
    commitIn(repo, 'ignore');
  };

const configured =
  (key: string, value: string): Setup =>
  async (repo) => {
    gitIn(repo, 'config', key, value);
  };

const ownIgnore = (value: string): Setup => configured(`submodule.${SUBMODULE}.ignore`, value);

const sharedIgnore = (value: string): Setup => configured('diff.ignoreSubmodules', value);

const gitmodulesDeleted: Setup = async (repo) => rm(gitmodulesPath(repo));

const gitmodulesNamed =
  (name: string, value: string): Setup =>
  async (repo) =>
    writeFile(
      gitmodulesPath(repo),
      `[submodule "${name}"]\n\tpath = ${SUBMODULE}\n\turl = x\n\tignore = ${value}\n`,
    );

const symlinkedTo =
  (target: (repo: string) => Promise<string>): Setup =>
  async (repo) => {
    const resolved = await target(repo);
    await rm(sub(repo), { recursive: true });
    await symlink(resolved, sub(repo));
  };

const symlinkToDirectory = symlinkedTo(async (repo) => {
  const away = `${repo}-away`;
  await mkdir(away);
  return away;
});

const symlinkToFile = symlinkedTo(async () => 'k');

const gitlinkDropped: Setup = async (repo) => {
  gitIn(repo, 'rm', '-q', '-f', SUBMODULE);
  commitIn(repo, 'drop');
};

interface Refusal {
  readonly title: string;
  readonly setup: Setup;
  readonly gitMessage: string;
  readonly data: unknown;
}

const REFUSALS: ReadonlyArray<Refusal> = [
  {
    title: 'a gitfile of exactly 1 MiB',
    setup: sparseDotGit(MIB),
    gitMessage: 'invalid gitfile format: sub/.git',
    data: { code: 'NOT_A_REPOSITORY', path: 'sub/.git' },
  },
  {
    title: 'a gitfile past 1 MiB',
    setup: sparseDotGit(OVERSIZED_GITFILE_BYTES),
    gitMessage: "too large to be a .git file: 'sub/.git'",
    data: { code: 'GITFILE_TOO_LARGE', path: 'sub/.git' },
  },
  {
    title: 'a gitfile past 1 MiB and a moved module HEAD',
    setup: compose(moved, sparseDotGit(OVERSIZED_GITFILE_BYTES)),
    gitMessage: "too large to be a .git file: 'sub/.git'",
    data: { code: 'GITFILE_TOO_LARGE', path: 'sub/.git' },
  },
  {
    title: 'an empty directory as .git',
    setup: emptyDirectoryDotGit,
    gitMessage: "'sub/.git' not recognized as a git repository",
    data: { code: 'NOT_A_REPOSITORY', path: 'sub/.git' },
  },
  {
    title: 'a gitfile naming a missing module directory',
    setup: writtenDotGit('gitdir: ../.git/modules/nowhere\n'),
    gitMessage: 'not a git repository: sub/../.git/modules/nowhere',
    data: { code: 'NOT_A_REPOSITORY', path: 'sub/../.git/modules/nowhere' },
  },
  {
    title: 'a gitfile that is not a pointer',
    setup: writtenDotGit('garbage'),
    gitMessage: 'invalid gitfile format: sub/.git',
    data: { code: 'NOT_A_REPOSITORY', path: 'sub/.git' },
  },
  {
    title: 'a module HEAD that is garbage',
    setup: moduleHeadGarbage,
    gitMessage: 'not a git repository: sub/../.git/modules/sub',
    data: { code: 'NOT_A_REPOSITORY', path: 'sub/../.git/modules/sub' },
  },
  {
    title: 'a module without its objects directory',
    setup: moduleObjectsRemoved,
    gitMessage: 'not a git repository: sub/../.git/modules/sub',
    data: { code: 'NOT_A_REPOSITORY', path: 'sub/../.git/modules/sub' },
  },
  {
    title: 'a committed .gitmodules untracked and an oversized gitfile',
    setup: compose(committedGitmodules('untracked'), sparseDotGit(OVERSIZED_GITFILE_BYTES)),
    gitMessage: "too large to be a .git file: 'sub/.git'",
    data: { code: 'GITFILE_TOO_LARGE', path: 'sub/.git' },
  },
  {
    title: 'a symlink to a directory in place of the submodule',
    setup: symlinkToDirectory,
    gitMessage: "expected submodule path 'sub' not to be a symbolic link",
    data: { code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' },
  },
  {
    title: 'a symlink to a file in place of the submodule',
    setup: symlinkToFile,
    gitMessage: "expected submodule path 'sub' not to be a symbolic link",
    data: { code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' },
  },
  {
    title: 'a committed .gitmodules untracked and a symlink in place of the submodule',
    setup: compose(committedGitmodules('untracked'), symlinkToFile),
    gitMessage: "expected submodule path 'sub' not to be a symbolic link",
    data: { code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' },
  },
];

const ROWS: ReadonlyArray<readonly [string, Setup]> = [
  ['a populated unmoved submodule', async () => {}],
  [
    'a deinitialised submodule',
    async (repo) => void gitIn(repo, 'submodule', 'deinit', '-q', '-f', SUBMODULE),
  ],
  [
    'an emptied directory with the modules removed',
    compose(emptied, (repo) => rm(path.join(repo, '.git', 'modules'), { recursive: true })),
  ],
  [
    'an empty directory with the module moved away',
    compose(emptied, (repo) => rename(moduleDir(repo), `${moduleDir(repo)}-away`)),
  ],
  ['a removed .git file with the module kept', gitRemoved],
  ['a removed .git file with the module HEAD moved', compose(moved, gitRemoved)],
  [
    'a detached HEAD at the recorded commit',
    async (repo) => void gitIn(sub(repo), 'checkout', '-q', '--detach'),
  ],
  ['a moved submodule', moved],
  ['a submodule with an edited tracked file', editedUpstreamFile],
  ['a submodule with an untracked file', untrackedFile],
  ['a submodule with an edited and an untracked file', compose(editedUpstreamFile, untrackedFile)],
  ['a moved submodule with an edited file', compose(moved, editedUpstreamFile)],
  ['a submodule on an orphan branch', orphanBranch],
  ['a nested submodule that moved', nestedMoved],
  ['a submodule moved to a commit from an unrelated repository', fetchedFromUnrelated],
  ['an embedded .git directory, moved', compose(embedded, moved)],
  ['a file in place of the submodule', replacedByFile(0o644)],
  ['an executable file in place of the submodule', replacedByFile(0o755)],
  ['a removed submodule', async (repo) => rm(sub(repo), { recursive: true })],
  ['a moved submodule marked skip-worktree', compose(moved, flagged('--skip-worktree'))],
  [
    'a moved submodule marked skip-worktree with an edited file',
    compose(moved, flagged('--skip-worktree'), editedUpstreamFile),
  ],
  ['a moved submodule marked assume-unchanged', compose(moved, flagged('--assume-unchanged'))],
  [
    'a moved submodule marked assume-unchanged with an edited file',
    compose(moved, flagged('--assume-unchanged'), editedUpstreamFile),
  ],
  ['an untracked file ignored by the submodule exclude file', ignoredUntracked],
  ['a moved submodule staged in the index', stagedMoved],
  ['a submodule removed from the index only', stagedDeletion],
  ['a gitlink below a directory replaced by a symlink', compose(underDirectory, linkedAway)],
  [
    'a regular file below a directory replaced by a symlink',
    compose(regularUnderDirectory, linkedAway),
  ],
];

const IGNORE_ROWS: ReadonlyArray<readonly [string, Setup]> = [
  [
    'a committed .gitmodules dirty and an edited file',
    compose(committedGitmodules('dirty'), editedUpstreamFile),
  ],
  [
    'diff.ignoreSubmodules dirty and an edited file',
    compose(sharedIgnore('dirty'), editedUpstreamFile),
  ],
  [
    'a committed .gitmodules dirty and an untracked file',
    compose(committedGitmodules('dirty'), untrackedFile),
  ],
  [
    'a committed .gitmodules dirty and a moved submodule',
    compose(committedGitmodules('dirty'), moved),
  ],
  ['config untracked and an untracked file', compose(ownIgnore('untracked'), untrackedFile)],
  [
    'a working .gitmodules untracked and an untracked file',
    compose(gitmodulesIgnoring('untracked'), untrackedFile),
  ],
  [
    'a working .gitmodules untracked and an edited file',
    compose(gitmodulesIgnoring('untracked'), editedUpstreamFile),
  ],
  [
    'a working .gitmodules untracked and a moved submodule',
    compose(gitmodulesIgnoring('untracked'), moved),
  ],
  [
    'an index .gitmodules all and a working .gitmodules none over a moved submodule',
    compose(stagedGitmodules('all'), gitmodulesIgnoring('none'), moved),
  ],
  [
    'a deleted working .gitmodules over an index and HEAD all and a moved submodule',
    compose(committedGitmodules('all'), gitmodulesDeleted, moved),
  ],
  [
    'status.submoduleSummary and a moved submodule',
    compose(configured('status.submoduleSummary', 'true'), moved),
  ],
  ['a working .gitmodules all and a moved submodule', compose(gitmodulesIgnoring('all'), moved)],
  ['diff.ignoreSubmodules all and a moved submodule', compose(sharedIgnore('all'), moved)],
  [
    'config none over a working .gitmodules all and a moved submodule',
    compose(ownIgnore('none'), gitmodulesIgnoring('all'), moved),
  ],
  [
    'a working .gitmodules none over diff.ignoreSubmodules all and a moved submodule',
    compose(gitmodulesIgnoring('none'), sharedIgnore('all'), moved),
  ],
  [
    'a .gitmodules section named apart from its path with all and a moved submodule',
    compose(gitmodulesNamed('alias', 'all'), moved),
  ],
  [
    'a .gitmodules ignore value outside the four modes and a moved submodule',
    compose(gitmodulesIgnoring('bogus'), moved),
  ],
  [
    'a committed .gitmodules all and an oversized gitfile',
    compose(committedGitmodules('all'), sparseDotGit(OVERSIZED_GITFILE_BYTES)),
  ],
  [
    'a committed .gitmodules dirty and an oversized gitfile',
    compose(committedGitmodules('dirty'), sparseDotGit(OVERSIZED_GITFILE_BYTES)),
  ],
  [
    'a committed .gitmodules dirty and a symlink in place of the submodule',
    compose(committedGitmodules('dirty'), symlinkToDirectory),
  ],
  [
    'a dropped gitlink and a dangling bogus submodule key',
    compose(gitlinkDropped, configured('submodule.x.ignore', 'bogus')),
  ],
  [
    'a dropped gitlink and a valid diff.ignoreSubmodules',
    compose(gitlinkDropped, sharedIgnore('dirty')),
  ],
];

interface ConfigRefusal {
  readonly title: string;
  readonly setup: Setup;
  readonly gitMessage: string;
  readonly code: string;
}

const INVALID_VALUE = 'bad --ignore-submodules argument: bogus';

const CONFIG_REFUSALS: ReadonlyArray<ConfigRefusal> = [
  {
    title: 'diff.ignoreSubmodules bogus and no gitlink in the index',
    setup: compose(gitlinkDropped, sharedIgnore('bogus')),
    gitMessage: INVALID_VALUE,
    code: 'CONFIG_INVALID_ENUM_VALUE',
  },
  {
    title: 'diff.ignoreSubmodules bogus beside config none',
    setup: compose(ownIgnore('none'), sharedIgnore('bogus')),
    gitMessage: INVALID_VALUE,
    code: 'CONFIG_INVALID_ENUM_VALUE',
  },
  {
    title: 'diff.ignoreSubmodules bogus beside a .gitmodules none',
    setup: compose(gitmodulesIgnoring('none'), sharedIgnore('bogus')),
    gitMessage: INVALID_VALUE,
    code: 'CONFIG_INVALID_ENUM_VALUE',
  },
  {
    title: 'config bogus for the submodule',
    setup: ownIgnore('bogus'),
    gitMessage: INVALID_VALUE,
    code: 'CONFIG_INVALID_ENUM_VALUE',
  },
];

const ALL_ROWS = [...ROWS, ...IGNORE_ROWS];

const modeOf = (side: { readonly mode: string } | undefined): string => side?.mode ?? ABSENT_MODE;

const columnOf = (kind: ChangedPath['staged']): string => {
  if (kind === undefined) return NO_CHANGE;
  if (kind === 'modified' || kind === 'mode-changed') return 'M';
  if (kind === 'type-changed') return 'T';
  if (kind === 'deleted') return 'D';
  return 'A';
};

const submoduleFieldOf = (submodule: ChangedPath['submodule']): string => {
  if (submodule === undefined) return NOT_A_SUBMODULE;
  const flag = (set: boolean, letter: string): string => (set ? letter : NO_CHANGE);
  return `S${flag(submodule.commitChanged, 'C')}${flag(submodule.trackedChanges, 'M')}${flag(submodule.untrackedChanges, 'U')}`;
};

/** git's `1 XY <sub> mH mI mW hH hI path` line, rebuilt from the structured change. */
const fieldsOf = (change: ChangedPath): string =>
  [
    `${columnOf(change.staged)}${columnOf(change.unstaged)}`,
    submoduleFieldOf(change.submodule),
    modeOf(change.head),
    modeOf(change.index),
    modeOf(change.worktree),
    change.head?.id ?? ABSENT_ID,
    change.index?.id ?? ABSENT_ID,
    change.path,
  ].join(' ');

const gitFieldsOf = (line: string): string => {
  const [, xy, subField, mH, mI, mW, hH, hI, ...rest] = line.split(' ');
  return [xy, subField, mH, mI, mW, hH, hI, rest.join(' ')].join(' ');
};

const porcelain = (repo: string): string[] =>
  gitIn(repo, 'status', '--porcelain=v2', '-uall').split('\n').filter(Boolean);

const gitChanges = (lines: string[]): string[] =>
  lines.filter((line) => line.startsWith('1 ')).map(gitFieldsOf);

const gitUntracked = (lines: string[]): string[] =>
  lines.filter((line) => line.startsWith('? ')).map((line) => line.slice(2));

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Two `git status` runs more than a second apart leave no racily-clean entry for either tool to refresh. */
const settle = async (repo: string): Promise<void> => {
  gitIn(repo, 'status', '--porcelain=v2');
  await wait(SETTLE_MS);
  gitIn(repo, 'status', '--porcelain=v2');
  await wait(SETTLE_MS);
};

const indexBytes = (repo: string): Promise<Buffer> => readFile(path.join(repo, '.git', 'index'));

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Feature: status over a tracked gitlink compared with git',
  () => {
    let root: string;
    let fixture: string;

    const twin = async (name: string): Promise<string> => {
      const dir = path.join(root, name);
      await cp(fixture, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      return dir;
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-status-gitlink-'));
      roots.push(root);
      fixture = await buildFixture(root);
    }, ROW_TIMEOUT);

    afterAll(async () => {
      await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    describe.each(ALL_ROWS)('Given %s', (_title, setup) => {
      describe('When status runs in both tools', () => {
        it(
          'Then the changed and untracked paths match git',
          async () => {
            // Arrange
            const gitTwin = await twin(`git-${ALL_ROWS.findIndex(([t]) => t === _title)}`);
            const tsgitTwin = await twin(`tsgit-${ALL_ROWS.findIndex(([t]) => t === _title)}`);
            await setup(gitTwin);
            await setup(tsgitTwin);
            const lines = porcelain(gitTwin);
            const sut = status;

            // Act
            const result = await sut(createNodeContext({ workDir: tsgitTwin }));

            // Assert
            expect(result.changes.map(fieldsOf)).toEqual(gitChanges(lines));
            expect([...result.untracked].sort()).toEqual(gitUntracked(lines).sort());
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a moved submodule and a settled index', () => {
      describe('When status runs', () => {
        it(
          'Then the index bytes are unchanged in both tools',
          async () => {
            // Arrange
            const gitTwin = await twin('git-moved-index');
            const tsgitTwin = await twin('tsgit-moved-index');
            for (const repo of [gitTwin, tsgitTwin]) {
              await moved(repo);
              await settle(repo);
            }
            const gitBefore = await indexBytes(gitTwin);
            const tsgitBefore = await indexBytes(tsgitTwin);
            const sut = status;

            // Act
            gitIn(gitTwin, 'status', '--porcelain=v2');
            await sut(createNodeContext({ workDir: tsgitTwin }));

            // Assert
            expect((await indexBytes(gitTwin)).equals(gitBefore)).toBe(true);
            expect((await indexBytes(tsgitTwin)).equals(tsgitBefore)).toBe(true);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a settled index and a submodule directory whose stat drifted', () => {
      describe('When status runs', () => {
        it(
          'Then the index bytes are unchanged in both tools',
          async () => {
            // Arrange
            const gitTwin = await twin('git-drift');
            const tsgitTwin = await twin('tsgit-drift');
            for (const repo of [gitTwin, tsgitTwin]) {
              await settle(repo);
              await writeFile(sub(repo, 'x'), 'x\n');
              await rm(sub(repo, 'x'));
              const now = new Date();
              await utimes(sub(repo), now, now);
            }
            const gitBefore = await indexBytes(gitTwin);
            const tsgitBefore = await indexBytes(tsgitTwin);
            const sut = status;

            // Act
            gitIn(gitTwin, 'status', '--porcelain=v2');
            const result = await sut(createNodeContext({ workDir: tsgitTwin }));

            // Assert
            expect((await indexBytes(gitTwin)).equals(gitBefore)).toBe(true);
            expect((await indexBytes(tsgitTwin)).equals(tsgitBefore)).toBe(true);
            expect(result.changes).toEqual([]);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a staged file and a moved submodule', () => {
      describe('When the commit is made', () => {
        it(
          'Then the tree records the gitlink as git does and its index stat is left as it was',
          async () => {
            // Arrange
            const identity: AuthorIdentity = {
              name: 't',
              email: 't@t',
              timestamp: 1_700_000_000,
              timezoneOffset: '+0000',
            };
            const gitTwin = await twin('git-commit');
            const tsgitTwin = await twin('tsgit-commit');
            for (const repo of [gitTwin, tsgitTwin]) {
              await writeFile(path.join(repo, 'k'), 'k2\n');
              gitIn(repo, 'add', 'k');
              await moved(repo);
            }
            gitIn(gitTwin, 'commit', '-q', '-m', 'x');
            const stampBefore = gitIn(tsgitTwin, 'ls-files', '--debug', SUBMODULE);
            const sut = commit;

            // Act
            await sut(createNodeContext({ workDir: tsgitTwin }), {
              message: 'x',
              author: identity,
              committer: identity,
            });

            // Assert
            const treeEntry = (repo: string): string => gitIn(repo, 'ls-tree', 'HEAD', SUBMODULE);
            expect(treeEntry(tsgitTwin)).toBe(treeEntry(gitTwin));
            expect(gitIn(tsgitTwin, 'ls-files', '--debug', SUBMODULE)).toBe(stampBefore);
          },
          ROW_TIMEOUT,
        );
      });
    });

    const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
      } catch (err) {
        return (err as { data: unknown }).data;
      }
      return undefined;
    };

    describe.each(REFUSALS)('Given $title', ({ title, setup, gitMessage, data }) => {
      describe('When status runs in both tools', () => {
        it(
          'Then both refuse and tsgit names the path as git does',
          async () => {
            // Arrange
            const gitTwin = await twin(`git-refusal-${title}`);
            const tsgitTwin = await twin(`tsgit-refusal-${title}`);
            await setup(gitTwin);
            await setup(tsgitTwin);
            const gitRun = tryRunGitWithExit(['-C', gitTwin, 'status'], { env: pinnedEnv() });
            const sut = status;

            // Act
            const result = await refusalOf(() => sut(createNodeContext({ workDir: tsgitTwin })));

            // Assert
            expect(gitRun.exitCode).toBe(REFUSED_EXIT);
            expect(gitRun.stderr).toContain(gitMessage);
            expect(result).toEqual(data);
          },
          NON_BLOCKING_TIMEOUT_MS,
        );
      });
    });

    describe.each(CONFIG_REFUSALS)('Given $title', ({ title, setup, gitMessage, code }) => {
      describe('When status runs in both tools', () => {
        it(
          'Then both refuse over the invalid ignore value',
          async () => {
            // Arrange
            const gitTwin = await twin(`git-config-${title}`);
            const tsgitTwin = await twin(`tsgit-config-${title}`);
            await setup(gitTwin);
            await setup(tsgitTwin);
            const gitRun = tryRunGitWithExit(['-C', gitTwin, 'status'], { env: pinnedEnv() });
            const sut = status;

            // Act
            const result = (await refusalOf(() =>
              sut(createNodeContext({ workDir: tsgitTwin })),
            )) as { code: string; value: string };

            // Assert
            expect(gitRun.exitCode).toBe(REFUSED_EXIT);
            expect(gitRun.stderr).toContain(gitMessage);
            expect(result.code).toBe(code);
            expect(result.value).toBe('bogus');
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a committed .gitmodules dirty and a submodule file rewritten with the same bytes', () => {
      describe('When git status and tsgit status run', () => {
        it(
          'Then the submodule index is left untouched in both tools',
          async () => {
            // Arrange
            const gitTwin = await twin('git-dirty-touch');
            const tsgitTwin = await twin('tsgit-dirty-touch');
            for (const repo of [gitTwin, tsgitTwin]) {
              await committedGitmodules('dirty')(repo);
              await settle(repo);
              await writeFile(sub(repo, 'u'), 'u\n');
            }
            const gitBefore = await readFile(path.join(moduleDir(gitTwin), 'index'));
            const tsgitBefore = await readFile(path.join(moduleDir(tsgitTwin), 'index'));
            const sut = status;

            // Act
            gitIn(gitTwin, 'status', '--porcelain=v2');
            const result = await sut(createNodeContext({ workDir: tsgitTwin }));

            // Assert
            const gitAfter = await readFile(path.join(moduleDir(gitTwin), 'index'));
            const tsgitAfter = await readFile(path.join(moduleDir(tsgitTwin), 'index'));
            expect(gitAfter.equals(gitBefore)).toBe(true);
            expect(tsgitAfter.equals(tsgitBefore)).toBe(true);
            expect(result.changes.filter((change) => change.path === SUBMODULE)).toEqual([]);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each([
      ['git status', ['status', '--porcelain=v2'], true],
      [
        'git --no-optional-locks status',
        ['--no-optional-locks', 'status', '--porcelain=v2'],
        false,
      ],
    ] as const)(
      'Given a submodule file rewritten with the same bytes',
      (_title, gitArgs, rewrites) => {
        describe(`When ${_title} and tsgit status run`, () => {
          it(
            'Then the submodule index is rewritten only when the tool may refresh it',
            async () => {
              // Arrange
              const gitTwin = await twin(`git-touch-${rewrites}`);
              const tsgitTwin = await twin(`tsgit-touch-${rewrites}`);
              for (const repo of [gitTwin, tsgitTwin]) {
                await settle(repo);
                await writeFile(sub(repo, 'u'), 'u\n');
              }
              const gitBefore = await readFile(path.join(moduleDir(gitTwin), 'index'));
              const tsgitBefore = await readFile(path.join(moduleDir(tsgitTwin), 'index'));
              const sut = status;

              // Act
              gitIn(gitTwin, ...gitArgs);
              const result = await sut(createNodeContext({ workDir: tsgitTwin }), {
                refresh: rewrites,
              });

              // Assert
              const gitAfter = await readFile(path.join(moduleDir(gitTwin), 'index'));
              const tsgitAfter = await readFile(path.join(moduleDir(tsgitTwin), 'index'));
              expect(gitAfter.equals(gitBefore)).toBe(!rewrites);
              expect(tsgitAfter.equals(tsgitBefore)).toBe(!rewrites);
              expect(result.changes).toEqual([]);
            },
            ROW_TIMEOUT,
          );
        });
      },
    );

    describe('Given a submodule whose index is truncated', () => {
      describe('When status runs in both tools', () => {
        it(
          'Then both refuse and tsgit rejects with the submodule index error',
          async () => {
            // Arrange
            const gitTwin = await twin('git-junk-index');
            const tsgitTwin = await twin('tsgit-junk-index');
            for (const repo of [gitTwin, tsgitTwin]) {
              await writeFile(path.join(moduleDir(repo), 'index'), 'junk\n');
            }
            const gitRun = tryRunGitWithExit(['-C', gitTwin, 'status', '--porcelain=2'], {
              env: pinnedEnv(),
            });
            const sut = status;

            // Act
            const result = await refusalOf(() => sut(createNodeContext({ workDir: tsgitTwin })));

            // Assert
            expect(gitRun.exitCode).toBe(REFUSED_EXIT);
            expect(gitRun.stderr).toContain('index file smaller than expected');
            expect(gitRun.stderr).toContain("'git status --porcelain=2' failed in submodule sub");
            expect(result).toEqual({
              code: 'INVALID_INDEX_HEADER',
              reason: 'file is shorter than the hash trailer',
            });
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(FORMAT_REFUSALS)(
      'Given a submodule whose config declares $title',
      ({ title, config, gitMessage, data }) => {
        describe('When status runs in both tools', () => {
          it(
            'Then both refuse over the repository format',
            async () => {
              // Arrange
              const gitTwin = await twin(`git-format-${title}`);
              const tsgitTwin = await twin(`tsgit-format-${title}`);
              for (const repo of [gitTwin, tsgitTwin]) {
                for (const [key, value] of config) {
                  gitIn(repo, 'config', '--file', path.join(moduleDir(repo), 'config'), key, value);
                }
              }
              const gitRun = tryRunGitWithExit(['-C', gitTwin, 'status', '--porcelain=2'], {
                env: pinnedEnv(),
              });
              const sut = status;

              // Act
              const result = await refusalOf(() => sut(createNodeContext({ workDir: tsgitTwin })));

              // Assert
              expect(gitRun.exitCode).toBe(REFUSED_EXIT);
              expect(gitRun.stderr).toContain(`fatal: ${gitMessage}`);
              expect(result).toEqual(data);
            },
            ROW_TIMEOUT,
          );
        });
      },
    );

    describe('Given a submodule whose .git is a FIFO', () => {
      describe('When status runs in both tools', () => {
        it(
          'Then neither refuses and neither reports a row',
          async () => {
            // Arrange
            const gitTwin = await twin('git-fifo-dotgit');
            const tsgitTwin = await twin('tsgit-fifo-dotgit');
            for (const repo of [gitTwin, tsgitTwin]) {
              await rm(sub(repo, '.git'));
              makeFifo(sub(repo, '.git'));
            }
            const gitRun = tryRunGitWithExit(['-C', gitTwin, 'status', '--porcelain=v2'], {
              env: pinnedEnv(),
            });
            const sut = status;

            // Act
            const result = await sut(createNodeContext({ workDir: tsgitTwin }));

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(gitChanges(gitRun.stdout.split('\n').filter(Boolean))).toEqual([]);
            expect(result.changes.filter((change) => change.path === SUBMODULE)).toEqual([]);
          },
          NON_BLOCKING_TIMEOUT_MS,
        );
      });
    });

    describe('Given a submodule whose HEAD is a FIFO held open', () => {
      describe('When status runs', () => {
        it(
          'Then it is classified as no repository and refuses with the module path',
          async () => {
            // Arrange
            const tsgitTwin = await twin('tsgit-fifo-outcome');
            const head = path.join(moduleDir(tsgitTwin), 'HEAD');
            await rm(head);
            makeFifo(head);
            const release = await open(head, constants.O_RDWR);
            const sut = status;

            // Act
            const outcome = await sut(createNodeContext({ workDir: tsgitTwin }))
              .then(
                (result) => result.changes.filter((change) => change.path === SUBMODULE),
                (err: { data: unknown }) => err.data,
              )
              .finally(() => release.close());

            // Assert
            expect(outcome).toEqual({
              code: 'NOT_A_REPOSITORY',
              path: 'sub/../.git/modules/sub',
            });
          },
          NON_BLOCKING_TIMEOUT_MS,
        );
      });
    });

    describe('Given a submodule whose HEAD is a FIFO', () => {
      describe('When status runs', () => {
        it(
          'Then it settles within the non-blocking timeout',
          async () => {
            // Arrange
            const tsgitTwin = await twin('tsgit-fifo');
            const head = path.join(moduleDir(tsgitTwin), 'HEAD');
            await rm(head);
            makeFifo(head);
            const release = await open(head, constants.O_RDWR);
            const sut = status;
            const settled = sut(createNodeContext({ workDir: tsgitTwin })).then(
              () => 'settled',
              () => 'settled',
            );
            const timedOut = wait(NON_BLOCKING_TIMEOUT_MS - 5_000).then(() => 'timed-out');

            // Act
            const outcome = await Promise.race([settled, timedOut]).finally(() => release.close());

            // Assert
            expect(outcome).toBe('settled');
          },
          NON_BLOCKING_TIMEOUT_MS,
        );
      });
    });
  },
);

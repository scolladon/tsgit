/**
 * Cross-tool interop — `add` stages an untracked repository a pathspec reaches as a
 * gitlink, and refuses one with no commit checked out, as git does.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add stages an untracked repository as a gitlink and refuses one with no commit as git does
 *   interopSurface: add
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm as removeTree,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { rm } from '../../src/application/commands/rm.js';
import { TsgitError } from '../../src/domain/index.js';
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

const PINNED_DATE = '@1700000000 +0000';
const REFUSED_EXIT = 128;
const NOT_A_COMMIT = 'e'.repeat(40);

type Setup = (repo: string) => Promise<void>;

const pinnedEnv = () => ({
  ...runGitEnv(),
  GIT_AUTHOR_DATE: PINNED_DATE,
  GIT_COMMITTER_DATE: PINNED_DATE,
});

const commitIn = (repo: string): void => {
  runGit(
    [
      '-C',
      repo,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'c',
    ],
    { env: pinnedEnv() },
  );
};

const writeFiles = async (repo: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const UNTRACKED = { u: 'u\n' };

/** A repository at `name` with one commit and an untracked file. */
const committed =
  (name = 'sub', files: Readonly<Record<string, string>> = UNTRACKED): Setup =>
  async (repo) => {
    runGit(['init', '-q', '-b', 'main', path.join(repo, name)]);
    commitIn(path.join(repo, name));
    await writeFiles(path.join(repo, name), files);
  };

/** A repository at `name` that has never been committed to. */
const unborn =
  (name = 'sub', files: Readonly<Record<string, string>> = UNTRACKED): Setup =>
  async (repo) => {
    runGit(['init', '-q', '-b', 'main', path.join(repo, name)]);
    await writeFiles(path.join(repo, name), files);
  };

const together =
  (...setups: ReadonlyArray<Setup>): Setup =>
  async (repo) => {
    for (const setup of setups) await setup(repo);
  };

const ignoring =
  (rules: string): Setup =>
  (repo) =>
    writeFiles(repo, { '.gitignore': rules });

const dotGitOf = (repo: string, name = 'sub'): string => path.join(repo, name, '.git');

/** The repository's own `.git` moved out of the working tree, then reached through `reach`. */
const movedThrough =
  (reach: (repo: string, dotGit: string, moved: string) => Promise<void>, base: Setup): Setup =>
  async (repo) => {
    await base(repo);
    const moved = `${repo}-gitdir`;
    await rename(dotGitOf(repo), moved);
    await reach(repo, dotGitOf(repo), moved);
  };

const gitfile = (dotGit: string, target: string) => writeFile(dotGit, `gitdir: ${target}\n`);

const absoluteGitfile = (base: Setup) =>
  movedThrough((_repo, dotGit, moved) => gitfile(dotGit, moved), base);
const relativeGitfile = (base: Setup) =>
  movedThrough((_repo, dotGit, moved) => gitfile(dotGit, `../../${path.basename(moved)}`), base);
const linkedTo = (base: Setup) =>
  movedThrough((_repo, dotGit, moved) => symlink(moved, dotGit), base);
const relativeLinkedTo = (base: Setup) =>
  movedThrough((_repo, dotGit, moved) => symlink(`../../${path.basename(moved)}`, dotGit), base);
const linkedToGitfile = (base: Setup) =>
  movedThrough(async (repo, dotGit, moved) => {
    const pointer = `${repo}-gitfile`;
    await gitfile(pointer, moved);
    await symlink(pointer, dotGit);
  }, base);

const detached: Setup = async (repo) => {
  await committed()(repo);
  runGit(['-C', path.join(repo, 'sub'), 'checkout', '-q', '--detach']);
};

const reftable: Setup = async (repo) => {
  runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', path.join(repo, 'sub')]);
  commitIn(path.join(repo, 'sub'));
  await writeFiles(path.join(repo, 'sub'), UNTRACKED);
};

const linkedWorktree: Setup = async (repo) => {
  const ext = `${repo}-ext`;
  runGit(['init', '-q', '-b', 'main', ext]);
  commitIn(ext);
  runGit(['-C', ext, 'worktree', 'add', '-q', '-b', 'wt', path.join(repo, 'sub')]);
};

const missingObjectBranch: Setup = async (repo) => {
  await committed()(repo);
  await writeFile(path.join(dotGitOf(repo), 'refs', 'heads', 'main'), `${NOT_A_COMMIT}\n`);
};

const garbageBranch: Setup = async (repo) => {
  await committed()(repo);
  await writeFile(path.join(dotGitOf(repo), 'refs', 'heads', 'main'), 'garbage\n');
};

const configuredWith =
  (key: string, value: string, base: Setup): Setup =>
  async (repo) => {
    await base(repo);
    runGit(['config', '--file', path.join(dotGitOf(repo), 'config'), key, value]);
  };

const formatV2 = configuredWith('core.repositoryformatversion', '2', committed());
const unknownExtension: Setup = async (repo) => {
  await committed()(repo);
  const config = path.join(dotGitOf(repo), 'config');
  runGit(['config', '--file', config, 'core.repositoryformatversion', '1']);
  runGit(['config', '--file', config, 'extensions.bogus', 'true']);
};

/** `sub` holding `u` and a `.git` that is not a repository, built by `make`. */
const brokenDotGit =
  (make: (repo: string, dotGit: string) => Promise<void>): Setup =>
  async (repo) => {
    await writeFiles(repo, { 'sub/u': 'u\n' });
    await make(repo, dotGitOf(repo));
  };

const withEmptyGitDir = brokenDotGit((_repo, dotGit) => mkdir(dotGit));
const withGarbageHead = brokenDotGit(async (_repo, dotGit) => {
  await writeFiles(dotGit, { HEAD: 'garbage\n' });
  await mkdir(path.join(dotGit, 'objects'));
  await mkdir(path.join(dotGit, 'refs'));
});
const withoutObjects = brokenDotGit(async (_repo, dotGit) => {
  await writeFiles(dotGit, { HEAD: 'ref: refs/heads/main\n' });
  await mkdir(path.join(dotGit, 'refs'));
});
const withDanglingLink = brokenDotGit((repo, dotGit) => symlink(`${repo}-nowhere`, dotGit));
const withLinkToFile = brokenDotGit(async (repo, dotGit) => {
  await writeFile(`${repo}-file`, 'f\n');
  await symlink(`${repo}-file`, dotGit);
});
const withGarbageGitfile = brokenDotGit((_repo, dotGit) => writeFile(dotGit, 'garbage\n'));
const withFifo = brokenDotGit(async (_repo, dotGit) => makeFifo(dotGit));
const withLinkToDevice = brokenDotGit((_repo, dotGit) => symlink('/dev/zero', dotGit));
const withOversizedGitfile = brokenDotGit(async (_repo, dotGit) =>
  makeSparseFile(dotGit, OVERSIZED_GITFILE_BYTES),
);
const withEmptyGitfile = brokenDotGit((_repo, dotGit) => writeFile(dotGit, ''));
const withGitfileToNothing = brokenDotGit((_repo, dotGit) => gitfile(dotGit, '../nothing'));
const withAdminFilesAtTheTop: Setup = async (repo) => {
  await writeFiles(repo, { 'sub/u': 'u\n', 'sub/HEAD': 'ref: refs/heads/main\n' });
  await mkdir(path.join(repo, 'sub', 'objects'));
  await mkdir(path.join(repo, 'sub', 'refs'));
};

/** A tracked gitlink `tail` whose gitfile names a module that does not exist. */
const trackedGitlinkToNowhere: Setup = async (repo) => {
  runGit(['-C', repo, 'update-index', '--add', '--cacheinfo', `160000,${NOT_A_COMMIT},tail`]);
  await writeFiles(repo, { 'tail/.git': 'gitdir: ../.git/modules/nowhere\n' });
};

/** A tracked path `sub` that a repository then replaces. */
const replacingTracked =
  (track: (repo: string) => Promise<void>, base: Setup): Setup =>
  async (repo) => {
    await track(repo);
    runGit(['-C', repo, 'add', 'sub']);
    await removeTree(path.join(repo, 'sub'), { force: true });
    await base(repo);
  };

const trackedFile = (repo: string) => writeFiles(repo, { sub: 'file\n' });
const trackedSymlink = async (repo: string) => {
  await writeFiles(repo, { k: 'k\n' });
  await symlink('k', path.join(repo, 'sub'));
};

/** `sub/u` tracked, then a repository made inside `sub`. */
const trackedBeneath =
  (after: (repo: string) => Promise<void> = async () => undefined): Setup =>
  async (repo) => {
    await writeFiles(repo, { 'sub/u': 'u\n' });
    runGit(['-C', repo, 'add', 'sub/u']);
    runGit(['init', '-q', '-b', 'main', path.join(repo, 'sub')]);
    commitIn(path.join(repo, 'sub'));
    await after(repo);
  };

const repositoryInside: Setup = async (repo) => {
  await committed()(repo);
  await committed('sub/inner', { v: 'v\n' })(repo);
};

interface Row {
  readonly label: string;
  readonly setup: Setup;
  readonly spec: ReadonlyArray<string>;
  /** git's spelling of an exclusion when it differs from tsgit's. */
  readonly gitSpec?: ReadonlyArray<string>;
  readonly force?: boolean;
  /** `add -A`: tsgit gets no pathspec, git gets none either. */
  readonly all?: boolean;
  /** The refusal tsgit must raise when git exits non-zero. */
  readonly refusal?: Readonly<Record<string, unknown>>;
  /** git exits 1 with a hint when a pathspec names an ignored path, yet stages what it can. */
  readonly ignoredHint?: boolean;
  /** A guard so a regression that blocks on a pipe fails instead of hanging. */
  readonly timeoutMs?: number;
}

const SUB_ROWS: ReadonlyArray<Row> = [
  ...[['.'], ['sub'], ['sub/'], ['s*'], ['su?/']].map((spec) => ({
    label: `a repository with a commit, added by ${spec[0]}`,
    setup: committed(),
    spec,
  })),
  ...[['*b'], ['su?']].map((spec) => ({
    label: `a repository with a commit, added by ${spec[0]}`,
    setup: committed(),
    spec,
    refusal: { code: 'PATHSPEC_NO_MATCH', pattern: spec[0] },
  })),
  { label: 'a repository with no files', setup: committed('sub', {}), spec: ['.'] },
  { label: 'a gitfile naming an absolute path', setup: absoluteGitfile(committed()), spec: ['.'] },
  { label: 'a gitfile naming a relative path', setup: relativeGitfile(committed()), spec: ['.'] },
  { label: 'a detached HEAD', setup: detached, spec: ['.'] },
  { label: 'a reftable repository', setup: reftable, spec: ['.'] },
  { label: 'a linked worktree', setup: linkedWorktree, spec: ['.'] },
  { label: 'a branch naming a missing object', setup: missingObjectBranch, spec: ['.'] },
  {
    label: 'two repositories',
    setup: together(committed('sub'), committed('sub2')),
    spec: ['.'],
  },
  ...[['.'], ['d'], ['d/sub'], ['*sub*'], ['*sub/'], ['s*'], ['sub'], ['*sub']].map((spec) => ({
    label: `a repository beside a file in a directory, added by ${spec[0]}`,
    setup: together(committed('d/sub'), (repo: string) => writeFiles(repo, { 'd/f': 'f\n' })),
    spec,
    ...(['s*', 'sub', '*sub'].includes(spec[0] as string)
      ? { refusal: { code: 'PATHSPEC_NO_MATCH', pattern: spec[0] } }
      : {}),
  })),
  { label: '.git a symlink to a repository', setup: linkedTo(committed()), spec: ['.'] },
  {
    label: '.git a relative symlink to a repository',
    setup: relativeLinkedTo(committed()),
    spec: ['.'],
  },
  { label: '.git a symlink to a gitfile', setup: linkedToGitfile(committed()), spec: ['.'] },
  {
    label: '.git a symlink to a repository with no commit',
    setup: linkedTo(unborn()),
    spec: ['.'],
    refusal: { code: 'NO_COMMIT_CHECKED_OUT', path: 'sub/' },
  },
  ...[
    ['a .git FIFO', withFifo],
    ['a .git symlink to a character device', withLinkToDevice],
    ['a .git file past 1 MiB', withOversizedGitfile],
  ].map(([label, setup]) => ({
    label: `${label as string}, which git takes for a plain directory`,
    setup: setup as Setup,
    spec: ['.'],
    timeoutMs: NON_BLOCKING_TIMEOUT_MS,
  })),
  ...[
    ['a dangling .git link', withDanglingLink],
    ['a .git link to a file', withLinkToFile],
    ['an empty .git directory', withEmptyGitDir],
    ['a garbage HEAD', withGarbageHead],
    ['no objects directory', withoutObjects],
    ['a garbage gitfile', withGarbageGitfile],
    ['an empty gitfile', withEmptyGitfile],
    ['a gitfile to nothing', withGitfileToNothing],
    ['admin files at the top', withAdminFilesAtTheTop],
  ].map(([label, setup]) => ({
    label: `${label as string}, which is no repository`,
    setup: setup as Setup,
    spec: ['.'],
  })),
];

const NO_COMMIT = { code: 'NO_COMMIT_CHECKED_OUT', path: 'sub/' };

const NO_COMMIT_SETUPS: ReadonlyArray<readonly [string, Setup]> = [
  ['a repository with no commit', unborn()],
  ['a repository with nothing in it', unborn('sub', {})],
  ['a repository at format version 2', formatV2],
  ['a repository with an unknown extension', unknownExtension],
  ['a branch holding garbage', garbageBranch],
];

const NO_COMMIT_ROWS: ReadonlyArray<Row> = [
  ...NO_COMMIT_SETUPS.flatMap(([label, setup]) =>
    [['.'], ['sub'], ['sub/'], ['s*']].map((spec) => ({
      label: `${label}, added by ${spec[0]}`,
      setup,
      spec,
      refusal: NO_COMMIT,
    })),
  ),
  ...[['.'], ['a', 'sub', 'z']].map((spec) => ({
    label: `a repository with no commit beside untracked files, added by ${spec.join(' ')}`,
    setup: together(unborn(), (repo: string) => writeFiles(repo, { a: 'a\n', z: 'z\n' })),
    spec,
    refusal: NO_COMMIT,
  })),
  {
    label: 'a repository with no commit beside untracked files, added without it',
    setup: together(unborn(), (repo) => writeFiles(repo, { a: 'a\n', z: 'z\n' })),
    spec: ['a', 'z'],
  },
  {
    label: 'a repository with no commit beside untracked files, added with an unmatched pathspec',
    setup: together(unborn(), (repo) => writeFiles(repo, { a: 'a\n', z: 'z\n' })),
    spec: ['.', 'nomatch*'],
    refusal: { code: 'PATHSPEC_NO_MATCH', pattern: 'nomatch*' },
  },
  {
    label: 'a repository with no commit beside untracked files, excluded',
    setup: together(unborn(), (repo) => writeFiles(repo, { a: 'a\n', z: 'z\n' })),
    spec: ['.', '!sub'],
    gitSpec: ['.', ':!sub'],
  },
  ...[['.'], ['b', 'a']].map((spec) => ({
    label: `two repositories with no commit, added by ${spec.join(' ')}`,
    setup: together(unborn('b'), unborn('a')),
    spec,
    refusal: { code: 'NO_COMMIT_CHECKED_OUT', path: 'a/' },
  })),
  {
    label: 'a tracked gitlink with a broken checkout beside a repository with no commit',
    setup: together(unborn('a'), trackedGitlinkToNowhere),
    spec: ['.'],
    refusal: { code: 'NOT_A_REPOSITORY', path: 'tail/../.git/modules/nowhere' },
  },
  ...[['.'], ['sub']].map((spec) => ({
    label: `a tracked file replaced by a repository with no commit, added by ${spec[0]}`,
    setup: replacingTracked(trackedFile, unborn()),
    spec,
    refusal: NO_COMMIT,
  })),
  ...[
    ['a', 'a/'],
    ['z', 'sub/'],
  ].map(([name, shown]) => ({
    label: `a tracked file replaced by a repository with no commit beside the one at ${name}`,
    setup: replacingTracked(trackedFile, together(unborn(), unborn(name as string))),
    spec: ['.'],
    refusal: { code: 'NO_COMMIT_CHECKED_OUT', path: shown },
  })),
];

const IGNORED_ROWS: ReadonlyArray<Row> = [
  {
    label: 'an ignored repository, added by dot',
    setup: together(committed(), ignoring('sub/\n')),
    spec: ['.'],
  },
  {
    label: 'an ignored repository, added by name',
    setup: together(committed(), ignoring('sub\n')),
    spec: ['sub'],
    ignoredHint: true,
  },
  {
    label: 'a repository beneath an ignored directory, added by dot',
    setup: together(committed('d/sub'), ignoring('d/\n')),
    spec: ['.'],
  },
  {
    label: 'an ignored repository, added by dot with force',
    setup: together(committed(), ignoring('sub/\n')),
    spec: ['.'],
    force: true,
  },
  {
    label: 'an ignored repository, added by name with force',
    setup: together(committed(), ignoring('sub/\n')),
    spec: ['sub'],
    force: true,
  },
  {
    label: 'a repository beneath an ignored directory, added by name with force',
    setup: together(committed('d/sub'), ignoring('d/\n')),
    spec: ['d'],
    force: true,
  },
  {
    label: 'an ignored repository with no commit, added by dot',
    setup: together(unborn(), ignoring('sub/\n')),
    spec: ['.'],
  },
  {
    label: 'an ignored repository with no commit, added by name',
    setup: together(unborn(), ignoring('sub/\n')),
    spec: ['sub'],
    ignoredHint: true,
  },
  {
    label: 'an ignored repository with no commit, added by dot with force',
    setup: together(unborn(), ignoring('sub/\n')),
    spec: ['.'],
    force: true,
    refusal: NO_COMMIT,
  },
];

const EXCLUDED_ROWS: ReadonlyArray<Row> = [
  {
    label: 'the repository excluded by dot',
    setup: committed(),
    spec: ['.', '!sub'],
    gitSpec: ['.', ':!sub'],
  },
  {
    label: 'the repository excluded from itself',
    setup: committed(),
    spec: ['sub', '!sub'],
    gitSpec: ['sub', ':!sub'],
  },
  {
    label: 'the repository excluded after a wildcard',
    setup: committed(),
    spec: ['s*', '!sub'],
    gitSpec: ['s*', ':!sub'],
    refusal: { code: 'PATHSPEC_NO_MATCH', pattern: 's*' },
  },
];

const NESTED_ROWS: ReadonlyArray<Row> = [
  { label: 'a repository inside a repository, added by dot', setup: repositoryInside, spec: ['.'] },
  {
    label: 'a repository inside a repository, added by its path',
    setup: repositoryInside,
    spec: ['sub/inner'],
  },
];

const REPLACED_ROWS: ReadonlyArray<Row> = [
  ...[
    ['file', trackedFile],
    ['symlink', trackedSymlink],
  ].flatMap(([kind, track]) =>
    [['.'], ['sub'], ['sub/'], ['s*']].map((spec) => ({
      label: `a tracked ${kind as string} replaced by a repository, added by ${spec[0]}`,
      setup: replacingTracked(track as (repo: string) => Promise<void>, committed()),
      spec,
    })),
  ),
];

const BENEATH_ROWS: ReadonlyArray<Row> = [
  ...[['.'], ['sub']].flatMap((spec) => [
    {
      label: `tracked files beneath a repository, added by ${spec[0]}`,
      setup: trackedBeneath(),
      spec,
    },
    {
      label: `a rewritten tracked file beneath a repository, added by ${spec[0]}`,
      setup: trackedBeneath((repo) => writeFiles(repo, { 'sub/u': 'rewritten\n' })),
      spec,
    },
    {
      label: `an untracked file beside tracked ones beneath a repository, added by ${spec[0]}`,
      setup: trackedBeneath((repo) => writeFiles(repo, { 'sub/new': 'n\n' })),
      spec,
    },
  ]),
];

const everythingRow = (label: string, setup: Setup, extra: Partial<Row> = {}): Row => ({
  label: `${label}, added by -A`,
  setup,
  spec: [],
  all: true,
  ...extra,
});

const ALL_TREE_ROWS: ReadonlyArray<Row> = [
  everythingRow('a repository with a commit', committed()),
  everythingRow('a repository with no files', committed('sub', {})),
  everythingRow('a gitfile naming an absolute path', absoluteGitfile(committed())),
  everythingRow('a .git symlink to a repository', linkedTo(committed())),
  everythingRow('a detached HEAD', detached),
  everythingRow('a linked worktree', linkedWorktree),
  everythingRow('two repositories', together(committed('sub'), committed('sub2'))),
  everythingRow(
    'a repository beside a file in a directory',
    together(committed('d/sub'), (repo) => writeFiles(repo, { 'd/f': 'f\n' })),
  ),
  everythingRow('a repository inside a repository', repositoryInside),
  everythingRow('a repository with no commit', unborn(), { refusal: NO_COMMIT }),
  everythingRow(
    'a repository with no commit beside untracked files',
    together(unborn(), (repo) => writeFiles(repo, { a: 'a\n', z: 'z\n' })),
    { refusal: NO_COMMIT },
  ),
  everythingRow('two repositories with no commit', together(unborn('b'), unborn('a')), {
    refusal: { code: 'NO_COMMIT_CHECKED_OUT', path: 'a/' },
  }),
  everythingRow('an ignored repository', together(committed(), ignoring('sub/\n'))),
  everythingRow('an ignored repository', together(committed(), ignoring('sub/\n')), {
    force: true,
    label: 'an ignored repository, added by -A with force',
  }),
  everythingRow(
    'a repository beneath an ignored directory',
    together(committed('d/sub'), ignoring('d/\n')),
  ),
  everythingRow('an ignored repository with no commit', together(unborn(), ignoring('sub/\n'))),
  everythingRow('an ignored repository with no commit', together(unborn(), ignoring('sub/\n')), {
    force: true,
    label: 'an ignored repository with no commit, added by -A with force',
    refusal: NO_COMMIT,
  }),
  everythingRow(
    'a tracked file replaced by a repository',
    replacingTracked(trackedFile, committed()),
  ),
  everythingRow(
    'a tracked symlink replaced by a repository',
    replacingTracked(trackedSymlink, committed()),
  ),
  everythingRow(
    'a tracked file replaced by a repository with no commit',
    replacingTracked(trackedFile, unborn()),
    { refusal: NO_COMMIT },
  ),
  everythingRow('tracked files beneath a repository', trackedBeneath()),
  everythingRow(
    'a rewritten tracked file beneath a repository',
    trackedBeneath((repo) => writeFiles(repo, { 'sub/u': 'rewritten\n' })),
  ),
  everythingRow(
    'an untracked file beside tracked ones beneath a repository',
    trackedBeneath((repo) => writeFiles(repo, { 'sub/new': 'n\n' })),
  ),
];

const INDEX_PASS_ROWS: ReadonlyArray<Row> = [
  ...[
    ['file', trackedFile],
    ['symlink', trackedSymlink],
  ].map(([kind, track]) => ({
    label: `a tracked ${kind as string} replaced by a repository, added by a wildcard only the index pass reaches`,
    setup: replacingTracked(track as (repo: string) => Promise<void>, committed()),
    spec: ['*b'],
  })),
  {
    label: 'a tracked file replaced by a repository with no commit, added by a wildcard',
    setup: replacingTracked(trackedFile, unborn()),
    spec: ['*b'],
  },
  ...[['.'], ['sub']].map((spec) => ({
    label: `a tracked file replaced by a repository with no commit under an ignore rule, added by ${spec[0]}`,
    setup: replacingTracked(trackedFile, together(unborn(), ignoring('sub\n'))),
    spec,
  })),
  ...[['.'], ['sub']].map((spec) => ({
    label: `a tracked file replaced by a repository under an ignore rule, added by ${spec[0]}`,
    setup: replacingTracked(trackedFile, together(committed(), ignoring('sub\n'))),
    spec,
  })),
  ...[['.'], ['sub']].map((spec) => ({
    label: `a tracked file replaced by a directory with an empty .git, added by ${spec[0]}`,
    setup: replacingTracked(trackedFile, withEmptyGitDir),
    spec,
  })),
];

const LITERAL_ROWS: ReadonlyArray<Row> = [
  { label: 'a file inside a repository', setup: committed(), spec: ['sub/u'] },
  { label: 'a file inside a repository with no commit', setup: unborn(), spec: ['sub/u'] },
  {
    label: 'a file inside a repository inside a repository',
    setup: repositoryInside,
    spec: ['sub/inner/v'],
  },
  {
    label: 'a file inside a directory whose .git has a garbage HEAD',
    setup: withGarbageHead,
    spec: ['sub/u'],
  },
  {
    label: 'a rewritten tracked file beneath a repository',
    setup: trackedBeneath((repo) => writeFiles(repo, { 'sub/u': 'rewritten\n' })),
    spec: ['sub/u'],
  },
  {
    label: 'an untracked file beside tracked ones beneath a repository',
    setup: trackedBeneath((repo) => writeFiles(repo, { 'sub/new': 'n\n' })),
    spec: ['sub/new'],
  },
];

const ALL_ROWS: ReadonlyArray<Row> = [
  ...SUB_ROWS,
  ...NO_COMMIT_ROWS,
  ...IGNORED_ROWS,
  ...EXCLUDED_ROWS,
  ...NESTED_ROWS,
  ...REPLACED_ROWS,
  ...BENEATH_ROWS,
  ...ALL_TREE_ROWS,
  ...INDEX_PASS_ROWS,
  ...LITERAL_ROWS,
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add stages an untracked repository as a gitlink and refuses one with no commit',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-embedded-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twins = async (setup: Setup) => {
      counter += 1;
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      for (const repo of [gitRepo, tsgitRepo]) {
        runGit(['init', '-q', '-b', 'main', repo]);
        await setup(repo);
      }
      return { gitRepo, tsgitRepo };
    };

    const indexOf = (repo: string): string => runGit(['-C', repo, 'ls-files', '-s']);

    const looseCountOf = async (repo: string): Promise<number> => {
      const objects = path.join(repo, '.git', 'objects');
      const prefixes = (await readdir(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name));
      const counts = await Promise.all(
        prefixes.map(async (prefix) => (await readdir(path.join(objects, prefix))).length),
      );
      return counts.reduce((sum, count) => sum + count, 0);
    };

    const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
      } catch (err) {
        if (err instanceof TsgitError) return err.data;
        throw err;
      }
      return undefined;
    };

    describe.each(ALL_ROWS)('Given $label', (row) => {
      describe('When git and tsgit add it', () => {
        it(
          'Then both leave the same index and agree on the refusal',
          async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await twins(row.setup);
            const sut = add;
            const gitArgs = [
              'add',
              ...(row.force === true ? ['-f'] : []),
              ...(row.all === true ? ['-A'] : []),
            ];

            // Act
            const gitRun = tryRunGitWithExit([
              '-C',
              gitRepo,
              ...gitArgs,
              '--',
              ...(row.gitSpec ?? row.spec),
            ]);
            const refusal = await refusalOf(() =>
              sut(createNodeContext({ workDir: tsgitRepo }), row.spec, {
                force: row.force === true,
                all: row.all === true,
              }),
            );

            // Assert
            const refused = gitRun.exitCode === REFUSED_EXIT;
            expect(gitRun.exitCode).toBe(refused ? REFUSED_EXIT : row.ignoredHint === true ? 1 : 0);
            expect(refusal !== undefined).toBe(refused);
            if (row.refusal !== undefined) expect(refusal).toMatchObject(row.refusal);
            expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
            if (!refused) expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
          },
          row.timeoutMs,
        );
      });
    });

    describe('Given a repository with no commit beside untracked files', () => {
      describe('When tsgit refuses the whole tree', () => {
        it('Then no object of the untracked files was written', async () => {
          // Arrange
          const setup = together(unborn(), (repo) => writeFiles(repo, { a: 'a\n', z: 'z\n' }));
          const { tsgitRepo } = await twins(setup);
          const before = await looseCountOf(tsgitRepo);
          const sut = add;

          // Act
          await refusalOf(() => sut(createNodeContext({ workDir: tsgitRepo }), ['.']));

          // Assert
          expect(await looseCountOf(tsgitRepo)).toBe(before);
          expect(indexOf(tsgitRepo)).toBe('');
        });
      });
    });

    describe('Given a staged repository', () => {
      describe('When tsgit reports what it staged', () => {
        it('Then the gitlink is added, and a type change is modified', async () => {
          // Arrange
          const fresh = await twins(committed());
          const replaced = await twins(replacingTracked(trackedFile, committed()));
          const sut = add;

          // Act
          const added = await sut(createNodeContext({ workDir: fresh.tsgitRepo }), ['.']);
          const modified = await sut(createNodeContext({ workDir: replaced.tsgitRepo }), ['.']);

          // Assert
          expect(added.added).toEqual(['sub']);
          expect(modified.modified).toEqual(['sub']);
          expect(modified.removed).toEqual([]);
        });
      });
    });

    describe('Given an untracked repository', () => {
      describe('When rm, checkout and renormalize reach it', () => {
        it('Then they behave as git does', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(committed());
          const ctx = createNodeContext({ workDir: tsgitRepo });

          // Act
          const gitRm = tryRunGitWithExit(['-C', gitRepo, 'rm', '--cached', 'sub']);
          const rmRefusal = await refusalOf(() => rm(ctx, ['sub'], { cached: true }));
          const gitCheckout = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', 'sub']);
          const checkoutRefusal = await refusalOf(() => checkout(ctx, { paths: ['sub'] }));
          const gitRenormalize = tryRunGitWithExit(['-C', gitRepo, 'add', '--renormalize', '.']);
          await add(ctx, ['.'], { renormalize: true });

          // Assert
          expect(gitRm.exitCode).toBe(REFUSED_EXIT);
          expect(rmRefusal).toMatchObject({ code: 'PATHSPEC_NO_MATCH' });
          expect(gitCheckout.exitCode).toBe(1);
          expect(checkoutRefusal).toMatchObject({ code: 'PATHSPEC_NO_MATCH' });
          expect(gitRenormalize.exitCode).toBe(0);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe('Given a repository with no commit', () => {
      describe('When renormalize reaches it', () => {
        it('Then nothing is staged, as in git', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(unborn());
          const ctx = createNodeContext({ workDir: tsgitRepo });

          // Act
          const gitRenormalize = tryRunGitWithExit(['-C', gitRepo, 'add', '--renormalize', '.']);
          await add(ctx, ['.'], { renormalize: true });

          // Assert
          expect(gitRenormalize.exitCode).toBe(0);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe('Given a staged repository', () => {
      describe('When rm --cached and checkout reach it', () => {
        it('Then rm refuses the staged content and checkout changes nothing, as in git', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(
            together(async (repo) => commitIn(repo), committed()),
          );
          const ctx = createNodeContext({ workDir: tsgitRepo });
          runGit(['-C', gitRepo, 'add', 'sub']);
          await add(ctx, ['sub']);

          // Act
          const gitRm = tryRunGitWithExit(['-C', gitRepo, 'rm', '--cached', 'sub']);
          const rmRefusal = await refusalOf(() => rm(ctx, ['sub'], { cached: true }));
          const gitCheckout = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', 'sub']);
          await checkout(ctx, { paths: ['sub'] });

          // Assert
          expect(gitRm.exitCode).toBe(1);
          expect(rmRefusal).toMatchObject({ code: 'RM_STAGED_AND_LOCAL_CHANGES' });
          expect(gitCheckout.exitCode).toBe(0);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });
  },
);

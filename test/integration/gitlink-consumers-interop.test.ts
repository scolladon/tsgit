/**
 * Cross-tool interop — a checkout, merge, cherry-pick or rebase never treats a tracked
 * gitlink as dirty, and a rewrite removes a deleted gitlink only when its directory is empty.
 * Both tools run the same step on twin copies; the index entry, the submodule HEAD, the
 * files under the submodule and the status lines are compared.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout, merge, cherry-pick, rebase and stash leave a gitlink directory alone and remove an empty one as git does
 *   interopSurface: checkout, merge, stash, rm
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseContinue, rebaseRun } from '../../src/application/commands/rebase.js';
import { rm as removePaths } from '../../src/application/commands/rm.js';
import { stashPush } from '../../src/application/commands/stash.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const PINNED_DATE = '@1700000000 +0000';
const SUBMODULE = 'sub';
const ABSENT = 'absent';
const NOT_A_DIRECTORY = 'not-a-directory';

type Setup = (repo: string) => Promise<void>;

interface Step {
  readonly git: (repo: string) => void;
  readonly tsgit: (ctx: Context, repo: string) => Promise<unknown>;
}

const CONFLICT_EXIT_STATUS = 1;

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
      '-c',
      'core.editor=true',
      ...args,
    ],
    { env: pinnedEnv() },
  );

const commitIn = (repo: string, message: string): void => {
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', message);
};

const sub = (repo: string, ...rest: string[]): string => path.join(repo, SUBMODULE, ...rest);

/** F2: `main` records `sub` at the upstream's first commit; `other` records its second; `side` adds a file. */
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
  const first = gitIn(superproject, 'rev-parse', `main:${SUBMODULE}`).trim();
  await writeFile(path.join(upstream, 'v'), 'v\n');
  gitIn(upstream, 'add', 'v');
  commitIn(upstream, 'up2');
  gitIn(superproject, 'checkout', '-q', '-b', 'other');
  gitIn(sub(superproject), 'fetch', '-q');
  gitIn(sub(superproject), 'checkout', '-q', 'origin/main');
  gitIn(superproject, 'add', SUBMODULE);
  commitIn(superproject, 'other');
  gitIn(sub(superproject), 'checkout', '-q', first);
  gitIn(superproject, 'checkout', '-q', 'main');
  gitIn(superproject, 'checkout', '-q', '-b', 'side');
  await writeFile(path.join(superproject, 'o'), 'o\n');
  gitIn(superproject, 'add', 'o');
  commitIn(superproject, 'side');
  gitIn(superproject, 'checkout', '-q', 'main');
  return superproject;
};

/** F3: F2 plus a commit `m` on `main`, so merging `other` is a real merge and `other` cherry-picks. */
const addMainCommit = async (repo: string): Promise<void> => {
  await writeFile(path.join(repo, 'k'), 'main\n');
  gitIn(repo, 'add', 'k');
  commitIn(repo, 'm');
};

const nothing: Setup = async () => {};
const moved: Setup = async (repo) => commitIn(sub(repo), 'z');
const edited: Setup = async (repo) => writeFile(sub(repo, 'u'), 'edited\n');
const untrackedInSubmodule: Setup = async (repo) => writeFile(sub(repo, 'n'), 'n\n');
const stagedMove: Setup = async (repo) => {
  await moved(repo);
  gitIn(repo, 'add', SUBMODULE);
};
const editedK: Setup = async (repo) => writeFile(path.join(repo, 'k'), 'edited\n');
const movedAndEditedK: Setup = async (repo) => {
  await moved(repo);
  await editedK(repo);
};
const stagedMoveAndEditedK: Setup = async (repo) => {
  await stagedMove(repo);
  await editedK(repo);
};
const deinitialised: Setup = async (repo) => {
  gitIn(repo, 'submodule', 'deinit', '-q', '-f', SUBMODULE);
};

/** `side` edits `k` too, so replaying `m` onto it stops on a conflict. */
const conflictingSide: Setup = async (repo) => {
  gitIn(repo, 'checkout', '-q', 'side');
  await writeFile(path.join(repo, 'k'), 'side\n');
  gitIn(repo, 'add', 'k');
  commitIn(repo, 'side k');
  gitIn(repo, 'checkout', '-q', 'main');
};

const stashPushStep: Step = {
  git: (repo) => {
    gitIn(repo, 'stash', 'push');
  },
  tsgit: (ctx) => stashPush(ctx, {}),
};

const gitStep = (...args: string[]): ((repo: string) => void) => {
  return (repo) => {
    gitIn(repo, ...args);
  };
};

const switchTo = (rev: string): Step => ({
  git: gitStep('checkout', '-q', rev),
  tsgit: (ctx) => checkout(ctx, { rev }),
});

const detachTo = (rev: string): Step => ({
  git: gitStep('checkout', '-q', '--detach', rev),
  tsgit: (ctx) => checkout(ctx, { rev, detach: true }),
});

const fastForwardTo = (rev: string): Step => ({
  git: gitStep('merge', '-q', '--no-edit', rev),
  tsgit: (ctx) => mergeRun(ctx, { rev }),
});

const mergeCommit = (rev: string): Step => ({
  git: gitStep('merge', '-q', '--no-edit', rev),
  tsgit: (ctx) => mergeRun(ctx, { rev }),
});

const cherryPick = (rev: string): Step => ({
  git: gitStep('cherry-pick', rev),
  tsgit: (ctx) => cherryPickRun(ctx, { commits: [rev] }),
});

const rebaseOnto = (upstream: string): Step => ({
  git: gitStep('rebase', '-q', upstream),
  tsgit: (ctx) => rebaseRun(ctx, { upstream }),
});

/** git exits 1 when a rebase stops on a conflict; any other failure is a real error. */
const rebaseStoppingOnConflict = (upstream: string): Step => ({
  git: (repo) => {
    try {
      gitIn(repo, 'rebase', '-q', upstream);
    } catch (error) {
      if ((error as { status?: number }).status !== CONFLICT_EXIT_STATUS) throw error;
    }
  },
  tsgit: (ctx) => rebaseRun(ctx, { upstream }),
});

const resolveAndMoveSubmodule = (repo: string): void => {
  writeFileSync(path.join(repo, 'k'), 'resolved\n');
  gitIn(repo, 'add', 'k');
  commitIn(sub(repo), 'z');
};

const resolveThenMoveSubmodule: Step = {
  git: resolveAndMoveSubmodule,
  tsgit: async (_ctx, repo) => resolveAndMoveSubmodule(repo),
};

const continueRebase: Step = {
  git: gitStep('rebase', '--continue'),
  tsgit: (ctx) => rebaseContinue(ctx),
};

interface Row {
  readonly title: string;
  readonly setup: Setup;
  readonly steps: ReadonlyArray<Step>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    title: 'an unmoved submodule, checkout of a branch moving it',
    setup: nothing,
    steps: [switchTo('other')],
  },
  {
    title: 'a moved submodule, checkout of a branch moving it',
    setup: moved,
    steps: [switchTo('other')],
  },
  {
    title: 'an edited submodule, checkout of a branch moving it',
    setup: edited,
    steps: [switchTo('other')],
  },
  {
    title: 'a moved submodule, checkout of a branch adding a file',
    setup: moved,
    steps: [switchTo('side')],
  },
  {
    title: 'an unmoved submodule, detached checkout of a commit without it',
    setup: nothing,
    steps: [detachTo('HEAD~1')],
  },
  {
    title: 'a moved submodule, detached checkout of a commit without it',
    setup: moved,
    steps: [detachTo('HEAD~1')],
  },
  {
    title: 'an edited submodule, detached checkout of a commit without it',
    setup: edited,
    steps: [detachTo('HEAD~1')],
  },
  {
    title: 'a deinitialised submodule, detached checkout of a commit without it',
    setup: deinitialised,
    steps: [detachTo('HEAD~1')],
  },
  {
    title: 'a deinitialised submodule removed, then checkout of the branch recording it',
    setup: deinitialised,
    steps: [detachTo('HEAD~1'), switchTo('main')],
  },
  {
    title: 'a moved submodule, fast-forward merge moving it',
    setup: moved,
    steps: [fastForwardTo('other')],
  },
  {
    title: 'an edited submodule, fast-forward merge moving it',
    setup: edited,
    steps: [fastForwardTo('other')],
  },
  {
    title: 'a moved submodule, fast-forward merge adding a file',
    setup: moved,
    steps: [fastForwardTo('side')],
  },
];

const F3_ROWS: ReadonlyArray<Row> = [
  {
    title: 'an unmoved submodule, merge of a branch moving it',
    setup: nothing,
    steps: [mergeCommit('other')],
  },
  {
    title: 'a moved submodule, merge of a branch moving it',
    setup: moved,
    steps: [mergeCommit('other')],
  },
  {
    title: 'an edited submodule, merge of a branch moving it',
    setup: edited,
    steps: [mergeCommit('other')],
  },
  {
    title: 'an unmoved submodule, cherry-pick of a commit moving it',
    setup: nothing,
    steps: [cherryPick('other')],
  },
  {
    title: 'a moved submodule, cherry-pick of a commit moving it',
    setup: moved,
    steps: [cherryPick('other')],
  },
  {
    title: 'a moved submodule, cherry-pick of a commit adding a file',
    setup: moved,
    steps: [cherryPick('side')],
  },
  {
    title: 'a moved submodule, rebase onto a branch adding a file',
    setup: moved,
    steps: [rebaseOnto('side')],
  },
  {
    title: 'an edited submodule, rebase onto a branch adding a file',
    setup: edited,
    steps: [rebaseOnto('side')],
  },
  {
    title: 'a submodule moved after a conflicted rebase was resolved, rebase continued',
    setup: conflictingSide,
    steps: [rebaseStoppingOnConflict('side'), resolveThenMoveSubmodule, continueRebase],
  },
];

interface RmRow {
  readonly title: string;
  readonly setup: Setup;
  readonly paths: ReadonlyArray<string>;
  readonly cached: boolean;
  /** git's exit status, and the error code tsgit raises for it; `undefined` when the removal succeeds. */
  readonly refusal?: { readonly exit: number; readonly code: string };
}

const OVERSIZED_GITFILE_BYTES = (1 << 20) + 1;
const LOCAL_MODIFICATIONS = { exit: 1, code: 'RM_LOCAL_MODIFICATIONS' };
const DIED = (code: string) => ({ exit: 128, code });

const replacedByFile: Setup = async (repo) => {
  await rm(sub(repo), { recursive: true });
  await writeFile(sub(repo), 'plain\n');
};
const replacedBySymlink: Setup = async (repo) => {
  await rm(sub(repo), { recursive: true });
  await symlink('k', sub(repo));
};
const ignoringAll: Setup = async (repo) => {
  gitIn(repo, 'config', '-f', '.gitmodules', 'submodule.sub.ignore', 'all');
  gitIn(repo, 'add', '.gitmodules');
  commitIn(repo, 'ignore all');
  await untrackedInSubmodule(repo);
};
const withGitfile = (body: string): Setup => {
  return (repo) => writeFile(sub(repo, '.git'), body);
};
const behindSymlinkedDirectory: Setup = async (repo) => {
  await mkdir(path.join(repo, 'd'));
  await writeFile(path.join(repo, 'd', 'f'), 'f\n');
  gitIn(repo, 'add', 'd/f');
  commitIn(repo, 'd');
  await rename(path.join(repo, 'd'), path.join(repo, 'd2'));
  await symlink('d2', path.join(repo, 'd'));
};

const RM_ROWS: ReadonlyArray<RmRow> = [
  {
    title: 'a moved submodule',
    setup: moved,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'an edited submodule',
    setup: edited,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'an untracked file in the submodule',
    setup: untrackedInSubmodule,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'an untracked file in a submodule configured ignore = all',
    setup: ignoringAll,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'a file in place of the submodule',
    setup: replacedByFile,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'a symlink in place of the submodule',
    setup: replacedBySymlink,
    paths: ['sub'],
    cached: false,
    refusal: DIED('SUBMODULE_PATH_IS_SYMLINK'),
  },
  {
    title: 'a submodule whose .git is past the size git reads',
    setup: withGitfile('x'.repeat(OVERSIZED_GITFILE_BYTES)),
    paths: ['sub'],
    cached: false,
    refusal: DIED('GITFILE_TOO_LARGE'),
  },
  {
    title: 'a submodule whose .git is not a pointer',
    setup: withGitfile('garbage\n'),
    paths: ['sub'],
    cached: false,
    refusal: DIED('NOT_A_REPOSITORY'),
  },
  {
    title: 'a moved submodule kept in the working tree',
    setup: moved,
    paths: ['sub'],
    cached: true,
  },
  {
    title: 'a tracked file behind a symlinked directory',
    setup: behindSymlinkedDirectory,
    paths: ['d/f'],
    cached: false,
  },
];

const gitRemoval = (repo: string, { paths, cached }: RmRow): number => {
  try {
    gitIn(repo, 'rm', '-q', ...(cached ? ['--cached'] : []), ...paths);
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
};

const tsgitRemoval = async (
  repo: string,
  { paths, cached }: RmRow,
): Promise<string | undefined> => {
  try {
    await removePaths(createNodeContext({ workDir: repo }), paths, { cached });
    return undefined;
  } catch (error) {
    return (error as { data: { code: string } }).data.code;
  }
};

const STASH_ORIGINS = ['stash@{0}', 'stash@{0}^2'] as const;

const stashObservation = (repo: string) => {
  const list = gitIn(repo, 'stash', 'list');
  if (list === '') return { list, trees: [ABSENT] };
  const trees = [
    gitIn(repo, 'rev-parse', 'stash@{0}^{tree}').trim(),
    ...STASH_ORIGINS.map((origin) => gitIn(repo, 'rev-parse', `${origin}:${SUBMODULE}`).trim()),
  ];
  return { list, trees };
};

const STASH_ROWS: ReadonlyArray<Row> = [
  { title: 'an unmoved submodule, stash push', setup: nothing, steps: [stashPushStep] },
  { title: 'a moved submodule, stash push', setup: moved, steps: [stashPushStep] },
  { title: 'an edited submodule, stash push', setup: edited, steps: [stashPushStep] },
  {
    title: 'an untracked file in the submodule, stash push',
    setup: untrackedInSubmodule,
    steps: [stashPushStep],
  },
  { title: 'a staged moved submodule, stash push', setup: stagedMove, steps: [stashPushStep] },
  {
    title: 'a moved submodule and an edited file, stash push',
    setup: movedAndEditedK,
    steps: [stashPushStep],
  },
  {
    title: 'a staged moved submodule and an edited file, stash push',
    setup: stagedMoveAndEditedK,
    steps: [stashPushStep],
  },
];

const filesUnder = async (dir: string): Promise<string[]> => {
  if (!existsSync(dir)) return [ABSENT];
  if (!statSync(dir).isDirectory()) return [NOT_A_DIRECTORY];
  const names = await readdir(dir);
  return names.filter((name) => name !== '.git').sort();
};

const submoduleHead = (repo: string): string =>
  existsSync(path.join(sub(repo), '.git')) ? gitIn(sub(repo), 'rev-parse', 'HEAD').trim() : ABSENT;

/** Git cannot read a status or a HEAD through a broken `.git`, so a removal is compared on what it leaves on disk. */
const afterRemoval = async (repo: string) => ({
  index: gitIn(repo, 'ls-files', '--stage'),
  files: await filesUnder(sub(repo)),
  behindLink: await filesUnder(path.join(repo, 'd2')),
});

const observed = async (repo: string) => ({
  index: gitIn(repo, 'ls-files', '--stage', SUBMODULE),
  head: submoduleHead(repo),
  files: await filesUnder(sub(repo)),
  status: gitIn(repo, 'status', '--porcelain=v2', '-uall'),
  stash: stashObservation(repo),
});

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Feature: tree-rewriting commands over a tracked gitlink compared with git',
  () => {
    let root: string;
    let fixture: string;
    let fixtureWithMainCommit: string;

    const twin = async (name: string, source: string): Promise<string> => {
      const dir = path.join(root, name);
      await cp(source, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      gitIn(dir, 'config', 'user.name', 't');
      gitIn(dir, 'config', 'user.email', 't@t');
      return dir;
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-gitlink-consumers-'));
      fixture = await buildFixture(root);
      fixtureWithMainCommit = path.join(root, 'fixture-main-commit');
      await cp(fixture, fixtureWithMainCommit, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await addMainCommit(fixtureWithMainCommit);
    }, ROW_TIMEOUT);

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const matchesGit = (prefix: string, rows: ReadonlyArray<Row>, source: () => string): void => {
      describe.each(rows.map((row, index) => [row.title, row, index] as const))(
        'Given %s',
        (_title, row, index) => {
          describe('When both tools run the steps', () => {
            it(
              'Then the index entry, the submodule HEAD, its files and the status lines match git',
              async () => {
                // Arrange
                const gitTwin = await twin(`${prefix}-git-${index}`, source());
                const tsgitTwin = await twin(`${prefix}-tsgit-${index}`, source());
                await row.setup(gitTwin);
                await row.setup(tsgitTwin);

                // Act
                for (const step of row.steps) {
                  step.git(gitTwin);
                  await step.tsgit(createNodeContext({ workDir: tsgitTwin }), tsgitTwin);
                }

                // Assert
                expect(await observed(tsgitTwin)).toEqual(await observed(gitTwin));
              },
              ROW_TIMEOUT,
            );
          });
        },
      );
    };

    describe.each(RM_ROWS.map((row, index) => [row.title, row, index] as const))(
      'Given %s',
      (_title, row, index) => {
        describe('When both tools run rm', () => {
          it(
            'Then the refusal and the resulting state match git',
            async () => {
              // Arrange
              const gitTwin = await twin(`rm-git-${index}`, fixture);
              const tsgitTwin = await twin(`rm-tsgit-${index}`, fixture);
              await row.setup(gitTwin);
              await row.setup(tsgitTwin);

              // Act
              const gitExit = gitRemoval(gitTwin, row);
              const tsgitCode = await tsgitRemoval(tsgitTwin, row);

              // Assert
              expect(gitExit).toBe(row.refusal?.exit ?? 0);
              expect(tsgitCode).toBe(row.refusal?.code);
              expect(await afterRemoval(tsgitTwin)).toEqual(await afterRemoval(gitTwin));
            },
            ROW_TIMEOUT,
          );
        });
      },
    );

    matchesGit('f2', ROWS, () => fixture);
    matchesGit('f3', F3_ROWS, () => fixtureWithMainCommit);
    matchesGit('stash', STASH_ROWS, () => fixture);
  },
);

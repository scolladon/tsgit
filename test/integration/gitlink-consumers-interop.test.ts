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
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import {
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../../src/application/commands/rebase.js';
import { rm as removePaths } from '../../src/application/commands/rm.js';
import { stashPush } from '../../src/application/commands/stash.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';
import { trackedRepositories } from './repository-lifecycle.js';

const openTrackedRepository = trackedRepositories();

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
const secondMainCommit: Setup = async (repo) => {
  await writeFile(path.join(repo, 'k2'), 'm2\n');
  gitIn(repo, 'add', 'k2');
  commitIn(repo, 'm2');
};
const stagedMoveAfterSecondCommit: Setup = async (repo) => {
  await secondMainCommit(repo);
  await stagedMove(repo);
};
const stagedMoveAndEditedK: Setup = async (repo) => {
  await stagedMove(repo);
  await editedK(repo);
};
const replaceSubmoduleWithFile: Setup = async (repo) => {
  await rm(sub(repo), { recursive: true, force: true });
  await writeFile(sub(repo), 'f\n');
};
const stagedFileInPlaceOfSubmodule: Setup = async (repo) => {
  await replaceSubmoduleWithFile(repo);
  gitIn(repo, 'add', SUBMODULE);
};
/** `file-sub` commits `sub` as a regular file; the repository is left on it. */
const onBranchWithFileSubmodule: Setup = async (repo) => {
  gitIn(repo, 'checkout', '-q', '-b', 'file-sub');
  gitIn(repo, 'rm', '-q', '--cached', SUBMODULE);
  await replaceSubmoduleWithFile(repo);
  gitIn(repo, 'add', SUBMODULE);
  commitIn(repo, 'file-sub');
};
const populatedSubmoduleBesideFileBranch: Setup = async (repo) => {
  await onBranchWithFileSubmodule(repo);
  gitIn(repo, 'checkout', '-q', 'main');
  gitIn(repo, 'submodule', 'update', '-q', '--init', '--force');
};
const populatedSubmoduleWithEmbeddedGitDirectory: Setup = async (repo) => {
  await populatedSubmoduleBesideFileBranch(repo);
  await rm(sub(repo, '.git'), { force: true });
  await cp(path.join(repo, '.git', 'modules', SUBMODULE), sub(repo, '.git'), { recursive: true });
};
/** `file-added` adds a regular file `f`; an empty untracked directory `f/` waits on `main`. */
const emptyDirectoryWhereABranchAddsAFile: Setup = async (repo) => {
  gitIn(repo, 'checkout', '-q', '-b', 'file-added');
  await writeFile(path.join(repo, 'f'), 'f\n');
  gitIn(repo, 'add', 'f');
  commitIn(repo, 'file-added');
  gitIn(repo, 'checkout', '-q', 'main');
  await mkdir(path.join(repo, 'f'));
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

const REFUSED_EXIT_STATUS = 1;

const exitStatusOf = (run: () => void): number => {
  try {
    run();
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
};

const codeOfRefusal = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as TsgitError).data.code;
  }
};

/** Both tools refuse (git: exit 1) and tsgit names `code`; whatever the refusal left is compared by the row. */
const refusedStep = (
  gitArgs: ReadonlyArray<string>,
  tsgit: (ctx: Context) => Promise<unknown>,
  code: string,
): Step => ({
  git: (repo) => {
    expect(exitStatusOf(() => gitIn(repo, ...gitArgs))).toBe(REFUSED_EXIT_STATUS);
  },
  tsgit: async (ctx) => {
    expect(await codeOfRefusal(() => tsgit(ctx))).toBe(code);
  },
});

const refusedRebase = (upstream: string, code: string): Step =>
  refusedStep(['rebase', upstream], (ctx) => rebaseRun(ctx, { upstream }), code);

const refusedContinue: Step = refusedStep(
  ['rebase', '--continue'],
  (ctx) => rebaseContinue(ctx),
  'WORKING_TREE_DIRTY',
);

const abortRebase: Step = {
  git: gitStep('rebase', '--abort'),
  tsgit: (ctx) => rebaseAbort(ctx),
};

const skipRebase: Step = {
  git: gitStep('rebase', '--skip'),
  tsgit: (ctx) => rebaseSkip(ctx),
};

const unstageSubmodule: Step = {
  git: gitStep('restore', '--staged', SUBMODULE),
  tsgit: async (_ctx, repo) => {
    gitIn(repo, 'restore', '--staged', SUBMODULE);
  },
};

interface Row {
  readonly title: string;
  readonly setup: Setup;
  readonly steps: ReadonlyArray<Step>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    title: 'a populated submodule, checkout of a branch holding a regular file at its path',
    setup: populatedSubmoduleBesideFileBranch,
    steps: [switchTo('file-sub')],
  },
  {
    title: 'a submodule with an embedded git directory, checkout of a branch holding a file there',
    setup: populatedSubmoduleWithEmbeddedGitDirectory,
    steps: [switchTo('file-sub')],
  },
  {
    title: 'an empty untracked directory, checkout of a branch adding a file of that name',
    setup: emptyDirectoryWhereABranchAddsAFile,
    steps: [switchTo('file-added')],
  },
  {
    title: 'a branch holding a regular file where main has the submodule, checkout of main',
    setup: onBranchWithFileSubmodule,
    steps: [switchTo('main')],
  },
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
  {
    title: 'a staged submodule move, rebase with nothing to replay',
    setup: stagedMove,
    steps: [rebaseOnto('side')],
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
    title: 'a staged submodule move, rebase onto a branch agreeing on the submodule',
    setup: stagedMove,
    steps: [refusedRebase('side', 'WORKING_TREE_DIRTY')],
  },
  {
    title: 'a staged submodule move, rebase onto a branch moving the submodule',
    setup: stagedMove,
    steps: [refusedRebase('other', 'CHECKOUT_OVERWRITE_DIRTY')],
  },
  {
    title: 'a staged submodule move, refused rebase aborted',
    setup: stagedMove,
    steps: [refusedRebase('side', 'WORKING_TREE_DIRTY'), abortRebase],
  },
  {
    title: 'a staged submodule move, refused rebase continued with the move still staged',
    setup: stagedMove,
    steps: [refusedRebase('side', 'WORKING_TREE_DIRTY'), refusedContinue],
  },
  {
    title: 'a staged submodule move, refused rebase continued after the move was unstaged',
    setup: stagedMove,
    steps: [refusedRebase('side', 'WORKING_TREE_DIRTY'), unstageSubmodule, continueRebase],
  },
  {
    title: 'a staged submodule move, refused rebase skipped',
    setup: stagedMove,
    steps: [refusedRebase('side', 'WORKING_TREE_DIRTY'), skipRebase],
  },
  {
    title: 'a staged submodule move and a second commit to replay, refused rebase skipped',
    setup: stagedMoveAfterSecondCommit,
    steps: [refusedRebase('side', 'WORKING_TREE_DIRTY'), skipRebase],
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
  readonly force?: boolean;
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

const GITMODULES = '.gitmodules';
const MODULE_DIR = ['.git', 'modules', SUBMODULE] as const;
const SECOND_SUBMODULE = 'sub2';

/** The submodule carries its own repository in `sub/.git`, as a plain clone would. */
const embedded: Setup = async (repo) => {
  await rm(sub(repo, '.git'));
  await rename(path.join(repo, ...MODULE_DIR), sub(repo, '.git'));
  gitIn(repo, 'config', '--file', sub(repo, '.git', 'config'), '--unset', 'core.worktree');
};
/** As `embedded`, but `.git/modules/sub` already holds a repository. */
const embeddedOverAbsorbed: Setup = async (repo) => {
  await rm(sub(repo, '.git'));
  await cp(path.join(repo, ...MODULE_DIR), sub(repo, '.git'), { recursive: true });
  gitIn(repo, 'config', '--file', sub(repo, '.git', 'config'), '--unset', 'core.worktree');
};
/** `embedded`, with the `.gitmodules` section naming the path removed and committed. */
const embeddedWithoutName: Setup = async (repo) => {
  await embedded(repo);
  await writeFile(path.join(repo, GITMODULES), '');
  gitIn(repo, 'add', GITMODULES);
  commitIn(repo, 'drop the section');
};
const unstagedGitmodulesEdit: Setup = async (repo) =>
  appendFile(path.join(repo, GITMODULES), '# edit\n');
const stagedGitmodulesEdit: Setup = async (repo) => {
  await unstagedGitmodulesEdit(repo);
  gitIn(repo, 'add', GITMODULES);
};
const gitmodulesRewrittenAlike: Setup = async (repo) =>
  writeFile(path.join(repo, GITMODULES), await readFile(path.join(repo, GITMODULES)));
const gitmodulesDeleted: Setup = async (repo) => rm(path.join(repo, GITMODULES));
const secondSubmodule: Setup = async (repo) => {
  gitIn(repo, 'submodule', 'add', '-q', '../up', SECOND_SUBMODULE);
  commitIn(repo, SECOND_SUBMODULE);
};
const gitmodulesWithoutSection: Setup = async (repo) => {
  await writeFile(
    path.join(repo, GITMODULES),
    '[submodule "other"]\n\tpath = other\n\turl = ../up\n',
  );
  gitIn(repo, 'add', GITMODULES);
  commitIn(repo, 'other section');
};

/** The populated checkout lost its `.git`; the user's file stays. */
const withoutDotGit: Setup = async (repo) => rm(sub(repo, '.git'));
/** `embedded`, the checkout then moved and the move staged. */
const embeddedStagedMove: Setup = async (repo) => {
  await embedded(repo);
  await stagedMove(repo);
};
const embeddedEdited: Setup = async (repo) => {
  await embedded(repo);
  await edited(repo);
};
const embeddedWithoutNameEdited: Setup = async (repo) => {
  await embeddedWithoutName(repo);
  await edited(repo);
};
const editedWithUnstagedGitmodules: Setup = async (repo) => {
  await edited(repo);
  await unstagedGitmodulesEdit(repo);
};
const upstreamOf = (repo: string): string => path.join(path.dirname(repo), 'up');
const NESTED = 'in';
const nestedModuleDir = (repo: string): string => path.join(repo, ...MODULE_DIR, 'modules', NESTED);
/** A nested submodule `in` inside `sub`, recorded by both; `gitmodulesExtra` lands in `sub`'s `.gitmodules` first. */
const withNested = async (repo: string, gitmodulesExtra = ''): Promise<void> => {
  gitIn(sub(repo), 'submodule', 'add', '-q', upstreamOf(repo), NESTED);
  if (gitmodulesExtra !== '') await appendFile(sub(repo, GITMODULES), gitmodulesExtra);
  gitIn(sub(repo), 'add', GITMODULES);
  commitIn(sub(repo), 'nested');
  gitIn(repo, 'add', SUBMODULE);
  commitIn(repo, 'record nested');
};
/** `sub` keeps its gitfile while the nested `in` carries its repository in `sub/in/.git`. */
const nestedEmbedded: Setup = async (repo) => {
  await withNested(repo);
  await rm(sub(repo, NESTED, '.git'));
  await rename(nestedModuleDir(repo), sub(repo, NESTED, '.git'));
  gitIn(repo, 'config', '--file', sub(repo, NESTED, '.git', 'config'), '--unset', 'core.worktree');
};
/** The nested `in` is ignored entirely by `sub`'s `.gitmodules`, then moved. */
const nestedIgnoredMoved: Setup = async (repo) => {
  await withNested(repo, '\tignore = all\n');
  commitIn(sub(repo, NESTED), 'z');
};
/** The section is renamed `a/b` and the module directory moved to `.git/modules/a`, left in place as the embedded copy's source. */
const nameClimbsIntoModule: Setup = async (repo) => {
  gitIn(repo, 'config', '--file', GITMODULES, '--rename-section', 'submodule.sub', 'submodule.a/b');
  gitIn(repo, 'add', GITMODULES);
  commitIn(repo, 'rename');
  await embeddedOverAbsorbed(repo);
  await rename(path.join(repo, ...MODULE_DIR), path.join(repo, '.git', 'modules', 'a'));
};
/** `.gitmodules` conflicted by a merge, its working copy then rewritten clean while the index stays unmerged. */
const unmergedGitmodules: Setup = async (repo) => {
  const original = await readFile(path.join(repo, GITMODULES), 'utf8');
  gitIn(repo, 'checkout', '-q', '-b', 'gm-side');
  await writeFile(path.join(repo, GITMODULES), `${original}\tbranch = side\n`);
  gitIn(repo, 'add', GITMODULES);
  commitIn(repo, 'gm side');
  gitIn(repo, 'checkout', '-q', 'main');
  await writeFile(path.join(repo, GITMODULES), `${original}\tbranch = main\n`);
  gitIn(repo, 'add', GITMODULES);
  commitIn(repo, 'gm main');
  try {
    gitIn(repo, 'merge', '-q', 'gm-side');
  } catch {
    // The conflict is the fixture.
  }
  await writeFile(path.join(repo, GITMODULES), original);
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
    title: 'an unmoved submodule',
    setup: nothing,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a deinitialised submodule',
    setup: deinitialised,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a submodule carrying its repository in .git',
    setup: embedded,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a submodule carrying its repository in .git, named by no .gitmodules row',
    setup: embeddedWithoutName,
    paths: ['sub'],
    cached: false,
    refusal: DIED('SUBMODULE_NAME_NOT_FOUND'),
  },
  {
    title: 'a moved submodule forced out',
    setup: moved,
    paths: ['sub'],
    cached: false,
    force: true,
  },
  {
    title: 'an unstaged .gitmodules edit',
    setup: unstagedGitmodulesEdit,
    paths: ['sub'],
    cached: false,
    refusal: DIED('GITMODULES_NOT_STAGED'),
  },
  {
    title: 'an unstaged .gitmodules edit, index only',
    setup: unstagedGitmodulesEdit,
    paths: ['sub'],
    cached: true,
    refusal: DIED('GITMODULES_NOT_STAGED'),
  },
  {
    title: 'an unstaged .gitmodules edit, forced',
    setup: unstagedGitmodulesEdit,
    paths: ['sub'],
    cached: false,
    force: true,
    refusal: DIED('GITMODULES_NOT_STAGED'),
  },
  {
    title: 'a staged .gitmodules edit',
    setup: stagedGitmodulesEdit,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a .gitmodules rewritten with the same bytes',
    setup: gitmodulesRewrittenAlike,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a .gitmodules deleted from the work tree',
    setup: gitmodulesDeleted,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a second submodule',
    setup: secondSubmodule,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a .gitmodules without a section for the submodule',
    setup: gitmodulesWithoutSection,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a repository in .git over a populated .git/modules entry',
    setup: embeddedOverAbsorbed,
    paths: ['sub'],
    cached: false,
    refusal: DIED('DIRECTORY_NOT_EMPTY'),
  },
  {
    title: 'an unmoved submodule kept in the working tree',
    setup: nothing,
    paths: ['sub'],
    cached: true,
  },
  {
    title: 'a populated checkout that lost its .git',
    setup: withoutDotGit,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'an embedded repository with a staged move, index only',
    setup: embeddedStagedMove,
    paths: ['sub'],
    cached: true,
    refusal: { exit: 1, code: 'RM_STAGED_AND_LOCAL_CHANGES' },
  },
  {
    title: 'a symlink in place of the submodule, index only',
    setup: replacedBySymlink,
    paths: ['sub'],
    cached: true,
  },
  {
    title: 'a symlink in place of the submodule, forced',
    setup: replacedBySymlink,
    paths: ['sub'],
    cached: false,
    force: true,
    refusal: DIED('SUBMODULE_PATH_IS_SYMLINK'),
  },
  {
    title: 'an edited embedded repository',
    setup: embeddedEdited,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'an edited embedded repository named by no .gitmodules row',
    setup: embeddedWithoutNameEdited,
    paths: ['sub'],
    cached: false,
    refusal: DIED('SUBMODULE_NAME_NOT_FOUND'),
  },
  {
    title: 'an edited submodule and an unstaged .gitmodules edit',
    setup: editedWithUnstagedGitmodules,
    paths: ['sub'],
    cached: false,
    refusal: DIED('GITMODULES_NOT_STAGED'),
  },
  {
    title: 'a tracked file and an embedded repository over a populated .git/modules entry',
    setup: embeddedOverAbsorbed,
    paths: ['k', 'sub'],
    cached: false,
    refusal: DIED('DIRECTORY_NOT_EMPTY'),
  },
  {
    title: 'a submodule holding a nested embedded repository',
    setup: nestedEmbedded,
    paths: ['sub'],
    cached: false,
  },
  {
    title: 'a nested submodule the checkout ignores entirely, moved',
    setup: nestedIgnoredMoved,
    paths: ['sub'],
    cached: false,
    refusal: LOCAL_MODIFICATIONS,
  },
  {
    title: 'an embedded repository whose module name climbs into another module',
    setup: nameClimbsIntoModule,
    paths: ['sub'],
    cached: false,
    refusal: DIED('SUBMODULE_GIT_DIR_NESTED'),
  },
  {
    title: 'an unmerged .gitmodules',
    setup: unmergedGitmodules,
    paths: ['sub'],
    cached: false,
    refusal: DIED('GITMODULES_UNMERGED'),
  },
  {
    title: 'a tracked file behind a symlinked directory',
    setup: behindSymlinkedDirectory,
    paths: ['d/f'],
    cached: false,
  },
];

const gitRemoval = (repo: string, { paths, cached, force }: RmRow): number => {
  try {
    gitIn(
      repo,
      'rm',
      '-q',
      ...(cached ? ['--cached'] : []),
      ...(force === true ? ['-f'] : []),
      ...paths,
    );
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
};

const tsgitRemoval = async (
  repo: string,
  { paths, cached, force }: RmRow,
): Promise<string | undefined> => {
  try {
    await removePaths(createNodeContext({ workDir: repo }), paths, {
      cached,
      ...(force === true ? { force } : {}),
    });
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
  {
    title: 'a regular file in place of the submodule, unstaged, stash push',
    setup: replaceSubmoduleWithFile,
    steps: [stashPushStep],
  },
  {
    title: 'a regular file staged in place of the submodule, stash push',
    setup: stagedFileInPlaceOfSubmodule,
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

const bytesOf = async (file: string): Promise<string> =>
  existsSync(file) ? (await readFile(file)).toString('latin1') : ABSENT;

/** A status through a broken `.git` is git's refusal, which both tools must share. */
const outcomeOf = (repo: string, ...args: string[]): string => {
  try {
    return gitIn(repo, ...args);
  } catch (error) {
    return `exit ${(error as { status: number }).status}`;
  }
};

/** Git cannot read a status or a HEAD through a broken `.git`, so a removal is compared on what it leaves on disk. */
const afterRemoval = async (repo: string) => ({
  index: gitIn(repo, 'ls-files', '--stage'),
  files: await filesUnder(sub(repo)),
  behindLink: await filesUnder(path.join(repo, 'd2')),
  gitmodules: await bytesOf(path.join(repo, GITMODULES)),
  stagedGitmodules: outcomeOf(repo, 'rev-parse', `:${GITMODULES}`),
  status: outcomeOf(repo, 'status', '--porcelain'),
  moduleConfig: await bytesOf(path.join(repo, ...MODULE_DIR, 'config')),
  moduleEntries: await filesUnder(path.join(repo, ...MODULE_DIR)),
});

const LINKED_WORKTREE = 'wt';

/** A linked worktree `wt` beside the superproject, its `sub` replaced by a clone-like repository at the recorded commit. */
const linkedWorktreeWithEmbeddedSubmodule = async (
  superproject: string,
  upstream: string,
): Promise<string> => {
  const linked = path.join(path.dirname(superproject), LINKED_WORKTREE);
  gitIn(superproject, 'worktree', 'add', '-q', linked, '-b', LINKED_WORKTREE);
  await rm(sub(linked), { recursive: true });
  await cp(upstream, sub(linked), { recursive: true });
  gitIn(sub(linked), 'checkout', '-q', gitIn(linked, 'rev-parse', `HEAD:${SUBMODULE}`).trim());
  return linked;
};

const afterLinkedRemoval = async (superproject: string, linked: string) => {
  const moduleDir = path.join(
    superproject,
    '.git',
    'worktrees',
    LINKED_WORKTREE,
    'modules',
    SUBMODULE,
  );
  return {
    index: gitIn(linked, 'ls-files', '--stage'),
    status: gitIn(linked, 'status', '--porcelain'),
    gitmodules: await bytesOf(path.join(linked, GITMODULES)),
    config: await bytesOf(path.join(moduleDir, 'config')),
    moduleEntries: await filesUnder(moduleDir),
    gitfile: await bytesOf(path.join(linked, SUBMODULE, '.git')),
    directory: await filesUnder(sub(linked)),
  };
};

const REBASE_STATE = ['.git', 'rebase-merge'] as const;
const REBASE_ROOT_FILES = ['ORIG_HEAD', 'REBASE_HEAD'] as const;

/** What a rebase in progress leaves on disk: HEAD, the marker files and every state file's bytes. */
const rebaseObservation = async (repo: string) => {
  const dir = path.join(repo, ...REBASE_STATE);
  if (!existsSync(dir)) return ABSENT;
  const files = await filesUnder(dir);
  const contents = Object.fromEntries(
    await Promise.all(files.map(async (name) => [name, await bytesOf(path.join(dir, name))])),
  );
  const rootFiles = await Promise.all(
    REBASE_ROOT_FILES.map((name) => bytesOf(path.join(repo, '.git', name))),
  );
  const head = gitIn(repo, 'rev-parse', 'HEAD').trim();
  return {
    files,
    contents,
    rootFiles,
    head,
    headRef: outcomeOf(repo, 'symbolic-ref', '-q', 'HEAD'),
  };
};

const observed = async (repo: string) => ({
  rebase: await rebaseObservation(repo),
  index: gitIn(repo, 'ls-files', '--stage', SUBMODULE),
  head: submoduleHead(repo),
  files: await filesUnder(sub(repo)),
  addedFile: await bytesOf(path.join(repo, 'f')),
  status: gitIn(repo, 'status', '--porcelain=v2', '-uall'),
  stash: stashObservation(repo),
});

const BEYOND_SYMLINK_STDERR = [
  "error: 'd/f' is beyond a symbolic link",
  'fatal: Unable to process path d/f',
  'Cannot save the current worktree state',
];

const stashRefusal = (repo: string, args: ReadonlyArray<string>) => {
  try {
    gitIn(repo, 'stash', ...args);
    return { status: 0, stderr: [] };
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: Buffer };
    return { status, stderr: stderr.toString().trimEnd().split('\n') };
  }
};

const tsgitStashRefusal = async (repo: string, args: ReadonlyArray<string>) => {
  try {
    await stashPush(createNodeContext({ workDir: repo }), {
      includeUntracked: args.includes('-u'),
    });
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

const afterRefusedStash = (repo: string) => ({
  list: gitIn(repo, 'stash', 'list'),
  index: gitIn(repo, 'ls-files', '--stage'),
  status: gitIn(repo, 'status', '--porcelain=v2', '-uall'),
});

const UNTRACKED_OPTIONS = [['push'], ['push', '-u']] as const;

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

    describe('Given an embedded repository in a linked worktree', () => {
      describe('When both tools run rm', () => {
        it(
          'Then the module migrates into the worktree admin directory with git core.worktree',
          async () => {
            // Arrange
            const upstream = path.join(root, 'up');
            const sides = await Promise.all(
              ['linked-git', 'linked-tsgit'].map(async (name) => {
                const parent = path.join(root, name);
                await mkdir(parent);
                const superproject = path.join(parent, 'super');
                await cp(fixture, superproject, {
                  recursive: true,
                  preserveTimestamps: true,
                  verbatimSymlinks: true,
                });
                gitIn(superproject, 'config', 'user.name', 't');
                gitIn(superproject, 'config', 'user.email', 't@t');
                const linked = await linkedWorktreeWithEmbeddedSubmodule(superproject, upstream);
                return { superproject, linked };
              }),
            );
            const [gitSide, tsgitSide] = sides as [(typeof sides)[number], (typeof sides)[number]];

            // Act
            gitIn(gitSide.linked, 'rm', '-q', SUBMODULE);
            const repo = await openTrackedRepository({ cwd: tsgitSide.linked });
            await repo.rm([SUBMODULE]);

            // Assert
            const expected = await afterLinkedRemoval(gitSide.superproject, gitSide.linked);
            expect(expected.config).toContain('worktree = ../../../../../../wt/sub');
            expect(await afterLinkedRemoval(tsgitSide.superproject, tsgitSide.linked)).toEqual(
              expected,
            );
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(UNTRACKED_OPTIONS.map((args) => [args.join(' '), args] as const))(
      'Given a tracked path whose leading directory became a symlink, stash %s',
      (_title, args) => {
        describe('When both tools run the stash', () => {
          it(
            'Then both refuse and leave the stash list, the index and the status untouched',
            async () => {
              // Arrange
              const gitTwin = await twin(`beyond-git-${args.length}`, fixture);
              const tsgitTwin = await twin(`beyond-tsgit-${args.length}`, fixture);
              await behindSymlinkedDirectory(gitTwin);
              await behindSymlinkedDirectory(tsgitTwin);
              const untouched = afterRefusedStash(gitTwin);

              // Act
              const gitRefusal = stashRefusal(gitTwin, args);
              const tsgitRefusal = await tsgitStashRefusal(tsgitTwin, args);

              // Assert
              expect(gitRefusal).toEqual({ status: 1, stderr: BEYOND_SYMLINK_STDERR });
              expect(tsgitRefusal).toEqual({ code: 'PATHSPEC_BEYOND_SYMLINK', path: 'd/f' });
              expect(untouched.list).toBe('');
              expect(untouched.status).toMatch(
                /^1 \.D N\.\.\. 100644 100644 000000 \w+ \w+ d\/f$/m,
              );
              expect(untouched.status).toMatch(/^\? d$/m);
              expect(afterRefusedStash(gitTwin)).toEqual(untouched);
              expect(afterRefusedStash(tsgitTwin)).toEqual(untouched);
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

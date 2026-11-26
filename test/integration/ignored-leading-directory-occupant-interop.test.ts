/**
 * Cross-tool interop — an untracked file standing where a command wants to write, beneath a
 * directory the ignore rules exclude, is ignored for git: the command overwrites it, and a
 * directory that must become a file loses its ignored contents. Without such a rule the same
 * occupant is refused. tsgit is driven through the same fixtures as git and compared by
 * structured snapshots of the branch, the head tree, the pending operation and the listing.
 *
 * @proves
 *   surface:        repo.checkout, repo.merge.run, repo.merge.abort, repo.cherryPick.run, repo.revert.run, repo.rebase.run, repo.rebase.abort, repo.rebase.skip, repo.stash.apply
 *   bucket:         cross-tool-interop
 *   unique:         an occupant beneath a directory excluded by the ignore rules is overwritten by every pre-flight as git does, and still refused when no rule excludes it
 *   interopSurface: checkout
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_GITIGNORE_BYTES } from '../../src/application/primitives/types.js';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  COMMIT_ENV,
  type DirtyRefusalCode,
  listing,
  OK,
  type Outcome,
  outcomeOfGitStderr,
  outcomeOfTsgitRefusal,
} from './occupant-displacement-fixtures.js';

const MINE = 'mine\n';
const THEIRS = 'theirs\n';
const BASE = 'base\n';

interface Snapshot {
  readonly succeeded: boolean;
  readonly branch: string;
  readonly headTree: string;
  readonly inProgress: boolean;
  readonly files: ReadonlyArray<string>;
}

interface Command {
  readonly git: ReadonlyArray<string>;
  readonly tsgit: (repo: Repository) => Promise<unknown>;
  readonly code: string;
  readonly dirtyCode?: DirtyRefusalCode;
}

interface Rule {
  readonly label: string;
  readonly text: string;
}

interface Group {
  readonly title: string;
  readonly rules: ReadonlyArray<Rule>;
  readonly build: (dir: string, rules: string) => void;
  readonly stop?: Command;
  readonly lay: (dir: string) => void;
  readonly command: Command;
}

const NO_RULE: Rule = { label: 'no rule', text: '' };
const DIRECTORY_RULE: Rule = { label: 'a rule excluding the directory', text: 'ab/\n' };
const BARE_RULE: Rule = { label: 'a rule naming the directory without a slash', text: 'ab\n' };
const FILE_RULE: Rule = { label: 'a rule naming only the file', text: 'ab/c\n' };
const NEGATED_RULE: Rule = {
  label: 'a rule excluding the directory and a negation of the file',
  text: 'ab/\n!ab/c\n',
};
const ADDED_RULES = [NO_RULE, DIRECTORY_RULE, BARE_RULE, FILE_RULE, NEGATED_RULE];
const STOP_RULES = [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE];
const PIN_RULES = [NO_RULE, DIRECTORY_RULE];

const put = (dir: string, rel: string, content: string): void => {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

const stageAndCommit = (dir: string, files: ReadonlyArray<string>, message: string): void => {
  git(dir, 'add', '-f', ...files);
  commit(dir, message);
};

const initTwin = (dir: string, ignorecase: string, rules: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'core.ignorecase', ignorecase);
  git(dir, 'config', 'user.name', 'p');
  git(dir, 'config', 'user.email', 'p@p');
  git(dir, 'config', 'commit.gpgsign', 'false');
  put(dir, '.gitignore', rules);
  put(dir, 'f', BASE);
};

const baseCommit = (dir: string, extra: ReadonlyArray<string> = []): void => {
  stageAndCommit(dir, ['.gitignore', 'f', ...extra], 'base');
};

const divergeMain = (dir: string): void => {
  put(dir, 'g', 'g\n');
  stageAndCommit(dir, ['g'], 'main');
};

const otherBranchAdding = (dir: string, rel: string, content: string): void => {
  git(dir, 'checkout', '-q', '-b', 'other');
  put(dir, rel, content);
  stageAndCommit(dir, [rel], 'other');
  git(dir, 'checkout', '-q', 'main');
};

const addedFile =
  (diverged: boolean) =>
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    initTwin(dir, ignorecase, rules);
    baseCommit(dir);
    otherBranchAdding(dir, 'ab/c', THEIRS);
    if (diverged) divergeMain(dir);
  };

const layAddedFile = (dir: string): void => put(dir, 'ab/c', MINE);

const CHECKOUT_OTHER: Command = {
  git: ['checkout', 'other'],
  tsgit: (repo) => repo.checkout({ rev: 'other' }),
  code: 'CHECKOUT_OVERWRITE_DIRTY',
  dirtyCode: 'CHECKOUT_OVERWRITE_DIRTY',
};
const MERGE_OTHER: Command = {
  git: ['merge', '--no-edit', 'other'],
  tsgit: (repo) => repo.merge.run({ rev: 'other' }),
  code: 'WORKING_TREE_DIRTY',
  dirtyCode: 'WORKING_TREE_DIRTY',
};
const CHERRY_PICK_OTHER: Command = {
  git: ['cherry-pick', 'other'],
  tsgit: (repo) => repo.cherryPick.run({ commits: ['other'] }),
  code: 'WORKING_TREE_DIRTY',
};
const REBASE_OTHER: Command = {
  git: ['rebase', 'other'],
  tsgit: (repo) => repo.rebase.run({ upstream: 'other' }),
  code: 'WORKING_TREE_DIRTY',
};

const reAddedFile =
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    initTwin(dir, ignorecase, rules);
    baseCommit(dir);
    put(dir, 'ab/c', THEIRS);
    stageAndCommit(dir, ['ab/c'], 'add');
    git(dir, 'rm', '-q', 'ab/c');
    commit(dir, 'drop');
  };

const stashedAdd =
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    initTwin(dir, ignorecase, rules);
    baseCommit(dir);
    put(dir, 'ab/c', THEIRS);
    git(dir, 'add', '-f', 'ab/c');
    git(dir, 'stash', 'push');
  };

const directoryBecomesFile =
  (diverged: boolean) =>
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    initTwin(dir, ignorecase, rules);
    baseCommit(dir);
    otherBranchAdding(dir, 'ab', THEIRS);
    if (diverged) divergeMain(dir);
  };

const layNestedOccupants = (dir: string): void => {
  put(dir, 'ab/c', MINE);
  put(dir, 'ab/sub/d', MINE);
};

const leadingFile =
  (diverged: boolean) =>
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    initTwin(dir, ignorecase, rules);
    baseCommit(dir);
    otherBranchAdding(dir, 'x/ab/c', THEIRS);
    if (diverged) divergeMain(dir);
  };

const oversizedNestedRuleFile = (dir: string): void => {
  layAddedFile(dir);
  put(dir, 'ab/.gitignore', '#'.repeat(MAX_GITIGNORE_BYTES + 1));
};

const directoryAtNestedRuleFile = (dir: string): void => {
  layAddedFile(dir);
  mkdirSync(path.join(dir, 'ab', '.gitignore'));
};

const TRACKED = 'tracked\n';

const trackedBelowDirectory = (dir: string, ignorecase: string, rules: string): void => {
  initTwin(dir, ignorecase, rules);
  put(dir, 'ab/c', TRACKED);
  baseCommit(dir, ['ab/c']);
};

const editFileOnBranch = (dir: string, branch: string, content: string, removeAbC: boolean) => {
  git(dir, 'checkout', '-q', '-b', branch);
  put(dir, 'f', content);
  if (removeAbC) git(dir, 'rm', '-q', 'ab/c');
  stageAndCommit(dir, ['f'], branch);
  git(dir, 'checkout', '-q', 'main');
};

const rebaseAbortShape =
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    trackedBelowDirectory(dir, ignorecase, rules);
    editFileOnBranch(dir, 'up', 'up\n', true);
    put(dir, 'f', 'main\n');
    stageAndCommit(dir, ['f'], 'main');
  };

const rebaseSkipShape =
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    trackedBelowDirectory(dir, ignorecase, rules);
    editFileOnBranch(dir, 'up', 'up\n', false);
    git(dir, 'rm', '-q', 'ab/c');
    put(dir, 'f', 'main\n');
    stageAndCommit(dir, ['f'], 'main');
  };

const mergeAbortShape =
  (ignorecase: string) =>
  (dir: string, rules: string): void => {
    trackedBelowDirectory(dir, ignorecase, rules);
    editFileOnBranch(dir, 'other', 'other\n', true);
    put(dir, 'f', 'main\n');
    stageAndCommit(dir, ['f'], 'main');
  };

const REBASE_UP: Command = {
  git: ['rebase', 'up'],
  tsgit: (repo) => repo.rebase.run({ upstream: 'up' }),
  code: 'WORKING_TREE_DIRTY',
};
const MERGE_STOP: Command = {
  git: ['merge', '--no-edit', 'other'],
  tsgit: (repo) => repo.merge.run({ rev: 'other' }),
  code: 'WORKING_TREE_DIRTY',
};

const groupsFor = (ic: string): ReadonlyArray<Group> => [
  {
    title: 'checkout over an untracked file beneath an excluded directory',
    rules: ADDED_RULES,
    build: addedFile(false)(ic),
    lay: layAddedFile,
    command: CHECKOUT_OTHER,
  },
  {
    title: 'a fast-forward merge over an untracked file beneath an excluded directory',
    rules: [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE],
    build: addedFile(false)(ic),
    lay: layAddedFile,
    command: {
      git: ['merge', 'other'],
      tsgit: (repo) => repo.merge.run({ rev: 'other' }),
      code: 'WORKING_TREE_DIRTY',
      dirtyCode: 'WORKING_TREE_DIRTY',
    },
  },
  {
    title: 'a merge over an untracked file beneath an excluded directory',
    rules: [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE],
    build: addedFile(true)(ic),
    lay: layAddedFile,
    command: MERGE_OTHER,
  },
  {
    title: 'a cherry-pick over an untracked file beneath an excluded directory',
    rules: [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE],
    build: addedFile(true)(ic),
    lay: layAddedFile,
    command: CHERRY_PICK_OTHER,
  },
  {
    title: 'a rebase over an untracked file beneath an excluded directory',
    rules: [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE],
    build: addedFile(true)(ic),
    lay: layAddedFile,
    command: REBASE_OTHER,
  },
  {
    title: 'a revert re-adding a file over an untracked file beneath an excluded directory',
    rules: [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE],
    build: reAddedFile(ic),
    lay: layAddedFile,
    command: {
      git: ['revert', '--no-edit', 'HEAD'],
      tsgit: (repo) => repo.revert.run({ commits: ['HEAD'] }),
      code: 'WORKING_TREE_DIRTY',
    },
  },
  {
    title: 'a stash apply over an untracked file beneath an excluded directory',
    rules: [NO_RULE, DIRECTORY_RULE, FILE_RULE, NEGATED_RULE],
    build: stashedAdd(ic),
    lay: layAddedFile,
    command: {
      git: ['stash', 'apply'],
      tsgit: (repo) => repo.stash.apply(),
      code: 'STASH_APPLY_WOULD_OVERWRITE',
    },
  },
  {
    title: 'checkout turning an excluded directory into a file',
    rules: [DIRECTORY_RULE, NO_RULE, { label: 'a rule naming its only file', text: 'ab/c\n' }],
    build: directoryBecomesFile(false)(ic),
    lay: (dir) => put(dir, 'ab/c', MINE),
    command: CHECKOUT_OTHER,
  },
  {
    title: 'a merge turning a directory holding nested files into a file',
    rules: [
      DIRECTORY_RULE,
      NO_RULE,
      { label: 'rules naming both nested files', text: 'ab/c\nab/sub/d\n' },
    ],
    build: directoryBecomesFile(true)(ic),
    lay: layNestedOccupants,
    command: MERGE_OTHER,
  },
  {
    title: 'a cherry-pick turning a directory holding nested files into a file',
    rules: [DIRECTORY_RULE, NO_RULE],
    build: directoryBecomesFile(true)(ic),
    lay: layNestedOccupants,
    command: CHERRY_PICK_OTHER,
  },
  {
    title: 'checkout over a file standing where a leading directory is due',
    rules: [
      NO_RULE,
      { label: 'a rule excluding the directory above it', text: 'x/\n' },
      { label: 'a rule naming the file itself', text: 'x/ab\n' },
    ],
    build: leadingFile(false)(ic),
    lay: (dir) => put(dir, 'x/ab', MINE),
    command: CHECKOUT_OTHER,
  },
  {
    title: 'a merge over a file standing where a leading directory is due',
    rules: [
      NO_RULE,
      { label: 'a rule excluding the directory above it', text: 'x/\n' },
      { label: 'a rule naming the file itself', text: 'x/ab\n' },
    ],
    build: leadingFile(true)(ic),
    lay: (dir) => put(dir, 'x/ab', MINE),
    command: MERGE_OTHER,
  },
  {
    title: 'checkout with an oversized rule file inside the excluded directory',
    rules: [DIRECTORY_RULE],
    build: addedFile(false)(ic),
    lay: oversizedNestedRuleFile,
    command: CHECKOUT_OTHER,
  },
  {
    title: 'checkout with a directory standing at the rule file inside the excluded directory',
    rules: [DIRECTORY_RULE],
    build: addedFile(false)(ic),
    lay: directoryAtNestedRuleFile,
    command: CHECKOUT_OTHER,
  },
  {
    title: 'a rebase abort over an untracked file beneath an excluded directory',
    rules: STOP_RULES,
    build: rebaseAbortShape(ic),
    stop: REBASE_UP,
    lay: layAddedFile,
    command: {
      git: ['rebase', '--abort'],
      tsgit: (repo) => repo.rebase.abort(),
      code: 'WORKING_TREE_DIRTY',
    },
  },
  {
    title: 'a rebase skip over an untracked file beneath an excluded directory',
    rules: PIN_RULES,
    build: rebaseSkipShape(ic),
    stop: REBASE_UP,
    lay: layAddedFile,
    command: {
      git: ['rebase', '--skip'],
      tsgit: (repo) => repo.rebase.skip(),
      code: 'WORKING_TREE_DIRTY',
    },
  },
  {
    title: 'a merge abort over an untracked file beneath an excluded directory',
    rules: PIN_RULES,
    build: mergeAbortShape(ic),
    stop: MERGE_STOP,
    lay: layAddedFile,
    command: {
      git: ['merge', '--abort'],
      tsgit: (repo) => repo.merge.abort(),
      code: 'WORKING_TREE_DIRTY',
    },
  },
];

const gitRun = (dir: string, args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: COMMIT_ENV });

const snapshotOf = (dir: string, succeeded: boolean): Snapshot => ({
  succeeded,
  branch: gitRun(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout,
  headTree: gitRun(dir, ['rev-parse', 'HEAD^{tree}']).stdout,
  inProgress:
    existsSync(path.join(dir, '.git', 'rebase-merge')) ||
    existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
  files: listing(dir),
});

const runTsgit = async (dir: string, act: Command['tsgit']): Promise<unknown> => {
  const repo = await openRepository({ cwd: dir });
  try {
    await act(repo);
    return undefined;
  } catch (err) {
    return err;
  } finally {
    await repo.dispose();
  }
};

const refusalOf = (error: unknown, command: Command): Outcome | undefined => {
  if (command.dirtyCode === undefined) return undefined;
  return error === undefined ? OK : outcomeOfTsgitRefusal(error, command.dirtyCode);
};

const gitRefusal = (
  result: { exitCode: number; stderr: string },
  command: Command,
): Outcome | undefined => {
  if (command.dirtyCode === undefined) return undefined;
  return result.exitCode === 0 ? OK : outcomeOfGitStderr(result.stderr);
};

const stopBoth = async (pair: PeerPair, stop: Command): Promise<void> => {
  const peer = gitRun(pair.peer, stop.git);
  const error = await runTsgit(pair.ours, stop.tsgit);
  expect(error).toBeUndefined();
  expect(peer.exitCode).toBe(1);
  const ours = snapshotOf(pair.ours, true);
  expect(ours).toEqual(snapshotOf(pair.peer, true));
  expect(ours.inProgress).toBe(true);
};

const errorCode = (error: unknown): unknown => (error as TsgitError).data.code;

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'ignored leading directory occupant interop',
  () => {
    describe.each(['false', 'true'] as const)(
      'Given core.ignorecase=%s in both twins',
      (ignorecase) => {
        let pair: PeerPair;
        beforeEach(async () => {
          pair = await makePeerPair('ignored-leading-occupant');
        });
        afterEach(async () => {
          await pair.dispose();
        });

        describe.each(groupsFor(ignorecase))('When $title', (group) => {
          it.each(group.rules)('Then with $label it ends as git ends', async (rule) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) group.build(dir, rule.text);
            if (group.stop !== undefined) await stopBoth(pair, group.stop);
            for (const dir of [pair.peer, pair.ours]) group.lay(dir);

            // Act
            const peer = gitRun(pair.peer, group.command.git);
            const error = await runTsgit(pair.ours, group.command.tsgit);

            // Assert
            const refuses = rule.text === '';
            expect(peer.exitCode === 0).toBe(!refuses);
            expect(snapshotOf(pair.ours, error === undefined)).toEqual(
              snapshotOf(pair.peer, peer.exitCode === 0),
            );
            expect(refusalOf(error, group.command)).toEqual(gitRefusal(peer, group.command));
            if (refuses) expect(errorCode(error)).toBe(group.command.code);
          });
        });
      },
    );
  },
);

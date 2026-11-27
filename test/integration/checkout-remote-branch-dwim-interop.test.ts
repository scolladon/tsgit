/**
 * Cross-tool interop — the branch a `checkout` creates or guesses from a
 * remote-tracking name. Bases are built once with canonical git: an upstream
 * `up`, a second upstream `otherUp`, a one-remote clone `baseOne` (packed
 * tracking refs) and a two-remote clone `baseTwo` (loose tracking refs); each
 * row copies one into a fresh `peer` (moved by git) and `ours` (moved by
 * tsgit), under both `core.ignorecase` values, and compares what both leave.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a checkout that creates or guesses a branch refuses and lands as git does
 *   interopSurface: checkout
 */
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { BranchCreateResult } from '../../src/application/commands/branch.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  lsStage,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const FATAL_EXIT = 128;

type CheckoutOptions = Parameters<typeof checkout>[1];

const IDENTITY_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

interface CasePair {
  readonly peer: string;
  readonly ours: string;
  readonly ctx: Context;
}

const headBytes = (dir: string): Promise<string> =>
  readFile(path.join(dir, '.git', 'HEAD'), 'utf8');

/** The `.data` tsgit refuses with; anything that is not a tsgit refusal propagates. */
const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof TsgitError)) throw error;
    return error.data;
  }
  return undefined;
};

const configureIdentity = (dir: string): void => {
  git(dir, 'config', 'user.name', 'A');
  git(dir, 'config', 'user.email', 'a@x');
  git(dir, 'config', 'commit.gpgsign', 'false');
  disableAutoMaintenance(dir);
};

const cloneOf = (source: string, target: string): void => {
  runGit(['clone', '-q', source, target], { env: IDENTITY_ENV });
  configureIdentity(target);
};

/** One setup step both copies of a row run, with canonical git or a raw file write. */
type Step = (dir: string) => void | Promise<void>;

type BaseName = 'one' | 'two' | 'unborn';

interface GuessRow {
  readonly label: string;
  readonly slug: string;
  readonly base: BaseName;
  readonly setup: ReadonlyArray<Step>;
  readonly name: string;
  /** git's arguments and tsgit's options when the row is not a bare `checkout <name>`. */
  readonly gitArgs?: ReadonlyArray<string>;
  readonly opts?: CheckoutOptions;
}

interface GuessRefusalRow {
  readonly label: string;
  readonly slug: string;
  readonly base: BaseName;
  readonly setup: ReadonlyArray<Step>;
  readonly gitArgs: ReadonlyArray<string>;
  readonly opts: CheckoutOptions;
  readonly exit: number;
  readonly line: string;
  readonly data: object;
}

const gitStep =
  (...args: ReadonlyArray<string>): Step =>
  (dir) => {
    runGit(['-C', dir, ...args], { env: IDENTITY_ENV });
  };

const packRefs = gitStep('pack-refs', '--all');

/** Appends raw config text: a valueless key has no `git config` spelling. */
const appendConfig =
  (text: string): Step =>
  (dir) =>
    appendFile(path.join(dir, '.git', 'config'), text);

const stageLocalFile: Step = async (dir) => {
  await writeFile(path.join(dir, 'f.txt'), 'local\n');
  git(dir, 'add', 'f.txt');
};

const writeText =
  (relative: string, text: string): Step =>
  async (dir) => {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };

const writeWorkFile = (relative: string): Step => writeText(relative, 'local\n');

const trackWorkFile = (relative: string): ReadonlyArray<Step> => [
  writeWorkFile(relative),
  gitStep('add', relative),
];

/** `g.txt` and `h.txt` committed on `master`, then both dirtied in the work tree. */
const dirtyCommittedPair: ReadonlyArray<Step> = [
  writeText('g.txt', 'g\n'),
  writeText('h.txt', 'h\n'),
  gitStep('add', 'g.txt', 'h.txt'),
  gitStep('commit', '-q', '-m', 'pair'),
  writeText('g.txt', 'dirty\n'),
  writeText('h.txt', 'dirty\n'),
];

const MERGE_CONFLICT_EXIT = 1;

const conflictedMerge =
  (branch: string): Step =>
  (dir) => {
    const run = tryRunGitWithExit(['-C', dir, 'merge', '-q', branch], { env: IDENTITY_ENV });
    if (run.exitCode !== MERGE_CONFLICT_EXIT) {
      throw new Error(`merge of ${branch} in ${dir} exited ${run.exitCode}: ${run.stderr}`);
    }
  };

/** `g.txt` changed on `master` and on `side`, then `side` merged: `g.txt` is left unmerged. */
const unmergedFile: ReadonlyArray<Step> = [
  writeText('g.txt', 'base\n'),
  gitStep('add', 'g.txt'),
  gitStep('commit', '-q', '-m', 'base'),
  gitStep('switch', '-q', '-c', 'side'),
  writeText('g.txt', 'side\n'),
  gitStep('commit', '-q', '-am', 'side'),
  gitStep('switch', '-q', 'master'),
  writeText('g.txt', 'main\n'),
  gitStep('commit', '-q', '-am', 'main'),
  conflictedMerge('side'),
];

/** Checks out `feat` by guess, back to `master`, then deletes `feat`: the previous branch is gone. */
const previousBranchDeleted: ReadonlyArray<Step> = [
  gitStep('checkout', '-q', 'feat'),
  gitStep('checkout', '-q', 'master'),
  gitStep('branch', '-q', '-D', 'feat'),
];

const danglingLink =
  (relative: string): Step =>
  (dir) =>
    symlink('missing', path.join(dir, relative));

/** Lists `[remote "origin"]` after every other remote: its section is rewritten at the end. */
const originLast: Step = (dir) => {
  const url = git(dir, 'config', 'remote.origin.url').trim();
  git(dir, 'config', '--remove-section', 'remote.origin');
  git(dir, 'config', 'remote.origin.url', url);
  git(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
};

const SYMLINKS_AVAILABLE = process.platform !== 'win32';

const ambiguous = (name: string, remotes: ReadonlyArray<string>) => ({
  exit: FATAL_EXIT,
  line: `'${name}' matched multiple (${remotes.length}) remote tracking branches`,
  data: { code: 'CHECKOUT_REMOTE_BRANCH_AMBIGUOUS', name, remotes },
});

const pathOrTracking = (name: string) => ({
  exit: FATAL_EXIT,
  line: `'${name}' could be both a local file and a tracking branch.`,
  data: { code: 'CHECKOUT_PATH_OR_TRACKING_BRANCH', name },
});

const pathspecNoMatch = (name: string) => ({
  exit: 1,
  line: `error: pathspec '${name}' did not match any file(s) known to git`,
  data: { code: 'PATHSPEC_NO_MATCH', pattern: name, patterns: [name] },
});

const startPointNotCommit = (revision: string, branch: string) => ({
  exit: FATAL_EXIT,
  line: `'${revision}' is not a commit and a branch '${branch}' cannot be created from it`,
  data: { code: 'CHECKOUT_START_POINT_NOT_COMMIT', revision, branch },
});

const detachPathArgument = (argument: string) => ({
  exit: FATAL_EXIT,
  line: `git checkout: --detach does not take a path argument '${argument}'`,
  data: { code: 'CHECKOUT_DETACH_PATH_ARGUMENT', argument },
});

const reflogTop = (dir: string, ref: string): string | undefined => {
  const run = tryRunGitWithExit(['-C', dir, 'log', '-g', '--format=%gs', ref]);
  return run.exitCode === 0 ? run.stdout.split('\n')[0] : undefined;
};

const RESTORED_FILES = ['g.txt', 'h.txt'] as const;

/** The bytes of the files a path restore may touch; `undefined` for one the row never wrote. */
const workFilesOf = (dir: string): Promise<ReadonlyArray<string | undefined>> =>
  Promise.all(
    RESTORED_FILES.map((file) =>
      readFile(path.join(dir, file), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }),
    ),
  );

const headsOf = (dir: string): string =>
  git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads');

/** What a checkout leaves that both tools must agree on. */
const stateOf = async (dir: string, name: string): Promise<unknown> => {
  const config = tryRunGitWithExit(['-C', dir, 'config', '--get-regexp', `^branch\\.${name}\\.`]);
  return {
    head: await headBytes(dir),
    config: { exitCode: config.exitCode, stdout: config.stdout },
    branchLog: reflogTop(dir, `refs/heads/${name}`),
    headLog: reflogTop(dir, 'HEAD'),
    heads: headsOf(dir),
    status: git(dir, 'status', '--porcelain'),
  };
};

const HEADS_PREFIX = 'refs/heads/';
const CREATION_LINE =
  /^(Switched to a new branch '.*'|branch '.*' set up to track '.*'( by rebasing)?\.)$/;

const shortBranchOf = (ref: string): string => ref.slice(HEADS_PREFIX.length);

/** The lines git announces a branch creation with, in stdout-then-stderr order. */
const gitCreationLines = (run: { stdout: string; stderr: string }): ReadonlyArray<string> =>
  `${run.stdout}\n${run.stderr}`.split('\n').filter((line) => CREATION_LINE.test(line));

/** git's creation lines, rebuilt from the structured result tsgit returns. */
const rebuiltCreationLines = (created: BranchCreateResult | undefined): ReadonlyArray<string> => {
  if (created === undefined) return [];
  const name = shortBranchOf(created.name);
  const switched = `Switched to a new branch '${name}'`;
  const upstream = created.upstream;
  if (upstream === undefined) return [switched];
  const tracked = `${upstream.remote}/${shortBranchOf(upstream.merges[0] ?? '')}`;
  const mode = upstream.rebase ? ' by rebasing' : '';
  return [`branch '${name}' set up to track '${tracked}'${mode}.`, switched];
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — checkout branch creation parity with canonical git',
  () => {
    let scratch = '';
    let baseOne = '';
    let baseTwo = '';
    let baseUnborn = '';
    let otherUp = '';
    const caseRoots: string[] = [];

    beforeAll(async () => {
      scratch = await mkdtemp(path.join(os.tmpdir(), 'tsgit-remote-dwim-interop-'));
      const up = path.join(scratch, 'up');
      runGit(['init', '-q', '-b', 'master', up]);
      configureIdentity(up);
      runGit(['-C', up, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
      // `master` stays at c1; `feat` and `only-up` carry c2, which adds f.txt.
      git(up, 'switch', '-q', '-c', 'feat');
      await writeFile(path.join(up, 'f.txt'), 'f\n');
      git(up, 'add', 'f.txt');
      runGit(['-C', up, 'commit', '-q', '-m', 'c2'], { env: IDENTITY_ENV });
      git(up, 'branch', 'only-up');
      git(up, 'switch', '-q', 'master');
      otherUp = path.join(scratch, 'otherUp');
      cloneOf(up, otherUp);
      git(otherUp, 'branch', 'only-other', 'origin/feat');
      // A clone carries only the default branch locally: `feat` must be made a branch of
      // `otherUp` for both remotes of `baseTwo` to carry it.
      git(otherUp, 'branch', 'feat', 'origin/feat');
      baseOne = path.join(scratch, 'baseOne');
      cloneOf(up, baseOne);
      baseTwo = path.join(scratch, 'baseTwo');
      await cp(baseOne, baseTwo, { recursive: true });
      git(baseTwo, 'remote', 'add', 'other', otherUp);
      runGit(['-C', baseTwo, 'fetch', '-q', 'other'], { env: IDENTITY_ENV });
      baseUnborn = path.join(scratch, 'baseUnborn');
      runGit(['init', '-q', '-b', 'master', baseUnborn]);
      configureIdentity(baseUnborn);
      git(baseUnborn, 'remote', 'add', 'origin', up);
      runGit(['-C', baseUnborn, 'fetch', '-q', 'origin'], { env: IDENTITY_ENV });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    const casePair = async (slug: string, base: string, ignoreCase: string): Promise<CasePair> => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `tsgit-remote-dwim-${slug}-${ignoreCase}-`),
      );
      caseRoots.push(root);
      const peer = path.join(root, 'peer');
      const ours = path.join(root, 'ours');
      await cp(base, peer, { recursive: true });
      await cp(base, ours, { recursive: true });
      git(peer, 'config', 'core.ignorecase', ignoreCase);
      git(ours, 'config', 'core.ignorecase', ignoreCase);
      return { peer, ours, ctx: createNodeContext({ workDir: ours }) };
    };

    const baseOf = (name: BaseName): string =>
      ({ one: baseOne, two: baseTwo, unborn: baseUnborn })[name];

    const addOtherRemote: Step = (dir) => {
      git(dir, 'remote', 'add', 'other', otherUp);
    };

    describe.each(['false', 'true'])('with core.ignorecase %s', (ignoreCase) => {
      describe('Given a new branch git refuses to create', () => {
        describe.each([
          {
            label: 'HEAD alongside detach',
            slug: 'b1',
            gitArgs: ['-b', 'HEAD', '--detach'],
            opts: { createBranch: { name: 'HEAD' }, detach: true },
            data: { code: 'INVALID_REF', reason: 'branch name must not be HEAD' },
            line: "'HEAD' is not a valid branch name",
          },
          {
            label: 'an existing branch alongside detach',
            slug: 'b2',
            gitArgs: ['-b', 'master', '--detach'],
            opts: { createBranch: { name: 'master' }, detach: true },
            data: { code: 'BRANCH_EXISTS', name: 'refs/heads/master' },
            line: "a branch named 'master' already exists",
          },
          {
            label: 'an existing branch from a start point naming nothing',
            slug: 'b3',
            gitArgs: ['-b', 'master', 'missing'],
            opts: { rev: 'missing', createBranch: { name: 'master' } },
            data: {
              code: 'CHECKOUT_START_POINT_NOT_COMMIT',
              revision: 'missing',
              branch: 'master',
            },
            line: "'missing' is not a commit and a branch 'master' cannot be created from it",
          },
        ] satisfies ReadonlyArray<{
          label: string;
          slug: string;
          gitArgs: ReadonlyArray<string>;
          opts: CheckoutOptions;
          data: object;
          line: string;
        }>)('When both tools create $label', ({ slug, gitArgs, opts, data, line }) => {
          it('Then both refuse with the same reason and HEAD stays', async () => {
            // Arrange
            const { peer, ours, ctx } = await casePair(slug, baseOne, ignoreCase);
            const headBefore = await headBytes(ours);
            const sut = checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', ...gitArgs], {
              env: IDENTITY_ENV,
            });
            const result = await refusalOf(() => sut(ctx, opts));

            // Assert
            expect(peerRun.exitCode).toBe(FATAL_EXIT);
            expect(peerRun.stderr).toContain(line);
            expect(result).toEqual(data);
            expect(await headBytes(ours)).toBe(headBefore);
            expect(await headBytes(peer)).toBe(headBefore);
          });
        });
      });

      describe('Given config entries checkout reads in file order', () => {
        describe.each([
          {
            label: 'a bad checkout.guess before switching to the current branch',
            slug: 'r24b',
            entries: [['checkout.guess', 'bogus']],
            gitArgs: ['master'],
            opts: { rev: 'master' },
            key: 'checkout.guess',
          },
          {
            label: 'a bad checkout.guess before restoring a path',
            slug: 'r24c',
            entries: [['checkout.guess', 'bogus']],
            gitArgs: ['--', 'f.txt'],
            opts: { paths: ['f.txt'] },
            key: 'checkout.guess',
          },
          {
            label: 'a bad checkout.guess before detaching at a tracking branch',
            slug: 'r24e',
            entries: [['checkout.guess', 'bogus']],
            gitArgs: ['origin/feat'],
            opts: { rev: 'origin/feat' },
            key: 'checkout.guess',
          },
          {
            label: 'a bad checkout.guess and the guess turned off',
            slug: 'r24d',
            entries: [['checkout.guess', 'bogus']],
            gitArgs: ['--no-guess', 'feat'],
            opts: { rev: 'feat', guess: false },
            key: 'checkout.guess',
          },
          {
            label: 'a bad checkout.guess a later true overrides',
            slug: 'c1',
            entries: [
              ['checkout.guess', 'bogus'],
              ['checkout.guess', 'true'],
            ],
            gitArgs: ['master'],
            opts: { rev: 'master' },
            key: 'checkout.guess',
          },
          {
            label: 'a bad checkout.guess above a bad branch.autoSetupMerge',
            slug: 'o1',
            entries: [
              ['checkout.guess', 'bogus'],
              ['branch.autoSetupMerge', 'bogus'],
            ],
            gitArgs: ['master'],
            opts: { rev: 'master' },
            key: 'checkout.guess',
          },
          {
            label: 'a bad branch.autoSetupMerge above a bad checkout.guess',
            slug: 'o2',
            entries: [
              ['branch.autoSetupMerge', 'bogus'],
              ['checkout.guess', 'bogus'],
            ],
            gitArgs: ['master'],
            opts: { rev: 'master' },
            key: 'branch.autosetupmerge',
          },
          {
            label: 'a bad branch.autoSetupMerge before detaching at a tracking branch',
            slug: 'r30',
            entries: [['branch.autoSetupMerge', 'bogus']],
            gitArgs: ['origin/feat'],
            opts: { rev: 'origin/feat' },
            key: 'branch.autosetupmerge',
          },
        ] satisfies ReadonlyArray<{
          label: string;
          slug: string;
          entries: ReadonlyArray<readonly [string, string]>;
          gitArgs: ReadonlyArray<string>;
          opts: CheckoutOptions;
          key: string;
        }>)('When both tools check out with $label', ({ slug, entries, gitArgs, opts, key }) => {
          it(`Then both refuse ${key} and HEAD stays`, async () => {
            // Arrange
            const { peer, ours, ctx } = await casePair(slug, baseOne, ignoreCase);
            for (const [name, value] of entries) {
              git(peer, 'config', '--add', name, value);
              git(ours, 'config', '--add', name, value);
            }
            const headBefore = await headBytes(ours);
            const sut = checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', ...gitArgs], {
              env: IDENTITY_ENV,
            });
            const result = await refusalOf(() => sut(ctx, opts));

            // Assert
            expect(peerRun.exitCode).toBe(FATAL_EXIT);
            expect(peerRun.stderr).toContain(`bad boolean config value 'bogus' for '${key}'`);
            expect(result).toMatchObject({ code: 'CONFIG_BAD_BOOLEAN_VALUE', key, value: 'bogus' });
            expect(await headBytes(ours)).toBe(headBefore);
            expect(await headBytes(peer)).toBe(headBefore);
          });
        });
      });

      describe('Given a bare repository and a config key checkout would refuse', () => {
        describe.each([
          { label: 'a bad checkout.guess', slug: 'w1', name: 'checkout.guess' },
          { label: 'a bad branch.autoSetupMerge', slug: 'w2', name: 'branch.autoSetupMerge' },
        ])('When both tools check out with $label', ({ slug, name }) => {
          it('Then both refuse the missing work tree before reading the config', async () => {
            // Arrange
            const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-remote-dwim-${slug}-`));
            caseRoots.push(root);
            const peer = path.join(root, 'peer.git');
            const ours = path.join(root, 'ours.git');
            for (const dir of [peer, ours]) {
              runGit(['clone', '-q', '--bare', baseOne, dir], { env: IDENTITY_ENV });
              git(dir, 'config', 'core.ignorecase', ignoreCase);
              git(dir, 'config', '--add', name, 'bogus');
            }
            const repo = await openRepository({ cwd: ours });
            const sut = repo.checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', 'master'], {
              env: IDENTITY_ENV,
            });
            const result = await refusalOf(() => sut({ rev: 'master' }));

            // Assert
            expect(peerRun.exitCode).toBe(FATAL_EXIT);
            expect(peerRun.stderr).toContain('this operation must be run in a work tree');
            expect(result).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'checkout' });
          });
        });
      });

      describe('Given a name only remote-tracking refs answer', () => {
        describe.each([
          { label: 'one remote', slug: 'r1', base: 'one', setup: [], name: 'feat' },
          { label: 'packed refs', slug: 'r1b', base: 'one', setup: [packRefs], name: 'feat' },
          {
            label: 'two remotes and the second as default',
            slug: 'r3',
            base: 'two',
            setup: [gitStep('config', 'checkout.defaultRemote', 'other')],
            name: 'feat',
          },
          {
            label: 'one match and an unfetched default remote',
            slug: 'r3y',
            base: 'one',
            setup: [addOtherRemote, gitStep('config', 'checkout.defaultRemote', 'other')],
            name: 'feat',
          },
          {
            label: 'a name only the second remote carries',
            slug: 'r3z',
            base: 'two',
            setup: [],
            name: 'only-other',
          },
          {
            label: 'one remote named as default',
            slug: 'r25',
            base: 'one',
            setup: [gitStep('config', 'checkout.defaultRemote', 'origin')],
            name: 'feat',
          },
          {
            label: 'a valueless default remote followed by the second remote',
            slug: 'c2',
            base: 'two',
            setup: [appendConfig('[checkout]\n\tdefaultRemote\n\tdefaultRemote = other\n')],
            name: 'feat',
          },
          {
            label: 'two default remotes, the last naming origin',
            slug: 'c3',
            base: 'two',
            setup: [
              gitStep('config', '--add', 'checkout.defaultRemote', 'other'),
              gitStep('config', '--add', 'checkout.defaultRemote', 'origin'),
            ],
            name: 'feat',
          },
          {
            label: 'a default remote fetching into another namespace',
            slug: 'c4',
            base: 'two',
            setup: [
              gitStep('config', 'checkout.defaultRemote', 'other'),
              gitStep('config', 'remote.other.fetch', '+refs/heads/*:refs/remotes/o2/*'),
              gitStep('fetch', '-q', 'other'),
            ],
            name: 'feat',
          },
          {
            label: 'a refspec mapping into another namespace',
            slug: 'r10',
            base: 'one',
            setup: [
              gitStep('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/mirror/*'),
              gitStep('fetch', '-q', 'origin'),
            ],
            name: 'feat',
          },
          {
            label: 'a negative refspec naming the branch',
            slug: 'r10c',
            base: 'one',
            setup: [gitStep('config', '--add', 'remote.origin.fetch', '^refs/heads/feat')],
            name: 'feat',
          },
          {
            label: 'a later exact refspec',
            slug: 'r10f',
            base: 'one',
            setup: [
              gitStep(
                'config',
                '--add',
                'remote.origin.fetch',
                '+refs/heads/feat:refs/remotes/zz/feat',
              ),
              gitStep('fetch', '-q', 'origin'),
            ],
            name: 'feat',
          },
          { label: 'an unborn HEAD', slug: 'r11', base: 'unborn', setup: [], name: 'feat' },
          {
            label: 'a detached HEAD',
            slug: 'r15',
            base: 'one',
            setup: [gitStep('checkout', '-q', '--detach', 'master')],
            name: 'feat',
          },
          {
            label: 'a valueless checkout.guess',
            slug: 'r26',
            base: 'one',
            setup: [appendConfig('[checkout]\n\tguess\n')],
            name: 'feat',
          },
          {
            label: 'checkout.guess false then true',
            slug: 'r29',
            base: 'one',
            setup: [
              gitStep('config', '--add', 'checkout.guess', 'false'),
              gitStep('config', '--add', 'checkout.guess', 'true'),
            ],
            name: 'feat',
          },
          {
            label: 'checkout.guess false and the guess turned on',
            slug: 'r5b',
            base: 'one',
            setup: [gitStep('config', 'checkout.guess', 'false')],
            name: 'feat',
            gitArgs: ['--guess', 'feat'],
            opts: { rev: 'feat', guess: true },
          },
          ...['false', 'inherit', 'simple', 'always'].map(
            (mode): GuessRow => ({
              label: `branch.autoSetupMerge ${mode}`,
              slug: `r12-${mode}`,
              base: 'one',
              setup: [gitStep('config', 'branch.autoSetupMerge', mode)],
              name: 'feat',
            }),
          ),
          {
            label: 'branch.autoSetupRebase always',
            slug: 'r12d',
            base: 'one',
            setup: [gitStep('config', 'branch.autoSetupRebase', 'always')],
            name: 'feat',
          },
          {
            label: 'a local branch of that name',
            slug: 'r7',
            base: 'one',
            setup: [gitStep('branch', 'feat', 'master')],
            name: 'feat',
          },
          {
            label: 'a tag of that name',
            slug: 'r21',
            base: 'one',
            setup: [gitStep('tag', 'feat', 'origin/feat')],
            name: 'feat',
          },
          {
            label: 'a file of that name one directory down',
            slug: 'f3',
            base: 'one',
            setup: [writeWorkFile('sub/feat')],
            name: 'feat',
          },
          {
            label: 'the remote-tracking spelling',
            slug: 'r8',
            base: 'one',
            setup: [],
            name: 'origin/feat',
          },
          {
            label: 'the remote-tracking spelling and a valueless default remote',
            slug: 'r27c',
            base: 'one',
            setup: [appendConfig('[checkout]\n\tdefaultRemote\n')],
            name: 'origin/feat',
          },
        ] satisfies ReadonlyArray<GuessRow>)(
          'When both tools check out with $label',
          ({ slug, base, setup, name, gitArgs = [name], opts = { rev: name } }) => {
            it('Then both leave the same HEAD, branch config, reflogs, branches and status', async () => {
              // Arrange
              const { peer, ours, ctx } = await casePair(slug, baseOf(base), ignoreCase);
              for (const step of setup) {
                await step(peer);
                await step(ours);
              }
              const sut = checkout;

              // Act
              const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', ...gitArgs], {
                env: IDENTITY_ENV,
              });
              const result = await sut(ctx, opts);

              // Assert
              expect(peerRun.exitCode).toBe(0);
              expect(await stateOf(ours, name)).toEqual(await stateOf(peer, name));
              expect(rebuiltCreationLines(result.createdBranch)).toEqual(gitCreationLines(peerRun));
            });
          },
        );

        describe('When both tools check out with a forced switch over an untracked file', () => {
          it('Then both create the branch and leave the same state', async () => {
            // Arrange
            const { peer, ours, ctx } = await casePair('r9e', baseOne, ignoreCase);
            await writeFile(path.join(peer, 'f.txt'), 'dirty\n');
            await writeFile(path.join(ours, 'f.txt'), 'dirty\n');
            const sut = checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', '-f', 'feat'], {
              env: IDENTITY_ENV,
            });
            const result = await sut(ctx, { rev: 'feat', force: true });

            // Assert
            expect(peerRun.exitCode).toBe(0);
            expect(await stateOf(ours, 'feat')).toEqual(await stateOf(peer, 'feat'));
            expect(rebuiltCreationLines(result.createdBranch)).toEqual(gitCreationLines(peerRun));
          });
        });

        describe('When both tools check out a name only another case of a loose ref carries', () => {
          it('Then both reach the same outcome on this file system', async () => {
            // Arrange
            const { peer, ours, ctx } = await casePair('r13c', baseTwo, ignoreCase);
            const sut = checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', 'ONLY-OTHER'], {
              env: IDENTITY_ENV,
            });
            const result = await refusalOf(() => sut(ctx, { rev: 'ONLY-OTHER' }));

            // Assert
            if (peerRun.exitCode === 0) {
              expect(result).toBeUndefined();
              expect(await stateOf(ours, 'ONLY-OTHER')).toEqual(await stateOf(peer, 'ONLY-OTHER'));
              return;
            }
            expect(peerRun.stderr).toContain("pathspec 'ONLY-OTHER' did not match");
            expect(result).toMatchObject({ code: 'PATHSPEC_NO_MATCH', pattern: 'ONLY-OTHER' });
          });
        });
      });

      describe('Given a guess git refuses', () => {
        describe.each([
          {
            label: 'a guessed branch alongside detach',
            slug: 'r9c',
            base: 'one',
            setup: [],
            gitArgs: ['--detach', 'feat'],
            opts: { rev: 'feat', detach: true },
            exit: FATAL_EXIT,
            line: "'--detach' cannot be used with '-b/-B/--orphan'",
            data: {
              code: 'INVALID_OPTION',
              option: 'createBranch',
              reason: 'cannot be combined with detach',
            },
          },
          {
            label: 'HEAD on an unborn branch',
            slug: 'h1',
            base: 'unborn',
            setup: [],
            gitArgs: ['HEAD'],
            opts: { rev: 'HEAD' },
            exit: FATAL_EXIT,
            line: "'HEAD' is not a valid branch name",
            data: { code: 'INVALID_REF', reason: 'branch name must not be HEAD' },
          },
          {
            label: 'HEAD on an unborn branch alongside detach',
            slug: 'h1d',
            base: 'unborn',
            setup: [],
            gitArgs: ['--detach', 'HEAD'],
            opts: { rev: 'HEAD', detach: true },
            exit: FATAL_EXIT,
            line: "'HEAD' is not a valid branch name",
            data: { code: 'INVALID_REF', reason: 'branch name must not be HEAD' },
          },
          {
            label: 'a name holding revision syntax',
            slug: 'tilde',
            base: 'one',
            setup: [],
            gitArgs: ['feat~1'],
            opts: { rev: 'feat~1' },
            exit: FATAL_EXIT,
            line: "'feat~1' is not a valid branch name",
            data: { code: 'INVALID_REF', reason: 'ref name contains forbidden character' },
          },
          {
            label: 'a tracking ref naming a tree',
            slug: 'r20',
            base: 'one',
            setup: [gitStep('update-ref', 'refs/remotes/origin/treeish', 'origin/feat^{tree}')],
            gitArgs: ['treeish'],
            opts: { rev: 'treeish' },
            exit: FATAL_EXIT,
            line: "Cannot switch branch to a non-commit 'refs/remotes/origin/treeish'",
            data: { code: 'CHECKOUT_NON_COMMIT', revision: 'refs/remotes/origin/treeish' },
          },
          {
            label: 'two remotes fetching into one namespace and origin as default',
            slug: 'r17',
            base: 'two',
            setup: [
              gitStep('config', 'remote.other.fetch', '+refs/heads/*:refs/remotes/origin/*'),
              gitStep('config', 'checkout.defaultRemote', 'origin'),
            ],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            exit: FATAL_EXIT,
            line: "not tracking: ambiguous information for ref 'refs/remotes/origin/feat'",
            data: {
              code: 'TRACKING_AMBIGUOUS',
              ref: 'refs/remotes/origin/feat',
              remotes: ['origin', 'other'],
            },
          },
          {
            label: 'a staged file the guessed branch would overwrite',
            slug: 'r22',
            base: 'one',
            setup: [gitStep('switch', '-q', '-c', 'wip'), stageLocalFile],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            exit: 1,
            line: 'Your local changes to the following files would be overwritten by checkout',
            data: { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['f.txt'], untracked: [] },
          },
          {
            label: 'a name two remotes carry and no default remote',
            slug: 'r2',
            base: 'two',
            setup: [],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'a name two remotes carry with the ambiguity advice off',
            slug: 'r2n',
            base: 'two',
            setup: [gitStep('config', 'advice.checkoutAmbiguousRemoteBranchName', 'false')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'a name two remotes carry, origin configured last',
            slug: 'r18',
            base: 'two',
            setup: [originLast],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['other', 'origin']),
          },
          {
            label: 'a name two remotes carry and a default remote naming none',
            slug: 'r3x',
            base: 'two',
            setup: [gitStep('config', 'checkout.defaultRemote', 'nope')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'a name two remotes carry and a default remote in another case',
            slug: 'r28',
            base: 'two',
            setup: [gitStep('config', 'checkout.defaultRemote', 'OTHER')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'two remotes fetching into one namespace and no default remote',
            slug: 'r17b',
            base: 'two',
            setup: [gitStep('config', 'remote.other.fetch', '+refs/heads/*:refs/remotes/origin/*')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'a file of that name and a name two remotes carry',
            slug: 'f1',
            base: 'two',
            setup: [writeWorkFile('feat')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'a name two remotes carry alongside detach',
            slug: 'a22d',
            base: 'two',
            setup: [],
            gitArgs: ['--detach', 'feat'],
            opts: { rev: 'feat', detach: true },
            ...ambiguous('feat', ['origin', 'other']),
          },
          {
            label: 'an untracked file of that name',
            slug: 'r6',
            base: 'one',
            setup: [writeWorkFile('feat')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...pathOrTracking('feat'),
          },
          {
            label: 'a directory of that name',
            slug: 'r32',
            base: 'one',
            setup: [writeWorkFile('feat/x')],
            gitArgs: ['feat'],
            opts: { rev: 'feat' },
            ...pathOrTracking('feat'),
          },
          ...(SYMLINKS_AVAILABLE
            ? [
                {
                  label: 'a dangling symbolic link of that name',
                  slug: 'f2',
                  base: 'one',
                  setup: [danglingLink('feat')],
                  gitArgs: ['feat'],
                  opts: { rev: 'feat' },
                  ...pathOrTracking('feat'),
                } satisfies GuessRefusalRow,
              ]
            : []),
          {
            label: 'a tracked file a remote-tracking ref also names',
            slug: 'p4',
            base: 'one',
            setup: [
              writeWorkFile('g.txt'),
              gitStep('add', 'g.txt'),
              gitStep('update-ref', 'refs/remotes/origin/g.txt', 'origin/feat'),
            ],
            gitArgs: ['g.txt'],
            opts: { rev: 'g.txt' },
            ...pathOrTracking('g.txt'),
          },
          {
            label: 'a file of that name alongside detach',
            slug: 'a22e',
            base: 'one',
            setup: [writeWorkFile('feat')],
            gitArgs: ['--detach', 'feat'],
            opts: { rev: 'feat', detach: true },
            ...pathOrTracking('feat'),
          },
          {
            label: 'a name only a remote-tracking ref carries with the guess turned off',
            slug: 'r5',
            base: 'one',
            setup: [],
            gitArgs: ['--no-guess', 'feat'],
            opts: { rev: 'feat', guess: false },
            ...pathspecNoMatch('feat'),
          },
          ...(
            [
              {
                label: 'checkout.guess false',
                slug: 'r4',
                base: 'one',
                setup: [gitStep('config', 'checkout.guess', 'false')],
                name: 'feat',
              },
              {
                label: 'a file of that name and checkout.guess false',
                slug: 'r31',
                base: 'one',
                setup: [writeWorkFile('feat'), gitStep('config', 'checkout.guess', 'false')],
                name: 'feat',
              },
              {
                label: 'a refspec mapping into an unfetched namespace',
                slug: 'r10b',
                base: 'one',
                setup: [
                  gitStep('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/mirror/*'),
                ],
                name: 'feat',
              },
              {
                label: 'a tracking ref under a namespace no remote maps onto',
                slug: 'r10d',
                base: 'one',
                setup: [gitStep('update-ref', 'refs/remotes/stale/feat2', 'origin/feat')],
                name: 'feat2',
              },
              {
                label: 'a remote without a fetch refspec',
                slug: 'r10e',
                base: 'one',
                setup: [gitStep('config', '--unset-all', 'remote.origin.fetch')],
                name: 'feat',
              },
              {
                label: 'a refspec mapping onto local branches',
                slug: 'r16',
                base: 'one',
                setup: [gitStep('config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*')],
                name: 'only-up',
              },
              {
                label: 'another case of a packed ref',
                slug: 'r13',
                base: 'one',
                setup: [],
                name: 'FEAT',
              },
              {
                label: 'another case of a ref packed again',
                slug: 'r13b',
                base: 'one',
                setup: [packRefs],
                name: 'FEAT',
              },
              {
                label: 'the previous branch deleted, by dash',
                slug: 'r19',
                base: 'one',
                setup: previousBranchDeleted,
                name: '-',
              },
              {
                label: 'the previous branch deleted, by reflog spelling',
                slug: 'r19b',
                base: 'one',
                setup: previousBranchDeleted,
                name: '@{-1}',
              },
              { label: '@ on an unborn branch', slug: 'h2', base: 'unborn', setup: [], name: '@' },
            ] satisfies ReadonlyArray<GuessRow>
          ).map(
            ({ name, ...row }): GuessRefusalRow => ({
              ...row,
              gitArgs: [name],
              opts: { rev: name },
              ...pathspecNoMatch(name),
            }),
          ),
          {
            label: 'a new branch from a name only a remote-tracking ref carries',
            slug: 'r9a',
            base: 'one',
            setup: [],
            gitArgs: ['-b', 'x', 'feat'],
            opts: { rev: 'feat', createBranch: { name: 'x' } },
            ...startPointNotCommit('feat', 'x'),
          },
          {
            label: 'a new branch from a tracked file',
            slug: 'p6',
            base: 'one',
            setup: trackWorkFile('g.txt'),
            gitArgs: ['-b', 'x', 'g.txt'],
            opts: { rev: 'g.txt', createBranch: { name: 'x' } },
            ...startPointNotCommit('g.txt', 'x'),
          },
          {
            label: 'a name nothing answers alongside detach',
            slug: 'a22a',
            base: 'one',
            setup: [],
            gitArgs: ['--detach', 'missing'],
            opts: { rev: 'missing', detach: true },
            ...detachPathArgument('missing'),
          },
          {
            label: 'a tracked file alongside detach',
            slug: 'a22c',
            base: 'one',
            setup: trackWorkFile('g.txt'),
            gitArgs: ['--detach', 'g.txt'],
            opts: { rev: 'g.txt', detach: true },
            ...detachPathArgument('g.txt'),
          },
          {
            label: 'an unmerged file',
            slug: 'u1',
            base: 'one',
            setup: unmergedFile,
            gitArgs: ['g.txt'],
            opts: { rev: 'g.txt' },
            exit: 1,
            line: "error: path 'g.txt' is unmerged",
            data: { code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['g.txt'] },
          },
        ] satisfies ReadonlyArray<GuessRefusalRow>)('When both tools check out $label', (row) => {
          it('Then both refuse with the same reason and leave the same HEAD and branches', async () => {
            // Arrange
            const { peer, ours, ctx } = await casePair(row.slug, baseOf(row.base), ignoreCase);
            for (const step of row.setup) {
              await step(peer);
              await step(ours);
            }
            const sut = checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', ...row.gitArgs], {
              env: IDENTITY_ENV,
            });
            const result = await refusalOf(() => sut(ctx, row.opts));

            // Assert
            expect(peerRun.exitCode).toBe(row.exit);
            expect(peerRun.stderr).toContain(row.line);
            expect(result).toEqual(row.data);
            expect(await headBytes(ours)).toBe(await headBytes(peer));
            expect(headsOf(ours)).toBe(headsOf(peer));
          });
        });

        describe('When both tools check out, from a subdirectory, a name a file there carries', () => {
          it('Then both refuse the name as a file and a tracking branch', async () => {
            // Arrange
            const { peer, ours } = await casePair('f3b', baseOne, ignoreCase);
            await writeWorkFile('sub/feat')(peer);
            await writeWorkFile('sub/feat')(ours);
            const repo = await openRepository({ cwd: path.join(ours, 'sub') });
            const sut = repo.checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', path.join(peer, 'sub'), 'checkout', 'feat'], {
              env: IDENTITY_ENV,
            });
            const result = await refusalOf(() => sut({ rev: 'feat' }));
            await repo.dispose();

            // Assert
            const expected = pathOrTracking('feat');
            expect(peerRun.exitCode).toBe(expected.exit);
            expect(peerRun.stderr).toContain(expected.line);
            expect(result).toEqual(expected.data);
            expect(await headBytes(ours)).toBe(await headBytes(peer));
            expect(headsOf(ours)).toBe(headsOf(peer));
          });
        });

        describe.each([
          { label: 'two matches', slug: 'r27', base: 'two' },
          { label: 'one match', slug: 'r27b', base: 'one' },
        ] as const)(
          'When both tools guess with a valueless last default remote and $label',
          ({ slug, base }) => {
            it('Then both refuse the missing value at the same line', async () => {
              // Arrange
              const { peer, ours, ctx } = await casePair(slug, baseOf(base), ignoreCase);
              await appendConfig('[checkout]\n\tdefaultRemote\n')(peer);
              await appendConfig('[checkout]\n\tdefaultRemote\n')(ours);
              const sut = checkout;

              // Act
              const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', 'feat'], {
                env: IDENTITY_ENV,
              });
              const result = await refusalOf(() => sut(ctx, { rev: 'feat' }));

              // Assert
              expect(peerRun.exitCode).toBe(FATAL_EXIT);
              expect(peerRun.stderr).toContain("error: missing value for 'checkout.defaultremote'");
              const line = Number(/at line (\d+)/.exec(peerRun.stderr)?.[1]);
              expect(result).toMatchObject({
                code: 'CONFIG_MISSING_VALUE',
                key: 'checkout.defaultremote',
                line,
              });
              expect(await headBytes(ours)).toBe(await headBytes(peer));
            });
          },
        );
      });

      describe('Given a switch argument that names paths and no branch', () => {
        describe.each([
          {
            label: 'a tracked file',
            slug: 'p1',
            base: 'one',
            setup: dirtyCommittedPair,
            gitArgs: ['g.txt'],
            opts: { rev: 'g.txt' },
          },
          {
            label: 'a glob over tracked files',
            slug: 'p2',
            base: 'one',
            setup: dirtyCommittedPair,
            gitArgs: ['*.txt'],
            opts: { rev: '*.txt' },
          },
          {
            label: 'a tracked file, forced',
            slug: 'p3',
            base: 'one',
            setup: dirtyCommittedPair,
            gitArgs: ['-f', 'g.txt'],
            opts: { rev: 'g.txt', force: true },
          },
          {
            label: 'a tracked file a remote-tracking ref also names and checkout.guess false',
            slug: 'p5',
            base: 'one',
            setup: [
              ...dirtyCommittedPair,
              gitStep('update-ref', 'refs/remotes/origin/g.txt', 'origin/feat'),
              gitStep('config', 'checkout.guess', 'false'),
            ],
            gitArgs: ['g.txt'],
            opts: { rev: 'g.txt' },
          },
          {
            label: 'a file staged then dirtied on an unborn branch',
            slug: 'p7',
            base: 'unborn',
            setup: [
              writeText('g.txt', 'g\n'),
              gitStep('add', 'g.txt'),
              writeText('g.txt', 'dirty\n'),
            ],
            gitArgs: ['g.txt'],
            opts: { rev: 'g.txt' },
          },
        ] satisfies ReadonlyArray<{
          label: string;
          slug: string;
          base: BaseName;
          setup: ReadonlyArray<Step>;
          gitArgs: ReadonlyArray<string>;
          opts: CheckoutOptions;
        }>)('When both tools check out $label', (row) => {
          it('Then both restore the same files and leave the same index and HEAD', async () => {
            // Arrange
            const { peer, ours, ctx } = await casePair(row.slug, baseOf(row.base), ignoreCase);
            for (const step of row.setup) {
              await step(peer);
              await step(ours);
            }
            const sut = checkout;

            // Act
            const peerRun = tryRunGitWithExit(['-C', peer, 'checkout', ...row.gitArgs], {
              env: IDENTITY_ENV,
            });
            await sut(ctx, row.opts);

            // Assert
            expect(peerRun.exitCode).toBe(0);
            expect(await workFilesOf(ours)).toEqual(await workFilesOf(peer));
            expect(lsStage(ours)).toBe(lsStage(peer));
            expect(await headBytes(ours)).toBe(await headBytes(peer));
          });
        });
      });
    });
  },
);

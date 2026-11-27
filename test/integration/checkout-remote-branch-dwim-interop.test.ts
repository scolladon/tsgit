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
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
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

describe.skipIf(!GIT_AVAILABLE)(
  'integration — checkout branch creation parity with canonical git',
  () => {
    let scratch = '';
    let baseOne = '';
    let baseTwo = '';
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
      const otherUp = path.join(scratch, 'otherUp');
      cloneOf(up, otherUp);
      git(otherUp, 'branch', 'only-other', 'origin/feat');
      baseOne = path.join(scratch, 'baseOne');
      cloneOf(up, baseOne);
      baseTwo = path.join(scratch, 'baseTwo');
      await cp(baseOne, baseTwo, { recursive: true });
      git(baseTwo, 'remote', 'add', 'other', otherUp);
      runGit(['-C', baseTwo, 'fetch', '-q', 'other'], { env: IDENTITY_ENV });
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

    describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignoreCase) => {
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
    });
  },
);

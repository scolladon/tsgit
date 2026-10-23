/**
 * Cross-tool interop — a pathspec made only of literals still honours its
 * exclusions: `add` stages exactly what git stages for `<literal> :!<literal>`,
 * writes the same loose objects and refuses the same unmatched pathspecs, and
 * `rm --cached` and `checkout --` select the same paths.
 *
 * @proves
 *   surface:        add, rm, checkout
 *   bucket:         cross-tool-interop
 *   unique:         literal pathspecs honour exclusions as git's :! does
 *   interopSurface: add, rm, checkout
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { rm } from '../../src/application/commands/rm.js';
import { pathspecNoMatch } from '../../src/domain/commands/error.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

type Files = Readonly<Record<string, string>>;

const UNTRACKED: Files = { x: 'x\n', y: 'y\n', 'd/x': 'dx\n', 'a.txt': 'a\n' };

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

const writeFiles = async (repo: string, files: Files): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const commitAll = (repo: string): void => {
  runGit(['-C', repo, 'add', '-A']);
  runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });
};

const looseCountOf = async (repo: string): Promise<number> => {
  const prefixes = (await readdir(path.join(repo, '.git', 'objects'))).filter((name) =>
    /^[0-9a-f]{2}$/.test(name),
  );
  const counts = await Promise.all(
    prefixes.map(
      async (prefix) => (await readdir(path.join(repo, '.git', 'objects', prefix))).length,
    ),
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

/** git spells a negation `:!p`; tsgit spells it `!p`. */
const gitSpelling = (arg: string): string => (arg.startsWith('!') ? `:${arg}` : arg);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given literal pathspecs holding an exclusion',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-literal-excl-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twin = async (side: string, tracked: boolean): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFiles(repo, UNTRACKED);
      if (tracked) {
        commitAll(repo);
        await writeFiles(
          repo,
          Object.fromEntries(Object.keys(UNTRACKED).map((name) => [name, `${name} rewritten\n`])),
        );
      }
      return repo;
    };

    interface AddRow {
      readonly tracked: boolean;
      readonly args: ReadonlyArray<string>;
      readonly refused?: string;
    }

    const accepted = (tracked: boolean, ...args: string[]): AddRow => ({ tracked, args });
    const refusedAs = (refused: string, ...args: string[]): AddRow => ({
      tracked: false,
      args,
      refused,
    });

    const addRows: ReadonlyArray<AddRow> = [
      accepted(false, 'x', '!x'),
      accepted(false, 'd/x', '!d'),
      accepted(false, 'a.txt', '!*.txt'),
      accepted(false, 'x', '!y'),
      accepted(false, 'x', 'y', '!x'),
      accepted(false, 'x', '*.txt', '!x'),
      accepted(false, 'd', '!d/x'),
      accepted(true, 'x', '!x'),
      accepted(true, 'd/x', '!d'),
      accepted(true, 'a.txt', '!*.txt'),
      accepted(true, 'x', '!y'),
      accepted(true, 'x', 'y', '!x'),
      accepted(true, 'x', '*.txt', '!x'),
      refusedAs('missing', 'missing', '!missing'),
      refusedAs('x*', 'x*', '!x'),
      refusedAs('q*', 'q*', '!q*'),
      refusedAs('nomatch*', 'x', '!x', 'nomatch*'),
    ];

    describe.each(addRows)('When git and tsgit add $args (tracked: $tracked)', (spec) => {
      it('Then both agree on the verdict, the index and the loose objects', async () => {
        // Arrange
        const gitRepo = await twin('git', spec.tracked);
        const tsgitRepo = await twin('tsgit', spec.tracked);
        const sut = add;

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec.args.map(gitSpelling)]);
        const refusal = await refusalOf(() =>
          sut(createNodeContext({ workDir: tsgitRepo }), [...spec.args]),
        );

        // Assert
        if (spec.refused === undefined) {
          expect(git.exitCode).toBe(0);
          expect(refusal).toBeUndefined();
        } else {
          expect(git.exitCode).toBe(128);
          expect(refusal).toEqual(pathspecNoMatch(spec.refused).data);
          expect(git.stderr.trim()).toBe(
            `fatal: pathspec '${spec.refused}' did not match any files`,
          );
        }
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
      });
    });

    const exclusionArgs: ReadonlyArray<ReadonlyArray<string>> = [
      ['x', '!x'],
      ['x', 'y', '!x'],
      ['d/x', '!d'],
      ['a.txt', '!*.txt'],
      ['x', '!y'],
    ];

    describe.each(exclusionArgs)('When git and tsgit rm --cached %j', (...args) => {
      it('Then both leave the same index', async () => {
        // Arrange
        const gitRepo = await twin('git', true);
        const tsgitRepo = await twin('tsgit', true);
        const sut = rm;

        // Act
        const git = tryRunGitWithExit([
          '-C',
          gitRepo,
          'rm',
          '--cached',
          '-q',
          '--',
          ...args.map(gitSpelling),
        ]);
        await sut(createNodeContext({ workDir: tsgitRepo }), [...args], { cached: true });

        // Assert
        expect(git.exitCode).toBe(0);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each(exclusionArgs)('When git and tsgit checkout -- %j', (...args) => {
      it('Then both restore the same files', async () => {
        // Arrange
        const gitRepo = await twin('git', true);
        const tsgitRepo = await twin('tsgit', true);
        const sut = checkout;

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', ...args.map(gitSpelling)]);
        await sut(createNodeContext({ workDir: tsgitRepo }), { paths: [...args] });

        // Assert
        expect(git.exitCode).toBe(0);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });
  },
);

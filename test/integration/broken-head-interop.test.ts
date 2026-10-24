/**
 * Cross-tool interop — a HEAD whose target git cannot read (a branch whose loose path the
 * file system refuses as too long, a name git refuses, a symbolic cycle). git reads such a
 * ref as unresolvable, so `log` and `rev-parse` refuse and `status` reports an unknown
 * branch with every index entry a staged add; tsgit answers with the same structured data.
 *
 * @proves
 *   surface:        status, log, revParse
 *   bucket:         cross-tool-interop
 *   unique:         a HEAD whose branch cannot be read refuses log and rev-parse and leaves status with an unknown branch as git does
 *   interopSurface: status, log, revParse
 */

import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { log } from '../../src/application/commands/log.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { type ChangedPath, status } from '../../src/application/commands/status.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const REFUSED_EXIT = 128;
const PINNED_DATE = '@1700000000 +0000';
const LONG_NAME_LENGTH = 5000;
const OVER_NAME_MAX_LENGTH = 300;
const ABSENT_MODE = '000000';
const ABSENT_ID = '0'.repeat(40);
const NO_CHANGE = '.';
const NOT_A_SUBMODULE = 'N...';
const INITIAL_OID = '# branch.oid (initial)';
const UNKNOWN_HEAD = '# branch.head (unknown)';

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
      ...args,
    ],
    { env: pinnedEnv() },
  );

const buildFixture = async (root: string): Promise<string> => {
  const fixture = path.join(root, 'fixture');
  runGit(['init', '-q', '-b', 'main', fixture]);
  await writeFile(path.join(fixture, 'k'), 'k\n');
  gitIn(fixture, 'add', 'k');
  gitIn(fixture, 'commit', '-q', '-m', 'c');
  await writeFile(path.join(fixture, 'u'), 'u\n');
  gitIn(fixture, 'add', 'u');
  return fixture;
};

type Setup = (repo: string) => Promise<void>;

const headNaming =
  (target: string): Setup =>
  async (repo) =>
    writeFile(path.join(repo, '.git', 'HEAD'), `ref: ${target}\n`);

const tooLong = headNaming(`refs/heads/${'1'.repeat(LONG_NAME_LENGTH)}`);

const twin = async (
  fixture: string,
  root: string,
  name: string,
  setup: Setup = tooLong,
): Promise<string> => {
  const dir = path.join(root, name);
  await cp(fixture, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  await setup(dir);
  return dir;
};

const modeOf = (side: { readonly mode: string } | undefined): string => side?.mode ?? ABSENT_MODE;

const columnOf = (kind: ChangedPath['staged']): string => {
  if (kind === undefined) return NO_CHANGE;
  return kind === 'added' ? 'A' : 'M';
};

/** git's `1 XY <sub> mH mI mW hH hI path` line, rebuilt from the structured change. */
const fieldsOf = (change: ChangedPath): string =>
  [
    `${columnOf(change.staged)}${columnOf(change.unstaged)}`,
    NOT_A_SUBMODULE,
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
  runGit(['-C', repo, 'status', '--porcelain=v2', '--branch', '-uall'], { env: pinnedEnv() })
    .split('\n')
    .filter(Boolean);

const gitChanges = (lines: string[]): string[] =>
  lines.filter((line) => line.startsWith('1 ')).map(gitFieldsOf);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'integration — a HEAD whose branch path is too long, compared with canonical git',
  () => {
    let root = '';
    let fixtureDir = '';
    let gitTwin = '';
    let tsgitTwin = '';

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-broken-head-'));
      fixtureDir = await buildFixture(root);
      gitTwin = await twin(fixtureDir, root, 'git-twin');
      tsgitTwin = await twin(fixtureDir, root, 'tsgit-twin');
    }, ROW_TIMEOUT);

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const refusal = async (attempt: (ctx: Context) => Promise<unknown>) => {
      const ctx = await createNodeContext({ workDir: tsgitTwin });
      return attempt(ctx).then(
        () => undefined,
        (err: TsgitError) => err.data,
      );
    };

    describe('Given a HEAD naming a branch whose loose path is too long', () => {
      describe('When rev-parse resolves HEAD', () => {
        it(
          'Then git and tsgit both refuse',
          async () => {
            // Arrange
            const sut = revParse;

            // Act
            const expected = tryRunGitWithExit(['-C', gitTwin, 'rev-parse', 'HEAD'], {
              env: pinnedEnv(),
            });
            const result = await refusal((ctx) => sut(ctx, 'HEAD'));

            // Assert
            expect(expected.exitCode).toBe(REFUSED_EXIT);
            expect(expected.stderr.split('\n')[0]).toBe(
              "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
            );
            expect(result).toEqual({
              code: 'OBJECT_NOT_FOUND',
              id: 'HEAD',
              printed: [{ kind: 'path', path: 'HEAD' }],
            });
          },
          ROW_TIMEOUT,
        );
      });

      describe('When log walks from HEAD', () => {
        it(
          'Then git and tsgit both refuse',
          async () => {
            // Arrange
            const sut = log;

            // Act
            const expected = tryRunGitWithExit(['-C', gitTwin, 'log', '-1'], { env: pinnedEnv() });
            const result = await refusal((ctx) => sut(ctx));

            // Assert
            expect(expected.exitCode).toBe(REFUSED_EXIT);
            expect(expected.stderr.split('\n')[0]).toBe(
              'fatal: your current branch appears to be broken',
            );
            expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: 'HEAD' });
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each([
      ['a branch too long for the file system', tooLong, undefined, UNKNOWN_HEAD],
      [
        'a branch name over NAME_MAX',
        headNaming(`refs/heads/${'a'.repeat(OVER_NAME_MAX_LENGTH)}`),
        undefined,
        UNKNOWN_HEAD,
      ],
      ['an unborn branch', headNaming('refs/heads/none'), 'refs/heads/none', '# branch.head none'],
      ['a name git refuses', headNaming('refs/heads/a..b'), undefined, UNKNOWN_HEAD],
      [
        'a symbolic cycle',
        async (repo: string) => {
          await headNaming('refs/heads/c1')(repo);
          await writeFile(path.join(repo, '.git', 'refs', 'heads', 'c1'), 'ref: refs/heads/c2\n');
          await writeFile(path.join(repo, '.git', 'refs', 'heads', 'c2'), 'ref: refs/heads/c1\n');
        },
        undefined,
        UNKNOWN_HEAD,
      ],
    ] as const)('Given a HEAD naming %s', (title, setup, branch, gitHead) => {
      describe('When status runs in both tools', () => {
        it(
          'Then every index entry is a staged add and the branch matches git',
          async () => {
            // Arrange
            const gitRepo = await twin(fixtureDir, root, `git-status-${title}`, setup);
            const tsgitRepo = await twin(fixtureDir, root, `tsgit-status-${title}`, setup);
            const lines = porcelain(gitRepo);
            const sut = status;

            // Act
            const result = await sut(await createNodeContext({ workDir: tsgitRepo }));

            // Assert
            expect(lines).toContain(INITIAL_OID);
            expect(lines).toContain(gitHead);
            expect(result.branch).toBe(branch);
            expect(result.detached).toBe(false);
            expect(result.changes.map(fieldsOf)).toEqual(gitChanges(lines));
            expect(result.changes.every((change) => change.head === undefined)).toBe(true);
            expect(result.untracked).toEqual([]);
            expect(result.clean).toBe(false);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a HEAD naming a branch whose loose path is too long', () => {
      describe('When symbolic-ref reads HEAD and status runs', () => {
        it(
          'Then git refuses to name HEAD and tsgit reports an unknown branch',
          async () => {
            // Arrange
            const sut = status;

            // Act
            const expected = tryRunGitWithExit(['-C', gitTwin, 'symbolic-ref', 'HEAD'], {
              env: pinnedEnv(),
            });
            const result = await sut(await createNodeContext({ workDir: tsgitTwin }));

            // Assert
            expect(expected.exitCode).toBe(REFUSED_EXIT);
            expect(expected.stderr).toBe('fatal: No such ref: HEAD\n');
            expect(result.branch).toBeUndefined();
            expect(result.detached).toBe(false);
          },
          ROW_TIMEOUT,
        );
      });
    });
  },
);

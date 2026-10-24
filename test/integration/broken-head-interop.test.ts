/**
 * Cross-tool interop — a HEAD naming a branch whose loose path the file system
 * refuses as too long. git reads such a ref as unresolvable, so `log` and
 * `rev-parse` refuse; tsgit refuses with the structured data of an unborn HEAD.
 *
 * @proves
 *   surface:        log, revParse
 *   bucket:         cross-tool-interop
 *   unique:         a HEAD whose branch cannot be read refuses log and rev-parse as git does
 *   interopSurface: log, revParse
 */

import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { log } from '../../src/application/commands/log.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const REFUSED_EXIT = 128;
const PINNED_DATE = '@1700000000 +0000';
const LONG_NAME_LENGTH = 5000;

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

const twin = async (fixture: string, root: string, name: string): Promise<string> => {
  const dir = path.join(root, name);
  await cp(fixture, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  await writeFile(
    path.join(dir, '.git', 'HEAD'),
    `ref: refs/heads/${'1'.repeat(LONG_NAME_LENGTH)}\n`,
  );
  return dir;
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'integration — a HEAD whose branch path is too long, compared with canonical git',
  () => {
    let root = '';
    let gitTwin = '';
    let tsgitTwin = '';

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-broken-head-'));
      const fixture = await buildFixture(root);
      gitTwin = await twin(fixture, root, 'git-twin');
      tsgitTwin = await twin(fixture, root, 'tsgit-twin');
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
  },
);

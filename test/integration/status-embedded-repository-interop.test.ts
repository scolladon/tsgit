/**
 * Cross-tool interop — `status` lists an untracked repository as its directory, as git does.
 * Compared with `git status --porcelain -uall -z`, the `??` entries.
 *
 * @proves
 *   surface:        status
 *   bucket:         cross-tool-interop
 *   unique:         status lists an untracked repository as its directory as git does
 *   interopSurface: status
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { status } from '../../src/application/commands/status.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const PINNED_DATE = '@1700000000 +0000';
const UNTRACKED_MARK = '?? ';

type Setup = (repo: string) => Promise<void>;

const createdDirs: string[] = [];

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

const repositoryWithFile: Setup = async (repo) => {
  runGit(['init', '-q', '-b', 'main', path.join(repo, 'sub')]);
  commitIn(path.join(repo, 'sub'));
  await writeFiles(repo, { 'sub/u': 'u\n' });
};

const linkedGitDir: Setup = async (repo) => {
  const outside = `${repo}-outside`;
  runGit(['init', '-q', '-b', 'main', outside]);
  commitIn(outside);
  await writeFiles(repo, { 'sub/u': 'u\n' });
  await symlink(path.join(outside, '.git'), path.join(repo, 'sub', '.git'));
};

const garbageHead: Setup = async (repo) => {
  await repositoryWithFile(repo);
  await writeFile(path.join(repo, 'sub', '.git', 'HEAD'), 'garbage\n');
};

const trackedBeneath: Setup = async (repo) => {
  await writeFiles(repo, { 'sub/u': 'u\n' });
  runGit(['-C', repo, 'add', 'sub/u']);
  runGit(['init', '-q', '-b', 'main', path.join(repo, 'sub')]);
  commitIn(path.join(repo, 'sub'));
};

const trackedBeneathWithNewFile: Setup = async (repo) => {
  await trackedBeneath(repo);
  await writeFiles(repo, { 'sub/new': 'n\n' });
};

const ignoredRepository: Setup = async (repo) => {
  await repositoryWithFile(repo);
  await writeFiles(repo, { '.gitignore': 'sub/\n' });
};

const trackedFileTurnedRepository: Setup = async (repo) => {
  await writeFiles(repo, { sub: 'file\n' });
  runGit(['-C', repo, 'add', 'sub']);
  await rm(path.join(repo, 'sub'));
  runGit(['init', '-q', '-b', 'main', path.join(repo, 'sub')]);
  commitIn(path.join(repo, 'sub'));
  await writeFiles(repo, { 'sub/u': 'u\n' });
};

const ROWS: ReadonlyArray<readonly [string, Setup]> = [
  ['a repository holding a committed file', repositoryWithFile],
  ['a .git that is a symlink to an outside repository', linkedGitDir],
  ['a repository whose HEAD holds garbage', garbageHead],
  ['a repository made inside a tracked directory', trackedBeneath],
  ['an untracked file beside a repository inside a tracked directory', trackedBeneathWithNewFile],
  ['a repository under an ignore rule', ignoredRepository],
  ['a tracked file turned into a repository', trackedFileTurnedRepository],
];

const gitUntracked = (repo: string): ReadonlyArray<string> =>
  runGit(['-C', repo, 'status', '--porcelain', '-uall', '-z'])
    .split('\0')
    .filter((line) => line.startsWith(UNTRACKED_MARK))
    .map((line) => line.slice(UNTRACKED_MARK.length));

afterAll(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'status lists an untracked repository as its directory as git does',
  () => {
    describe.each(ROWS)('Given %s', (_label, setup) => {
      describe('When the status is taken', () => {
        it(
          'Then the untracked paths equal git porcelain',
          async () => {
            // Arrange
            const repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-status-embedded-'));
            createdDirs.push(repo, `${repo}-outside`);
            runGit(['init', '-q', '-b', 'main', repo]);
            await setup(repo);
            const sut = status;

            // Act
            const result = await sut(createNodeContext({ workDir: repo }));

            // Assert
            expect([...result.untracked]).toEqual(gitUntracked(repo));
          },
          SETUP_TIMEOUT,
        );
      });
    });
  },
);

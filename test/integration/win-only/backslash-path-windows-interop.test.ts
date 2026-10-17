/**
 * Real-Windows interop — backslash index paths. git for Windows reads `\` as a
 * directory separator and its `verify_path` refuses every one (with
 * `core.protectNTFS`, the default); tsgit applies that rule under Windows path
 * syntax, which the node runtime sets on Windows. Lives in
 * `test/integration/win-only/`, scheduled only on the Windows runner: no
 * `skipIf`, so a missing git fails instead of skipping.
 *
 * @proves
 *   surface:        repo.reset
 *   bucket:         cross-tool-interop
 *   unique:         a backslash index path is refused on Windows as git for Windows refuses it, and an index already holding one still reads
 *   interopSurface: reset, checkout, update-index, ls-files
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';
import type { Repository } from '../../../src/repository.js';
import {
  disableAutoMaintenance,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from '../interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ROW_TIMEOUT = 60_000;
const SYMLINK_MODE = '120000';
const REGULAR_MODE = '100644';
const GIT_REFUSED_EXIT = 128;
const INVALID_INDEX_ENTRY = 'INVALID_INDEX_ENTRY';
const BACKSLASH_REASON = 'backslash rejected under Windows path syntax';
const SEED_FILE = 'seed.txt';
const STAGED_PATH = 'x\\y';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

const REFUSED_ROWS = [
  { path: '\\.git\\hooks\\post-checkout', mode: REGULAR_MODE },
  { path: '\\.git\\config', mode: REGULAR_MODE },
  { path: 'x\\y', mode: REGULAR_MODE },
  { path: '\\gitmod~1', mode: SYMLINK_MODE },
] as const;
const ADMITTED_ROWS = [{ path: 'a/b', mode: REGULAR_MODE }] as const;

const gitIn = (dir: string, args: ReadonlyArray<string>, input?: string) =>
  tryRunGitWithExit(['-C', dir, ...args], {
    env: COMMIT_ENV,
    ...(input === undefined ? {} : { input }),
  });

const gitOut = (dir: string, args: ReadonlyArray<string>, input?: string): string => {
  const result = gitIn(dir, args, input);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// Plain `ls-files` C-quotes backslashes.
const listIndex = (dir: string): ReadonlyArray<string> =>
  gitOut(dir, ['ls-files', '-z'])
    .split('\0')
    .filter((entry) => entry !== '');

const errorCodeOf = (err: unknown): string | undefined =>
  (err as { data?: { code?: string } } | undefined)?.data?.code;
const errorReasonOf = (err: unknown): string | undefined =>
  (err as { data?: { reason?: string } } | undefined)?.data?.reason;

const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (err) {
    return err;
  }
  return undefined;
};

/** Builds the nested trees for `target` bottom-up and commits the root tree. */
const buildLeafCommit = (dir: string, target: string, mode: string): string => {
  const blob = gitOut(dir, ['hash-object', '-w', '--stdin'], 'target');
  const components = target.split('/');
  const leaf = components.pop() as string;
  let tree = gitOut(dir, ['mktree'], `${mode} blob ${blob}\t${leaf}\n`);
  for (const name of components.reverse()) {
    tree = gitOut(dir, ['mktree'], `040000 tree ${tree}\t${name}\n`);
  }
  return gitOut(dir, ['commit-tree', tree, '-m', 'leaf']);
};

const initPeerDir = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  disableAutoMaintenance(dir);
};

interface RepoPair {
  readonly peerDir: string;
  readonly oursDir: string;
  readonly repo: Repository;
}

const seedCommit = async (dir: string, repo?: Repository): Promise<void> => {
  writeFileSync(path.join(dir, SEED_FILE), 'seed\n');
  if (repo === undefined) {
    gitOut(dir, ['add', SEED_FILE]);
    gitOut(dir, ['commit', '-q', '-m', 'seed']);
    return;
  }
  await repo.add([SEED_FILE]);
  await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });
};

const buildSeededPair = async (root: string, slug: string): Promise<RepoPair> => {
  const peerDir = path.join(root, `${slug}-peer`);
  const oursDir = path.join(root, `${slug}-ours`);
  initPeerDir(peerDir);
  await seedCommit(peerDir);
  mkdirSync(oursDir, { recursive: true });
  const repo = await openRepository({ cwd: oursDir });
  await repo.init();
  disableAutoMaintenance(oursDir);
  await seedCommit(oursDir, repo);
  return { peerDir, oursDir, repo };
};

describe('backslash path windows interop', () => {
  let root: string;
  let shared: RepoPair;
  let peerSeed: string;
  let oursSeed: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-backslash-')));
    shared = await buildSeededPair(root, 'shared');
    peerSeed = gitOut(shared.peerDir, ['rev-parse', 'HEAD']);
    oursSeed = gitOut(shared.oursDir, ['rev-parse', 'HEAD']);
  }, SETUP_TIMEOUT);

  // Rows share one repo pair: rewind it even when a row fails, so one defect
  // cannot cascade into every later row.
  const rewindShared = async (): Promise<void> => {
    gitOut(shared.peerDir, ['reset', '-q', peerSeed]);
    await shared.repo.reset({ mode: 'mixed', rev: oursSeed });
  };

  afterAll(async () => {
    await shared.repo.dispose();
    await rm(root, { recursive: true, force: true });
  });

  describe('Given a tree holding a backslash path', () => {
    describe('When the tree is loaded into the index with reset', () => {
      afterEach(rewindShared);

      it.each([
        ...REFUSED_ROWS.map((row) => ({ ...row, gitRefuses: true })),
        ...ADMITTED_ROWS.map((row) => ({ ...row, gitRefuses: false })),
      ])(
        'Then $path is refused by tsgit iff refused by git ($gitRefuses)',
        async ({ path: target, mode, gitRefuses }) => {
          // Arrange
          const { peerDir, oursDir, repo } = shared;
          const peerCommit = buildLeafCommit(peerDir, target, mode);
          const oursCommit = buildLeafCommit(oursDir, target, mode);

          // Act
          const gitResult = gitIn(peerDir, ['reset', '-q', peerCommit]);
          const oursError = await captureError(() =>
            repo.reset({ mode: 'mixed', rev: oursCommit }),
          );

          // Assert
          expect(gitResult.exitCode).toBe(gitRefuses ? GIT_REFUSED_EXIT : 0);
          expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
          expect(errorReasonOf(oursError)).toBe(gitRefuses ? BACKSLASH_REASON : undefined);
          expect(listIndex(oursDir)).toStrictEqual(listIndex(peerDir));
          expect(listIndex(peerDir)).toStrictEqual(gitRefuses ? [SEED_FILE] : [target]);
          for (const dir of [peerDir, oursDir]) {
            expect(existsSync(path.join(dir, '.git', 'hooks', 'post-checkout'))).toBe(false);
          }
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a commit holding a backslash path', () => {
    describe('When the commit is checked out', () => {
      afterEach(rewindShared);

      it.each([
        ...REFUSED_ROWS.map((row) => ({ ...row, gitRefuses: true })),
        ...ADMITTED_ROWS.map((row) => ({ ...row, gitRefuses: false })),
      ])(
        'Then $path is refused by tsgit iff refused by git ($gitRefuses)',
        async ({ path: target, mode, gitRefuses }) => {
          // Arrange
          const { peerDir, oursDir, repo } = shared;
          const peerCommit = buildLeafCommit(peerDir, target, mode);
          const oursCommit = buildLeafCommit(oursDir, target, mode);

          // Act
          const gitResult = gitIn(peerDir, ['checkout', '-q', peerCommit]);
          const oursError = await captureError(() => repo.checkout({ rev: oursCommit }));

          // Assert
          expect(gitResult.exitCode).toBe(gitRefuses ? 1 : 0);
          expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
          expect(errorReasonOf(oursError)).toBe(gitRefuses ? BACKSLASH_REASON : undefined);
          expect(gitOut(peerDir, ['rev-parse', 'HEAD'])).toBe(gitRefuses ? peerSeed : peerCommit);
          expect(gitOut(oursDir, ['rev-parse', 'HEAD'])).toBe(gitRefuses ? oursSeed : oursCommit);
          expect(listIndex(oursDir)).toStrictEqual(listIndex(peerDir));
          for (const dir of [peerDir, oursDir]) {
            expect(existsSync(path.join(dir, '.git', 'hooks', 'post-checkout'))).toBe(false);
          }
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given an index git wrote with x\\y staged', () => {
    describe('When tsgit reads it', () => {
      it(
        'Then x\\y is listed by git and read back by tsgit',
        async () => {
          // Arrange
          const { oursDir, repo } = await buildSeededPair(root, 'parsed');
          const blob = gitOut(oursDir, ['hash-object', '-w', '--stdin'], 'target');
          gitOut(
            oursDir,
            ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--index-info'],
            `${REGULAR_MODE} ${blob}\t${STAGED_PATH}\n`,
          );

          // Act
          const listing = listIndex(oursDir);
          const index = await repo.primitives.readIndex();

          // Assert
          expect(listing).toContain(STAGED_PATH);
          expect(index.entries.map((entry) => entry.path)).toContain(STAGED_PATH);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

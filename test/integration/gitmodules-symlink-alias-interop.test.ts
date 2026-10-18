/**
 * Cross-tool interop — the `.gitmodules` symlink check. Pins, against real
 * git, which symlink paths are refused when a tree is loaded into the index
 * (`reset`, `checkout`), when an on-disk symlink is staged (`add`), and when a
 * parsed index is read. git re-tests the rest of the whole path at each
 * component start and after each mid-component backslash, so an alias behind a
 * backslash is refused, while an alias followed by `/` is a plain directory.
 * Fixtures are built with real git plumbing so both tools read the same
 * objects; assertions compare verdicts and index listings, never messages.
 *
 * @proves
 *   surface:        repo.reset
 *   bucket:         cross-tool-interop
 *   unique:         .gitmodules symlink and .git aliases behind a backslash are refused like git
 *   interopSurface: reset, checkout, add, update-index, ls-files
 */
import { mkdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ROW_TIMEOUT = 60_000;
const ZWNJ = String.fromCodePoint(0x200c);
const SYMLINK_MODE = '120000';
const REGULAR_MODE = '100644';
const GIT_REFUSED_EXIT = 128;
const GIT_CHECKOUT_REFUSED_EXIT = 1;
const INVALID_INDEX_ENTRY = 'INVALID_INDEX_ENTRY';
const SEED_FILE = 'seed.txt';
const GITMODULES_SYMLINK_REASON = "'.gitmodules' must not be a symlink";

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

interface Row {
  readonly path: string;
  readonly gitRefuses: boolean;
}

const refused = (paths: ReadonlyArray<string>): ReadonlyArray<Row> =>
  paths.map((p) => ({ path: p, gitRefuses: true }));
const admitted = (paths: ReadonlyArray<string>): ReadonlyArray<Row> =>
  paths.map((p) => ({ path: p, gitRefuses: false }));

const ROWS: ReadonlyArray<Row> = [
  ...refused([
    '.gitmodules',
    '.GITMODULES',
    'gitmod~1',
    'gitmod~1 ',
    'GI7EBA~1',
    'x\\/gitmod~1',
    'x/gitmod~1',
    '.gitmodules/y',
    '.GITMODULES/y',
    '.gitmodules:s/y',
    'gitmod~1:s/y',
    `.gitmod${ZWNJ}ules/y`,
    'x\\.gitmodules',
    'x\\.GITMODULES',
    'x\\gitmod~1',
    'x\\GITMOD~1',
    'x\\gitmod~4',
    'x\\gi7eba~1',
    'x\\.gitmodules.',
    'x\\.gitmodules ',
    'x\\.gitmodules. .',
    'x\\gitmod~1.',
    'x\\gitmod~1 ',
    'x\\gitmod~1 . ',
    'x\\.gitmodules:s',
    'x\\gitmod~1:s',
    'x\\.gitmodules:s\\y',
    'a\\b\\.gitmodules',
    'y/x\\gitmod~1',
    'x\\\\gitmod~1',
    '\\\\gitmod~1',
    'x:\\gitmod~1',
    'x\\g~123456',
    'gi7eb~12',
    'g~123456',
    '~1234567',
  ]),
  ...admitted([
    '.gitmodules\\y',
    'x\\.gitmodules\\y',
    'x\\gitmod~1\\y',
    'x\\.gitmodules/y',
    'x\\gitmod~1/y',
    'x\\gitmod~5',
    `x\\.gitmod${ZWNJ}ules`,
    'gi7eba~10',
    'gi7eb~1',
    'x\\',
    'xy.gitmodules',
    '\\gitmod~1',
    'x/\\gitmod~1',
    '\\.gitmodules',
    'gitmod~1/y',
    'gi7eba~1/y',
    '.gitmodules./y',
    'gitmod~1./y',
    'xy/gitmod~1/z',
  ]),
];

// git refuses the exact dotfile name unconditionally, even with path protection off,
// so those rows never reach a git-written index.
const PROTECTION_INDEPENDENT_ROWS = ROWS.filter(
  (row) => !row.path.split('/').some((component) => component.toLowerCase() === '.gitmodules'),
);

const DOTGIT_BACKSLASH_ROWS: ReadonlyArray<Row> = [
  ...admitted(['\\.git', '\\git~1', 'x/\\.git', '\\.git\\y', 'x/\\.git/y', '\\.git:s']),
  ...refused(['\\\\.git', 'x\\.git']),
];

const BACKSLASH_FREE_ROWS = ROWS.filter((row) => !row.path.includes('\\'));

// git on Windows reads `\` as a directory separator, so the pinned verdicts are POSIX git's.
// core.protectHFS is forced on: git defaults it on only on macOS, and the ZWNJ rows need it.
const gitIn = (dir: string, args: ReadonlyArray<string>, input?: string) =>
  tryRunGitWithExit(['-c', 'core.protectHFS=true', '-C', dir, ...args], {
    env: COMMIT_ENV,
    ...(input === undefined ? {} : { input }),
  });

const gitOut = (dir: string, args: ReadonlyArray<string>, input?: string): string => {
  const result = gitIn(dir, args, input);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// Plain `ls-files` C-quotes backslashes and non-ASCII bytes.
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

const treeLinesOf = (blob: string, name: string, mode: string): string =>
  `${mode} blob ${blob}\t${name}`;

/** Builds the nested trees for `target` bottom-up and commits the root tree. */
const buildLeafCommit = (dir: string, target: string, mode: string): string => {
  const blob = gitOut(dir, ['hash-object', '-w', '--stdin'], 'target');
  const components = target.split('/');
  const leaf = components.pop() as string;
  let tree = gitOut(dir, ['mktree'], `${treeLinesOf(blob, leaf, mode)}\n`);
  for (const name of components.reverse()) {
    tree = gitOut(dir, ['mktree'], `040000 tree ${tree}\t${name}\n`);
  }
  return gitOut(dir, ['commit-tree', tree, '-m', 'symlink']);
};

const buildSymlinkCommit = (dir: string, target: string): string =>
  buildLeafCommit(dir, target, SYMLINK_MODE);

const initPeerDir = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  runGit(['-C', dir, 'config', 'core.symlinks', 'true']);
  disableAutoMaintenance(dir);
};

interface RepoPair {
  readonly peerDir: string;
  readonly oursDir: string;
  readonly repo: Repository;
}

const seedCommit = async (dir: string, repo?: Repository): Promise<void> => {
  const { writeFileSync } = await import('node:fs');
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

const slugOf = (index: number): string => `row${String(index)}`;

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'gitmodules symlink alias interop',
  () => {
    let root: string;
    let shared: RepoPair;
    let peerSeed: string;
    let oursSeed: string;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-symlink-alias-')));
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
      await rm(root, { recursive: true, force: true });
    });

    describe('Given a tree holding a symlink at the row path', () => {
      describe('When the tree is loaded into the index with reset', () => {
        afterEach(rewindShared);

        it.each(ROWS.map((row, index) => ({ ...row, index })))(
          'Then $path is refused by tsgit iff refused by git ($gitRefuses)',
          async ({ path: target, gitRefuses }) => {
            // Arrange
            const { peerDir, oursDir, repo } = shared;
            const peerCommit = buildSymlinkCommit(peerDir, target);
            const oursCommit = buildSymlinkCommit(oursDir, target);

            // Act
            const gitResult = gitIn(peerDir, ['reset', '-q', peerCommit]);
            const oursError = await captureError(() =>
              repo.reset({ mode: 'mixed', rev: oursCommit }),
            );

            // Assert
            expect(gitResult.exitCode).toBe(gitRefuses ? GIT_REFUSED_EXIT : 0);
            expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
            expect(listIndex(oursDir)).toStrictEqual(listIndex(peerDir));
            expect(listIndex(peerDir)).toStrictEqual(gitRefuses ? [SEED_FILE] : [target]);
          },
          ROW_TIMEOUT,
        );
      });

      describe('When the commit is checked out', () => {
        it.each(ROWS.map((row, index) => ({ ...row, index })))(
          'Then $path is refused by tsgit iff refused by git ($gitRefuses)',
          async ({ path: target, gitRefuses, index }) => {
            // Arrange
            const { peerDir, oursDir, repo } = await buildSeededPair(root, `co-${slugOf(index)}`);
            const peerHead = gitOut(peerDir, ['rev-parse', 'HEAD']);
            const oursHead = gitOut(oursDir, ['rev-parse', 'HEAD']);
            const peerCommit = buildSymlinkCommit(peerDir, target);
            const oursCommit = buildSymlinkCommit(oursDir, target);

            // Act
            const gitResult = gitIn(peerDir, ['checkout', '-q', peerCommit]);
            const oursError = await captureError(() => repo.checkout({ rev: oursCommit }));

            // Assert
            expect(gitResult.exitCode).toBe(gitRefuses ? GIT_CHECKOUT_REFUSED_EXIT : 0);
            expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
            expect(gitOut(peerDir, ['rev-parse', 'HEAD'])).toBe(gitRefuses ? peerHead : peerCommit);
            expect(gitOut(oursDir, ['rev-parse', 'HEAD'])).toBe(gitRefuses ? oursHead : oursCommit);
            expect(listIndex(oursDir)).toStrictEqual(listIndex(peerDir));
            expect(listIndex(peerDir)).toStrictEqual(gitRefuses ? [SEED_FILE] : [target]);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a symlink on disk at a backslash-free row path', () => {
      describe('When it is staged with add', () => {
        it.each(BACKSLASH_FREE_ROWS.map((row, index) => ({ ...row, index })))(
          'Then $path is refused by tsgit iff refused by git ($gitRefuses)',
          async ({ path: target, gitRefuses, index }) => {
            // Arrange
            const { peerDir, oursDir, repo } = await buildSeededPair(root, `add-${slugOf(index)}`);
            for (const dir of [peerDir, oursDir]) {
              mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
              symlinkSync('target', path.join(dir, target));
            }

            // Act
            const gitResult = gitIn(peerDir, ['add', '--', target]);
            const oursError = await captureError(() => repo.add([target]));

            // Assert
            const staged = gitRefuses ? [SEED_FILE] : [SEED_FILE, target];
            expect(gitResult.exitCode === 0).toBe(!gitRefuses);
            expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
            expect([...listIndex(peerDir)].sort()).toStrictEqual([...staged].sort());
            expect([...listIndex(oursDir)].sort()).toStrictEqual([...staged].sort());
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given an index written by git without path protection', () => {
      // tsgit validates entries when it reads the index; git does not. This arm pins
      // that known divergence: git lists every row, tsgit refuses the refused ones.
      describe('When tsgit reads the index', () => {
        it.each(PROTECTION_INDEPENDENT_ROWS.map((row, index) => ({ ...row, index })))(
          'Then $path is refused iff git refuses it at write time ($gitRefuses)',
          async ({ path: target, gitRefuses, index }) => {
            // Arrange
            const { oursDir, repo } = await buildSeededPair(root, `idx-${slugOf(index)}`);
            const blob = gitOut(oursDir, ['hash-object', '-w', '--stdin'], 'target');
            const unprotected = ['-c', 'core.protectNTFS=false', '-c', 'core.protectHFS=false'];
            gitOut(
              oursDir,
              [...unprotected, 'update-index', '--add', '--index-info'],
              `${SYMLINK_MODE} ${blob}\t${target}\n`,
            );

            // Act
            const listing = listIndex(oursDir);
            const oursError = await captureError(() => repo.primitives.readIndex());

            // Assert
            expect(listing).toContain(target);
            expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
            expect(errorReasonOf(oursError)).toBe(
              gitRefuses ? GITMODULES_SYMLINK_REASON : undefined,
            );
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a regular file whose component opens with a backslash', () => {
      describe('When the tree is loaded into the index with reset', () => {
        afterEach(rewindShared);

        it.each(DOTGIT_BACKSLASH_ROWS)(
          'Then $path is refused by tsgit iff refused by git ($gitRefuses)',
          async ({ path: target, gitRefuses }) => {
            // Arrange
            const { peerDir, oursDir, repo } = shared;
            const peerCommit = buildLeafCommit(peerDir, target, REGULAR_MODE);
            const oursCommit = buildLeafCommit(oursDir, target, REGULAR_MODE);

            // Act
            const gitResult = gitIn(peerDir, ['reset', '-q', peerCommit]);
            const oursError = await captureError(() =>
              repo.reset({ mode: 'mixed', rev: oursCommit }),
            );

            // Assert
            expect(gitResult.exitCode).toBe(gitRefuses ? GIT_REFUSED_EXIT : 0);
            expect(errorCodeOf(oursError)).toBe(gitRefuses ? INVALID_INDEX_ENTRY : undefined);
            expect(listIndex(oursDir)).toStrictEqual(listIndex(peerDir));
            expect(listIndex(peerDir)).toStrictEqual(gitRefuses ? [SEED_FILE] : [target]);
          },
          ROW_TIMEOUT,
        );
      });

      describe('When tsgit reads an index git wrote with the file staged', () => {
        it.each(
          DOTGIT_BACKSLASH_ROWS.filter((row) => !row.gitRefuses).map((row, index) => ({
            ...row,
            index,
          })),
        )(
          'Then $path is read back',
          async ({ path: target, index }) => {
            // Arrange
            const { oursDir, repo } = await buildSeededPair(root, `dg-${slugOf(index)}`);
            const blob = gitOut(oursDir, ['hash-object', '-w', '--stdin'], 'target');
            gitOut(
              oursDir,
              ['update-index', '--add', '--index-info'],
              `${REGULAR_MODE} ${blob}\t${target}\n`,
            );

            // Act
            const listing = listIndex(oursDir);
            const oursError = await captureError(() => repo.primitives.readIndex());

            // Assert
            expect(listing).toContain(target);
            expect(errorCodeOf(oursError)).toBeUndefined();
          },
          ROW_TIMEOUT,
        );
      });
    });
  },
);

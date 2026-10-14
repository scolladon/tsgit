/**
 * Cross-tool interop — `status` writes refreshed stat data back to the index
 * under the optional `index.lock`, exactly where canonical git does: after a
 * copy, a touch or a racy entry; never for a content change alone; never when
 * `refresh: false` / `GIT_OPTIONAL_LOCKS` forbid it or the lock is taken.
 * "Rewritten" is the index file's inode changing.
 *
 * @proves
 *   surface:        status
 *   bucket:         cross-tool-interop
 *   unique:         status refresh write-back triggers and refusals match git's optional-lock index update
 *   interopSurface: index
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { status } from '../../src/application/commands/status.js';
import type { Context } from '../../src/ports/context.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const TRACKED = ['a', 'b', 'c'] as const;
const PAST_SECONDS = 10;
const TOUCH_SECONDS = 5;
const HALF_SECOND = 0.5;
const OPTIONAL_LOCKS = 'GIT_OPTIONAL_LOCKS';

const secondsAgo = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

const indexIno = async (dir: string): Promise<number> =>
  (await stat(path.join(dir, '.git', 'index'))).ino;

const withEnv = (ctx: Context, name: string, value: string): Context => ({
  ...ctx,
  env: { get: (n: string) => (n === name ? value : undefined) },
});

const gitWithOptionalLocks = (dir: string, value: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: { ...runGitEnv(), [OPTIONAL_LOCKS]: value } });

const buildRepo = async (dir: string, objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', `--object-format=${objectFormat}`, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  for (const name of TRACKED) await writeFile(path.join(dir, name), `${name} body\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
};

const pastAllTracked = async (dir: string): Promise<void> => {
  const past = secondsAgo(PAST_SECONDS);
  for (const name of TRACKED) await utimes(path.join(dir, name), past, past);
};

/** Index written now, tracked files 10 s older: nothing racy, nothing stale. */
const settle = async (dir: string): Promise<void> => {
  await pastAllTracked(dir);
  git(dir, 'update-index', '--refresh');
};

const touchB = async (dir: string): Promise<void> => {
  const when = secondsAgo(TOUCH_SECONDS);
  await utimes(path.join(dir, 'b'), when, when);
};

const xyLines = (changes: Awaited<ReturnType<typeof status>>): string[] => {
  const code = (kind: string | undefined): string => {
    if (kind === undefined) return '.';
    if (kind === 'added') return 'A';
    if (kind === 'deleted') return 'D';
    if (kind === 'type-changed') return 'T';
    return 'M';
  };
  const tracked = changes.changes.map((c) => `${code(c.staged)}${code(c.unstaged)} ${c.path}`);
  const untracked = changes.untracked.map((p) => `? ${p}`);
  return [...tracked, ...untracked].sort();
};

const gitPorcelainV2Lines = (dir: string): string[] =>
  git(dir, 'status', '--porcelain=v2', '--no-renames')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (l.startsWith('1 ') ? `${l.split(' ')[1]} ${l.split(' ').slice(8).join(' ')}` : l))
    .sort();

describe.skipIf(!GIT_AVAILABLE)('status refresh interop', () => {
  let pair: PeerPair;
  let ctx: Context;

  beforeEach(async () => {
    pair = await makePeerPair('status-refresh');
    await buildRepo(pair.peer);
    await buildRepo(pair.ours);
    ctx = createNodeContext({ workDir: pair.ours });
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a git-built repository copied elsewhere', () => {
    describe('When status runs on the copy', () => {
      it('Then the index is rewritten with the copy lstat data and git status then leaves it alone', async () => {
        // Arrange
        const copy = path.join(pair.ours, '..', `${path.basename(pair.ours)}-copy`);
        onTestFinished(() => rm(copy, { recursive: true, force: true }));
        await cp(pair.peer, copy, { recursive: true });
        await pastAllTracked(copy);
        const before = await indexIno(copy);
        const copyCtx = createNodeContext({ workDir: copy });
        const sut = status;

        // Act
        await sut(copyCtx);
        const afterTsgit = await indexIno(copy);
        const debug = git(copy, 'ls-files', '--debug', 'a');
        const lstat = await stat(path.join(copy, 'a'), { bigint: true });
        git(copy, 'status');
        const afterGit = await indexIno(copy);

        // Assert
        expect(afterTsgit).not.toBe(before);
        expect(debug).toContain(`ino: ${lstat.ino}`);
        expect(debug).toContain(`mtime: ${lstat.mtimeMs / 1000n}:`);
        expect(afterGit).toBe(afterTsgit);
      });
    });
  });

  describe('Given a settled repository', () => {
    beforeEach(async () => {
      await settle(pair.peer);
      await settle(pair.ours);
    });

    describe('When b is touched with the same bytes', () => {
      it('Then tsgit rewrites the index as git does', async () => {
        // Arrange
        await touchB(pair.peer);
        await touchB(pair.ours);
        const peerBefore = await indexIno(pair.peer);
        const oursBefore = await indexIno(pair.ours);

        // Act
        git(pair.peer, 'status');
        await status(ctx);

        // Assert
        expect(await indexIno(pair.peer)).not.toBe(peerBefore);
        expect(await indexIno(pair.ours)).not.toBe(oursBefore);
      });
    });

    describe('When only the content of b changes', () => {
      it('Then neither tool rewrites the index', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          await writeFile(path.join(dir, 'b'), 'a longer different body\n');
          const when = secondsAgo(PAST_SECONDS);
          await utimes(path.join(dir, 'b'), when, when);
        }
        const peerBefore = await indexIno(pair.peer);
        const oursBefore = await indexIno(pair.ours);

        // Act
        git(pair.peer, 'status');
        await status(ctx);

        // Assert
        expect(await indexIno(pair.peer)).toBe(peerBefore);
        expect(await indexIno(pair.ours)).toBe(oursBefore);
      });
    });

    describe('When an entry mtime equals the index mtime', () => {
      it('Then both tools rewrite the index', async () => {
        // Arrange — the entry stat still matches; only raciness remains.
        for (const dir of [pair.peer, pair.ours]) {
          git(dir, 'update-index', '--refresh');
          execFileSync('touch', ['-r', path.join(dir, 'a'), path.join(dir, '.git', 'index')]);
        }
        const peerBefore = await indexIno(pair.peer);
        const oursBefore = await indexIno(pair.ours);

        // Act
        git(pair.peer, 'status');
        await status(ctx);

        // Assert
        expect(await indexIno(pair.peer)).not.toBe(peerBefore);
        expect(await indexIno(pair.ours)).not.toBe(oursBefore);
      });
    });

    describe('When an entry mtime shares the index second but precedes it in nanoseconds', () => {
      it('Then both tools rewrite the index', async () => {
        // Arrange — git compares whole seconds, so the sub-second order does not clear it.
        const entrySecond = Math.floor(Date.now() / 1000) - PAST_SECONDS;
        for (const dir of [pair.peer, pair.ours]) {
          await utimes(path.join(dir, 'a'), entrySecond, entrySecond);
          git(dir, 'update-index', '--refresh');
          const indexTime = entrySecond + HALF_SECOND;
          await utimes(path.join(dir, '.git', 'index'), indexTime, indexTime);
        }
        const peerBefore = await indexIno(pair.peer);
        const oursBefore = await indexIno(pair.ours);

        // Act
        git(pair.peer, 'status');
        await status(ctx);

        // Assert
        expect(await indexIno(pair.peer)).not.toBe(peerBefore);
        expect(await indexIno(pair.ours)).not.toBe(oursBefore);
      });
    });

    describe('When refresh is false', () => {
      it('Then the index is not rewritten', async () => {
        // Arrange
        await touchB(pair.ours);
        const before = await indexIno(pair.ours);

        // Act
        await status(ctx, { refresh: false });

        // Assert
        expect(await indexIno(pair.ours)).toBe(before);
      });
    });

    describe('When GIT_OPTIONAL_LOCKS is 0', () => {
      it('Then neither tool rewrites the index', async () => {
        // Arrange
        await touchB(pair.peer);
        await touchB(pair.ours);
        const peerBefore = await indexIno(pair.peer);
        const oursBefore = await indexIno(pair.ours);

        // Act
        gitWithOptionalLocks(pair.peer, '0', 'status');
        await status(withEnv(ctx, OPTIONAL_LOCKS, '0'));

        // Assert
        expect(await indexIno(pair.peer)).toBe(peerBefore);
        expect(await indexIno(pair.ours)).toBe(oursBefore);
      });
    });

    describe('When GIT_OPTIONAL_LOCKS is 2', () => {
      it('Then both tools rewrite the index', async () => {
        // Arrange
        await touchB(pair.peer);
        await touchB(pair.ours);
        const peerBefore = await indexIno(pair.peer);
        const oursBefore = await indexIno(pair.ours);

        // Act
        gitWithOptionalLocks(pair.peer, '2', 'status');
        await status(withEnv(ctx, OPTIONAL_LOCKS, '2'));

        // Assert
        expect(await indexIno(pair.peer)).not.toBe(peerBefore);
        expect(await indexIno(pair.ours)).not.toBe(oursBefore);
      });
    });

    describe('When GIT_OPTIONAL_LOCKS is bogus', () => {
      it('Then tsgit refuses with the message git dies with', async () => {
        // Arrange
        const gitRun = tryRunGit(['-C', pair.peer, 'status'], {
          env: { ...runGitEnv(), [OPTIONAL_LOCKS]: 'bogus' },
        });
        let caught: unknown;

        // Act
        try {
          await status(withEnv(ctx, OPTIONAL_LOCKS, 'bogus'));
        } catch (error) {
          caught = error;
        }

        // Assert
        const err = caught as { code: string; message: string; data: Record<string, unknown> };
        expect(gitRun.ok).toBe(false);
        expect(err.data.code).toBe('ENV_BAD_BOOLEAN_VALUE');
        expect(err.data.variable).toBe(OPTIONAL_LOCKS);
        expect(err.data.value).toBe('bogus');
        expect(gitRun.stderr.trim()).toBe(
          `fatal: ${err.message.replace('ENV_BAD_BOOLEAN_VALUE: ', '')}`,
        );
      });
    });

    describe('When an empty index.lock is present', () => {
      it('Then the index is untouched, one warning is logged and the result equals git porcelain v2', async () => {
        // Arrange
        await touchB(pair.ours);
        await writeFile(path.join(pair.ours, 'untracked'), 'u\n');
        const lock = path.join(pair.ours, '.git', 'index.lock');
        await writeFile(lock, '');
        const warn = vi.fn();
        const logged = { ...ctx, logger: { warn } } as Context;
        const before = await indexIno(pair.ours);
        const sut = status;

        // Act
        const result = await sut(logged);

        // Assert
        expect(await indexIno(pair.ours)).toBe(before);
        expect((await stat(lock)).size).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          'status: index refresh skipped',
          expect.objectContaining({
            code: 'FILE_EXISTS',
            path: expect.stringContaining('index.lock'),
          }),
        );
        expect(xyLines(result)).toEqual(
          gitPorcelainV2Lines(pair.ours).filter((l) => !l.startsWith('# ')),
        );
      });
    });

    describe('When tsgit refreshes the index', () => {
      it('Then git reads it back to the same status and fsck passes', async () => {
        // Arrange
        await touchB(pair.ours);
        await writeFile(path.join(pair.ours, 'untracked'), 'u\n');
        const before = await indexIno(pair.ours);

        // Act
        const result = await status(ctx);

        // Assert
        expect(await indexIno(pair.ours)).not.toBe(before);
        expect(xyLines(result)).toEqual(
          gitPorcelainV2Lines(pair.ours).filter((l) => !l.startsWith('# ')),
        );
        expect(tryRunGit(['-C', pair.ours, 'fsck']).ok).toBe(true);
      });
    });
  });

  describe('Given a racy entry behind a clean filter', () => {
    const FUTURE_SECONDS = 3600;

    const buildFilteredRepo = async (dir: string, log: string): Promise<void> => {
      runGit(['init', '-q', '-b', 'main', dir]);
      git(dir, 'config', 'user.name', 'Ada');
      git(dir, 'config', 'user.email', 'ada@example.com');
      git(dir, 'config', 'filter.log.clean', `sh -c 'echo run >> "${log}"; cat'`);
      await writeFile(path.join(dir, '.gitattributes'), '*.txt filter=log\n');
      await writeFile(path.join(dir, 'f.txt'), 'body\n');
      const future = new Date(Date.now() + FUTURE_SECONDS * 1000);
      await utimes(path.join(dir, 'f.txt'), future, future);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'one');
      await writeFile(log, '');
    };

    const filterRuns = async (log: string): Promise<number> =>
      (await readFile(log, 'utf-8')).split('\n').filter((line) => line !== '').length;

    describe('When status runs', () => {
      it('Then the clean filter runs as often as under git', async () => {
        // Arrange
        const peerLog = path.join(pair.peer, '..', `${path.basename(pair.peer)}-filter.log`);
        const oursLog = path.join(pair.ours, '..', `${path.basename(pair.ours)}-filter.log`);
        const peerDir = path.join(pair.peer, 'filtered');
        const oursDir = path.join(pair.ours, 'filtered');
        onTestFinished(() => rm(peerLog, { force: true }));
        onTestFinished(() => rm(oursLog, { force: true }));
        await mkdir(peerDir);
        await mkdir(oursDir);
        await buildFilteredRepo(peerDir, peerLog);
        await buildFilteredRepo(oursDir, oursLog);
        const filteredCtx = createNodeContext({ workDir: oursDir });
        const sut = status;

        // Act
        git(peerDir, 'status');
        await sut(filteredCtx);

        // Assert
        const gitRuns = await filterRuns(peerLog);
        expect(gitRuns).toBe(1);
        expect(await filterRuns(oursLog)).toBe(gitRuns);
      });
    });
  });

  describe('Given a SHA-256 repository', () => {
    describe('When b is touched and status runs', () => {
      it('Then the index is rewritten and git fsck passes', async () => {
        // Arrange
        const dir = path.join(pair.ours, 'sha256');
        await mkdir(dir);
        await buildRepo(dir, 'sha256');
        await settle(dir);
        await touchB(dir);
        const before = await indexIno(dir);
        const sha256Ctx = createNodeContext({ workDir: dir, algorithm: 'sha256' });
        const sut = status;

        // Act
        await sut(sha256Ctx);

        // Assert
        expect(await indexIno(dir)).not.toBe(before);
        expect(tryRunGit(['-C', dir, 'fsck']).ok).toBe(true);
      });
    });
  });
});

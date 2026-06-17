/**
 * Cross-tool interop — checkout replaces an occupying symlink with a regular
 * file. Builds the same graph in a canonical-git peer and a tsgit repo (base +
 * `main` commit `p` as a symlink, `feat` commits `p` as a regular file), then
 * branch-switches on both tools and asserts byte-for-byte parity of the
 * resulting working-tree kind/content/mode and the index stages. Covers the
 * reverse (regular → symlink) and the dangling-symlink force-restore edges too.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout symlink→file replace runs against git
 *   interopSurface: checkout
 */
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

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

const REGULAR_CONTENT = 'regular file content\n';
const EXEC_CONTENT = '#!/bin/sh\necho hi\n';
const LINK_TARGET = 'the-target';
const PERM_MASK = 0o777;

const writeFileSyncMode = (filePath: string, content: string, mode: number): void => {
  writeFileSync(filePath, content, { mode });
};

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — symlink ↔ regular-file kind switch',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    // ── peer helpers ─────────────────────────────────────────────────────────

    const peerCommit = (message: string): void =>
      void runGit(['-C', pair.peer, 'commit', '-q', '-m', message], { env: COMMIT_ENV });

    const oursCommit = async (message: string): Promise<void> => {
      await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    };

    // Build, on BOTH tools, the graph: base+main hold `p` as a symlink to
    // `LINK_TARGET`; `feat` holds `p` as a regular file with `bytes` at `perm`.
    // Leaves HEAD on `main` (disk = symlink) on both tools.
    const buildKindSwitchGraph = async (bytes: string, perm: number): Promise<void> => {
      symlinkSync(LINK_TARGET, path.join(pair.peer, 'p'));
      runGit(['-C', pair.peer, 'add', 'p']);
      peerCommit('base');
      runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'feat']);
      runGit(['-C', pair.peer, 'rm', '-q', 'p']);
      const peerFile = path.join(pair.peer, 'p');
      writeFileSyncMode(peerFile, bytes, perm);
      runGit(['-C', pair.peer, 'add', 'p']);
      peerCommit('feat');
      runGit(['-C', pair.peer, 'checkout', '-q', 'main']);

      symlinkSync(LINK_TARGET, path.join(pair.ours, 'p'));
      await repo.add(['p']);
      await oursCommit('base');
      await repo.branch.create({ name: 'feat' });
      await repo.checkout({ rev: 'feat' });
      await repo.rm(['p']);
      writeFileSyncMode(path.join(pair.ours, 'p'), bytes, perm);
      await repo.add(['p']);
      await oursCommit('feat');
      await repo.checkout({ rev: 'main' });
    };

    beforeEach(async () => {
      pair = await makePeerPair('checkout-symlink-file');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      runGit(['-C', pair.peer, 'config', 'core.symlinks', 'true']);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe('Given main holds a symlink and feat holds a regular 644 file at the same path', () => {
      describe('When both tools checkout feat', () => {
        it('Then p is a regular 644 file with feat content and no residual symlink, matching git', async () => {
          // Arrange
          await buildKindSwitchGraph(REGULAR_CONTENT, 0o644);

          // Act
          runGit(['-C', pair.peer, 'checkout', '-q', 'feat']);
          await repo.checkout({ rev: 'feat' });

          // Assert — tsgit replaced the symlink with a regular file
          const oursPath = path.join(pair.ours, 'p');
          expect(lstatSync(oursPath).isSymbolicLink()).toBe(false);
          expect(readFileSync(oursPath, 'utf8')).toBe(REGULAR_CONTENT);
          expect(lstatSync(oursPath).mode & PERM_MASK).toBe(0o644);
          // Parity with canonical git: same index stages, same on-disk kind/mode.
          const peerPath = path.join(pair.peer, 'p');
          expect(lstatSync(peerPath).isSymbolicLink()).toBe(false);
          expect(lstatSync(peerPath).mode & PERM_MASK).toBe(0o644);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect((await repo.status()).clean).toBe(true);
          expect(runGit(['-C', pair.peer, 'status', '--porcelain'])).toBe('');
        });
      });
    });

    describe('Given main holds a symlink and feat holds an executable 755 file at the same path', () => {
      describe('When both tools checkout feat', () => {
        it('Then p is a regular 755 file with feat content and no residual symlink, matching git', async () => {
          // Arrange
          await buildKindSwitchGraph(EXEC_CONTENT, 0o755);

          // Act
          runGit(['-C', pair.peer, 'checkout', '-q', 'feat']);
          await repo.checkout({ rev: 'feat' });

          // Assert
          const oursPath = path.join(pair.ours, 'p');
          expect(lstatSync(oursPath).isSymbolicLink()).toBe(false);
          expect(readFileSync(oursPath, 'utf8')).toBe(EXEC_CONTENT);
          expect(lstatSync(oursPath).mode & PERM_MASK).toBe(0o755);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect((await repo.status()).clean).toBe(true);
          expect(runGit(['-C', pair.peer, 'status', '--porcelain'])).toBe('');
        });
      });
    });

    describe('Given a checkout has already switched a path from a symlink to a regular file', () => {
      describe('When both tools checkout back to main', () => {
        it('Then p is restored as a symlink to its target and no residual regular file, matching git', async () => {
          // Arrange — switch to feat first (p becomes a regular file on both)
          await buildKindSwitchGraph(REGULAR_CONTENT, 0o644);
          runGit(['-C', pair.peer, 'checkout', '-q', 'feat']);
          await repo.checkout({ rev: 'feat' });

          // Act — reverse: regular file → symlink
          runGit(['-C', pair.peer, 'checkout', '-q', 'main']);
          await repo.checkout({ rev: 'main' });

          // Assert
          const oursPath = path.join(pair.ours, 'p');
          expect(lstatSync(oursPath).isSymbolicLink()).toBe(true);
          expect(readlinkSync(oursPath)).toBe(LINK_TARGET);
          expect(readlinkSync(path.join(pair.peer, 'p'))).toBe(LINK_TARGET);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect((await repo.status()).clean).toBe(true);
          expect(runGit(['-C', pair.peer, 'status', '--porcelain'])).toBe('');
        });
      });
    });

    describe('Given feat holds a regular file but a dangling symlink squats the path on disk', () => {
      describe('When both tools force-restore the path', () => {
        it('Then the dangling symlink is removed and the regular file is written, matching git', async () => {
          // Arrange — land on feat (regular file), then squat with a dangling symlink
          await buildKindSwitchGraph(REGULAR_CONTENT, 0o644);
          runGit(['-C', pair.peer, 'checkout', '-q', 'feat']);
          await repo.checkout({ rev: 'feat' });
          const peerSquat = path.join(pair.peer, 'p');
          const oursSquat = path.join(pair.ours, 'p');
          unlinkSync(peerSquat);
          unlinkSync(oursSquat);
          symlinkSync('/nonexistent/dangling', peerSquat);
          symlinkSync('/nonexistent/dangling', oursSquat);

          // Act
          runGit(['-C', pair.peer, 'checkout', '--force', '--', 'p']);
          await repo.checkout({ paths: ['p'], force: true });

          // Assert
          expect(lstatSync(oursSquat).isSymbolicLink()).toBe(false);
          expect(readFileSync(oursSquat, 'utf8')).toBe(REGULAR_CONTENT);
          expect(lstatSync(peerSquat).isSymbolicLink()).toBe(false);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect((await repo.status()).clean).toBe(true);
          expect(runGit(['-C', pair.peer, 'status', '--porcelain'])).toBe('');
        });
      });
    });
  },
);

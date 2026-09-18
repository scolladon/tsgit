/**
 * Cross-tool interop — a symlink occupying a checkout target refuses exactly
 * like canonical git, including a DANGLING one. git's untracked/local-changes
 * probe is `lstat`-based (never follows), so a dangling symlink still counts
 * as occupying the path; this pins that tsgit's `checkout` agrees, on the Node
 * adapter, for both the untracked-clash and the tracked-dirty refusal axes.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         a symlink (dangling or live) squatting a checkout target refuses like git
 *   interopSurface: checkout
 */
import { symlink, unlink, writeFile } from 'node:fs/promises';
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
  tryRunGit,
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

interface CheckoutOverwriteData {
  readonly code?: string;
  readonly localChanges?: ReadonlyArray<string>;
  readonly untracked?: ReadonlyArray<string>;
}

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — symlink-obstruction refusal',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('checkout-symlink-refusal');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    // ── shared peer + tsgit graph helpers ─────────────────────────────────────

    const writeBoth = async (rel: string, content: string): Promise<void> => {
      await writeFile(path.join(pair.peer, rel), content);
      await writeFile(path.join(pair.ours, rel), content);
    };

    const commitBoth = async (message: string, paths: ReadonlyArray<string>): Promise<void> => {
      runGit(['-C', pair.peer, 'add', ...paths]);
      await repo.add(paths);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
      await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    };

    const branchBoth = async (name: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '-q', '-b', name]);
      await repo.branch.create({ name });
      await repo.checkout({ rev: name });
    };

    const checkoutMainBoth = async (): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '-q', 'main']);
      await repo.checkout({ rev: 'main' });
    };

    /**
     * Attempts `checkout feature` on both tools, expecting a co-refusal. Returns
     * tsgit's structured `CHECKOUT_OVERWRITE_DIRTY` data and the peer's stderr;
     * asserts the working tree, index and HEAD are untouched on tsgit.
     */
    const expectCoRefusal = async (): Promise<{
      data: CheckoutOverwriteData;
      peerStderr: string;
    }> => {
      const stageBefore = lsStage(pair.ours);
      const headBefore = runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim();

      const peerResult = tryRunGit(['-C', pair.peer, 'checkout', 'feature']);
      let data: CheckoutOverwriteData | undefined;
      try {
        await repo.checkout({ rev: 'feature' });
      } catch (err) {
        data = (err as { data?: CheckoutOverwriteData }).data;
      }

      expect(peerResult.ok).toBe(false);
      expect(data?.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
      expect(runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim()).toBe(headBefore);
      expect(lsStage(pair.ours)).toBe(stageBefore);
      return { data: data ?? {}, peerStderr: peerResult.stderr };
    };

    // ── base graph: main has base.txt only; feature adds p.txt too ────────────

    const buildAddGraph = async (): Promise<void> => {
      await writeBoth('base.txt', 'base\n');
      await commitBoth('base', ['base.txt']);
      await branchBoth('feature');
      await writeBoth('p.txt', 'p-content\n');
      await commitBoth('add p.txt on feature', ['p.txt']);
      await checkoutMainBoth();
    };

    describe('Given an untracked DANGLING symlink squats a path the target branch would add', () => {
      describe('When both tools checkout the target branch', () => {
        it('Then both refuse with the path as untracked, matching git exactly', async () => {
          // Arrange
          await buildAddGraph();
          await symlink('/nonexistent/dangling-checkout-target', path.join(pair.peer, 'p.txt'));
          await symlink('/nonexistent/dangling-checkout-target', path.join(pair.ours, 'p.txt'));

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert
          expect(data.untracked).toEqual(['p.txt']);
          expect(data.localChanges).toEqual([]);
          expect(peerStderr).toContain(
            'The following untracked working tree files would be overwritten by checkout',
          );
        });
      });
    });

    describe('Given an untracked LIVE symlink squats a path the target branch would add', () => {
      describe('When both tools checkout the target branch', () => {
        it('Then both refuse with the path as untracked, matching git exactly', async () => {
          // Arrange
          await buildAddGraph();
          await writeFile(path.join(pair.peer, 'live-target.txt'), 'live\n');
          await writeFile(path.join(pair.ours, 'live-target.txt'), 'live\n');
          await symlink('live-target.txt', path.join(pair.peer, 'p.txt'));
          await symlink('live-target.txt', path.join(pair.ours, 'p.txt'));

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert
          expect(data.untracked).toEqual(['p.txt']);
          expect(data.localChanges).toEqual([]);
          expect(peerStderr).toContain(
            'The following untracked working tree files would be overwritten by checkout',
          );
        });
      });
    });

    describe('Given a tracked path the target branch would update is replaced by a dangling symlink', () => {
      describe('When both tools checkout the target branch', () => {
        it('Then both refuse with the path as a local change, matching git exactly', async () => {
          // Arrange — base.txt is tracked and modified on feature too, so the
          // checkout needs to update it; the symlink squatting it is "dirty".
          await writeBoth('base.txt', 'base\n');
          await commitBoth('base', ['base.txt']);
          await branchBoth('feature');
          await writeBoth('base.txt', 'changed on feature\n');
          await commitBoth('modify base.txt on feature', ['base.txt']);
          await checkoutMainBoth();
          await unlink(path.join(pair.peer, 'base.txt'));
          await unlink(path.join(pair.ours, 'base.txt'));
          await symlink('/nonexistent/dangling-dirty-target', path.join(pair.peer, 'base.txt'));
          await symlink('/nonexistent/dangling-dirty-target', path.join(pair.ours, 'base.txt'));

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert
          expect(data.localChanges).toEqual(['base.txt']);
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain(
            'Your local changes to the following files would be overwritten by checkout',
          );
        });
      });
    });
  },
);

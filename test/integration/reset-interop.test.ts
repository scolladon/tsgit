/**
 * Cross-tool interop — `reset` porcelain. Seeds two commits with a pinned
 * identity (so their SHAs match canonical git — proven by
 * `commit-interop.test.ts`), then resets to the first commit in each mode via
 * `repo.reset` and `git reset --<mode>`, asserting HEAD (`git rev-parse`),
 * index (`git ls-files --stage`), and working tree agree.
 *
 * @proves
 *   surface:        reset
 *   bucket:         cross-tool-interop
 *   unique:         reset porcelain HEAD+index+worktree matches canonical git reset
 *   interopSurface: reset
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
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
  topReflogSubject,
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

interface SeedFile {
  readonly path: string;
  readonly content: string;
}

interface ResetSnapshot {
  readonly head: string;
  readonly stage: string;
  readonly a: string | null;
  readonly bExists: boolean;
}

describe.skipIf(!GIT_AVAILABLE)('reset porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('reset');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (file: SeedFile): Promise<void> => {
    await writeFile(path.join(pair.peer, file.path), file.content);
    await writeFile(path.join(pair.ours, file.path), file.content);
  };

  const commitBoth = async (message: string, files: ReadonlyArray<SeedFile>): Promise<string> => {
    for (const file of files) await writeBoth(file);
    const paths = files.map((file) => file.path);
    runGit(['-C', pair.peer, 'add', ...paths]);
    // Signing OFF + whitespace cleanup so the peer commit id matches tsgit's
    // (a globally-enabled `commit.gpgsign` would otherwise diverge the SHA).
    runGit(
      [
        '-C',
        pair.peer,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'commit.cleanup=whitespace',
        'commit',
        '-q',
        '-m',
        message,
      ],
      { env: COMMIT_ENV },
    );
    await repo.add(paths);
    const { id } = await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    return id;
  };

  const seedTwoCommits = async (): Promise<{ readonly c0: string }> => {
    const c0 = await commitBoth('c0', [{ path: 'a.txt', content: 'v0\n' }]);
    await commitBoth('c1', [
      { path: 'a.txt', content: 'v1\n' },
      { path: 'b.txt', content: 'b\n' },
    ]);
    return { c0 };
  };

  const pathExists = async (dir: string, rel: string): Promise<boolean> => {
    try {
      await stat(path.join(dir, rel));
      return true;
    } catch {
      return false;
    }
  };

  const readMaybe = async (dir: string, rel: string): Promise<string | null> => {
    try {
      return await readFile(path.join(dir, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const snapshot = async (dir: string): Promise<ResetSnapshot> => ({
    head: runGit(['-C', dir, 'rev-parse', 'HEAD']).trim(),
    stage: lsStage(dir),
    a: await readMaybe(dir, 'a.txt'),
    bExists: await pathExists(dir, 'b.txt'),
  });

  describe('Given two commits with the second adding a file and editing another', () => {
    describe('When repo.reset --soft moves HEAD back like git reset --soft', () => {
      it('Then HEAD moves but index and working tree match git', async () => {
        // Arrange
        const { c0 } = await seedTwoCommits();

        // Act
        await repo.reset({ mode: 'soft', target: c0 });
        runGit(['-C', pair.peer, 'reset', '--soft', c0]);
        const sut = await snapshot(pair.ours);

        // Assert
        expect(sut).toEqual(await snapshot(pair.peer));
        expect(sut.head).toBe(c0);
      });
    });

    describe('When repo.reset --mixed rewinds the index like git reset --mixed', () => {
      it('Then HEAD and index rewind but the working tree is untouched, like git', async () => {
        // Arrange
        const { c0 } = await seedTwoCommits();

        // Act
        await repo.reset({ mode: 'mixed', target: c0 });
        runGit(['-C', pair.peer, 'reset', '--mixed', c0]);
        const sut = await snapshot(pair.ours);

        // Assert
        expect(sut).toEqual(await snapshot(pair.peer));
        expect(sut.head).toBe(c0);
        expect(sut.bExists).toBe(true);
      });
    });

    describe('When repo.reset --hard rewinds everything like git reset --hard', () => {
      it('Then HEAD, index, and working tree all rewind identically to git', async () => {
        // Arrange
        const { c0 } = await seedTwoCommits();

        // Act
        await repo.reset({ mode: 'hard', target: c0 });
        runGit(['-C', pair.peer, 'reset', '--hard', c0]);
        const sut = await snapshot(pair.ours);

        // Assert
        expect(sut).toEqual(await snapshot(pair.peer));
        expect(sut.head).toBe(c0);
        expect(sut.a).toBe('v0\n');
        expect(sut.bExists).toBe(false);
      });
    });
  });

  describe('Given a detached HEAD at the tip', () => {
    const detachBoth = async (tip: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '--detach', tip]);
      await repo.checkout({ target: tip, detach: true });
    };

    describe('When reset --hard HEAD is a no-move on both tools', () => {
      it('Then neither git nor tsgit appends a HEAD reflog entry', async () => {
        // Arrange — seed, detach to the tip on both, snapshot each HEAD reflog top.
        await seedTwoCommits();
        const tip = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
        await detachBoth(tip);
        const peerBefore = topReflogSubject(pair.peer, 'HEAD');
        const oursBefore = topReflogSubject(pair.ours, 'HEAD');

        // Act — reset to the same oid: a detached direct-ref no-move writes nothing.
        runGit(['-C', pair.peer, 'reset', '--hard', 'HEAD']);
        await repo.reset({ mode: 'hard', target: 'HEAD' });

        // Assert — each tool's HEAD reflog top is unchanged by the reset. The
        // before/after-per-tool form isolates the gate from any checkout-message
        // formatting difference between the tools.
        expect(topReflogSubject(pair.peer, 'HEAD')).toBe(peerBefore);
        expect(topReflogSubject(pair.ours, 'HEAD')).toBe(oursBefore);
      });
    });

    describe('When reset --hard <c0> moves the detached HEAD on both tools', () => {
      it('Then both append the identical `reset: moving to <c0>` HEAD entry', async () => {
        // Arrange — seed, detach to the tip on both.
        const { c0 } = await seedTwoCommits();
        const tip = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
        await detachBoth(tip);

        // Act — a real move records the faithful message on both tools.
        runGit(['-C', pair.peer, 'reset', '--hard', c0]);
        await repo.reset({ mode: 'hard', target: c0 });

        // Assert — guards the routing from over-skipping a real move.
        const sut = topReflogSubject(pair.ours, 'HEAD');
        expect(sut).toBe(`reset: moving to ${c0}`);
        expect(sut).toBe(topReflogSubject(pair.peer, 'HEAD'));
      });
    });
  });
});

/**
 * Cross-tool interop — `merge`'s default message. One history is built with
 * canonical git, copied, then merged by `git merge --no-edit` in one copy and
 * `repo.merge.run` (no message) in the other under a pinned identity and date:
 * the merge commit SHAs must agree, and a conflicted merge's MERGE_MSG bytes too.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         merge records git's fmt_merge_msg default message byte for byte
 *   interopSurface: merge
 */
import { cp, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const IDENTITY: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_AUTHOR_DATE: `${IDENTITY.timestamp} ${IDENTITY.timezoneOffset}`,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  GIT_COMMITTER_DATE: `${IDENTITY.timestamp} ${IDENTITY.timezoneOffset}`,
};

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: COMMIT_ENV }).trim();

/** base; feature adds b and is tagged `lt`, `at` (annotated) and `refs/custom/at`; main adds c. */
const buildHistory = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'on-feature');
  git(dir, 'tag', 'lt');
  git(dir, 'tag', '-a', '-m', 'tag body line', 'at');
  git(dir, 'update-ref', 'refs/custom/at', 'at');
  git(dir, 'update-ref', 'refs/remotes/origin/feature', 'feature');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'on-main');
};

describe.skipIf(!GIT_AVAILABLE)('merge interop — default message', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('merge-message');
    buildHistory(pair.peer);
    await cp(pair.peer, pair.ours, { recursive: true });
  });

  afterEach(async () => {
    await pair.dispose();
  });

  /** HEAD after each tool merges `rev` into `branch` with no message. */
  const mergeBoth = async (rev: string, branch: string): Promise<readonly [string, string]> => {
    for (const dir of [pair.peer, pair.ours]) git(dir, 'checkout', '-q', '-B', branch, 'main');
    git(pair.peer, 'merge', '-q', '--no-edit', rev);
    const repo = await openRepository({ cwd: pair.ours });
    try {
      await repo.merge.run({ rev, author: IDENTITY, committer: IDENTITY });
    } finally {
      await repo.dispose();
    }
    return [git(pair.ours, 'rev-parse', 'HEAD'), git(pair.peer, 'rev-parse', 'HEAD')];
  };

  describe.each([
    ['a local branch into main', 'feature', 'main'],
    ['a local branch into another branch', 'feature', 'topic'],
    ['a branch by its full ref', 'refs/heads/feature', 'main'],
    ['a lightweight tag', 'lt', 'main'],
    ['an annotated tag', 'at', 'main'],
    ['an annotated tag through an unlabelled ref', 'refs/custom/at', 'main'],
    ['a remote-tracking branch', 'origin/feature', 'main'],
  ])('Given %s', (_label, rev, branch) => {
    describe('When both tools merge it without a message', () => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut(rev, branch);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the feature commit named by its full and abbreviated id', () => {
    describe.each([
      ['full', 40],
      ['abbreviated', 7],
    ])('When both tools merge its %s id without a message', (_label, width) => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        const rev = git(pair.peer, 'rev-parse', 'feature').slice(0, width);
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut(rev, 'main');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given merge.suppressDest set to a glob matching the destination', () => {
    describe('When both tools merge into it without a message', () => {
      it('Then the merge commits are identical', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) git(dir, 'config', 'merge.suppressDest', 'top*');
        const sut = mergeBoth;

        // Act
        const [result, expected] = await sut('feature', 'topic');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given both sides change the same file', () => {
    describe('When both tools merge without a message and conflict', () => {
      it('Then MERGE_MSG is byte-identical', async () => {
        // Arrange
        const commitFile = async (dir: string, branch: string, content: string) => {
          git(dir, 'checkout', '-q', branch);
          await writeFile(path.join(dir, 'z.txt'), content);
          git(dir, 'add', 'z.txt');
          git(dir, 'commit', '-q', '-m', `z on ${branch}`);
        };
        for (const dir of [pair.peer, pair.ours]) {
          await commitFile(dir, 'feature', 'theirs\n');
          await commitFile(dir, 'main', 'ours\n');
        }
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge.run;

        // Act
        tryRunGit(['-C', pair.peer, 'merge', '-q', '--no-edit', 'feature'], { env: COMMIT_ENV });
        await sut({ rev: 'feature', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        const read = (dir: string) => readFile(path.join(dir, '.git', 'MERGE_MSG'), 'utf8');
        expect(await read(pair.ours)).toBe(await read(pair.peer));
      });
    });
  });
});

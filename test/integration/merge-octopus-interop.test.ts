/**
 * Cross-tool interop — merging several heads. One history is built with
 * canonical git, copied, then merged by `git merge --no-edit <heads>` in one
 * copy and `repo.merge.run({ rev: [...] })` in the other under a pinned
 * identity and date: the octopus commit, its reflog note, and a conflicted
 * merge's MERGE_HEAD, MERGE_MSG and index must agree.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         merge of several heads follows git's reduce_heads and octopus strategy
 *   interopSurface: merge
 */
import { writeFileSync } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
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

const commitFile = (dir: string, name: string, content: string): void => {
  writeFileSync(path.join(dir, name), content);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', name);
};

/** a; b1..b3 each add a file; c1 rewrites m; main rewrites m too. */
const buildHistory = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  commitFile(dir, 'a', 'a\n');
  commitFile(dir, 'm', 'm\n');
  for (const branch of ['b1', 'b2', 'b3', 'c1']) {
    git(dir, 'checkout', '-q', '-b', branch, 'main');
    commitFile(dir, branch === 'c1' ? 'm' : branch, `${branch}\n`);
  }
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'm', 'm2\n');
};

describe.skipIf(!GIT_AVAILABLE)('merge interop — several heads', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('merge-octopus');
    buildHistory(pair.peer);
    await cp(pair.peer, pair.ours, { recursive: true });
  });

  afterEach(async () => {
    await pair.dispose();
  });

  /** Each tool merges `heads`; tsgit's result, or its refusal, is returned. */
  const mergeBoth = async (
    heads: ReadonlyArray<string>,
    options: {
      readonly allowUnrelatedHistories?: boolean;
      readonly fastForward?: 'never';
    } = {},
  ): Promise<unknown> => {
    const allow = options.allowUnrelatedHistories === true ? ['--allow-unrelated-histories'] : [];
    const noFf = options.fastForward === 'never' ? ['--no-ff'] : [];
    tryRunGitWithExit(['-C', pair.peer, 'merge', '-q', '--no-edit', ...allow, ...noFf, ...heads], {
      env: COMMIT_ENV,
    });
    const repo = await openRepository({ cwd: pair.ours });
    try {
      return await repo.merge.run({
        rev: heads,
        author: IDENTITY,
        committer: IDENTITY,
        ...options,
      });
    } catch (error) {
      return error;
    } finally {
      await repo.dispose();
    }
  };

  const both = (...args: ReadonlyArray<string>): readonly [string, string] => [
    git(pair.ours, ...args),
    git(pair.peer, ...args),
  ];

  const gitFile = async (name: string): Promise<readonly [string, string]> => [
    await readFile(path.join(pair.ours, '.git', name), 'utf8'),
    await readFile(path.join(pair.peer, '.git', name), 'utf8'),
  ];

  describe.each([
    ['three diverged branches', ['b1', 'b2', 'b3']],
    ['a repeated branch', ['b1', 'b1', 'b2']],
    ['branches alongside main itself', ['b1', 'main', 'b2']],
  ])('Given %s', (_label, heads) => {
    describe('When both tools merge them', () => {
      it('Then the merge commits and their reflog notes are identical', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        await sut(heads);

        // Assert
        const [result, expected] = both('log', '-1', '-g', '--format=%H %gs', 'HEAD');
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the last head conflicts with main', () => {
    describe('When both tools merge b1, b2 and c1', () => {
      it('Then MERGE_HEAD, MERGE_MSG and the index are identical', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        await sut(['b1', 'b2', 'c1']);

        // Assert
        const [mergeHead, expectedMergeHead] = await gitFile('MERGE_HEAD');
        expect(mergeHead).toBe(expectedMergeHead);
        const [mergeMsg, expectedMergeMsg] = await gitFile('MERGE_MSG');
        expect(mergeMsg).toBe(expectedMergeMsg);
        const [index, expectedIndex] = both('ls-files', '-s');
        expect(index).toBe(expectedIndex);
      });
    });
  });

  describe('Given the last head conflicted and m was resolved', () => {
    describe('When both tools commit the resolution', () => {
      it('Then the commits record HEAD and every head alike', async () => {
        // Arrange
        await mergeBoth(['b1', 'b2', 'c1']);
        for (const dir of [pair.ours, pair.peer]) {
          writeFileSync(path.join(dir, 'm'), 'r\n');
          git(dir, 'add', 'm');
        }
        git(pair.peer, 'commit', '-q', '-m', 'resolved');
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.commit;

        // Act
        try {
          await sut({ message: 'resolved', author: IDENTITY, committer: IDENTITY });
        } finally {
          await repo.dispose();
        }

        // Assert
        const [result, expected] = both('rev-parse', 'HEAD');
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the first head conflicts with main', () => {
    describe('When both tools merge c1, b1 and b2', () => {
      it('Then both refuse the octopus and leave HEAD and the tree untouched', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const result = await sut(['c1', 'b1', 'b2']);

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'OCTOPUS_MERGE_FAILED',
          head: 'c1',
          reason: 'conflict-before-last-head',
        });
        const [status, expectedStatus] = both('status', '--porcelain');
        expect(status).toBe(expectedStatus);
        const [head, expectedHead] = both('rev-parse', 'HEAD');
        expect(head).toBe(expectedHead);
      });
    });
  });

  describe('Given a root sharing no history with main', () => {
    const addOrphan = (): void => {
      for (const dir of [pair.ours, pair.peer]) {
        git(dir, 'checkout', '-q', '--orphan', 'orphan');
        git(dir, 'rm', '-rfq', '.');
        commitFile(dir, 'o', 'o\n');
        git(dir, 'checkout', '-q', 'main');
      }
    };

    describe.each([
      ['the orphan alone', ['orphan']],
      ['b1 and the orphan', ['b1', 'orphan']],
    ])('When both tools merge %s', (_label, heads) => {
      it('Then both refuse after recording ORIG_HEAD alike', async () => {
        // Arrange
        addOrphan();
        const sut = mergeBoth;

        // Act
        const result = await sut(heads);

        // Assert
        expect((result as TsgitError).data).toEqual({ code: 'UNRELATED_HISTORIES' });
        const [origHead, expectedOrigHead] = await gitFile('ORIG_HEAD');
        expect(origHead).toBe(expectedOrigHead);
        const [status, expectedStatus] = both('status', '--porcelain');
        expect(status).toBe(expectedStatus);
      });
    });

    describe('When both tools merge the orphan allowing unrelated histories', () => {
      it('Then the merge commits and their reflog notes are identical', async () => {
        // Arrange
        addOrphan();
        const sut = mergeBoth;

        // Act
        await sut(['orphan'], { allowUnrelatedHistories: true });

        // Assert
        const [result, expected] = both('log', '-1', '-g', '--format=%H %gs', 'HEAD');
        expect(result).toBe(expected);
      });
    });

    describe('When both tools merge b1 and the orphan allowing unrelated histories', () => {
      it("Then both stop at the orphan with git's MERGE_HEAD, MERGE_MSG and index", async () => {
        // Arrange
        addOrphan();
        const sut = mergeBoth;

        // Act
        const result = await sut(['b1', 'orphan'], { allowUnrelatedHistories: true });

        // Assert
        expect(result).toMatchObject({ kind: 'conflict', conflicts: [] });
        for (const name of ['MERGE_HEAD', 'MERGE_MSG']) {
          const [file, expectedFile] = await gitFile(name);
          expect(file).toBe(expectedFile);
        }
        const [index, expectedIndex] = both('ls-files', '-s');
        expect(index).toBe(expectedIndex);
        const [status, expectedStatus] = both('status', '--porcelain');
        expect(status).toBe(expectedStatus);
      });
    });

    describe.each([
      ['by default', {}],
      ['never fast-forwarding', { fastForward: 'never' as const }],
    ])('When both tools merge ahead and the orphan %s, then commit', (_mode, extra) => {
      it('Then MERGE_MODE and the resolving commits are identical', async () => {
        // Arrange
        addOrphan();
        for (const dir of [pair.ours, pair.peer]) {
          git(dir, 'checkout', '-q', '-b', 'ahead', 'main');
          commitFile(dir, 'h', 'h\n');
          git(dir, 'checkout', '-q', 'main');
        }
        await mergeBoth(['ahead', 'orphan'], { allowUnrelatedHistories: true, ...extra });
        git(pair.peer, 'commit', '-q', '-m', 'resolved');
        const repo = await openRepository({ cwd: pair.ours });
        const sut = repo.commit;

        // Act
        try {
          await sut({ message: 'resolved', author: IDENTITY, committer: IDENTITY });
        } finally {
          await repo.dispose();
        }

        // Assert
        const [result, expected] = both('cat-file', 'commit', 'HEAD');
        expect(result).toBe(expected);
      });
    });

    describe('When both tools merge ahead and the orphan never fast-forwarding', () => {
      it('Then MERGE_MODE bytes are identical', async () => {
        // Arrange
        addOrphan();
        for (const dir of [pair.ours, pair.peer]) {
          git(dir, 'checkout', '-q', '-b', 'ahead', 'main');
          commitFile(dir, 'h', 'h\n');
          git(dir, 'checkout', '-q', 'main');
        }
        const sut = mergeBoth;

        // Act
        await sut(['ahead', 'orphan'], { allowUnrelatedHistories: true, fastForward: 'never' });

        // Assert
        const [mode, expectedMode] = await gitFile('MERGE_MODE');
        expect(mode).toBe(expectedMode);
      });
    });
  });

  describe('Given a head whose parent the store lacks, alongside b1', () => {
    describe('When both tools merge them', () => {
      it("Then both log the parse failure and stay up to date with git's ORIG_HEAD", async () => {
        // Arrange
        const tree = git(pair.peer, 'rev-parse', 'main^{tree}');
        const body = [
          `tree ${tree}`,
          `parent cd${'0'.repeat(38)}`,
          'author Ada <ada@example.com> 1700000000 +0000',
          'committer Ada <ada@example.com> 1700000000 +0000',
          '',
          'broken',
          '',
        ].join('\n');
        const ids = [pair.ours, pair.peer].map((dir) =>
          runGit(['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
            input: body,
            env: COMMIT_ENV,
          }).trim(),
        );
        const sut = mergeBoth;

        // Act
        const result = await sut([ids[0]!, 'b1']);

        // Assert
        expect(result).toEqual({ kind: 'up-to-date', id: git(pair.ours, 'rev-parse', 'main') });
        const [head, expectedHead] = both('rev-parse', 'HEAD');
        expect(head).toBe(expectedHead);
        const [origHead, expectedOrigHead] = await gitFile('ORIG_HEAD');
        expect(origHead).toBe(expectedOrigHead);
      });
    });
  });
});

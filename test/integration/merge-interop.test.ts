/**
 * Cross-tool interop — `merge` non-conflict materialisation. Builds the same
 * diverged graph in a canonical-git peer and a tsgit repo (pinned identity, so
 * the setup commit SHAs match — proven by `commit-interop.test.ts`), then runs
 * `repo.merge.run` and `git merge`, asserting HEAD (`git rev-parse`), index
 * (`git ls-files --stage`), and the working tree agree for the fast-forward and
 * clean true-merge paths, plus a dirty-worktree co-refusal.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         merge fast-forward + clean true-merge materialise worktree+index like git
 *   interopSurface: merge
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

interface MergeSnapshot {
  readonly head: string;
  readonly stage: string;
}

describe.skipIf(!GIT_AVAILABLE)('merge interop — non-conflict materialisation', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('merge');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (rel: string, content: string): Promise<void> => {
    await writeFile(path.join(pair.peer, rel), content);
    await writeFile(path.join(pair.ours, rel), content);
  };

  const commitBothStaged = async (message: string): Promise<void> => {
    runGit(['-C', pair.peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
      env: COMMIT_ENV,
    });
    await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
  };

  const commitBoth = async (message: string, paths: ReadonlyArray<string>): Promise<void> => {
    runGit(['-C', pair.peer, 'add', ...paths]);
    await repo.add(paths);
    await commitBothStaged(message);
  };

  const branchBoth = async (name: string): Promise<void> => {
    runGit(['-C', pair.peer, 'checkout', '-q', '-b', name]);
    await repo.branch.create({ name });
    await repo.checkout({ rev: name });
  };

  const checkoutBoth = async (rev: string): Promise<void> => {
    runGit(['-C', pair.peer, 'checkout', '-q', rev]);
    await repo.checkout({ rev });
  };

  const removeBoth = async (rel: string): Promise<void> => {
    runGit(['-C', pair.peer, 'rm', '-q', rel]);
    await repo.rm([rel]);
  };

  const mergeBoth = async (rev: string, message: string): Promise<void> => {
    runGit(
      ['-C', pair.peer, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', message, rev],
      { env: COMMIT_ENV },
    );
    await repo.merge.run({ rev, message, author: AUTHOR, committer: AUTHOR });
  };

  const readMaybe = async (dir: string, rel: string): Promise<string | null> => {
    try {
      return await readFile(path.join(dir, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const pathExists = async (dir: string, rel: string): Promise<boolean> => {
    try {
      await stat(path.join(dir, rel));
      return true;
    } catch {
      return false;
    }
  };

  const snapshot = (dir: string): MergeSnapshot => ({
    head: runGit(['-C', dir, 'rev-parse', 'HEAD']).trim(),
    stage: lsStage(dir),
  });

  describe('Given an ancestor target that adds a file', () => {
    describe('When the merge fast-forwards on both tools', () => {
      it('Then HEAD, index, and working tree match git, with the added file present', async () => {
        // Arrange — base f.txt; feature +m.txt; main stays at base.
        await writeBoth('f.txt', 'base\n');
        await commitBoth('base', ['f.txt']);
        await branchBoth('feature');
        await writeBoth('m.txt', 'm\n');
        await commitBoth('feature-add', ['m.txt']);
        await checkoutBoth('main');

        // Act — git fast-forwards; repo.merge fast-forwards.
        runGit(['-C', pair.peer, 'merge', '--ff-only', '-q', 'feature']);
        const result = await repo.merge.run({ rev: 'feature', author: AUTHOR });

        // Assert — identical HEAD + index, and m.txt materialised on disk.
        expect(result.kind).toBe('fast-forward');
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        expect(await readMaybe(pair.ours, 'm.txt')).toBe('m\n');
      });
    });
  });

  describe('Given diverged histories with a theirs-only add', () => {
    describe('When the clean true-merge runs on both tools', () => {
      it('Then HEAD, index, and working tree match git, with the added file present', async () => {
        // Arrange — base f.txt; theirs +m.txt; ours +a.txt (disjoint → clean).
        await writeBoth('f.txt', 'base\n');
        await commitBoth('base', ['f.txt']);
        await branchBoth('theirs');
        await writeBoth('m.txt', 'm\n');
        await commitBoth('theirs-add', ['m.txt']);
        await checkoutBoth('main');
        await writeBoth('a.txt', 'a\n');
        await commitBoth('ours-add', ['a.txt']);

        // Act
        await mergeBoth('theirs', 'merge theirs');

        // Assert — identical merge commit + index, and m.txt on disk.
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        expect(await readMaybe(pair.ours, 'm.txt')).toBe('m\n');
        expect(await readMaybe(pair.ours, 'a.txt')).toBe('a\n');
      });
    });
  });

  describe('Given each side edits a different region of the same file', () => {
    describe('When the clean content merge runs on both tools', () => {
      it('Then HEAD, index, and working tree match git, with both edits merged', async () => {
        // Arrange — base 3-line file; ours edits line1; theirs edits line3.
        await writeBoth('file.txt', 'line1\nline2\nline3\n');
        await commitBoth('base', ['file.txt']);
        await branchBoth('theirs');
        await writeBoth('file.txt', 'line1\nline2\nTHEIRS\n');
        await commitBoth('theirs-edit', ['file.txt']);
        await checkoutBoth('main');
        await writeBoth('file.txt', 'OURS\nline2\nline3\n');
        await commitBoth('ours-edit', ['file.txt']);

        // Act
        await mergeBoth('theirs', 'merge theirs');

        // Assert — identical merge commit + index, both edits on disk.
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        expect(await readMaybe(pair.ours, 'file.txt')).toBe('OURS\nline2\nTHEIRS\n');
      });
    });
  });

  describe('Given theirs deletes a file ours leaves untouched', () => {
    describe('When the clean true-merge runs on both tools', () => {
      it('Then HEAD, index, and working tree match git, with the file removed', async () => {
        // Arrange — base a.txt + b.txt; theirs deletes a.txt; ours +c.txt.
        await writeBoth('a.txt', 'a\n');
        await writeBoth('b.txt', 'b\n');
        await commitBoth('base', ['a.txt', 'b.txt']);
        await branchBoth('theirs');
        await removeBoth('a.txt');
        await commitBothStaged('theirs-delete');
        await checkoutBoth('main');
        await writeBoth('c.txt', 'c\n');
        await commitBoth('ours-add', ['c.txt']);

        // Act
        await mergeBoth('theirs', 'merge theirs');

        // Assert — identical merge commit + index, a.txt gone from disk.
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
        expect(await pathExists(pair.ours, 'a.txt')).toBe(false);
        expect(await readMaybe(pair.ours, 'b.txt')).toBe('b\n');
      });
    });
  });

  describe('Given a local edit to a path the clean merge would overwrite', () => {
    describe('When merge runs on both tools', () => {
      it('Then both refuse without mutating HEAD, index, or the dirty file', async () => {
        // Arrange — base f.txt; theirs edits f.txt; ours +o.txt; then drift f.txt.
        await writeBoth('f.txt', 'base\n');
        await commitBoth('base', ['f.txt']);
        await branchBoth('theirs');
        await writeBoth('f.txt', 'theirs\n');
        await commitBoth('theirs-edit', ['f.txt']);
        await checkoutBoth('main');
        await writeBoth('o.txt', 'o\n');
        await commitBoth('ours-add', ['o.txt']);
        await writeBoth('f.txt', 'DIRTY\n');
        const before = snapshot(pair.ours);

        // Act — git refuses; repo.merge refuses with WORKING_TREE_DIRTY.
        const peerResult = tryRunGit(
          ['-C', pair.peer, 'merge', '--no-ff', '-m', 'merge theirs', 'theirs'],
          { env: COMMIT_ENV },
        );
        let code: string | undefined;
        try {
          await repo.merge.run({ rev: 'theirs', message: 'merge theirs', author: AUTHOR });
        } catch (caught) {
          code = (caught as { readonly data?: { readonly code?: string } }).data?.code;
        }

        // Assert — both refuse, leaving HEAD + index + the dirty bytes intact.
        expect(peerResult.ok).toBe(false);
        expect(code).toBe('WORKING_TREE_DIRTY');
        expect(snapshot(pair.ours)).toEqual(before);
        expect(await readMaybe(pair.ours, 'f.txt')).toBe('DIRTY\n');
      });
    });
  });
});

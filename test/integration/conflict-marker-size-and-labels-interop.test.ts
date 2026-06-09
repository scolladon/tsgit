/**
 * Cross-tool interop — conflict-marker size + per-operation labels. Builds the
 * same diverged graph in a canonical-git peer and a tsgit repo, runs the
 * conflicting operation on both, and asserts the conflicted working-tree file
 * (and a recording driver's captured placeholders) agree byte-for-byte. This
 * pins, against real git:
 *  - the `conflict-marker-size` gitattributes value → built-in marker run length,
 *  - the merge-driver `%L` / `%S` / `%X` / `%Y` placeholder values,
 *  - the `<<<<<<<` / `>>>>>>>` labels for merge, cherry-pick, revert, rebase, stash.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         conflict-marker size + labels match git across operations
 *   interopSurface: merge
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
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

describe.skipIf(!GIT_AVAILABLE)('conflict-marker size + label interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('marker-labels');
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

  const commitBoth = async (message: string, paths: ReadonlyArray<string>): Promise<void> => {
    runGit(['-C', pair.peer, 'add', ...paths]);
    await repo.add(paths);
    runGit(['-C', pair.peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
      env: COMMIT_ENV,
    });
    await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
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

  const read = (dir: string, rel: string): Promise<string> => readFile(path.join(dir, rel), 'utf8');
  const reopen = async (): Promise<void> => {
    await repo.dispose();
    repo = await openRepository({ cwd: pair.ours });
  };

  /** base/theirs/ours each whole-file-different on the named path. */
  const divergeBranch = async (attributes: string): Promise<void> => {
    await writeBoth('.gitattributes', attributes);
    await writeBoth('data.txt', 'l1\nl2\n');
    await commitBoth('base', ['.gitattributes', 'data.txt']);
    await branchBoth('feature');
    await writeBoth('data.txt', 'l1\nFEATURE\n');
    await commitBoth('feature change', ['data.txt']);
    await checkoutBoth('main');
    await writeBoth('data.txt', 'l1\nMAIN\n');
    await commitBoth('main change', ['data.txt']);
  };

  describe('Given a conflicting merge with conflict-marker-size=15', () => {
    describe('When merging the feature branch on both tools', () => {
      it('Then the 15-char markers and HEAD / rev labels match git byte-for-byte', async () => {
        // Arrange
        await divergeBranch('data.txt conflict-marker-size=15\n');

        // Act — pin the peer to git's default 2-way style (host global may pick diff3).
        tryRunGit(
          [
            '-C',
            pair.peer,
            '-c',
            'merge.conflictStyle=merge',
            'merge',
            '--no-ff',
            '-m',
            'm',
            'feature',
          ],
          { env: COMMIT_ENV },
        );
        const result = await repo.merge.run({ rev: 'feature', message: 'm', author: AUTHOR });

        // Assert
        expect(result.kind).toBe('conflict');
        const ours = await read(pair.ours, 'data.txt');
        expect(ours).toBe(await read(pair.peer, 'data.txt'));
        expect(ours).toContain(`${'<'.repeat(15)} HEAD\n`);
        expect(ours).toContain(`${'>'.repeat(15)} feature\n`);
      });
    });
  });

  describe('Given a merge driver capturing %L %S %X %Y with conflict-marker-size=9', () => {
    describe('When merging on both tools', () => {
      it('Then the driver receives identical placeholder values, matching git', async () => {
        // Arrange — record placeholders to ph.txt then conflict (exit non-zero).
        // No `;`/`#`/`"` in the command: git stores it unquoted, both tools read it alike.
        for (const dir of [pair.peer, pair.ours]) {
          runGit(['-C', dir, 'config', 'merge.cap.driver', 'echo %L-%S-%X-%Y > ph.txt && false']);
        }
        await divergeBranch('data.txt merge=cap conflict-marker-size=9\n');
        await reopen();

        // Act
        tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'feature'], { env: COMMIT_ENV });
        await repo.merge.run({ rev: 'feature', message: 'm', author: AUTHOR });

        // Assert
        const ours = await read(pair.ours, 'ph.txt');
        expect(ours).toBe(await read(pair.peer, 'ph.txt'));
        expect(ours.trim()).toMatch(/^9-[0-9a-f]{7}-HEAD-feature$/);
      });
    });
  });

  describe('Given a conflicting cherry-pick', () => {
    describe('When picking the feature commit on both tools', () => {
      it('Then the markers are labelled HEAD and the picked commit, matching git', async () => {
        // Arrange
        await divergeBranch('# no attributes\n');
        const feat = git(pair.peer, 'rev-parse', 'feature').trim();

        // Act
        tryRunGit(['-C', pair.peer, '-c', 'merge.conflictStyle=merge', 'cherry-pick', 'feature'], {
          env: COMMIT_ENV,
        });
        await repo.cherryPick.run({ commits: ['feature'] });

        // Assert
        const ours = await read(pair.ours, 'data.txt');
        expect(ours).toBe(await read(pair.peer, 'data.txt'));
        expect(ours).toContain('<<<<<<< HEAD\n');
        expect(ours).toContain(`>>>>>>> ${feat.slice(0, 7)} (feature change)\n`);
      });
    });
  });

  describe('Given a conflicting revert', () => {
    describe('When reverting the middle commit on both tools', () => {
      it('Then the markers are labelled HEAD and the parent of the reverted commit', async () => {
        // Arrange — c1 base, c2 edits the line, c3 edits it again (revert c2 conflicts).
        await writeBoth('data.txt', 'a\nb\nc\n');
        await commitBoth('c1', ['data.txt']);
        await writeBoth('data.txt', 'a\nX\nc\n');
        await commitBoth('c2 mid', ['data.txt']);
        await writeBoth('data.txt', 'a\nY\nc\n');
        await commitBoth('c3 top', ['data.txt']);
        const c2 = git(pair.peer, 'rev-parse', 'HEAD~1').trim();

        // Act
        tryRunGit(
          [
            '-C',
            pair.peer,
            '-c',
            'core.editor=true',
            '-c',
            'merge.conflictStyle=merge',
            'revert',
            '--no-edit',
            c2,
          ],
          { env: COMMIT_ENV },
        );
        await repo.revert.run({ commits: [c2] });

        // Assert
        const ours = await read(pair.ours, 'data.txt');
        expect(ours).toBe(await read(pair.peer, 'data.txt'));
        expect(ours).toContain('<<<<<<< HEAD\n');
        expect(ours).toContain(`>>>>>>> parent of ${c2.slice(0, 7)} (c2 mid)\n`);
      });
    });
  });

  describe('Given a conflicting rebase', () => {
    describe('When rebasing the topic onto main on both tools', () => {
      it('Then the markers are labelled HEAD and the replayed commit, matching git', async () => {
        // Arrange
        await divergeBranch('# no attributes\n');
        const feat = git(pair.peer, 'rev-parse', 'feature').trim();
        await checkoutBoth('feature');

        // Act
        tryRunGit(['-C', pair.peer, '-c', 'merge.conflictStyle=merge', 'rebase', 'main'], {
          env: COMMIT_ENV,
        });
        await repo.rebase.run({ upstream: 'main' });

        // Assert
        const ours = await read(pair.ours, 'data.txt');
        expect(ours).toBe(await read(pair.peer, 'data.txt'));
        expect(ours).toContain('<<<<<<< HEAD\n');
        expect(ours).toContain(`>>>>>>> ${feat.slice(0, 7)} (feature change)\n`);
      });
    });
  });

  describe('Given a conflicting stash apply', () => {
    describe('When the working tree diverged on the stashed path', () => {
      it('Then the markers read Updated upstream / Stashed changes, matching git', async () => {
        // Arrange
        await writeBoth('data.txt', 'base\n');
        await commitBoth('base', ['data.txt']);
        await writeBoth('data.txt', 'stashed\n');
        runGit(['-C', pair.peer, 'stash'], { env: COMMIT_ENV });
        await repo.stash.push();
        await writeBoth('data.txt', 'current\n');
        await commitBoth('diverge', ['data.txt']);
        await reopen();

        // Act
        tryRunGit(['-C', pair.peer, '-c', 'merge.conflictStyle=merge', 'stash', 'apply'], {
          env: COMMIT_ENV,
        });
        await repo.stash.apply();

        // Assert
        const ours = await read(pair.ours, 'data.txt');
        expect(ours).toBe(await read(pair.peer, 'data.txt'));
        expect(ours).toContain('<<<<<<< Updated upstream\n');
        expect(ours).toContain('>>>>>>> Stashed changes\n');
      });
    });
  });
});

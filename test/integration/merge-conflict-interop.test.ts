/**
 * Cross-tool interop — per-region conflict materialisation. Builds the same
 * overlapping edit in a canonical-git peer and a tsgit repo, runs the (failing)
 * content merge on both, and asserts the conflicted working-tree file and the
 * stage-1/2/3 index agree with real `git` for: a single trimmed overlap, two
 * conflicts coalesced by a ≤3-line gap, and two conflicts kept separate by a
 * 4-line gap. The `<<<<<<<`/`>>>>>>>` *label* text is
 * normalised away (tsgit writes `ours`, git writes `HEAD` — a separate,
 * pre-existing gap); everything else is compared byte-for-byte.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         per-region conflict markers (trim + coalesce) match git
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

/** Strip the marker *label* (tsgit: `ours`/`theirs`, git: `HEAD`/branch) so only structure is compared. */
const normaliseMarkers = (content: string): string =>
  content.replace(/^(<<<<<<<|>>>>>>>) .*$/gm, '$1');

describe.skipIf(!GIT_AVAILABLE)('merge interop — per-region conflict materialisation', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('merge-conflict');
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
    runGit(['-C', pair.peer, 'commit', '-q', '-m', message], {
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

  /** base on main, theirs branch edits to `theirsContent`, ours (main) edits to `oursContent`. */
  const divergeFile = async (
    base: string,
    oursContent: string,
    theirsContent: string,
  ): Promise<void> => {
    await writeBoth('file.txt', base);
    await commitBoth('base', ['file.txt']);
    await branchBoth('theirs');
    await writeBoth('file.txt', theirsContent);
    await commitBoth('theirs-edit', ['file.txt']);
    await checkoutBoth('main');
    await writeBoth('file.txt', oursContent);
    await commitBoth('ours-edit', ['file.txt']);
  };

  /**
   * Run the (conflicting) merge on both tools; both leave markers in the worktree.
   * tsgit implements git's default 2-way `merge.conflictStyle`.
   */
  const mergeBothConflict = async (): Promise<void> => {
    const peerMerge = tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
      env: COMMIT_ENV,
    });
    const result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });
    expect(peerMerge.ok).toBe(false);
    expect(result.kind).toBe('conflict');
  };

  const expectConflictMatch = async (): Promise<void> => {
    expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
    expect(normaliseMarkers(await read(pair.ours, 'file.txt'))).toBe(
      normaliseMarkers(await read(pair.peer, 'file.txt')),
    );
  };

  describe('Given a single overlap with shared edges', () => {
    describe('When the content merge conflicts on both tools', () => {
      it('Then only the differing middle is marked, matching git', async () => {
        // Arrange
        await divergeFile('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n');

        // Act
        await mergeBothConflict();

        // Assert
        await expectConflictMatch();
        expect(normaliseMarkers(await read(pair.ours, 'file.txt'))).toBe(
          'a\n<<<<<<<\nX\n=======\nY\n>>>>>>>\nc\n',
        );
      });
    });
  });

  describe('Given two conflicts separated by three common lines', () => {
    describe('When the content merge conflicts on both tools', () => {
      it('Then they coalesce into one block with the gap on both sides, matching git', async () => {
        // Arrange
        await divergeFile(
          'H\nX\nm1\nm2\nm3\nY\nT\n',
          'H\nXo\nm1\nm2\nm3\nYo\nT\n',
          'H\nXt\nm1\nm2\nm3\nYt\nT\n',
        );

        // Act
        await mergeBothConflict();

        // Assert
        await expectConflictMatch();
      });
    });
  });

  describe('Given two conflicts separated by four common lines', () => {
    describe('When the content merge conflicts on both tools', () => {
      it('Then they stay two separate blocks, matching git', async () => {
        // Arrange
        await divergeFile(
          'H\nX\nm1\nm2\nm3\nm4\nY\nT\n',
          'H\nXo\nm1\nm2\nm3\nm4\nYo\nT\n',
          'H\nXt\nm1\nm2\nm3\nm4\nYt\nT\n',
        );

        // Act
        await mergeBothConflict();

        // Assert
        await expectConflictMatch();
      });
    });
  });
});

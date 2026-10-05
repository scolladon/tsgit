/**
 * Cross-tool interop — git's `remove_branch_state`. A stopped merge, pick or
 * revert is built by canonical git, copied, then ended once by git and once by
 * tsgit; the in-progress state files each leaves behind must agree.
 *
 * @proves
 *   surface:        branch-state
 *   bucket:         cross-tool-interop
 *   unique:         ending a stopped operation removes the same branch-state files as git
 *   interopSurface: branch-state
 */
import { existsSync } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const IDENTITY = { name: 'Ada', email: 'ada@example.com', date: '1700000000 +0000' };

const ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_AUTHOR_DATE: IDENTITY.date,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  GIT_COMMITTER_DATE: IDENTITY.date,
};

const STATE_FILES = [
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'SQUASH_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'AUTO_MERGE',
  'ORIG_HEAD',
  'sequencer',
] as const;

const gitIn = (dir: string, ...args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: ENV });

const stateFilesOf = (dir: string): ReadonlyArray<string> =>
  STATE_FILES.filter((name) => existsSync(path.join(dir, '.git', name)));

describe.skipIf(!GIT_AVAILABLE)('branch-state removal interop', () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('branch-state');
    repo = undefined;
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const write = (file: string, content: string): Promise<void> =>
    writeFile(path.join(pair.peer, file), content);

  const commitAll = async (file: string, content: string, message: string): Promise<void> => {
    await write(file, content);
    gitIn(pair.peer, 'add', file);
    runGit(['-C', pair.peer, 'commit', '-q', '-m', message], { env: ENV });
  };

  /** main and side both rewrite `f`; side then adds `h` twice. */
  const seedDivergedHistory = async (): Promise<void> => {
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    gitIn(pair.peer, 'config', 'commit.gpgsign', 'false');
    gitIn(pair.peer, 'config', 'user.name', IDENTITY.name);
    gitIn(pair.peer, 'config', 'user.email', IDENTITY.email);
    await commitAll('f', 'base\n', 'base');
    gitIn(pair.peer, 'checkout', '-q', '-b', 'side');
    await commitAll('f', 'side\n', 'side');
    await commitAll('h', 's2\n', 'side2');
    await commitAll('h', 's3\n', 'side3');
    gitIn(pair.peer, 'checkout', '-q', 'main');
    await commitAll('f', 'main\n', 'main');
  };

  const openOurCopy = async (warnings: string[] = []): Promise<Repository> => {
    await cp(pair.peer, pair.ours, { recursive: true });
    repo = await openRepository({
      cwd: pair.ours,
      logger: { warn: (message: string) => warnings.push(message) },
    });
    return repo;
  };

  const resolveF = async (): Promise<void> => {
    await write('f', 'resolved\n');
    gitIn(pair.peer, 'add', 'f');
  };

  const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (err) {
      return (err as { data?: unknown }).data;
    }
    return undefined;
  };

  describe('Given a merge stopped on a conflict', () => {
    describe('When both tools reset --hard', () => {
      it('Then both leave only ORIG_HEAD', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', 'side');
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '--hard');
        await sut({ mode: 'hard', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['ORIG_HEAD']);
      });
    });

    describe('When both tools reset --soft', () => {
      it('Then both refuse in the middle of a merge and keep the state', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', 'side');
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        const git = gitIn(pair.peer, 'reset', '--soft');
        const result = await codeOf(() => sut({ mode: 'soft', rev: 'HEAD' }));

        // Assert
        expect(git.stderr).toBe('fatal: Cannot do a soft reset in the middle of a merge.\n');
        expect(result).toEqual({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
        expect(stateFilesOf(pair.ours)).toEqual(stateFilesOf(pair.peer));
      });
    });
  });

  describe('Given a multi-pick stopped on its first pick, resolved', () => {
    describe('When both tools reset --soft', () => {
      it('Then both drop the pick state and keep the sequencer', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'cherry-pick', 'side~2', 'side~1');
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '--soft');
        await sut({ mode: 'soft', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['ORIG_HEAD', 'sequencer']);
      });
    });
  });

  describe('Given a multi-pick stopped on its last pick, resolved', () => {
    describe('When both tools reset --mixed', () => {
      it('Then both drop the pick state and the sequencer', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'cherry-pick', 'side~1', 'side~2');
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset');
        await sut({ mode: 'mixed', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['ORIG_HEAD']);
      });
    });
  });

  describe('Given a squash merge awaiting its commit', () => {
    describe('When both tools reset --hard', () => {
      it('Then both drop SQUASH_MSG', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', '--squash', 'side');
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '--hard');
        await sut({ mode: 'hard', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['ORIG_HEAD']);
      });
    });
  });

  describe('Given a history whose tip a reset steps back from', () => {
    describe('When both tools reset --mixed HEAD~1', () => {
      it('Then both record the tip left behind as ORIG_HEAD', async () => {
        // Arrange
        await seedDivergedHistory();
        const tip = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']);
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '-q', 'HEAD~1');
        await sut({ mode: 'mixed', rev: 'HEAD~1' });

        // Assert
        const result = await readFile(path.join(pair.ours, '.git', 'ORIG_HEAD'), 'utf8');
        expect(result).toBe(await readFile(path.join(pair.peer, '.git', 'ORIG_HEAD'), 'utf8'));
        expect(result).toBe(tip);
      });
    });
  });

  describe.each([
    ['a multi-pick stopped on its last pick', ['cherry-pick', 'side~1', 'side~2'], []],
    ['a multi-pick stopped on its first pick', ['cherry-pick', 'side~2', 'side~1'], ['sequencer']],
    ['a squash merge', ['merge', '--squash', 'side'], ['ORIG_HEAD']],
  ])('Given %s, resolved', (_label, stop, expected) => {
    describe('When both tools commit the resolution', () => {
      it('Then both leave the same branch state behind', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, ...stop);
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.commit;

        // Act
        gitIn(pair.peer, 'commit', '-q', '-m', 'resolved');
        await sut({ message: 'resolved' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a cherry-pick stopped on a conflict, resolved to HEAD', () => {
    describe('When both tools checkout another branch', () => {
      it('Then both switch, warn of the cancelled pick and drop its state', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'cherry-pick', 'side~2');
        gitIn(pair.peer, 'checkout', 'HEAD', '--', 'f');
        const warnings: string[] = [];
        const ours = await openOurCopy(warnings);
        const sut = ours.checkout;

        // Act
        const git = gitIn(pair.peer, 'checkout', 'side');
        await sut({ rev: 'side' });

        // Assert
        expect(git.stderr).toContain('warning: cancelling a cherry picking in progress\n');
        expect(warnings).toEqual(['cancelling a cherry picking in progress']);
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a merge stopped on a conflict', () => {
    describe('When both tools checkout another branch', () => {
      it('Then both refuse until the index is resolved', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', 'side');
        const ours = await openOurCopy();
        const sut = ours.checkout;

        // Act
        const git = gitIn(pair.peer, 'checkout', 'side');
        const result = await codeOf(() => sut({ rev: 'side' }));

        // Assert
        expect(git.stderr).toBe('error: you need to resolve your current index first\n');
        expect(result).toEqual({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['f'] });
        expect(stateFilesOf(pair.ours)).toEqual(stateFilesOf(pair.peer));
      });
    });
  });

  describe("Given a merge stopped on a conflict, with git's AUTO_MERGE beside it", () => {
    describe('When both tools abort the merge', () => {
      it('Then both drop the whole merge state', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', 'side');
        const ours = await openOurCopy();
        const sut = ours.merge.abort;

        // Act
        gitIn(pair.peer, 'merge', '--abort');
        await sut();

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['ORIG_HEAD']);
      });
    });
  });

  describe.each([
    ['cherry-pick', ['cherry-pick', 'side~2'], 'skip'],
    ['cherry-pick', ['cherry-pick', 'side~2'], 'abort'],
    ['revert', ['revert', '--no-edit', 'HEAD~1'], 'abort'],
  ] as const)('Given a %s stopped on a conflict', (op, stop, verb) => {
    describe(`When both tools end it with --${verb}`, () => {
      it('Then both drop the stop and record the HEAD they left as ORIG_HEAD', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, ...stop);
        const ours = await openOurCopy();
        const namespace = op === 'revert' ? ours.revert : ours.cherryPick;
        const sut = verb === 'skip' ? namespace.skip : namespace.abort;

        // Act
        gitIn(pair.peer, op, `--${verb}`);
        await sut();

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['ORIG_HEAD']);
        const origHead = (dir: string) => readFile(path.join(dir, '.git', 'ORIG_HEAD'), 'utf8');
        expect(await origHead(pair.ours)).toBe(await origHead(pair.peer));
      });
    });
  });

  describe('Given a rebase stopped on a conflict', () => {
    describe('When both tools abort it', () => {
      it('Then both drop the stop state', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'rebase', 'side');
        const ours = await openOurCopy();
        const sut = ours.rebase.abort;

        // Act
        gitIn(pair.peer, 'rebase', '--abort');
        await sut();

        // Assert
        const result = stateFilesOf(pair.ours).filter((name) => name !== 'ORIG_HEAD');
        expect(result).toEqual(stateFilesOf(pair.peer).filter((name) => name !== 'ORIG_HEAD'));
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given stale merge files and a branch HEAD already contains', () => {
    describe('When both tools merge it', () => {
      it('Then both conclude up to date and drop the stale merge files', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'branch', 'old', 'main~1');
        const tip = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']);
        for (const name of ['MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE', 'SQUASH_MSG']) {
          await writeFile(path.join(pair.peer, '.git', name), tip);
        }
        const ours = await openOurCopy();
        const sut = ours.merge.run;

        // Act
        const git = gitIn(pair.peer, 'merge', 'old');
        const merged = await sut({ rev: 'old' });

        // Assert
        expect(git.stdout).toBe('Already up to date.\n');
        expect(merged.kind).toBe('up-to-date');
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['SQUASH_MSG', 'ORIG_HEAD']);
      });
    });
  });
});

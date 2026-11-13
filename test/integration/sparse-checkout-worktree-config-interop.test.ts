/**
 * Cross-tool interop — sparse-checkout keys in the per-worktree config layer.
 *
 * @proves
 *   surface:        sparseCheckoutConfig
 *   bucket:         cross-tool-interop
 *   unique:         sparse keys resolve local-then-worktree and are written to config.worktree as git does
 *   interopSurface: config, sparseCheckoutFile
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';
import { commitOn, listing, regular } from './occupant-displacement-fixtures.js';

const CONE_FILE = '/*\n!/*/\n/b/\n';
const seedFixture = (dir: string): void => {
  const main = commitOn(dir, [
    regular('a/f', 'f1\n'),
    regular('b/f', 'f1\n'),
    regular('top', 't\n'),
  ]);
  const other = commitOn(
    dir,
    [regular('a/f', 'f2\n'), regular('a/g', 'g\n'), regular('b/f', 'f2\n'), regular('top', 't\n')],
    main,
  );
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/other', other]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const tagView = async (repo: Repository): Promise<string> =>
  (await readIndex(repo.ctx)).entries
    .map((e) => `${e.flags.skipWorktree ? 'S' : 'H'} ${e.path}\n`)
    .join('');
const gitTagView = (dir: string): string => runGit(['-C', dir, 'ls-files', '-t']);

const writeConeFile = (dir: string): void => {
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'sparse-checkout'), CONE_FILE);
};
const gitConfig = (dir: string, key: string, value: string): void => {
  runGit(['-C', dir, 'config', key, value]);
};

interface ReaderRow {
  readonly id: string;
  readonly extension: string | undefined;
  readonly local: ReadonlyArray<readonly [string, string]>;
  readonly worktreeFile: string | undefined;
  readonly listingOnly?: boolean;
  readonly viaSet?: boolean;
}

const WT_TRUE = '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n';
const CONE_ON: readonly [string, string] = ['core.sparseCheckoutCone', 'true'];

const READER_ROWS: ReadonlyArray<ReaderRow> = [
  { id: 'T0', extension: undefined, local: [], worktreeFile: undefined, viaSet: true },
  { id: 'R1', extension: undefined, local: [], worktreeFile: WT_TRUE },
  {
    id: 'R2',
    extension: 'true',
    local: [CONE_ON],
    worktreeFile: '[core]\n\tsparseCheckout = true\n',
  },
  {
    id: 'R3',
    extension: 'true',
    local: [['core.sparseCheckout', 'true'], CONE_ON],
    worktreeFile: undefined,
  },
  {
    id: 'R4',
    extension: 'true',
    local: [['core.sparseCheckout', 'true'], CONE_ON],
    worktreeFile: '[core]\n\tsparseCheckout = false\n',
  },
  {
    id: 'R5',
    extension: 'true',
    local: [['core.sparseCheckout', 'false'], CONE_ON],
    worktreeFile: '[core]\n\tsparseCheckout = true\n',
  },
  {
    id: 'R11',
    extension: undefined,
    local: [],
    worktreeFile: '[core]\n\tsparseCheckout = bogus\n',
  },
  { id: 'M2', extension: undefined, local: [], worktreeFile: '[core' },
  { id: 'V1', extension: 'true', local: [CONE_ON], worktreeFile: '[core]\n\tsparseCheckout\n' },
  {
    id: 'D1',
    extension: 'true',
    local: [],
    worktreeFile: '[core]\n\tsparseCheckout = true\n\tsparseCheckout = false\n',
  },
  {
    id: 'X1',
    extension: 'yes',
    local: [CONE_ON],
    worktreeFile: '[core]\n\tsparseCheckout = true\n',
  },
];

describe.skipIf(!GIT_AVAILABLE)('sparse-checkout worktree-config interop', () => {
  let pair: PeerPair;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    pair = await makePeerPair('sparse-worktree-config');
    initBothRepos(pair.peer, pair.ours);
    for (const dir of [pair.peer, pair.ours]) seedFixture(dir);
  });

  afterEach(async () => {
    await pair.dispose();
    for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const bothSides = (action: (dir: string) => void): void => {
    for (const dir of [pair.peer, pair.ours]) action(dir);
  };

  const prepare = (row: ReaderRow): void =>
    bothSides((dir) => {
      if (row.viaSet === true) {
        runGit(['-C', dir, 'sparse-checkout', 'set', '--cone', 'b']);
        return;
      }
      writeConeFile(dir);
      if (row.extension !== undefined) gitConfig(dir, 'extensions.worktreeConfig', row.extension);
      for (const [key, value] of row.local) gitConfig(dir, key, value);
      if (row.worktreeFile !== undefined) {
        writeFileSync(join(dir, '.git', 'config.worktree'), row.worktreeFile);
      }
    });

  describe.each(READER_ROWS)('Given reader row $id', (row) => {
    describe('When both tools check out the other branch', () => {
      it('Then the index tags and the work tree match git', async () => {
        // Arrange
        prepare(row);
        runGit(['-C', pair.peer, 'checkout', '-q', 'other']);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.checkout({ rev: 'other' });

        // Assert
        expect(await tagView(repo)).toBe(gitTagView(pair.peer));
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
      });
    });
  });

  describe('Given the extension switched off after a sparse set', () => {
    describe('When both tools check out the other branch', () => {
      it('Then the work tree matches git', async () => {
        // Arrange
        bothSides((dir) => {
          runGit(['-C', dir, 'sparse-checkout', 'set', '--cone', 'b']);
          gitConfig(dir, 'extensions.worktreeConfig', 'false');
        });
        runGit(['-C', pair.peer, 'checkout', '-q', 'other']);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.checkout({ rev: 'other' });

        // Assert
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
      });
    });
  });

  describe('Given a sparse work tree set through git', () => {
    const sparseSet = (): void =>
      bothSides((dir) => runGit(['-C', dir, 'sparse-checkout', 'set', '--cone', 'b']));
    const expectSameState = async (repo: Repository): Promise<void> => {
      expect(await tagView(repo)).toBe(gitTagView(pair.peer));
      expect(listing(pair.ours)).toEqual(listing(pair.peer));
    };

    describe('When both tools reset --hard to the other branch', () => {
      it('Then the index tags and the work tree match git', async () => {
        // Arrange
        sparseSet();
        runGit(['-C', pair.peer, 'reset', '-q', '--hard', 'other']);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.reset({ mode: 'hard', rev: 'other' });

        // Assert
        await expectSameState(repo);
      });
    });

    describe('When both tools reset --mixed to the other branch', () => {
      it('Then the index tags and the work tree match git', async () => {
        // Arrange
        sparseSet();
        runGit(['-C', pair.peer, 'reset', '-q', 'other']);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.reset({ mode: 'mixed', rev: 'other' });

        // Assert
        await expectSameState(repo);
      });
    });
  });

  describe('Given a linked worktree made sparse through git', () => {
    interface Side {
      readonly main: string;
      readonly linked: string;
    }
    const linkedSide = async (main: string): Promise<Side> => {
      const parent = await mkdtemp(join(tmpdir(), 'tsgit-wt-'));
      extraDirs.push(parent);
      const linked = join(parent, 'wt');
      runGit(['-C', main, 'worktree', 'add', '-q', linked, '-b', 'side']);
      runGit(['-C', linked, 'sparse-checkout', 'set', '--cone', 'b']);
      return { main, linked };
    };

    describe('When both tools detach-checkout the other branch in the main worktree', () => {
      it('Then the main worktree stays unaffected as in git', async () => {
        // Arrange
        const peer = await linkedSide(pair.peer);
        const ours = await linkedSide(pair.ours);
        runGit(['-C', peer.main, 'checkout', '-q', '--detach', 'other']);
        const repo = await openRepository({ cwd: ours.main });

        // Act
        await repo.checkout({ rev: 'other', detach: true });

        // Assert
        expect(await tagView(repo)).toBe(gitTagView(peer.main));
        expect(listing(ours.main).filter((e) => !e.startsWith('.'))).toEqual(
          listing(peer.main).filter((e) => !e.startsWith('.')),
        );
      });
    });

    describe('When both tools detach-checkout the other branch in the linked worktree', () => {
      it('Then the index tags and the work tree match git', async () => {
        // Arrange
        const peer = await linkedSide(pair.peer);
        const ours = await linkedSide(pair.ours);
        runGit(['-C', peer.linked, 'checkout', '-q', '--detach', 'other']);
        const repo = await openRepository({ cwd: ours.linked });

        // Act
        await repo.checkout({ rev: 'other', detach: true });

        // Assert
        expect(await tagView(repo)).toBe(gitTagView(peer.linked));
        expect(listing(ours.linked)).toEqual(listing(peer.linked));
        expect(existsSync(join(ours.main, '.git', 'worktrees', 'wt', 'config.worktree'))).toBe(
          existsSync(join(peer.main, '.git', 'worktrees', 'wt', 'config.worktree')),
        );
      });
    });
  });
});

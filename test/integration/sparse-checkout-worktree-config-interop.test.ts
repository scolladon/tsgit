/**
 * Cross-tool interop — sparse-checkout keys in the per-worktree config layer.
 *
 * @proves
 *   surface:        sparseCheckoutConfig
 *   bucket:         cross-tool-interop
 *   unique:         sparse keys resolve local-then-worktree and are written to config.worktree as git does
 *   interopSurface: config, sparseCheckoutFile
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { COMMIT_ENV, commitOn, listing, regular } from './occupant-displacement-fixtures.js';

const CONE_FILE = '/*\n!/*/\n/b/\n';
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

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

    describe('When both tools fast-forward merge the other branch', () => {
      it('Then the index tags and the work tree match git', async () => {
        // Arrange
        sparseSet();
        runGit(['-C', pair.peer, 'merge', '-q', '--ff-only', 'other']);
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.merge.run({ rev: 'other', fastForward: 'only' });

        // Assert
        await expectSameState(repo);
      });
    });
  });

  describe('Given a diverged main and a sparse work tree set through git', () => {
    describe('When both tools three-way merge the other branch', () => {
      it('Then the index tags and the work tree match git', async () => {
        // Arrange
        bothSides((dir) => {
          const main = runGit(['-C', dir, 'rev-parse', 'main']).trim();
          const next = commitOn(
            dir,
            [regular('a/f', 'f1\n'), regular('b/f', 'f1\n'), regular('top', 't2\n')],
            main,
          );
          runGit(['-C', dir, 'update-ref', 'refs/heads/main', next]);
          runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
          runGit(['-C', dir, 'sparse-checkout', 'set', '--cone', 'b']);
        });
        runGit(['-C', pair.peer, 'merge', '-q', '--no-edit', 'other'], { env: COMMIT_ENV });
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR });

        // Assert
        expect(await tagView(repo)).toBe(gitTagView(pair.peer));
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
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

  describe('Given the verbs run on a sparse repository', () => {
    const readFile = (dir: string, name: string): string =>
      readFileSync(join(dir, '.git', name), 'utf8');
    const gitList = (dir: string): ReadonlyArray<string> =>
      runGit(['-C', dir, 'sparse-checkout', 'list'])
        .split('\n')
        .filter((line) => line !== '');
    const expectSameConfigFiles = (): void => {
      expect(readFile(pair.ours, 'config')).toBe(readFile(pair.peer, 'config'));
      expect(existsSync(join(pair.ours, '.git', 'config.worktree'))).toBe(
        existsSync(join(pair.peer, '.git', 'config.worktree')),
      );
      if (existsSync(join(pair.peer, '.git', 'config.worktree'))) {
        expect(readFile(pair.ours, 'config.worktree')).toBe(readFile(pair.peer, 'config.worktree'));
      }
    };
    const expectSamePatternFile = (): void => {
      expect(readFile(pair.ours, 'info/sparse-checkout')).toBe(
        readFile(pair.peer, 'info/sparse-checkout'),
      );
    };
    const sparseSetCone = (): void =>
      bothSides((dir) => runGit(['-C', dir, 'sparse-checkout', 'set', '--cone', 'b']));
    const localOnly = (cone: string): void =>
      bothSides((dir) => {
        writeConeFile(dir);
        gitConfig(dir, 'core.sparseCheckout', 'true');
        gitConfig(dir, 'core.sparseCheckoutCone', cone);
      });
    const writePatterns = (text: string): void =>
      bothSides((dir) => {
        mkdirSync(join(dir, '.git', 'info'), { recursive: true });
        writeFileSync(join(dir, '.git', 'info', 'sparse-checkout'), text);
      });

    describe('When both tools list after the cone key flips in the worktree layer', () => {
      it('Then the list matches git before and after the flip', async () => {
        // Arrange
        sparseSetCone();
        const sut = async (): Promise<{ cone: boolean; patterns: ReadonlyArray<string> }> => {
          const repo = await openRepository({ cwd: pair.ours });
          return repo.sparseCheckout.list();
        };

        // Act
        const before = await sut();
        const gitBefore = gitList(pair.peer);
        bothSides((dir) =>
          runGit(['-C', dir, 'config', '--worktree', 'core.sparseCheckoutCone', 'false']),
        );
        const after = await sut();
        const gitAfter = gitList(pair.peer);

        // Assert
        expect(before).toEqual({ cone: true, patterns: gitBefore });
        expect(after).toEqual({ cone: false, patterns: gitAfter });
        expect(after.patterns).toEqual(['/*', '!/*/', '/b/']);
      });
    });

    describe.each([
      {
        id: 'R7',
        cone: 'false',
        worktree: '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n',
        local: 'true',
      },
      {
        id: 'R8',
        cone: 'true',
        worktree: '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n',
        local: 'false',
      },
    ])('Given layered cone keys, row $id', (row) => {
      describe('When both tools list', () => {
        it('Then the list matches git', async () => {
          // Arrange
          bothSides((dir) => {
            writeConeFile(dir);
            gitConfig(dir, 'extensions.worktreeConfig', 'true');
            gitConfig(dir, 'core.sparseCheckout', 'true');
            gitConfig(dir, 'core.sparseCheckoutCone', row.local);
            writeFileSync(join(dir, '.git', 'config.worktree'), row.worktree);
          });
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.sparseCheckout.list;

          // Act
          const result = await sut();

          // Assert
          expect(result.patterns).toEqual(gitList(pair.peer));
          expect(result.cone).toBe(row.cone === 'true');
        });
      });
    });

    describe('Given the extension off and a worktree file holding a cone key', () => {
      describe('When both tools list', () => {
        it('Then the worktree file is ignored as in git', async () => {
          // Arrange
          bothSides((dir) => {
            writeConeFile(dir);
            gitConfig(dir, 'core.sparseCheckout', 'true');
            gitConfig(dir, 'core.sparseCheckoutCone', 'true');
            writeFileSync(
              join(dir, '.git', 'config.worktree'),
              '[core]\n\tsparseCheckoutCone = false\n',
            );
          });
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.sparseCheckout.list;

          // Act
          const result = await sut();

          // Assert
          expect(result.patterns).toEqual(gitList(pair.peer));
          expect(result.cone).toBe(true);
        });
      });
    });

    describe('Given a cone set through git', () => {
      describe('When both tools add a directory', () => {
        it('Then the config files, pattern file and tags match git', async () => {
          // Arrange
          sparseSetCone();
          runGit(['-C', pair.peer, 'sparse-checkout', 'add', 'a']);
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.sparseCheckout.add;

          // Act
          await sut({ patterns: ['a'] });

          // Assert
          expectSameConfigFiles();
          expectSamePatternFile();
          expect(await tagView(repo)).toBe(gitTagView(pair.peer));
        });
      });

      describe('When both tools reapply', () => {
        it('Then the config files and tags match git and the cone is reported', async () => {
          // Arrange
          sparseSetCone();
          runGit(['-C', pair.peer, 'sparse-checkout', 'reapply']);
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.sparseCheckout.reapply;

          // Act
          const result = await sut();

          // Assert
          expect(result.cone).toBe(true);
          expectSameConfigFiles();
          expect(await tagView(repo)).toBe(gitTagView(pair.peer));
        });
      });
    });

    describe('Given a local-only sparse non-cone repository', () => {
      describe('When both tools add a pattern', () => {
        it('Then the config stays unchanged and the pattern file matches git', async () => {
          // Arrange
          bothSides((dir) => gitConfig(dir, 'core.sparseCheckout', 'true'));
          writePatterns('/b/\n');
          runGit(['-C', pair.peer, 'sparse-checkout', 'add', 'a']);
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.sparseCheckout.add;

          // Act
          await sut({ patterns: ['a'] });

          // Assert
          expectSameConfigFiles();
          expectSamePatternFile();
          expect(readFile(pair.ours, 'info/sparse-checkout')).toBe('/b/\na\n');
        });
      });
    });

    describe.each([
      { id: 'B7', cone: 'true' },
      { id: 'B8', cone: 'true' },
    ])('Given a local true/true repository, row $id', (row) => {
      describe('When both tools run the verb', () => {
        it('Then the config files match git', async () => {
          // Arrange
          localOnly(row.cone);
          const gitVerb = row.id === 'B7' ? ['add', 'a'] : ['reapply'];
          runGit(['-C', pair.peer, 'sparse-checkout', ...gitVerb]);
          const repo = await openRepository({ cwd: pair.ours });

          // Act
          if (row.id === 'B7') await repo.sparseCheckout.add({ patterns: ['a'] });
          else await repo.sparseCheckout.reapply();

          // Assert
          expectSameConfigFiles();
        });
      });
    });

    describe.each([
      { id: 'S1', cone: 'false', patterns: ['/a/'], expected: '/a/\n' },
      { id: 'S2', cone: 'true', patterns: ['a'], expected: undefined },
    ])('Given a local sparse repository without an explicit mode, row $id', (row) => {
      describe('When both tools set patterns without a cone flag', () => {
        it('Then the config files and pattern file match git', async () => {
          // Arrange
          localOnly(row.cone);
          runGit(['-C', pair.peer, 'sparse-checkout', 'set', ...row.patterns]);
          const repo = await openRepository({ cwd: pair.ours });
          const sut = repo.sparseCheckout.set;

          // Act
          await sut({ patterns: row.patterns });

          // Assert
          expectSameConfigFiles();
          expectSamePatternFile();
          if (row.expected !== undefined) {
            expect(readFile(pair.ours, 'info/sparse-checkout')).toBe(row.expected);
          }
        });
      });
    });
  });
});

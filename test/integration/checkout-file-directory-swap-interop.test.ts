/**
 * Cross-tool interop — checkout swaps a regular file for a directory at the
 * same path and back. Real git builds the history, both tools switch branches,
 * and the work tree plus `ls-files -s` are compared.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout file<->directory swap runs against git
 *   interopSurface: checkout
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  lsStage,
  makePeerPair,
  type PeerPair,
  tryRunGit,
} from './interop-helpers.js';

const buildHistory = (dir: string): void => {
  writeFileSync(path.join(dir, 'b'), 'b\n');
  git(dir, 'add', 'b');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  mkdirSync(path.join(dir, 'f'));
  writeFileSync(path.join(dir, 'f', 'x'), 'x\n');
  git(dir, 'add', 'f/x');
  git(dir, 'commit', '-q', '-m', 'adds directory f');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'f'), 'file\n');
  git(dir, 'add', 'f');
  git(dir, 'commit', '-q', '-m', 'adds file f');
};

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — regular file <-> directory swap',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('checkout-file-dir-swap');
      initBothRepos(pair.peer, pair.ours);
      buildHistory(pair.peer);
      buildHistory(pair.ours);
      repo = await openRepository({ cwd: pair.ours });
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe('Given main holds file f and side holds directory f/', () => {
      describe('When both tools checkout side', () => {
        it('Then f/x replaces the file f, matching git', async () => {
          // Arrange
          git(pair.peer, 'checkout', '-q', 'side');

          // Act
          await repo.checkout({ rev: 'side' });

          // Assert
          expect(readFileSync(path.join(pair.ours, 'f', 'x'), 'utf8')).toBe('x\n');
          expect(lstatSync(path.join(pair.ours, 'f')).isDirectory()).toBe(
            lstatSync(path.join(pair.peer, 'f')).isDirectory(),
          );
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    describe('Given both tools sit on side holding directory f/ and main holds file f', () => {
      describe('When both tools checkout main', () => {
        it('Then file f replaces the directory, matching git', async () => {
          // Arrange
          git(pair.peer, 'checkout', '-q', 'side');
          await repo.checkout({ rev: 'side' });

          // Act
          git(pair.peer, 'checkout', '-q', 'main');
          await repo.checkout({ rev: 'main' });

          // Assert
          expect(readFileSync(path.join(pair.ours, 'f'), 'utf8')).toBe('file\n');
          expect(lstatSync(path.join(pair.ours, 'f')).isFile()).toBe(
            lstatSync(path.join(pair.peer, 'f')).isFile(),
          );
          expect(existsSync(path.join(pair.ours, 'f', 'x'))).toBe(false);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    describe('Given both tools sit on side with an untracked file inside directory f/', () => {
      describe('When both tools checkout main', () => {
        it('Then both refuse and keep the untracked file', async () => {
          // Arrange
          git(pair.peer, 'checkout', '-q', 'side');
          await repo.checkout({ rev: 'side' });
          writeFileSync(path.join(pair.peer, 'f', 'y'), 'y\n');
          writeFileSync(path.join(pair.ours, 'f', 'y'), 'y\n');

          // Act
          const peerRefused = !tryRunGit(['-C', pair.peer, 'checkout', 'main']).ok;
          let oursCode: string | undefined;
          try {
            await repo.checkout({ rev: 'main' });
          } catch (err) {
            oursCode = (err as TsgitError).data.code;
          }

          // Assert
          expect(peerRefused).toBe(true);
          expect(oursCode).toBe('CHECKOUT_OVERWRITE_DIRTY');
          expect(readFileSync(path.join(pair.ours, 'f', 'y'), 'utf8')).toBe('y\n');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });
  },
);

const listWorkTree = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry !== '.git' && !entry.startsWith(`.git${path.sep}`))
    .sort();

const buildNestedHistory = (dir: string): void => {
  writeFileSync(path.join(dir, 'b'), 'b\n');
  git(dir, 'add', 'b');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  mkdirSync(path.join(dir, 'd', 'e'), { recursive: true });
  writeFileSync(path.join(dir, 'd', 'e', 'q'), 'q\n');
  mkdirSync(path.join(dir, 'f', 'g'), { recursive: true });
  writeFileSync(path.join(dir, 'f', 'g', 'x'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'adds nested directories');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'f'), 'file\n');
  git(dir, 'add', 'f');
  git(dir, 'commit', '-q', '-m', 'adds file f');
};

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — directories left empty',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('checkout-empty-dirs');
      initBothRepos(pair.peer, pair.ours);
      buildNestedHistory(pair.peer);
      buildNestedHistory(pair.ours);
      repo = await openRepository({ cwd: pair.ours });
      git(pair.peer, 'checkout', '-q', 'side');
      await repo.checkout({ rev: 'side' });
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe('Given both tools sit on side holding d/e/q and f/g/x', () => {
      describe('When both tools checkout main', () => {
        it('Then the emptied directories are gone and the work tree listing matches git', async () => {
          // Arrange
          git(pair.peer, 'checkout', '-q', 'main');

          // Act
          await repo.checkout({ rev: 'main' });

          // Assert
          expect(existsSync(path.join(pair.ours, 'd'))).toBe(false);
          expect(listWorkTree(pair.ours)).toEqual(listWorkTree(pair.peer));
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    describe('Given both tools sit on side with ignored files inside the directory f/', () => {
      describe('When both tools checkout main', () => {
        it('Then the ignored files give way to the file f, matching git', async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '*.o\n');
            writeFileSync(path.join(dir, 'f', 'junk.o'), 'j\n');
            writeFileSync(path.join(dir, 'f', 'g', 'deep.o'), 'j\n');
          }
          git(pair.peer, 'checkout', '-q', 'main');

          // Act
          await repo.checkout({ rev: 'main' });

          // Assert
          expect(lstatSync(path.join(pair.ours, 'f')).isFile()).toBe(true);
          expect(listWorkTree(pair.ours)).toEqual(listWorkTree(pair.peer));
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    describe('Given both tools sit on side with an untracked file beside d/e/q', () => {
      describe('When both tools checkout main', () => {
        it('Then the directory holding it stays, matching git', async () => {
          // Arrange
          writeFileSync(path.join(pair.peer, 'd', 'e', 'untracked'), 'u\n');
          writeFileSync(path.join(pair.ours, 'd', 'e', 'untracked'), 'u\n');
          git(pair.peer, 'checkout', '-q', 'main');

          // Act
          await repo.checkout({ rev: 'main' });

          // Assert
          expect(listWorkTree(pair.ours)).toEqual(listWorkTree(pair.peer));
          expect(existsSync(path.join(pair.ours, 'd', 'e', 'untracked'))).toBe(true);
        });
      });
    });
  },
);

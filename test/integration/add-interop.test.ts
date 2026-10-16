/**
 * Cross-tool interop — `add` porcelain. Stages the same paths via `repo.add`
 * (through the `openRepository` facade) and via canonical `git add` on a peer
 * repo, then asserts the resulting index (`git ls-files --stage`) and tree
 * (`git write-tree`) agree. Pins the staging *command* — pathspec expansion,
 * blob hashing, mode bits — to canonical git, beyond the index byte-format
 * proof (`index-interop.test.ts`) that uses add only as a vehicle.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add porcelain index+tree state matches canonical git add
 *   interopSurface: add
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  writeTreeOf,
} from './interop-helpers.js';

interface SeedFile {
  readonly path: string;
  readonly content: string;
}

interface StateSnapshot {
  readonly stage: string;
  readonly tree: string;
}

describe.skipIf(!GIT_AVAILABLE)('add porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('add');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (file: SeedFile): Promise<void> => {
    const parent = path.dirname(file.path);
    if (parent !== '.') {
      await mkdir(path.join(pair.peer, parent), { recursive: true });
      await mkdir(path.join(pair.ours, parent), { recursive: true });
    }
    await writeFile(path.join(pair.peer, file.path), file.content);
    await writeFile(path.join(pair.ours, file.path), file.content);
  };

  const snapshot = (dir: string): StateSnapshot => ({
    stage: lsStage(dir),
    tree: writeTreeOf(dir),
  });

  describe('Given a single untracked file in both repos', () => {
    describe('When repo.add stages it like git add', () => {
      it('Then the index and tree match canonical git', async () => {
        // Arrange
        await writeBoth({ path: 'a.txt', content: 'hello\n' });

        // Act
        const added = await repo.add(['a.txt']);
        runGit(['-C', pair.peer, 'add', 'a.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        expect(added.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a subdirectory of untracked files in both repos', () => {
    describe('When repo.add stages the directory pathspec like git add', () => {
      it('Then every file under it is staged identically to git', async () => {
        // Arrange
        await writeBoth({ path: 'sub/one.txt', content: '1\n' });
        await writeBoth({ path: 'sub/nested/two.txt', content: '2\n' });

        // Act
        await repo.add(['sub']);
        runGit(['-C', pair.peer, 'add', 'sub']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
      });
    });
  });

  describe('Given a staged file whose working copy is then edited', () => {
    describe('When repo.add re-stages it like git add', () => {
      it('Then the index advances to the new blob identically to git', async () => {
        // Arrange
        await writeBoth({ path: 'a.txt', content: 'first\n' });
        await repo.add(['a.txt']);
        runGit(['-C', pair.peer, 'add', 'a.txt']);
        await writeBoth({ path: 'a.txt', content: 'second\n' });

        // Act
        await repo.add(['a.txt']);
        runGit(['-C', pair.peer, 'add', 'a.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
      });
    });
  });

  describe.each([['.'], ['*.log'], ['a.log']])(
    'Given an ignored tracked file deleted from disk and pathspec %s',
    (spec) => {
      describe('When repo.add stages it like git add', () => {
        it('Then the deletion is staged identically to git', async () => {
          // Arrange
          for (const dir of [pair.ours, pair.peer]) {
            await writeFile(path.join(dir, '.gitignore'), '*.log\n');
            await writeFile(path.join(dir, 'a.log'), 'x\n');
          }
          await repo.add(['a.log']);
          runGit(['-C', pair.peer, 'add', '-f', 'a.log']);
          await repo.add(['.gitignore']);
          runGit(['-C', pair.peer, 'add', '.gitignore']);
          for (const dir of [pair.ours, pair.peer]) await rm(path.join(dir, 'a.log'));

          // Act
          const added = await repo.add([spec]);
          runGit(['-C', pair.peer, 'add', '--', spec]);
          const result = snapshot(pair.ours);

          // Assert
          const peer = snapshot(pair.peer);
          expect(added.removed).toEqual(['a.log']);
          expect(result.stage).toBe(peer.stage);
          expect(result.tree).toBe(peer.tree);
        });
      });
    },
  );

  describe('Given a tracked directory replaced by a symlink to a directory holding the same file name', () => {
    describe('When repo.add({ all }) stages it like git add -A', () => {
      it('Then the index and tree match git and keep no path beyond the link', async () => {
        // Arrange
        for (const dir of [pair.ours, pair.peer]) {
          await mkdir(path.join(dir, 'a'));
          await mkdir(path.join(dir, 'real'));
          await writeFile(path.join(dir, 'a', 'b'), 'one\n');
          await writeFile(path.join(dir, 'real', 'b'), 'two\n');
        }
        await repo.add(['.']);
        runGit(['-C', pair.peer, 'add', '.']);
        for (const dir of [pair.ours, pair.peer]) {
          await rm(path.join(dir, 'a'), { recursive: true });
          await symlink('real', path.join(dir, 'a'));
        }

        // Act
        const added = await repo.add([], { all: true });
        runGit(['-C', pair.peer, 'add', '-A']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(added.removed).toEqual(['a/b']);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
      });
    });
  });
});

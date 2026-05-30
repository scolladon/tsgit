/**
 * Cross-tool interop — `mv` porcelain. Drives `repo.mv` through the
 * `openRepository` facade and the same move via canonical `git mv` on a peer
 * repo seeded identically, then asserts the resulting index (`git ls-files
 * --stage`), tree (`git write-tree`), and working tree agree. This is the
 * faithfulness proof that the mv *orchestration* matches git — which the
 * cross-adapter parity golden (tsgit-computed) cannot vouch for.
 *
 * @proves
 *   surface:        mv
 *   bucket:         cross-tool-interop
 *   unique:         mv porcelain index+tree state matches canonical git mv
 *   interopSurface: mv
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGit,
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

describe.skipIf(!GIT_AVAILABLE)('mv porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('mv');
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

  const seed = async (files: ReadonlyArray<SeedFile>): Promise<void> => {
    for (const file of files) await writeBoth(file);
    const paths = files.map((file) => file.path);
    runGit(['-C', pair.peer, 'add', ...paths]);
    await repo.add(paths);
  };

  const snapshot = (dir: string): StateSnapshot => ({
    stage: lsStage(dir),
    tree: writeTreeOf(dir),
  });

  const pathExists = async (dir: string, rel: string): Promise<boolean> => {
    try {
      await stat(path.join(dir, rel));
      return true;
    } catch {
      return false;
    }
  };

  describe('Given a tracked file staged in both repos', () => {
    describe('When repo.mv renames it and git mv renames the peer', () => {
      it('Then the index, tree, and working tree match canonical git', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'hello\n' }]);

        // Act
        const moved = await repo.mv(['a.txt'], 'renamed.txt');
        runGit(['-C', pair.peer, 'mv', 'a.txt', 'renamed.txt']);
        const sut = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(sut.stage).toBe(peer.stage);
        expect(sut.tree).toBe(peer.tree);
        expect(moved.moved).toEqual([{ from: 'a.txt', to: 'renamed.txt' }]);
        await expect(readFile(path.join(pair.ours, 'renamed.txt'), 'utf8')).resolves.toBe(
          'hello\n',
        );
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(false);
      });
    });
  });

  describe('Given a tracked file and an existing tracked directory', () => {
    describe('When repo.mv moves the file into the directory like git mv', () => {
      it('Then the file reparents to dir/<basename> identically to git', async () => {
        // Arrange
        await seed([
          { path: 'b.txt', content: 'bee\n' },
          { path: 'dir/keep.txt', content: 'keep\n' },
        ]);

        // Act
        const moved = await repo.mv(['b.txt'], 'dir');
        runGit(['-C', pair.peer, 'mv', 'b.txt', 'dir']);
        const sut = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(sut.stage).toBe(peer.stage);
        expect(sut.tree).toBe(peer.tree);
        expect(moved.moved).toEqual([{ from: 'b.txt', to: 'dir/b.txt' }]);
        await expect(pathExists(pair.ours, 'dir/b.txt')).resolves.toBe(true);
      });
    });
  });

  describe('Given a tracked subtree staged in both repos', () => {
    describe('When repo.mv renames the directory like git mv', () => {
      it('Then every entry reparents identically to git', async () => {
        // Arrange
        await seed([
          { path: 'old/one.txt', content: '1\n' },
          { path: 'old/nested/two.txt', content: '2\n' },
        ]);

        // Act
        await repo.mv(['old'], 'new');
        runGit(['-C', pair.peer, 'mv', 'old', 'new']);
        const sut = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(sut.stage).toBe(peer.stage);
        expect(sut.tree).toBe(peer.tree);
        await expect(pathExists(pair.ours, 'new/nested/two.txt')).resolves.toBe(true);
        await expect(pathExists(pair.ours, 'old')).resolves.toBe(false);
      });
    });
  });

  describe('Given two tracked files', () => {
    describe('When repo.mv -f overwrites one with the other like git mv -f', () => {
      it('Then the destination carries the source blob identically to git', async () => {
        // Arrange
        await seed([
          { path: 'a.txt', content: 'source\n' },
          { path: 'b.txt', content: 'target\n' },
        ]);

        // Act
        await repo.mv(['a.txt'], 'b.txt', { force: true });
        runGit(['-C', pair.peer, 'mv', '-f', 'a.txt', 'b.txt']);
        const sut = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(sut.stage).toBe(peer.stage);
        expect(sut.tree).toBe(peer.tree);
        await expect(readFile(path.join(pair.ours, 'b.txt'), 'utf8')).resolves.toBe('source\n');
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(false);
      });
    });
  });

  describe('Given a staged file whose working copy was edited but not re-staged', () => {
    describe('When repo.mv renames it like git mv', () => {
      it('Then the staged blob travels unchanged and the edit rides the working file', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'staged\n' }]);
        await writeFile(path.join(pair.peer, 'a.txt'), 'edited\n');
        await writeFile(path.join(pair.ours, 'a.txt'), 'edited\n');

        // Act
        await repo.mv(['a.txt'], 'renamed.txt');
        runGit(['-C', pair.peer, 'mv', 'a.txt', 'renamed.txt']);
        const sut = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(sut.stage).toBe(peer.stage);
        expect(sut.tree).toBe(peer.tree);
        await expect(readFile(path.join(pair.ours, 'renamed.txt'), 'utf8')).resolves.toBe(
          'edited\n',
        );
      });
    });
  });

  describe('Given an untracked source path', () => {
    describe('When repo.mv is asked to move it', () => {
      it('Then it refuses like git mv and mutates nothing', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'hello\n' }]);
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'mv', 'ghost.txt', 'dest.txt']);
        let code = '';
        try {
          await repo.mv(['ghost.txt'], 'dest.txt');
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('MV_SOURCE_NOT_TRACKED');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given a destination that is already tracked', () => {
    describe('When repo.mv moves onto it without force', () => {
      it('Then it refuses like git mv and mutates nothing', async () => {
        // Arrange
        await seed([
          { path: 'a.txt', content: 'source\n' },
          { path: 'b.txt', content: 'target\n' },
        ]);
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'mv', 'a.txt', 'b.txt']);
        let code = '';
        try {
          await repo.mv(['a.txt'], 'b.txt');
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('MV_DESTINATION_EXISTS');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given a directory and a path inside it as overlapping sources', () => {
    describe('When repo.mv is asked to move both', () => {
      it('Then it refuses like git mv and mutates nothing', async () => {
        // Arrange
        await seed([
          { path: 'sub/x.txt', content: 'x\n' },
          { path: 'target/keep.txt', content: 'keep\n' },
        ]);
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'mv', 'sub', 'sub/x.txt', 'target']);
        let code = '';
        try {
          await repo.mv(['sub', 'sub/x.txt'], 'target');
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('MV_OVERLAPPING_SOURCES');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });
});

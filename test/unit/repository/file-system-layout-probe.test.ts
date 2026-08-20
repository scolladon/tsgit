import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';

describe('fileSystemLayoutProbe', () => {
  describe('Given an fs whose stat and readUtf8 always reject', () => {
    const fs = {
      stat: async () => {
        throw new Error('boom');
      },
      readUtf8: async () => {
        throw new Error('boom');
      },
    } as unknown as FileSystem;

    describe('When stat runs', () => {
      it('Then it resolves to undefined instead of rejecting', async () => {
        // Arrange
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.stat('/anything');

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When readUtf8 runs', () => {
      it('Then it resolves to undefined instead of rejecting', async () => {
        // Arrange
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.readUtf8('/anything');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a MemoryFileSystem and a path outside its rootDir', () => {
    describe('When stat runs on the outside path', () => {
      it('Then it resolves to undefined (the PERMISSION_DENIED narrowing)', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.stat('/outside');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a MemoryFileSystem with a directory at a path', () => {
    describe('When stat runs on that path', () => {
      it('Then it resolves with isDirectory true and isFile false', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/.git');
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.stat('/repo/.git');

        // Assert
        expect(result).toStrictEqual({ isDirectory: true, isFile: false, size: 0 });
      });
    });
  });

  describe('Given a MemoryFileSystem with a regular file at a path', () => {
    describe('When stat runs on that path', () => {
      it('Then it resolves with isFile true and isDirectory false', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git', 'gitdir: /elsewhere\n');
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.stat('/repo/.git');

        // Assert
        expect(result).toStrictEqual({ isDirectory: false, isFile: true, size: 19 });
      });
    });
  });

  describe('Given a MemoryFileSystem with a file at a path', () => {
    describe('When readUtf8 runs on that path', () => {
      it('Then it resolves with the file content', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git', 'gitdir: /elsewhere\n');
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.readUtf8('/repo/.git');

        // Assert
        expect(result).toBe('gitdir: /elsewhere\n');
      });
    });
  });

  describe('Given a MemoryFileSystem with no file at a path', () => {
    describe('When readUtf8 runs on that path', () => {
      it('Then it resolves to undefined', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        const sut = fileSystemLayoutProbe(fs);

        // Act
        const result = await sut.readUtf8('/repo/missing');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('Given a FileSystem-backed layout probe', () => {
  describe('When its capability set is inspected', () => {
    it('Then isOwnedByCaller is undefined', () => {
      // Arrange
      const fs = new MemoryFileSystem({ rootDir: '/repo' });
      const sut = fileSystemLayoutProbe(fs);

      // Assert — a FileSystem sourced from a sandboxed adapter (memory,
      // browser) hardcodes uid 0, so this shim must never claim ownership
      // capability: doing so would declare every sandboxed repository
      // foreign-owned for any non-root caller.
      expect(sut.isOwnedByCaller).toBeUndefined();
    });
  });
});

describe('Given a symlink and a regular file behind the probe', () => {
  describe('When readLink runs', () => {
    it('Then the symlink yields its link text and the regular file collapses to undefined', async () => {
      // Arrange
      const fs = new MemoryFileSystem({ rootDir: '/repo' });
      await fs.writeUtf8('/repo/plain.txt', 'x');
      await fs.symlink('refs/heads/main', '/repo/HEAD');
      const sut = fileSystemLayoutProbe(fs);

      // Act
      const linked = await sut.readLink?.('/repo/HEAD');
      const plain = await sut.readLink?.('/repo/plain.txt');
      const absent = await sut.readLink?.('/repo/missing');

      // Assert
      expect(linked).toBe('refs/heads/main');
      expect(plain).toBeUndefined();
      expect(absent).toBeUndefined();
    });
  });
});

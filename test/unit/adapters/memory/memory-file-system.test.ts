import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../../src/adapters/memory/memory-file-system.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { fileSystemContractTests } from '../../ports/file-system.contract.js';

describe('MemoryFileSystem', () => {
  fileSystemContractTests(async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.write('/repo/existing.txt', new Uint8Array([1, 2, 3]));
    return {
      fs,
      rootDir: '/repo',
      getRootDirSibling: async () => '/repo-evil/x',
      getExistingInRoot: async () => '/repo/existing.txt',
    };
  });

  describe('memory-specific behaviors', () => {
    it('Given pre-seeded files, When reading, Then returns seeded bytes', async () => {
      // Arrange
      const seeded = new Uint8Array([10, 20, 30]);
      const sut = new MemoryFileSystem({
        rootDir: '/repo',
        files: { '/repo/seed.bin': seeded },
      });

      // Act
      const result = await sut.read('/repo/seed.bin');

      // Assert
      expect(result).toEqual(seeded);
    });

    it('Given pre-seeded file outside rootDir, When constructing, Then throws PERMISSION_DENIED', () => {
      // Arrange / Act
      let caught: unknown;
      try {
        new MemoryFileSystem({
          rootDir: '/repo',
          files: { '/outside/evil.bin': new Uint8Array([1]) },
        });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    });

    it('Given two memory file systems, When mutating one, Then other unaffected', async () => {
      // Arrange
      const sutA = new MemoryFileSystem({ rootDir: '/repo' });
      const sutB = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      await sutA.write('/repo/a.bin', new Uint8Array([1, 2, 3]));

      // Assert
      expect(await sutA.exists('/repo/a.bin')).toBe(true);
      expect(await sutB.exists('/repo/a.bin')).toBe(false);
    });

    it('Given write then mutate input buffer, When reading, Then stored bytes unchanged', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      const input = new Uint8Array([1, 2, 3]);
      await sut.write('/repo/copy.bin', input);

      // Act
      input[0] = 99;
      const result = await sut.read('/repo/copy.bin');

      // Assert
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('Given read result, When mutating, Then stored bytes unchanged', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/copy.bin', new Uint8Array([1, 2, 3]));
      const first = await sut.read('/repo/copy.bin');

      // Act
      first[0] = 99;
      const second = await sut.read('/repo/copy.bin');

      // Assert
      expect(second).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('Given pre-seeded file then mutate source buffer, When reading, Then seeded bytes unchanged', async () => {
      // Arrange
      const source = new Uint8Array([7, 8, 9]);
      const sut = new MemoryFileSystem({
        rootDir: '/repo',
        files: { '/repo/seed.bin': source },
      });

      // Act
      source[0] = 99;
      const result = await sut.read('/repo/seed.bin');

      // Assert
      expect(result).toEqual(new Uint8Array([7, 8, 9]));
    });

    it('Given readlink on non-symlink, When reading, Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/regular.txt', new Uint8Array([1]));

      // Act
      let caught: unknown;
      try {
        await sut.readlink('/repo/regular.txt');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
    });

    it('Given symlink over existing file, When symlink, Then throws FILE_EXISTS', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/there.txt', new Uint8Array([1]));

      // Act
      let caught: unknown;
      try {
        await sut.symlink('/repo/other.txt', '/repo/there.txt');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('FILE_EXISTS');
    });

    it('Given readdir on directory, When reading, Then entries have correct DirEntry shape', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/listing');
      await sut.write('/repo/listing/a.txt', new Uint8Array([1]));
      await sut.mkdir('/repo/listing/sub');

      // Act
      const entries = await sut.readdir('/repo/listing');

      // Assert
      const fileEntry = entries.find((entry) => entry.name === 'a.txt');
      const dirEntry = entries.find((entry) => entry.name === 'sub');
      expect(fileEntry).toEqual({
        name: 'a.txt',
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      });
      expect(dirEntry).toEqual({
        name: 'sub',
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    });

    it('Given chmod on contained path, When called, Then succeeds as no-op', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/file.txt', new Uint8Array([1]));

      // Act
      await sut.chmod('/repo/file.txt', 0o755);

      // Assert
      const stat = await sut.stat('/repo/file.txt');
      expect(stat.mode).toBe(0o100644);
    });

    it('Given rename of symlink, When renaming, Then target and new path are linked', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/target.txt', new Uint8Array([1]));
      await sut.symlink('/repo/target.txt', '/repo/old-link');

      // Act
      await sut.rename('/repo/old-link', '/repo/new-link');

      // Assert
      expect(await sut.readlink('/repo/new-link')).toBe('/repo/target.txt');
      expect(await sut.exists('/repo/old-link')).toBe(false);
    });

    it('Given regular file, When lstat, Then returns isFile stat (non-symlink branch)', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/regular.txt', new Uint8Array([1, 2, 3]));

      // Act
      const stat = await sut.lstat('/repo/regular.txt');

      // Assert
      expect(stat.isFile).toBe(true);
      expect(stat.isSymbolicLink).toBe(false);
      expect(stat.size).toBe(3);
    });

    it('Given non-existent path, When readdir, Then throws NOT_A_DIRECTORY', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      let caught: unknown;
      try {
        await sut.readdir('/repo/does-not-exist');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
    });

    it('Given symlink, When rm, Then symlink is removed', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/target.txt', new Uint8Array([1]));
      await sut.symlink('/repo/target.txt', '/repo/link');

      // Act
      await sut.rm('/repo/link');

      // Assert
      expect(await sut.exists('/repo/link')).toBe(false);
      expect(await sut.exists('/repo/target.txt')).toBe(true);
    });

    it('Given empty directory, When rm, Then directory is removed', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/empty-dir');

      // Act
      await sut.rm('/repo/empty-dir');

      // Assert
      expect(await sut.exists('/repo/empty-dir')).toBe(false);
    });

    it('Given directory containing only a nested subdirectory, When rm parent, Then throws DIRECTORY_NOT_EMPTY', async () => {
      // Arrange — ensures hasChildren iterates the directories set (non-empty via dir child)
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/parent/child');

      // Act
      let caught: unknown;
      try {
        await sut.rm('/repo/parent');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DIRECTORY_NOT_EMPTY');
    });

    it('Given directory containing only a symlink, When rm parent, Then throws DIRECTORY_NOT_EMPTY', async () => {
      // Arrange — ensures hasChildren iterates the symlinks map
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/has-link');
      await sut.symlink('/repo/somewhere', '/repo/has-link/inner-link');

      // Act
      let caught: unknown;
      try {
        await sut.rm('/repo/has-link');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DIRECTORY_NOT_EMPTY');
    });

    it('Given rename of non-existent src, When renaming, Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      let caught: unknown;
      try {
        await sut.rename('/repo/missing.txt', '/repo/dst.txt');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
    });

    it('Given write path whose parent segment is an existing file, When writing, Then throws NOT_A_DIRECTORY', async () => {
      // Arrange — addDirectoryRecursive throws when a file blocks a directory segment
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/blocker.txt', new Uint8Array([1]));

      // Act
      let caught: unknown;
      try {
        await sut.write('/repo/blocker.txt/child.txt', new Uint8Array([1]));
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
    });

    it('Given directory containing a symlink, When readdir, Then entry is returned with isSymbolicLink=true', async () => {
      // Arrange — exercises the symlinks loop inside readdir
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/listing');
      await sut.write('/repo/listing/target.txt', new Uint8Array([1]));
      await sut.symlink('/repo/listing/target.txt', '/repo/listing/shortcut');

      // Act
      const entries = await sut.readdir('/repo/listing');

      // Assert
      const linkEntry = entries.find((entry) => entry.name === 'shortcut');
      expect(linkEntry).toEqual({
        name: 'shortcut',
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
      });
    });

    it('Given deeply nested file and readdir at parent, When listing, Then non-leaf entry is reported as directory (nested ternary)', async () => {
      // Arrange — exercises the `isNested` true branch in addDirectEntry
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/outer/inner/leaf.txt', new Uint8Array([1]));

      // Act
      const entries = await sut.readdir('/repo/outer');

      // Assert
      const innerEntry = entries.find((entry) => entry.name === 'inner');
      expect(innerEntry).toEqual({
        name: 'inner',
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    });

    it('Given directory with file-named-same-as-subdir-entry, When readdir, Then name is deduplicated (seen.has branch)', async () => {
      // Arrange — put a subdir and a file below it sharing the same first segment as another file in parent
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/dup/a.txt', new Uint8Array([1]));
      // A second file directly under /repo/dup reuses the same 'a.txt' name via nested path from another segment.
      // To trigger duplicate seen entries we create two files that both claim the name 'shared' from the /repo
      // perspective: one is a directory (seen via /repo/shared/x.txt iteration) and one a file at /repo/shared.
      // Files and directories share a namespace in this FS, so the simpler path is two nested files whose
      // first segment collides after slicing.
      await sut.write('/repo/shared/level/deep.txt', new Uint8Array([1]));
      await sut.write('/repo/shared/level/other.txt', new Uint8Array([2]));

      // Act
      const entries = await sut.readdir('/repo/shared');

      // Assert — only one 'level' directory entry despite multiple files beneath it
      const levelEntries = entries.filter((entry) => entry.name === 'level');
      expect(levelEntries).toHaveLength(1);
    });

    it('Given dir to rm and an unrelated symlink outside, When hasChildren iterates symlinks, Then the unrelated link is skipped', async () => {
      // Arrange — covers the `startsWith(prefix) === false` branch in hasChildren's symlink loop
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/empty-dir');
      await sut.write('/repo/target.txt', new Uint8Array([1]));
      await sut.symlink('/repo/target.txt', '/repo/unrelated-link');

      // Act
      await sut.rm('/repo/empty-dir');

      // Assert — removal succeeded because the unrelated symlink does NOT start with /repo/empty-dir/
      expect(await sut.exists('/repo/empty-dir')).toBe(false);
      expect(await sut.exists('/repo/unrelated-link')).toBe(true);
    });

    it('Given mutually-recursive symlink pair, When stat, Then throws UNSUPPORTED_OPERATION with stat operation and symlink-loop reason', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.symlink('/repo/b', '/repo/a');
      await sut.symlink('/repo/a', '/repo/b');

      // Act
      let caught: unknown;
      try {
        await sut.stat('/repo/a');
      } catch (err) {
        caught = err;
      }

      // Assert — cycle detected; no infinite recursion / stack overflow
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('UNSUPPORTED_OPERATION');
      if (data.code === 'UNSUPPORTED_OPERATION') {
        expect(data.operation).toBe('stat');
        expect(data.reason).toBe('symlink loop: /repo/a');
      }
    });

    it('Given chain of exactly 40 valid symlinks ending at a file, When stat, Then throws ELOOP at POSIX threshold', async () => {
      // Arrange — POSIX SYMLOOP_MAX = 40. Kills the mutant that relaxes `>=` to `>`.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/target.txt', new Uint8Array([1]));
      // link0 -> link1 -> ... -> link39 -> target.txt (40 symlink hops total).
      await sut.symlink('/repo/target.txt', '/repo/link39');
      for (let i = 38; i >= 0; i--) {
        await sut.symlink(`/repo/link${i + 1}`, `/repo/link${i}`);
      }

      // Act
      let caught: unknown;
      try {
        await sut.stat('/repo/link0');
      } catch (err) {
        caught = err;
      }

      // Assert — the POSIX-defined 40-level limit is reached and throws ELOOP.
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('UNSUPPORTED_OPERATION');
    });

    it('Given writeExclusive then mutate input buffer, When reading, Then stored bytes unchanged', async () => {
      // Arrange — proves writeExclusive defensively copies input (kills `data.slice()` → `data`).
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      const input = new Uint8Array([1, 2, 3]);
      await sut.writeExclusive('/repo/excl.bin', input);

      // Act
      input[0] = 99;
      const result = await sut.read('/repo/excl.bin');

      // Assert
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('Given symlink, When lstat, Then reports isFile=false, isDirectory=false, isSymbolicLink=true', async () => {
      // Arrange — covers boolean flags in the lstat symlink branch.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/target.txt', new Uint8Array([1, 2, 3]));
      await sut.symlink('/repo/target.txt', '/repo/link');

      // Act
      const stat = await sut.lstat('/repo/link');

      // Assert
      expect(stat.isSymbolicLink).toBe(true);
      expect(stat.isFile).toBe(false);
      expect(stat.isDirectory).toBe(false);
    });

    it('Given directory, When stat, Then reports isFile=false, isDirectory=true, isSymbolicLink=false', async () => {
      // Arrange — covers boolean flags in buildStat's directory branch.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.mkdir('/repo/somedir');

      // Act
      const stat = await sut.stat('/repo/somedir');

      // Assert
      expect(stat.isDirectory).toBe(true);
      expect(stat.isFile).toBe(false);
      expect(stat.isSymbolicLink).toBe(false);
    });

    it('Given regular file, When stat, Then reports isDirectory=false (file branch)', async () => {
      // Arrange — covers the `isDirectory: false` literal in buildStat's file branch.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/file.txt', new Uint8Array([1, 2, 3]));

      // Act
      const stat = await sut.stat('/repo/file.txt');

      // Assert
      expect(stat.isFile).toBe(true);
      expect(stat.isDirectory).toBe(false);
      expect(stat.isSymbolicLink).toBe(false);
    });

    it('Given write at a time, When reading stat, Then ctimeMs and mtimeMs are non-zero (touch ran)', async () => {
      // Arrange — kills the mutant that empties touch() to a no-op.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      await sut.write('/repo/stamped.txt', new Uint8Array([1]));
      const stat = await sut.stat('/repo/stamped.txt');

      // Assert — touch() must have populated both times with a real wall-clock value.
      expect(stat.ctimeMs).toBeGreaterThan(0);
      expect(stat.mtimeMs).toBeGreaterThan(0);
    });

    it('Given rootDir path itself, When exists, Then returns true (resolve passes rootDir through)', async () => {
      // Arrange — kills the mutant that short-circuits resolve() to always throw for non-root paths.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      const result = await sut.exists('/repo');

      // Assert
      expect(result).toBe(true);
    });

    it('Given relative path, When writing, Then file is stored under rootDir', async () => {
      // Arrange — kills the StringLiteral mutants on the `startsWith('/')` and the `${rootDir}/${path}` template inside normalizePath.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      await sut.write('relative.txt', new Uint8Array([5, 6, 7]));
      const result = await sut.read('/repo/relative.txt');

      // Assert
      expect(result).toEqual(new Uint8Array([5, 6, 7]));
    });

    it("Given path with '.' segments, When writing, Then '.' segments are stripped during normalization", async () => {
      // Arrange — kills StringLiteral/ConditionalExpression mutants on the `segment === '.'` check.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      await sut.write('/repo/./dot-segment.txt', new Uint8Array([9]));
      const result = await sut.read('/repo/dot-segment.txt');

      // Assert — if `.` were not stripped the canonical path would differ and this read would throw FILE_NOT_FOUND.
      expect(result).toEqual(new Uint8Array([9]));
    });

    it('Given nested file, When readdir at grandparent, Then first-path-segment name is extracted via slice (not full remainder)', async () => {
      // Arrange — kills the ternary and slice mutants in addDirectEntry that would return the full remainder as `name`.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/parent/child-dir/leaf.txt', new Uint8Array([1]));

      // Act
      const entries = await sut.readdir('/repo/parent');

      // Assert — the entry name must be just `child-dir`, not `child-dir/leaf.txt`.
      const names = entries.map((entry) => entry.name);
      expect(names).toContain('child-dir');
      expect(names).not.toContain('child-dir/leaf.txt');
      for (const name of names) {
        expect(name).not.toContain('/');
      }
    });
  });

  describe('writeExclusive Phase 7 §14.17 contract', () => {
    it('Given a path whose parent directory does not exist, When writeExclusive is called, Then parent is auto-created and write succeeds', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      await sut.writeExclusive('/repo/objects/ab/cdef', new Uint8Array([1, 2, 3]));

      // Assert — mkdir-then-write contract (plan Step 0(f)) satisfied by construction.
      expect(await sut.exists('/repo/objects/ab/cdef')).toBe(true);
    });

    it('Given the memory fs has no real symlinks, When writeExclusive is called, Then succeeds (symlink-safe contract trivially holds)', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });

      // Act
      await sut.writeExclusive('/repo/a/b/c.bin', new Uint8Array([42]));

      // Assert
      expect(await sut.exists('/repo/a/b/c.bin')).toBe(true);
    });

    it('Given a symlink leaf, When rmRecursive, Then the link is removed but its target file is untouched', async () => {
      // Arrange — exercises the symlink branch of removeLeafEntry; without it the symlink
      // would be left behind when its containing directory is removed.
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/target.txt', new Uint8Array([1]));
      await sut.symlink('/repo/target.txt', '/repo/link.txt');

      // Act
      await sut.rmRecursive('/repo/link.txt');

      // Assert — the link is gone, the target survives.
      expect(await sut.exists('/repo/link.txt')).toBe(false);
      expect(await sut.exists('/repo/target.txt')).toBe(true);
    });

    it('Given a symlink leaf, When openWithNoFollow, Then throws PERMISSION_DENIED (no traversal through symlinks)', async () => {
      // Arrange
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/target.txt', new Uint8Array([1]));
      await sut.symlink('/repo/target.txt', '/repo/link.txt');

      // Act
      let caught: unknown;
      try {
        await sut.openWithNoFollow('/repo/link.txt', 'read');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    });

    it('Given an opened FileHandle, When read is called without position, Then reads from offset 0 (default)', async () => {
      // Arrange — exercises the `position ?? 0` default branch (no test in the contract suite
      // omits the position argument).
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/seed.bin', new Uint8Array([10, 20, 30]));
      const handle = await sut.openWithNoFollow('/repo/seed.bin', 'read');

      // Act
      const buffer = new Uint8Array(3);
      try {
        const bytes = await handle.read(buffer, 0, 3);

        // Assert
        expect(bytes).toBe(3);
        expect(buffer).toEqual(new Uint8Array([10, 20, 30]));
      } finally {
        await handle.close();
      }
    });

    it('Given an opened FileHandle in write mode, When write is called, Then content is replaced', async () => {
      // Arrange — exercises the memory write-handle branch (the contract suite covers
      // the read variant; this kills BlockStatement mutants on `write` and `touch`).
      const sut = new MemoryFileSystem({ rootDir: '/repo' });
      await sut.write('/repo/seed.bin', new Uint8Array([0]));
      const handle = await sut.openWithNoFollow('/repo/seed.bin', 'write');

      // Act
      try {
        await handle.write(new Uint8Array([1, 2, 3]));
      } finally {
        await handle.close();
      }

      // Assert
      const result = await sut.read('/repo/seed.bin');
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});

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
      symlinkReadEscape: {
        create: async () => {
          const link = '/repo/escape-read-link';
          await fs.symlink('/repo-evil/escape-read-target.txt', link);
          return link;
        },
        expected: 'refused' as const,
      },
    };
  });

  describe('memory-specific behaviors', () => {
    describe('Given pre-seeded files', () => {
      describe('When reading', () => {
        it('Then returns seeded bytes', async () => {
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
      });
    });

    describe('Given pre-seeded file outside rootDir', () => {
      describe('When constructing', () => {
        it('Then throws PERMISSION_DENIED', () => {
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
      });
    });

    describe('Given two memory file systems', () => {
      describe('When mutating one', () => {
        it('Then other unaffected', async () => {
          // Arrange
          const sutA = new MemoryFileSystem({ rootDir: '/repo' });
          const sutB = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          await sutA.write('/repo/a.bin', new Uint8Array([1, 2, 3]));

          // Assert
          expect(await sutA.exists('/repo/a.bin')).toBe(true);
          expect(await sutB.exists('/repo/a.bin')).toBe(false);
        });
      });
    });

    describe('Given write then mutate input buffer', () => {
      describe('When reading', () => {
        it('Then stored bytes unchanged', async () => {
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
      });
    });

    describe('Given read result', () => {
      describe('When mutating', () => {
        it('Then stored bytes unchanged', async () => {
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
      });
    });

    describe('Given pre-seeded file then mutate source buffer', () => {
      describe('When reading', () => {
        it('Then seeded bytes unchanged', async () => {
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
      });
    });

    describe('Given readlink on non-symlink', () => {
      describe('When reading', () => {
        it('Then throws FILE_NOT_FOUND', async () => {
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
      });
    });

    describe('Given symlink over existing file', () => {
      describe('When symlink', () => {
        it('Then throws FILE_EXISTS', async () => {
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
      });
    });

    describe('Given readdir on directory', () => {
      describe('When reading', () => {
        it('Then entries have correct DirEntry shape', async () => {
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
      });
    });

    describe('Given chmod on contained path', () => {
      describe('When called', () => {
        it('Then succeeds as no-op', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/file.txt', new Uint8Array([1]));

          // Act
          await sut.chmod('/repo/file.txt', 0o755);

          // Assert
          const stat = await sut.stat('/repo/file.txt');
          expect(stat.mode).toBe(0o100644);
        });
      });
    });

    describe('Given rename of symlink', () => {
      describe('When renaming', () => {
        it('Then target and new path are linked', async () => {
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
      });
    });

    describe('Given rename of a directory subtree', () => {
      describe('When renaming', () => {
        it('Then nested files, symlinks and dirs move and the source is gone', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/wt/a.txt', new Uint8Array([1]));
          await sut.write('/repo/wt/sub/b.txt', new Uint8Array([2]));
          await sut.symlink('/repo/wt/a.txt', '/repo/wt/link');
          await sut.mkdir('/repo/wt/empty');

          // Act
          await sut.rename('/repo/wt', '/repo/moved');

          // Assert
          expect(await sut.read('/repo/moved/a.txt')).toEqual(new Uint8Array([1]));
          expect(await sut.read('/repo/moved/sub/b.txt')).toEqual(new Uint8Array([2]));
          expect(await sut.readlink('/repo/moved/link')).toBe('/repo/wt/a.txt');
          expect(await sut.exists('/repo/moved/empty')).toBe(true);
          expect(await sut.exists('/repo/wt')).toBe(false);
          expect(await sut.exists('/repo/wt/a.txt')).toBe(false);
        });
      });
    });

    describe('Given a directory rename and a sibling file outside the subtree', () => {
      describe('When renaming the directory', () => {
        it('Then the sibling file keeps its exact path and bytes', async () => {
          // Arrange — /repo/keep.txt lives outside /repo/wt, so the subtree move must only
          // re-key entries at or under `${src}/`, never every key in the map.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/wt/inner.txt', new Uint8Array([1]));
          await sut.write('/repo/keep.txt', new Uint8Array([9]));

          // Act
          await sut.rename('/repo/wt', '/repo/moved');

          // Assert — subtree moved, but the unrelated sibling is byte-for-byte untouched
          expect(await sut.read('/repo/moved/inner.txt')).toEqual(new Uint8Array([1]));
          expect(await sut.exists('/repo/keep.txt')).toBe(true);
          expect(await sut.read('/repo/keep.txt')).toEqual(new Uint8Array([9]));
        });
      });
    });

    describe('Given a directory rename and a sibling directory outside the subtree', () => {
      describe('When renaming the directory', () => {
        it('Then the sibling directory keeps its exact path', async () => {
          // Arrange — /repo/sibling-dir lives outside /repo/wt, so the directories pass must only
          // re-key dirs at or under `${src}/`, never every directory in the set.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/wt/inner.txt', new Uint8Array([1]));
          await sut.mkdir('/repo/sibling-dir');

          // Act
          await sut.rename('/repo/wt', '/repo/moved');

          // Assert — the renamed directory exists at its new path; the sibling directory is untouched
          expect(await sut.exists('/repo/moved')).toBe(true);
          expect(await sut.exists('/repo/sibling-dir')).toBe(true);
        });
      });
    });

    describe('Given regular file', () => {
      describe('When lstat', () => {
        it('Then returns isFile stat (non-symlink branch)', async () => {
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
      });
    });

    describe('Given non-existent path', () => {
      describe('When readdir', () => {
        it('Then throws NOT_A_DIRECTORY', async () => {
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
      });
    });

    describe('Given symlink', () => {
      describe('When rm', () => {
        it('Then symlink is removed', async () => {
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
      });
    });

    describe('Given empty directory', () => {
      describe('When rm', () => {
        it('Then directory is removed', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/empty-dir');

          // Act
          await sut.rm('/repo/empty-dir');

          // Assert
          expect(await sut.exists('/repo/empty-dir')).toBe(false);
        });
      });
    });

    describe('Given directory containing only a nested subdirectory', () => {
      describe('When rm parent', () => {
        it('Then throws DIRECTORY_NOT_EMPTY', async () => {
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
      });
    });

    describe('Given directory containing only a symlink', () => {
      describe('When rm parent', () => {
        it('Then throws DIRECTORY_NOT_EMPTY', async () => {
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
      });
    });

    describe('Given rename of non-existent src', () => {
      describe('When renaming', () => {
        it('Then throws FILE_NOT_FOUND', async () => {
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
      });
    });

    describe('Given write path whose parent segment is an existing file', () => {
      describe('When writing', () => {
        it('Then throws NOT_A_DIRECTORY', async () => {
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
      });
    });

    describe('Given directory containing a symlink', () => {
      describe('When readdir', () => {
        it('Then entry is returned with isSymbolicLink=true', async () => {
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
      });
    });

    describe('Given deeply nested file and readdir at parent', () => {
      describe('When listing', () => {
        it('Then non-leaf entry is reported as directory (nested ternary)', async () => {
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
      });
    });

    describe('Given directory with file-named-same-as-subdir-entry', () => {
      describe('When readdir', () => {
        it('Then name is deduplicated (seen.has branch)', async () => {
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
      });
    });

    describe('Given dir to rm and an unrelated symlink outside', () => {
      describe('When hasChildren iterates symlinks', () => {
        it('Then the unrelated link is skipped', async () => {
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
      });
    });

    describe('Given mutually-recursive symlink pair', () => {
      describe('When stat', () => {
        it('Then throws UNSUPPORTED_OPERATION with stat operation and symlink-loop reason', async () => {
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
      });
    });

    describe('Given chain of exactly 40 valid symlinks ending at a file', () => {
      describe('When stat', () => {
        it('Then throws ELOOP at POSIX threshold', async () => {
          // Arrange — POSIX SYMLOOP_MAX = 40. Kills the mutant that relaxes `>=` to `>`.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/target.txt', new Uint8Array([1]));
          // link0 -> link1 ->... -> link39 -> target.txt (40 symlink hops total).
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
      });
    });

    describe('Given writeExclusive then mutate input buffer', () => {
      describe('When reading', () => {
        it('Then stored bytes unchanged', async () => {
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
      });
    });

    describe('Given symlink', () => {
      describe('When lstat', () => {
        it('Then reports isFile=false, isDirectory=false, isSymbolicLink=true', async () => {
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
      });
    });

    describe('Given directory', () => {
      describe('When stat', () => {
        it('Then reports isFile=false, isDirectory=true, isSymbolicLink=false', async () => {
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
      });
    });

    describe('Given regular file', () => {
      describe('When stat', () => {
        it('Then reports isDirectory=false (file branch)', async () => {
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
      });
    });

    describe('Given write at a time', () => {
      describe('When reading stat', () => {
        it('Then ctimeMs and mtimeMs are non-zero (touch ran)', async () => {
          // Arrange — kills the mutant that empties touch() to a no-op.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          await sut.write('/repo/stamped.txt', new Uint8Array([1]));
          const stat = await sut.stat('/repo/stamped.txt');

          // Assert — touch() must have populated both times with a real wall-clock value.
          expect(stat.ctimeMs).toBeGreaterThan(0);
          expect(stat.mtimeMs).toBeGreaterThan(0);
        });
      });
    });

    describe('Given rootDir path itself', () => {
      describe('When exists', () => {
        it('Then returns true (resolve passes rootDir through)', async () => {
          // Arrange — kills the mutant that short-circuits resolve() to always throw for non-root paths.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          const result = await sut.exists('/repo');

          // Assert
          expect(result).toBe(true);
        });
      });
    });

    describe('Given relative path', () => {
      describe('When writing', () => {
        it('Then file is stored under rootDir', async () => {
          // Arrange — kills the StringLiteral mutants on the `startsWith('/')` and the `${rootDir}/${path}` template inside normalizePath.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          await sut.write('relative.txt', new Uint8Array([5, 6, 7]));
          const result = await sut.read('/repo/relative.txt');

          // Assert
          expect(result).toEqual(new Uint8Array([5, 6, 7]));
        });
      });
    });

    describe("Given path with '.' segments", () => {
      describe('When writing', () => {
        it("Then '.' segments are stripped during normalization", async () => {
          // Arrange — kills StringLiteral/ConditionalExpression mutants on the `segment === '.'` check.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          await sut.write('/repo/./dot-segment.txt', new Uint8Array([9]));
          const result = await sut.read('/repo/dot-segment.txt');

          // Assert — if `.` were not stripped the canonical path would differ and this read would throw FILE_NOT_FOUND.
          expect(result).toEqual(new Uint8Array([9]));
        });
      });
    });

    describe('Given nested file', () => {
      describe('When readdir at grandparent', () => {
        it('Then first-path-segment name is extracted via slice (not full remainder)', async () => {
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
    });

    describe('Given a memory file system', () => {
      describe('When atomicRename is invoked', () => {
        it('Then the destination holds the source bytes and the source is gone', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const data = new Uint8Array([7, 8, 9]);
          await sut.write('/repo/atomic-src.bin', data);

          // Act
          await sut.atomicRename('/repo/atomic-src.bin', '/repo/atomic-dst.bin');

          // Assert
          expect(await sut.read('/repo/atomic-dst.bin')).toEqual(data);
          expect(await sut.exists('/repo/atomic-src.bin')).toBe(false);
        });
      });
    });
  });

  describe('writeExclusive contract', () => {
    describe('Given a path whose parent directory does not exist', () => {
      describe('When writeExclusive is called', () => {
        it('Then parent is auto-created and write succeeds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          await sut.writeExclusive('/repo/objects/ab/cdef', new Uint8Array([1, 2, 3]));

          // Assert — mkdir-then-write contract (plan Step 0(f)) satisfied by construction.
          expect(await sut.exists('/repo/objects/ab/cdef')).toBe(true);
        });
      });
    });

    describe('Given a multi-level nested path whose ancestors do not exist', () => {
      describe('When writeExclusive is called', () => {
        it('Then every missing ancestor directory is auto-created and write succeeds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          await sut.writeExclusive('/repo/a/b/c.bin', new Uint8Array([42]));

          // Assert
          expect(await sut.exists('/repo/a/b/c.bin')).toBe(true);
        });
      });
    });

    describe('Given an empty directory occupies the target path', () => {
      describe('When writeExclusive is called', () => {
        it('Then throws FILE_EXISTS carrying the requested path', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/empty-dir');

          // Act
          let caught: unknown;
          try {
            await sut.writeExclusive('/repo/empty-dir', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('FILE_EXISTS');
          if (data.code === 'FILE_EXISTS') expect(data.path).toBe('/repo/empty-dir');
        });
      });
    });

    describe('Given a directory holding a child file occupies the target path', () => {
      describe('When writeExclusive is called', () => {
        it('Then throws FILE_EXISTS, and the child and directory kind are unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const childData = new Uint8Array([9, 8, 7]);
          await sut.write('/repo/occupied-dir/child.bin', childData);
          const before = await sut.lstat('/repo/occupied-dir');

          // Act
          let caught: unknown;
          try {
            await sut.writeExclusive('/repo/occupied-dir', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('FILE_EXISTS');
          if (data.code === 'FILE_EXISTS') expect(data.path).toBe('/repo/occupied-dir');
          expect(await sut.read('/repo/occupied-dir/child.bin')).toEqual(childData);
          const after = await sut.lstat('/repo/occupied-dir');
          expect(after.isDirectory).toBe(true);
          expect(after.mtimeMs).toBe(before.mtimeMs);
          expect(after.ctimeMs).toBe(before.ctimeMs);
        });
      });
    });

    describe("Given the target path is the adapter's root", () => {
      describe('When writeExclusive is called', () => {
        it('Then throws FILE_EXISTS, and a later write elsewhere in the tree still succeeds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          let caught: unknown;
          try {
            await sut.writeExclusive('/repo', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('FILE_EXISTS');
          if (data.code === 'FILE_EXISTS') expect(data.path).toBe('/repo');
          await sut.write('/repo/after-root-refusal.bin', new Uint8Array([2]));
          expect(await sut.exists('/repo/after-root-refusal.bin')).toBe(true);
        });
      });
    });

    describe('Given a regular file occupies the target path', () => {
      describe('When writeExclusive is called', () => {
        it('Then throws FILE_EXISTS', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/occupied-file.bin', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.writeExclusive('/repo/occupied-file.bin', new Uint8Array([2]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('FILE_EXISTS');
        });
      });
    });

    describe('Given a symlink occupies the target path', () => {
      describe('When writeExclusive is called', () => {
        it('Then throws FILE_EXISTS', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/link-target.bin', new Uint8Array([1]));
          await sut.symlink('/repo/link-target.bin', '/repo/occupied-link');

          // Act
          let caught: unknown;
          try {
            await sut.writeExclusive('/repo/occupied-link', new Uint8Array([2]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('FILE_EXISTS');
        });
      });
    });

    describe('Given a symlink leaf', () => {
      describe('When rmRecursive', () => {
        it('Then the link is removed but its target file is untouched', async () => {
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
      });
      describe('When openWithNoFollow', () => {
        it('Then throws PERMISSION_DENIED (no traversal through symlinks)', async () => {
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
      });
    });

    describe('Given an opened FileHandle', () => {
      describe('When read is called without position', () => {
        it('Then reads from offset 0 (default)', async () => {
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
      });
    });

    describe('Given an opened FileHandle in write mode', () => {
      describe('When write is called', () => {
        it('Then content is replaced', async () => {
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

    describe('Given an opened FileHandle', () => {
      describe('When write then the input buffer is mutated', () => {
        it('Then stored bytes are unchanged', async () => {
          // Arrange — kills the `data.slice()` -> `data` mutant in makeMemoryHandle's write:
          // the handle must defensively copy the caller's buffer.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/seed.bin', new Uint8Array([0]));
          const handle = await sut.openWithNoFollow('/repo/seed.bin', 'write');
          const input = new Uint8Array([1, 2, 3]);

          // Act
          try {
            await handle.write(input);
          } finally {
            await handle.close();
          }
          input[0] = 99;
          const result = await sut.read('/repo/seed.bin');

          // Assert — if the handle stored the buffer by reference, result[0] would be 99.
          expect(result).toEqual(new Uint8Array([1, 2, 3]));
        });
      });
    });
  });

  describe('rename kind guard', () => {
    describe('Given a file at src and an empty directory at dst', () => {
      describe('When renaming', () => {
        it('Then throws PERMISSION_DENIED carrying src, and both keep their kinds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src.txt', new Uint8Array([1]));
          await sut.mkdir('/repo/dst-dir');

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src.txt', '/repo/dst-dir');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('/repo/src.txt');
          expect((await sut.lstat('/repo/src.txt')).isFile).toBe(true);
          expect((await sut.lstat('/repo/dst-dir')).isDirectory).toBe(true);
        });
      });
    });

    describe('Given a file at src and a directory with children at dst', () => {
      describe('When renaming', () => {
        it("Then throws PERMISSION_DENIED carrying src, and dst's child reads back byte-identical", async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src.txt', new Uint8Array([1]));
          const childData = new Uint8Array([9, 8, 7]);
          await sut.write('/repo/dst-dir/child.bin', childData);

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src.txt', '/repo/dst-dir');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('/repo/src.txt');
          expect(await sut.read('/repo/dst-dir/child.bin')).toEqual(childData);
        });
      });
    });

    describe('Given a symlink at src and a directory at dst', () => {
      describe('When renaming', () => {
        it('Then throws PERMISSION_DENIED carrying src, and readlink(src) is unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/target.txt', new Uint8Array([1]));
          await sut.symlink('/repo/target.txt', '/repo/src-link');
          await sut.mkdir('/repo/dst-dir');

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-link', '/repo/dst-dir');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('/repo/src-link');
          expect(await sut.readlink('/repo/src-link')).toBe('/repo/target.txt');
        });
      });
    });

    describe("Given a file at src and dst is the adapter's root", () => {
      describe('When renaming', () => {
        it('Then throws PERMISSION_DENIED, and a later write still succeeds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src.txt', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src.txt', '/repo');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          await sut.write('/repo/after-root-refusal.bin', new Uint8Array([2]));
          expect(await sut.exists('/repo/after-root-refusal.bin')).toBe(true);
        });
      });
    });

    describe('Given an empty directory at src and a regular file at dst', () => {
      describe('When renaming', () => {
        it('Then throws NOT_A_DIRECTORY carrying src, and dst keeps its bytes', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/src-dir');
          const dstData = new Uint8Array([4, 5, 6]);
          await sut.write('/repo/dst.txt', dstData);

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/dst.txt');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('NOT_A_DIRECTORY');
          if (data.code === 'NOT_A_DIRECTORY') expect(data.path).toBe('/repo/src-dir');
          expect(await sut.read('/repo/dst.txt')).toEqual(dstData);
        });
      });
    });

    describe('Given a directory with children at src and a regular file at dst', () => {
      describe('When renaming', () => {
        it('Then throws NOT_A_DIRECTORY carrying src, and children are still listed under src', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/child.txt', new Uint8Array([1]));
          await sut.write('/repo/dst.txt', new Uint8Array([2]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/dst.txt');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('NOT_A_DIRECTORY');
          if (data.code === 'NOT_A_DIRECTORY') expect(data.path).toBe('/repo/src-dir');
          const entries = await sut.readdir('/repo/src-dir');
          expect(entries.find((entry) => entry.name === 'child.txt')).toBeDefined();
        });
      });
    });

    describe('Given a directory at src and a symlink at dst', () => {
      describe('When renaming', () => {
        it('Then throws NOT_A_DIRECTORY carrying src, and readlink(dst) is unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/child.txt', new Uint8Array([1]));
          await sut.write('/repo/target.txt', new Uint8Array([2]));
          await sut.symlink('/repo/target.txt', '/repo/dst-link');

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/dst-link');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('NOT_A_DIRECTORY');
          if (data.code === 'NOT_A_DIRECTORY') expect(data.path).toBe('/repo/src-dir');
          expect(await sut.readlink('/repo/dst-link')).toBe('/repo/target.txt');
        });
      });
    });

    describe('Given a directory at src and a non-empty directory at dst', () => {
      describe('When renaming', () => {
        it('Then throws DIRECTORY_NOT_EMPTY carrying src, and neither tree merges', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/a.txt', new Uint8Array([1]));
          await sut.write('/repo/dst-dir/b.txt', new Uint8Array([2]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/dst-dir');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('DIRECTORY_NOT_EMPTY');
          if (data.code === 'DIRECTORY_NOT_EMPTY') expect(data.path).toBe('/repo/src-dir');
          expect(await sut.exists('/repo/src-dir/a.txt')).toBe(true);
          expect(await sut.exists('/repo/dst-dir/b.txt')).toBe(true);
          expect(await sut.exists('/repo/dst-dir/a.txt')).toBe(false);
        });
      });
    });

    describe('Given an empty directory at src and a non-empty directory at dst', () => {
      describe('When renaming', () => {
        it('Then throws DIRECTORY_NOT_EMPTY carrying src', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/src-dir');
          await sut.write('/repo/dst-dir/b.txt', new Uint8Array([2]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/dst-dir');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('DIRECTORY_NOT_EMPTY');
          if (data.code === 'DIRECTORY_NOT_EMPTY') expect(data.path).toBe('/repo/src-dir');
        });
      });
    });

    describe("Given a directory at src and dst is src's own parent", () => {
      describe('When renaming', () => {
        it('Then throws DIRECTORY_NOT_EMPTY carrying src — not the inside-source code', async () => {
          // Arrange — /repo is the parent of /repo/src-dir; a parent is not "inside" its child.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/a.txt', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('DIRECTORY_NOT_EMPTY');
          if (data.code === 'DIRECTORY_NOT_EMPTY') expect(data.path).toBe('/repo/src-dir');
        });
      });
    });

    describe('Given a directory at src and an absent dst inside src', () => {
      describe('When renaming', () => {
        it("Then throws UNSUPPORTED_OPERATION('filesystem', 'EINVAL'), and src's subtree is intact", async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/a.txt', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/src-dir/absent');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('filesystem');
            expect(data.reason).toBe('EINVAL');
          }
          expect(await sut.exists('/repo/src-dir/a.txt')).toBe(true);
        });
      });
    });

    describe('Given a directory at src and an existing non-empty directory dst inside src', () => {
      describe('When renaming', () => {
        it('Then throws the same error, and both levels are intact', async () => {
          // Arrange — proves the inside-source clause wins over the DIRECTORY_NOT_EMPTY check
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/inner/a.txt', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/src-dir/inner');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('filesystem');
            expect(data.reason).toBe('EINVAL');
          }
          expect(await sut.exists('/repo/src-dir/inner/a.txt')).toBe(true);
          expect(await sut.exists('/repo/src-dir')).toBe(true);
        });
      });
    });

    describe('Given a directory at src and an existing regular file dst inside src', () => {
      describe('When renaming', () => {
        it('Then throws the same error, and the file is unchanged', async () => {
          // Arrange — memory-only: darwin and linux disagree on this arrangement (the design
          // picks linux), so it is never a contract row and is pinned nowhere on the node side.
          // Proves the inside-source clause sits above the file/symlink kind check.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const fileData = new Uint8Array([7, 8]);
          await sut.write('/repo/src-dir/inner.txt', fileData);

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/src-dir/inner.txt');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('filesystem');
            expect(data.reason).toBe('EINVAL');
          }
          expect(await sut.read('/repo/src-dir/inner.txt')).toEqual(fileData);
        });
      });
    });

    describe('Given a directory at src and an existing symlink dst inside src', () => {
      describe('When renaming', () => {
        it('Then throws the same error, and readlink(dst) is unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/target.txt', new Uint8Array([1]));
          await sut.symlink('/repo/target.txt', '/repo/src-dir/inner-link');

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/src-dir/inner-link');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('filesystem');
            expect(data.reason).toBe('EINVAL');
          }
          expect(await sut.readlink('/repo/src-dir/inner-link')).toBe('/repo/target.txt');
        });
      });
    });

    describe("Given src is the adapter's root and dst is inside it", () => {
      describe('When renaming', () => {
        it('Then throws the same error, and a later write still succeeds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/existing.txt', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo', '/repo/inside');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('filesystem');
            expect(data.reason).toBe('EINVAL');
          }
          expect((await sut.lstat('/repo')).isDirectory).toBe(true);
          await sut.write('/repo/after-root-inside-refusal.bin', new Uint8Array([2]));
          expect(await sut.exists('/repo/after-root-inside-refusal.bin')).toBe(true);
        });
      });
    });

    describe('Given a directory at src and a deep dst inside src whose mid segment is absent', () => {
      describe('When renaming', () => {
        it('Then throws the same error — the clause is a prefix test, not a lookup', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/a.txt', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.rename('/repo/src-dir', '/repo/src-dir/absent-mid/leaf');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('filesystem');
            expect(data.reason).toBe('EINVAL');
          }
        });
      });
    });

    describe('Given a file at src and a directory at dst', () => {
      describe('When atomicRename is invoked', () => {
        it('Then throws PERMISSION_DENIED carrying src — proves the delegation, not a second guard', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src.txt', new Uint8Array([1]));
          await sut.mkdir('/repo/dst-dir');

          // Act
          let caught: unknown;
          try {
            await sut.atomicRename('/repo/src.txt', '/repo/dst-dir');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('/repo/src.txt');
        });
      });
    });

    describe('Given a directory with children at src and an empty directory at dst', () => {
      describe('When renaming', () => {
        it('Then it succeeds; every child is reachable under dst and none under src', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/src-dir/a.txt', new Uint8Array([1]));
          await sut.mkdir('/repo/dst-dir');

          // Act
          await sut.rename('/repo/src-dir', '/repo/dst-dir');

          // Assert
          expect(await sut.read('/repo/dst-dir/a.txt')).toEqual(new Uint8Array([1]));
          expect(await sut.exists('/repo/src-dir')).toBe(false);
          expect(await sut.exists('/repo/src-dir/a.txt')).toBe(false);
        });
      });
    });

    describe('Given a regular file, src === dst', () => {
      describe('When renaming', () => {
        it('Then it resolves and the bytes are unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const data = new Uint8Array([1, 2, 3]);
          await sut.write('/repo/same.txt', data);

          // Act
          await sut.rename('/repo/same.txt', '/repo/same.txt');

          // Assert
          expect(await sut.read('/repo/same.txt')).toEqual(data);
        });
      });
    });

    describe('Given a non-empty directory, src === dst', () => {
      describe('When renaming', () => {
        it('Then it resolves and every child is still reachable', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/same-dir/a.txt', new Uint8Array([1]));

          // Act
          await sut.rename('/repo/same-dir', '/repo/same-dir');

          // Assert
          expect(await sut.read('/repo/same-dir/a.txt')).toEqual(new Uint8Array([1]));
        });
      });
    });

    describe('Given two files, src === dst for the first', () => {
      describe('When renaming', () => {
        it('Then the directory listing order is unchanged — a self-rename is a true no-op', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/a.txt', new Uint8Array([1]));
          await sut.write('/repo/b.txt', new Uint8Array([2]));

          // Act
          await sut.rename('/repo/a.txt', '/repo/a.txt');

          // Assert — a re-inserted entry would move to the end of the listing
          expect((await sut.readdir('/repo')).map((entry) => entry.name)).toEqual([
            'a.txt',
            'b.txt',
          ]);
        });
      });
    });

    describe('Given a regular file at src and an existing symlink at dst', () => {
      describe('When renaming', () => {
        it('Then the link is replaced by the file and its target is untouched', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const srcBytes = new Uint8Array([4, 5, 6]);
          const targetBytes = new Uint8Array([1, 2, 3]);
          await sut.write('/repo/moved.bin', srcBytes);
          await sut.write('/repo/target.bin', targetBytes);
          await sut.symlink('/repo/target.bin', '/repo/dst-link');

          // Act
          await sut.rename('/repo/moved.bin', '/repo/dst-link');

          // Assert — the destination is now the file, not a link, and the old target is intact
          const dst = await sut.lstat('/repo/dst-link');
          expect(dst.isFile).toBe(true);
          expect(dst.isSymbolicLink).toBe(false);
          expect(await sut.read('/repo/dst-link')).toEqual(srcBytes);
          expect(await sut.read('/repo/target.bin')).toEqual(targetBytes);
          expect(await sut.exists('/repo/moved.bin')).toBe(false);
        });
      });
    });

    describe('Given a symlink at src and an existing regular file at dst', () => {
      describe('When renaming', () => {
        it('Then the file is replaced by the link, which keeps its target', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/target.bin', new Uint8Array([1]));
          await sut.symlink('/repo/target.bin', '/repo/moved-link');
          await sut.write('/repo/dst-file.bin', new Uint8Array([9]));

          // Act
          await sut.rename('/repo/moved-link', '/repo/dst-file.bin');

          // Assert — the destination is the link; the file entry it replaced is gone
          // (memory `read` never follows a link, so a surviving file entry would read back)
          const dst = await sut.lstat('/repo/dst-file.bin');
          expect(dst.isSymbolicLink).toBe(true);
          expect(await sut.readlink('/repo/dst-file.bin')).toBe('/repo/target.bin');
          let caught: unknown;
          try {
            await sut.read('/repo/dst-file.bin');
          } catch (err) {
            caught = err;
          }
          expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
          expect(await sut.exists('/repo/moved-link')).toBe(false);
        });
      });
    });

    describe('Given a directory at /repo/a and the sibling /repo/ab at dst', () => {
      describe('When renaming', () => {
        it('Then it succeeds — /repo/ab is not inside /repo/a', async () => {
          // Arrange — the prefix-boundary pin: without the trailing slash in the `${src}/`
          // check, '/repo/ab'.startsWith('/repo/a') would incorrectly be true.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/a/inner.txt', new Uint8Array([1]));

          // Act
          await sut.rename('/repo/a', '/repo/ab');

          // Assert
          expect(await sut.read('/repo/ab/inner.txt')).toEqual(new Uint8Array([1]));
          expect(await sut.exists('/repo/a')).toBe(false);
        });
      });
    });
  });

  describe('write leaf guard', () => {
    describe('Given an empty directory occupies the target path', () => {
      describe('When write is called', () => {
        it('Then throws PERMISSION_DENIED carrying the requested path, and lstat still reports a directory', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/empty-dir');

          // Act
          let caught: unknown;
          try {
            await sut.write('/repo/empty-dir', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('/repo/empty-dir');
          expect((await sut.lstat('/repo/empty-dir')).isDirectory).toBe(true);
        });
      });
    });

    describe('Given a symlink to an existing file occupies the target path', () => {
      describe('When write is called', () => {
        it('Then throws PERMISSION_DENIED carrying the requested path, and readlink and the target bytes are unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const targetData = new Uint8Array([1, 2, 3]);
          await sut.write('/repo/link-target.bin', targetData);
          await sut.symlink('/repo/link-target.bin', '/repo/occupied-link');

          // Act
          let caught: unknown;
          try {
            await sut.write('/repo/occupied-link', new Uint8Array([9, 9]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('/repo/occupied-link');
          expect(await sut.readlink('/repo/occupied-link')).toBe('/repo/link-target.bin');
          expect(await sut.read('/repo/link-target.bin')).toEqual(targetData);
        });
      });
    });

    describe('Given a directory holding a child file occupies the target path', () => {
      describe('When write is called', () => {
        it('Then throws PERMISSION_DENIED, and the child reads back byte-identical', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const childData = new Uint8Array([9, 8, 7]);
          await sut.write('/repo/occupied-dir/child.bin', childData);

          // Act
          let caught: unknown;
          try {
            await sut.write('/repo/occupied-dir', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          const entries = await sut.readdir('/repo/occupied-dir');
          expect(entries.map((entry) => entry.name)).toContain('child.bin');
          expect(await sut.read('/repo/occupied-dir/child.bin')).toEqual(childData);
        });
      });
    });

    describe("Given the target path is the adapter's root", () => {
      describe('When write is called', () => {
        it('Then throws PERMISSION_DENIED, and a later write elsewhere still succeeds', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          let caught: unknown;
          try {
            await sut.write('/repo', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          await sut.write('/repo/after-root-refusal.bin', new Uint8Array([2]));
          expect(await sut.exists('/repo/after-root-refusal.bin')).toBe(true);
        });
      });
    });

    describe('Given a dangling symlink occupies the target path', () => {
      describe('When write is called', () => {
        it('Then throws PERMISSION_DENIED, and readlink still returns the original target', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.symlink('/repo/missing-target', '/repo/link');

          // Act
          let caught: unknown;
          try {
            await sut.write('/repo/link', new Uint8Array([1]));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          expect(await sut.readlink('/repo/link')).toBe('/repo/missing-target');
        });
      });
    });

    describe('Given an empty directory occupies the target path', () => {
      describe('When writeUtf8 is called', () => {
        it('Then throws PERMISSION_DENIED', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/empty-dir');

          // Act
          let caught: unknown;
          try {
            await sut.writeUtf8('/repo/empty-dir', 'hello');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given an empty directory occupies the target path', () => {
      describe('When writeStream is called', () => {
        it('Then throws PERMISSION_DENIED', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/empty-dir');

          // Act
          let caught: unknown;
          try {
            await sut.writeStream(
              '/repo/empty-dir',
              (async function* () {
                yield new Uint8Array([1]);
              })(),
            );
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given a directory holding a child occupies the target path', () => {
      describe('When appendUtf8 is called', () => {
        it('Then throws PERMISSION_DENIED, and the child is unchanged — nothing was written before the refusal', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          const childData = new Uint8Array([9, 8, 7]);
          await sut.write('/repo/occupied-dir/child.bin', childData);

          // Act
          let caught: unknown;
          try {
            await sut.appendUtf8('/repo/occupied-dir', 'hello');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          expect(await sut.read('/repo/occupied-dir/child.bin')).toEqual(childData);
        });
      });
    });

    describe('Given a symlink occupies the target path', () => {
      describe('When writeUtf8 is called', () => {
        it('Then throws PERMISSION_DENIED', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/link-target.bin', new Uint8Array([1]));
          await sut.symlink('/repo/link-target.bin', '/repo/occupied-link');

          // Act
          let caught: unknown;
          try {
            await sut.writeUtf8('/repo/occupied-link', 'hello');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given a symlink occupies the target path', () => {
      describe('When writeStream is called', () => {
        it('Then throws PERMISSION_DENIED', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/link-target.bin', new Uint8Array([1]));
          await sut.symlink('/repo/link-target.bin', '/repo/occupied-link');

          // Act
          let caught: unknown;
          try {
            await sut.writeStream(
              '/repo/occupied-link',
              (async function* () {
                yield new Uint8Array([1]);
              })(),
            );
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given a symlink occupies the target path', () => {
      describe('When appendUtf8 is called', () => {
        it('Then throws PERMISSION_DENIED, and readlink is unchanged', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/link-target.bin', new Uint8Array([1]));
          await sut.symlink('/repo/link-target.bin', '/repo/occupied-link');

          // Act
          let caught: unknown;
          try {
            await sut.appendUtf8('/repo/occupied-link', 'hello');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          expect(await sut.readlink('/repo/occupied-link')).toBe('/repo/link-target.bin');
        });
      });
    });

    describe('Given a regular file occupies the target path', () => {
      describe('When write is called', () => {
        it('Then overwrites, and reads back the new bytes', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/occupied-file.bin', new Uint8Array([1, 2, 3]));

          // Act
          await sut.write('/repo/occupied-file.bin', new Uint8Array([9, 9]));

          // Assert
          expect(await sut.read('/repo/occupied-file.bin')).toEqual(new Uint8Array([9, 9]));
        });
      });
    });
  });

  describe('ancestor refusals leave no directory behind', () => {
    describe('Given a regular file at a grandparent segment of the target path', () => {
      describe('When write is called', () => {
        it('Then throws NOT_A_DIRECTORY and records no intermediate directory', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/blocker', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.write('/repo/blocker/mid/leaf.bin', new Uint8Array([2]));
          } catch (err) {
            caught = err;
          }

          // Assert — refused, and the tree is exactly what it was before the call
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
          expect(await sut.exists('/repo/blocker/mid')).toBe(false);
          expect((await sut.readdir('/repo')).map((entry) => entry.name)).toEqual(['blocker']);
        });
      });

      describe('When mkdir is called', () => {
        it('Then throws NOT_A_DIRECTORY and records neither the leaf nor the intermediate directory', async () => {
          // Arrange
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/blocker', new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await sut.mkdir('/repo/blocker/mid/leaf');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
          expect(await sut.exists('/repo/blocker/mid/leaf')).toBe(false);
          expect(await sut.exists('/repo/blocker/mid')).toBe(false);
          expect((await sut.readdir('/repo')).map((entry) => entry.name)).toEqual(['blocker']);
        });
      });
    });
  });

  describe('rmRecursive subtree boundaries', () => {
    describe('Given a sibling file outside the target subtree', () => {
      describe('When rmRecursive on the subtree', () => {
        it('Then the sibling file survives', async () => {
          // Arrange — kills the `${normalized}/` -> `` empty-prefix mutant in removeSubtree
          // (empty prefix makes collectStartsWith match every file) and the collectStartsWith
          // ConditionalExpression -> true mutant.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/subtree/inner.txt', new Uint8Array([1]));
          await sut.write('/repo/sibling.txt', new Uint8Array([2]));

          // Act
          await sut.rmRecursive('/repo/subtree');

          // Assert — only the targeted subtree is gone; the unrelated sibling remains.
          expect(await sut.exists('/repo/subtree/inner.txt')).toBe(false);
          expect(await sut.exists('/repo/sibling.txt')).toBe(true);
          expect(await sut.read('/repo/sibling.txt')).toEqual(new Uint8Array([2]));
        });
      });
    });

    describe('Given a sibling symlink outside the target subtree', () => {
      describe('When rmRecursive on the subtree', () => {
        it('Then the sibling symlink survives', async () => {
          // Arrange — kills the collectStartsWith ConditionalExpression -> true mutant on the
          // symlinks pass: a true predicate would collect (and delete) every symlink.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/subtree/inner.txt', new Uint8Array([1]));
          await sut.write('/repo/target.txt', new Uint8Array([2]));
          await sut.symlink('/repo/target.txt', '/repo/sibling-link');

          // Act
          await sut.rmRecursive('/repo/subtree');

          // Assert
          expect(await sut.exists('/repo/subtree/inner.txt')).toBe(false);
          expect(await sut.exists('/repo/sibling-link')).toBe(true);
        });
      });
    });

    describe('Given a sibling directory outside the target subtree', () => {
      describe('When rmRecursive on the subtree', () => {
        it('Then the sibling directory survives', async () => {
          // Arrange — kills the collectMatchingDirs ConditionalExpression -> true mutant
          // (would collect every directory, including unrelated ones).
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.write('/repo/subtree/inner.txt', new Uint8Array([1]));
          await sut.mkdir('/repo/sibling-dir');

          // Act
          await sut.rmRecursive('/repo/subtree');

          // Assert — the sibling directory must remain after the unrelated subtree is removed.
          expect(await sut.exists('/repo/subtree')).toBe(false);
          expect(await sut.exists('/repo/sibling-dir')).toBe(true);
        });
      });
    });

    describe('Given a nested subdirectory inside the target subtree', () => {
      describe('When rmRecursive', () => {
        it('Then the nested subdirectory is removed', async () => {
          // Arrange — kills the collectMatchingDirs `key.startsWith(prefix)` -> `key.endsWith(prefix)`
          // mutant: a nested dir path does not END with `${normalized}/`, so endsWith would skip it.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/subtree/nested');

          // Act
          await sut.rmRecursive('/repo/subtree');

          // Assert — the nested directory must be collected and deleted, not left behind.
          expect(await sut.exists('/repo/subtree')).toBe(false);
          expect(await sut.exists('/repo/subtree/nested')).toBe(false);
        });
      });
    });
  });

  describe('hasChildren directory scanning', () => {
    describe('Given an empty directory while an unrelated directory also exists', () => {
      describe('When rm', () => {
        it('Then the empty directory is removed', async () => {
          // Arrange — kills the hasChildren directories-loop ConditionalExpression -> true mutant:
          // a `true` predicate reports children whenever the directory set is non-empty (it always
          // contains rootDir plus the unrelated dir), so rm would wrongly throw DIRECTORY_NOT_EMPTY.
          const sut = new MemoryFileSystem({ rootDir: '/repo' });
          await sut.mkdir('/repo/empty-dir');
          await sut.mkdir('/repo/unrelated-dir');

          // Act
          await sut.rm('/repo/empty-dir');

          // Assert — removal succeeds; the unrelated directory is untouched.
          expect(await sut.exists('/repo/empty-dir')).toBe(false);
          expect(await sut.exists('/repo/unrelated-dir')).toBe(true);
        });
      });
    });
  });
});

describe('MemoryFileSystem config-path capabilities', () => {
  describe('Given a MemoryFileSystem constructed without overrides', () => {
    describe('When a config-path accessor is called', () => {
      it.each([
        {
          read: (fs: MemoryFileSystem) => fs.homedir(),
          expected: '/home/user',
          label: 'homedir() returns the default "/home/user"',
        },
        {
          read: (fs: MemoryFileSystem) => fs.xdgConfigHome(),
          expected: '/home/user/.config',
          label: 'xdgConfigHome() returns the default "/home/user/.config"',
        },
        {
          read: (fs: MemoryFileSystem) => fs.systemConfigPath(),
          expected: '/etc/gitconfig',
          label: 'systemConfigPath() returns the default "/etc/gitconfig"',
        },
      ])('Then $label', ({ read, expected }) => {
        // Arrange
        const sut = new MemoryFileSystem({ rootDir: '/repo' });

        // Act + Assert
        expect(read(sut)).toBe(expected);
      });
    });
  });

  describe('Given a MemoryFileSystem constructed with all three overrides', () => {
    describe('When the three methods are called', () => {
      it('Then each returns the injected value', () => {
        // Arrange
        const sut = new MemoryFileSystem({
          rootDir: '/repo',
          home: '/u/ada',
          xdg: '/cfg',
          systemConfig: '/opt/etc/gitconfig',
        });

        // Act + Assert
        expect(sut.homedir()).toBe('/u/ada');
        expect(sut.xdgConfigHome()).toBe('/cfg');
        expect(sut.systemConfigPath()).toBe('/opt/etc/gitconfig');
      });
    });
  });

  describe('Given partial overrides (home only)', () => {
    describe('When xdgConfigHome() is called', () => {
      it('Then still returns the default (overrides are independent)', () => {
        // Arrange
        const sut = new MemoryFileSystem({ rootDir: '/repo', home: '/u/x' });

        // Act + Assert
        expect(sut.homedir()).toBe('/u/x');
        expect(sut.xdgConfigHome()).toBe('/home/user/.config');
      });
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  discardDirectory,
  materializeFile,
  removeDirectory,
  removeFile,
  renameInWorkingTree,
  validatePath,
} from '../../../../../src/application/commands/internal/working-tree.js';
import { pathTooLong } from '../../../../../src/domain/error.js';
import {
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../../../../src/domain/index.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileHandle, FileStat, FileSystem } from '../../../../../src/ports/file-system.js';

/** A complete leaf-file `FileStat` (regular file, not a directory, not a symlink). */
const leafStat = (): FileStat => ({
  ctimeMs: 0,
  mtimeMs: 0,
  dev: 0,
  ino: 0,
  mode: 0,
  uid: 0,
  gid: 0,
  size: 0,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
});

const withoutDirectoryRename = (fs: FileSystem): FileSystem => {
  const { renameDirectory: _absent, ...rest } = fs;
  return rest;
};

const expectError = async (
  fn: () => unknown | Promise<unknown>,
  code: string,
): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

/**
 * Build a context whose `openWithNoFollow` throws a caller-supplied error so
 * the catch-branch fallback / rethrow logic in `materializeFile` is exercised
 * — the memory adapter natively supports `openWithNoFollow`, so its happy path
 * never reaches that branch.
 */
const contextWithFailingOpen = (
  error: unknown,
): { ctx: Context; chmod: ReturnType<typeof vi.fn> } => {
  const base = createMemoryContext();
  const chmod = vi.fn(base.fs.chmod);
  const fs: FileSystem = {
    ...base.fs,
    chmod,
    openWithNoFollow: (): Promise<FileHandle> => Promise.reject(error),
  };
  return { ctx: { ...base, fs }, chmod };
};

describe('internal/working-tree', () => {
  describe('validatePath', () => {
    describe("Given 'src/foo.ts'", () => {
      describe('When validatePath', () => {
        it('Then returns it as a FilePath', () => {
          // Arrange
          const result = validatePath('src/foo.ts');

          // Assert
          expect(result).toBe('src/foo.ts');
        });
      });
    });

    describe('Given a path rejected by a validatePath guard', () => {
      describe('When validatePath', () => {
        it.each([
          { path: '/abs/path', label: "'/abs/path'" },
          { path: '../escape', label: "'../escape'" },
          { path: 'a/../b', label: "'a/../b'" },
          { path: 'a\0b', label: 'a path containing a NUL byte' },
          { path: 'foo/.git/config', label: "'foo/.git/config' (lowercase .git)" },
          {
            path: 'foo/.GIT/config',
            label: "'foo/.GIT/config' (uppercase .GIT, case-insensitive)",
          },
          { path: 'foo/.git /file', label: "'foo/.git ' (trailing space, NTFS-safe)" },
          { path: 'foo/.git./file', label: "'foo/.git.' (trailing dot, NTFS-safe)" },
          { path: 'foo/bar\x01baz', label: 'a control character (\\x01) in a component' },
          { path: '', label: 'an empty string' },
          {
            path: 'a\\b',
            label: 'a path with backslash separator (Windows-style, use POSIX separators)',
          },
          {
            path: `foo/bar${String.fromCharCode(0x1f)}baz`,
            label: 'a control character at exactly 0x1F (boundary kill for `code <= 0x1f`)',
          },
          {
            path: 'foo/.git:$DATA/x',
            label: "a component containing ':' (NTFS Alternate Data Stream / Windows drive)",
          },
          {
            path: 'C:relative/file',
            label: "a component starting with a Windows drive letter ('C:rel')",
          },
          {
            path: 'foo/.git . . /file',
            label: "'.git' followed by mixed dots and spaces (defensive NTFS strip)",
          },
          {
            path: 'foo/',
            label: 'a path with trailing slash (kills `startsWith` vs `endsWith` direction mutant)',
          },
        ])('Then $label throws PATHSPEC_OUTSIDE_REPO', async ({ path }) => {
          // Arrange + Assert
          await expectError(() => validatePath(path), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a path no length rule refuses', () => {
      describe('When validatePath', () => {
        it.each([
          {
            path: `${Array.from({ length: 16 }, () => 'a'.repeat(255)).join('/')}/a`,
            label: 'a 4097-byte path',
          },
          {
            path: Array.from({ length: 16 }, () => 'a'.repeat(255)).join('/'),
            label: 'a 4095-byte path of sixteen 255-byte components',
          },
          { path: `a/${'b'.repeat(256)}/c`, label: 'a 256-byte component' },
          { path: `a/${'b'.repeat(255)}/c`, label: 'a 255-byte component' },
        ])('Then $label is returned unchanged', ({ path }) => {
          // Arrange
          const sut = validatePath;

          // Act + Assert
          expect(sut(path)).toBe(path);
        });
      });
    });

    describe('Given a path with leading slash', () => {
      describe('When validatePath', () => {
        it('Then thrown error.data.path is the original input (kills StringLiteral on factory arg)', async () => {
          // Arrange + Assert
          const err = await expectError(() => validatePath('/abs'), 'PATHSPEC_OUTSIDE_REPO');
          const data = err.data;
          if (data.code === 'PATHSPEC_OUTSIDE_REPO') {
            expect(data.path).toBe('/abs');
          }
        });
      });
    });
  });

  describe('materializeFile', () => {
    describe("Given mode 100644 + content 'abc'", () => {
      describe('When materializeFile', () => {
        it('Then file written with content', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = 'src/file.txt' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('abc'), '100644');

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('abc');
        });
      });
    });

    describe('Given mode 100755', () => {
      describe('When materializeFile', () => {
        it('Then file written (executable mode honored where supported)', async () => {
          // Arrange — memory FS has no permission model, so we just verify it was written.
          const ctx = createMemoryContext();
          const path = 'bin/run.sh' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('#!/bin/sh\n'), '100755');

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(true);
        });
      });
    });

    describe('Given mode 120000 on a platform without symlink support (memory)', () => {
      describe('When materializeFile', () => {
        it('Then writes a regular file with link target as content (no trailing newline)', async () => {
          // Arrange — memory adapter doesn't support symlinks via openWithNoFollow's fallback,
          // and the design says: write the link-target string as bytes, no trailing newline.
          const ctx = createMemoryContext();
          const path = 'link.txt' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('target/path'), '120000');

          // Assert — content is byte-exact; no trailing newline injected.
          const bytes = await ctx.fs.read(`${ctx.layout.workDir}/${path}`);
          expect(new TextDecoder().decode(bytes)).toBe('target/path');
        });
      });
    });

    describe('Given mode 160000 (gitlink)', () => {
      describe('When materializeFile', () => {
        it('Then throws UNSUPPORTED_OPERATION with gitlink operation/reason', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = 'sub-module' as FilePath;

          // Act
          const err = await expectError(
            () => materializeFile(ctx, path, new Uint8Array(), '160000'),
            'UNSUPPORTED_OPERATION',
          );

          // Assert — exact factory args (kills the L43 StringLiteral mutants).
          const data = err.data;
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('materializeFile');
            expect(data.reason).toBe('gitlink (submodule) not supported in v1');
          }
        });
      });
    });

    describe('Given mode 40000 (tree)', () => {
      describe('When materializeFile', () => {
        it('Then throws UNSUPPORTED_OPERATION with directory-mode reason', async () => {
          // Arrange — tree mode is not a leaf; covers the L45 guard + L47 StringLiterals.
          const ctx = createMemoryContext();
          const path = 'a-dir' as FilePath;

          // Act
          const err = await expectError(
            () => materializeFile(ctx, path, new Uint8Array(), '40000'),
            'UNSUPPORTED_OPERATION',
          );

          // Assert — exact factory args (kills the L47 StringLiteral mutants).
          const data = err.data;
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('materializeFile');
            expect(data.reason).toBe('directory mode is not a leaf');
          }
          // No file written for a tree-mode path.
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(false);
        });
      });
    });

    describe('Given mode 100644', () => {
      describe('When materializeFile', () => {
        it('Then chmod is called with 0o644 (not 0o755)', async () => {
          // Arrange
          const base = createMemoryContext();
          const chmod = vi.fn(base.fs.chmod);
          const ctx: Context = { ...base, fs: { ...base.fs, chmod } };
          const path = 'src/regular.txt' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('x'), '100644');

          // Assert — kills L71 EqualityOperator / ConditionalExpression and the chmod-arg path.
          expect(chmod).toHaveBeenCalledTimes(1);
          expect(chmod).toHaveBeenCalledWith(`${ctx.layout.workDir}/${path}`, 0o644);
        });
      });
    });

    describe('Given mode 100755 with chmod observed', () => {
      describe('When materializeFile', () => {
        it('Then chmod is called with 0o755 (not 0o644)', async () => {
          // Arrange
          const base = createMemoryContext();
          const chmod = vi.fn(base.fs.chmod);
          const ctx: Context = { ...base, fs: { ...base.fs, chmod } };
          const path = 'bin/exec.sh' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('#!/bin/sh\n'), '100755');

          // Assert — kills L69 ConditionalExpression and the chmod-arg path.
          expect(chmod).toHaveBeenCalledTimes(1);
          expect(chmod).toHaveBeenCalledWith(`${ctx.layout.workDir}/${path}`, 0o755);
        });
      });
    });

    describe('Given mode 120000 (symlink)', () => {
      describe('When materializeFile', () => {
        it('Then chmod is never called', async () => {
          // Arrange — symlink mode matches neither chmod branch; both guards must be false.
          const base = createMemoryContext();
          const chmod = vi.fn(base.fs.chmod);
          const ctx: Context = { ...base, fs: { ...base.fs, chmod } };
          const path = 'a-link' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('target'), '120000');

          // Assert — kills the L69/L71 ConditionalExpression `true` mutants.
          expect(chmod).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given openWithNoFollow throws UNSUPPORTED_OPERATION', () => {
      describe('When materializeFile', () => {
        it('Then it falls back to a plain write', async () => {
          // Arrange — emulates browser OPFS where O_NOFOLLOW is unavailable.
          const { ctx } = contextWithFailingOpen(
            unsupportedOperation('openWithNoFollow', 'OPFS has no symlinks'),
          );
          const path = 'src/fallback.txt' as FilePath;

          // Act — covers the L60-62 catch block + L61 equality check.
          await materializeFile(ctx, path, new TextEncoder().encode('via-fallback'), '100644');

          // Assert — the blob landed through the plain-write fallback.
          expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('via-fallback');
        });
      });
    });

    describe('Given openWithNoFollow throws a non-UNSUPPORTED TsgitError', () => {
      describe('When materializeFile', () => {
        it('Then it rethrows that error', async () => {
          // Arrange — a different TsgitError must NOT trigger the fallback write.
          const { ctx } = contextWithFailingOpen(permissionDenied('/repo/src/denied.txt'));
          const path = 'src/denied.txt' as FilePath;

          // Act — covers the L63-65 else branch (rethrow).
          const err = await expectError(
            () => materializeFile(ctx, path, new TextEncoder().encode('nope'), '100644'),
            'PERMISSION_DENIED',
          );

          // Assert — the original error propagated; no fallback content was written.
          const data = err.data;
          if (data.code === 'PERMISSION_DENIED') {
            expect(data.path).toBe('/repo/src/denied.txt');
          }
          expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('');
        });
      });
    });

    describe('Given openWithNoFollow throws a plain non-TsgitError', () => {
      describe('When materializeFile', () => {
        it('Then it rethrows (not a TsgitError → no fallback)', async () => {
          // Arrange — proves the L61 `instanceof TsgitError` guard, not just the code check.
          const sentinel = new Error('disk gone');
          const { ctx } = contextWithFailingOpen(sentinel);
          const path = 'src/plain-error.txt' as FilePath;

          // Act + Assert — the raw error propagates unchanged.
          let caught: unknown;
          try {
            await materializeFile(ctx, path, new TextEncoder().encode('nope'), '100644');
          } catch (e) {
            caught = e;
          }
          // Assert
          expect(caught).toBe(sentinel);
          // No fallback write occurred.
          expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('');
        });
      });
    });

    describe('Given a successful no-follow write', () => {
      describe('When materializeFile', () => {
        it('Then the file handle is closed in the finally block', async () => {
          // Arrange — wrap the memory adapter's real handle so `write` still
          // lands the bytes, but `close` is a spy. The L66 `finally` block
          // (`await handle?.close()`) must run on the happy path; a BlockStatement
          // mutant emptying that finally to `{}` would leak the descriptor.
          const base = createMemoryContext();
          const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
          const fs: FileSystem = {
            ...base.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
              const real = await base.fs.openWithNoFollow(path, mode);
              return { ...real, close };
            },
          };
          const ctx: Context = { ...base, fs };
          const path = 'src/closed.txt' as FilePath;

          // Act
          await materializeFile(ctx, path, new TextEncoder().encode('handle-content'), '100644');

          // Assert — close ran exactly once AND the write still succeeded.
          expect(close).toHaveBeenCalledTimes(1);
          expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('handle-content');
        });
      });
    });

    describe('Given the no-follow write itself throws', () => {
      describe('When materializeFile', () => {
        it('Then the handle is still closed before the error propagates', async () => {
          // Arrange — `handle.write` rejects, so the finally block is the only
          // place `close` can run. A BlockStatement→`{}` mutant on the L66
          // finally would skip `close` entirely on the error path.
          const base = createMemoryContext();
          const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
          const writeError = new Error('write blew up');
          const fs: FileSystem = {
            ...base.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
              const real = await base.fs.openWithNoFollow(path, mode);
              return { ...real, write: () => Promise.reject(writeError), close };
            },
          };
          const ctx: Context = { ...base, fs };
          const path = 'src/error-then-close.txt' as FilePath;

          // Act
          let caught: unknown;
          try {
            await materializeFile(ctx, path, new TextEncoder().encode('x'), '100644');
          } catch (err) {
            caught = err;
          }

          // Assert — the original error propagated AND the handle was closed.
          expect(caught).toBe(writeError);
          expect(close).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe("Given a path containing '.git'", () => {
      describe('When materializeFile', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO before any I/O', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await expectError(
            () => materializeFile(ctx, '.git/config' as FilePath, new Uint8Array(), '100644'),
            'PATHSPEC_OUTSIDE_REPO',
          );

          // Assert — no file written.
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/.git/config`)).toBe(false);
        });
      });
    });
  });

  describe('removeFile', () => {
    describe('Given a regular file we wrote', () => {
      describe('When removeFile', () => {
        it('Then it is removed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = 'src/foo.txt' as FilePath;
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, 'data');

          // Act
          await removeFile(ctx, path);

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(false);
        });
      });
    });

    describe('Given a directory at the path', () => {
      describe('When removeFile', () => {
        it('Then throws CHECKOUT_OVERWRITE_DIRTY listing that path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const dir = 'subdir' as FilePath;
          await ctx.fs.mkdir(`${ctx.layout.workDir}/${dir}`);

          // Act
          const err = await expectError(() => removeFile(ctx, dir), 'CHECKOUT_OVERWRITE_DIRTY');

          // Assert — the offending path is reported (kills L99 ArrayDeclaration `[]`).
          const data = err.data;
          if (data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
            expect(data.localChanges).toEqual([dir]);
            expect(data.untracked).toEqual([]);
          }
        });
      });
    });

    describe('Given a missing file', () => {
      describe('When removeFile', () => {
        it('Then throws FILE_NOT_FOUND carrying the full path, for the caller to tolerate', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = 'missing.txt' as FilePath;

          // Act
          const err = await expectError(() => removeFile(ctx, path), 'FILE_NOT_FOUND');

          // Assert
          if (err.data.code !== 'FILE_NOT_FOUND') throw new Error('unexpected error shape');
          expect(err.data.path).toBe(`${ctx.layout.workDir}/${path}`);
        });
      });
    });

    describe('Given an lstat denied by the file system', () => {
      describe('When removeFile', () => {
        it('Then throws CHECKOUT_OVERWRITE_DIRTY listing that path', async () => {
          // Arrange
          const base = createMemoryContext();
          const path = 'locked.txt' as FilePath;
          const ctx: Context = {
            ...base,
            fs: {
              ...base.fs,
              lstat: async (full: string) => {
                throw permissionDenied(full);
              },
            },
          };

          // Act
          const err = await expectError(() => removeFile(ctx, path), 'CHECKOUT_OVERWRITE_DIRTY');

          // Assert
          if (err.data.code !== 'CHECKOUT_OVERWRITE_DIRTY')
            throw new Error('unexpected error shape');
          expect(err.data.localChanges).toEqual([path]);
          expect(err.data.untracked).toEqual([]);
        });
      });
    });

    describe('Given a backslash-named file on a POSIX host', () => {
      describe('When removeFile', () => {
        it('Then it is removed — the backslash is an ordinary file-name byte', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a\\b`, 'data');
          const sut = removeFile;

          // Act
          await sut(ctx, 'a\\b');

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/a\\b`)).toBe(false);
        });
      });
    });

    describe('Given a backslash path on a Windows path-syntax host', () => {
      describe('When removeFile', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO carrying the path', async () => {
          // Arrange
          const ctx = { ...createMemoryContext(), windowsPathSyntax: true };
          const sut = removeFile;

          // Act
          const err = await expectError(() => sut(ctx, 'a\\b'), 'PATHSPEC_OUTSIDE_REPO');

          // Assert
          expect(err.data).toMatchObject({ path: 'a\\b' });
        });
      });
    });

    describe('Given a symlink at the path', () => {
      describe('When removeFile', () => {
        it('Then it is removed (covers the !isSymbolicLink guard)', async () => {
          // Arrange — a symlink leaf is a legitimate removal target, not a divergence.
          const ctx = createMemoryContext();
          const path = 'a-symlink' as FilePath;
          await ctx.fs.symlink('target', `${ctx.layout.workDir}/${path}`);

          // Act
          await removeFile(ctx, path);

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(false);
        });
      });
    });

    describe('Given a path that fails validation', () => {
      describe('When removeFile', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO before any I/O', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Assert
          await expectError(
            () => removeFile(ctx, '../escape' as FilePath),
            'PATHSPEC_OUTSIDE_REPO',
          );
        });
      });
    });
  });

  describe('removeDirectory', () => {
    describe('Given a populated directory', () => {
      describe('When removeDirectory', () => {
        it('Then the directory and its contents are removed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/a/b.txt`, 'data');
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'gitdir: x');

          // Act
          await removeDirectory(ctx, 'sub');

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/sub`)).toBe(false);
        });
      });
    });

    describe('Given a regular file at the path', () => {
      describe('When removeDirectory', () => {
        it('Then throws CHECKOUT_OVERWRITE_DIRTY listing that path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub`, 'data');

          // Act
          const err = await expectError(
            () => removeDirectory(ctx, 'sub'),
            'CHECKOUT_OVERWRITE_DIRTY',
          );

          // Assert
          expect(err.data).toEqual({
            code: 'CHECKOUT_OVERWRITE_DIRTY',
            localChanges: ['sub'],
            untracked: [],
          });
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/sub`)).toBe(true);
        });
      });
    });

    describe('Given a missing path', () => {
      describe('When removeDirectory', () => {
        it('Then throws CHECKOUT_OVERWRITE_DIRTY listing that path', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const err = await expectError(
            () => removeDirectory(ctx, 'sub'),
            'CHECKOUT_OVERWRITE_DIRTY',
          );

          // Assert
          expect(err.data).toEqual({
            code: 'CHECKOUT_OVERWRITE_DIRTY',
            localChanges: ['sub'],
            untracked: [],
          });
        });
      });
    });

    describe('Given a symlink at the path', () => {
      describe('When removeDirectory', () => {
        it('Then throws CHECKOUT_OVERWRITE_DIRTY and keeps the link', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.workDir}/real`);
          await ctx.fs.symlink('real', `${ctx.layout.workDir}/sub`);

          // Act
          const err = await expectError(
            () => removeDirectory(ctx, 'sub'),
            'CHECKOUT_OVERWRITE_DIRTY',
          );

          // Assert
          expect(err.data).toMatchObject({ localChanges: ['sub'] });
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/real`)).toBe(true);
        });
      });
    });

    describe('Given a path that fails validation', () => {
      describe('When removeDirectory', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO carrying the path', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const err = await expectError(
            () => removeDirectory(ctx, '../escape'),
            'PATHSPEC_OUTSIDE_REPO',
          );

          // Assert
          expect(err.data).toMatchObject({ path: '../escape' });
        });
      });
    });
  });

  describe('discardDirectory', () => {
    describe('Given a tree holding a file, a nested directory and an empty directory', () => {
      describe('When discardDirectory', () => {
        it('Then all of it is removed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const root = ctx.layout.workDir;
          await ctx.fs.writeUtf8(`${root}/sub/f`, 'f');
          await ctx.fs.writeUtf8(`${root}/sub/n/g`, 'g');
          await ctx.fs.mkdir(`${root}/sub/emp`);
          const sut = discardDirectory;

          // Act
          await sut(ctx, 'sub');

          // Assert
          expect(await ctx.fs.exists(`${root}/sub`)).toBe(false);
        });
      });
    });

    describe('Given a missing path', () => {
      describe('When discardDirectory', () => {
        it('Then it resolves', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = discardDirectory;

          // Act
          const result = sut(ctx, 'sub');

          // Assert
          await expect(result).resolves.toBeUndefined();
        });
      });
    });

    describe('Given a path outside the repository', () => {
      describe('When discardDirectory', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO carrying the path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = discardDirectory;

          // Act
          const err = await expectError(() => sut(ctx, '../x'), 'PATHSPEC_OUTSIDE_REPO');

          // Assert
          expect(err.data).toMatchObject({ path: '../x' });
        });
      });
    });
  });

  describe('renameInWorkingTree', () => {
    describe('Given a directory containing a leaf file', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then without renameDirectory it reads the directory, creates the destination, renames each leaf and removes nothing recursively', async () => {
          // Arrange — the memory adapter's `rename` moves a whole subtree in one call,
          // so end-state alone cannot tell recursion from a direct directory rename.
          // Spies pin the portable leaf-by-leaf primitive the directory branch must use.
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old`);
          await base.fs.writeUtf8(`${root}/old/f.txt`, 'data');
          const bare = withoutDirectoryRename(base.fs);
          const readdir = vi.fn(base.fs.readdir);
          const mkdir = vi.fn(base.fs.mkdir);
          const rmRecursive = vi.fn(base.fs.rmRecursive);
          const rename = vi.fn(base.fs.rename);
          const ctx: Context = { ...base, fs: { ...bare, readdir, mkdir, rmRecursive, rename } };

          // Act
          await renameInWorkingTree(ctx, 'old', 'new');

          // Assert — entries were listed, the destination was created, the leaf was
          // renamed and no recursive removal ran. The directory node itself is never
          // renamed directly.
          expect(readdir).toHaveBeenCalledWith(`${root}/old`);
          expect(mkdir).toHaveBeenCalledWith(`${root}/new`);
          expect(rename).toHaveBeenCalledWith(`${root}/old/f.txt`, `${root}/new/f.txt`);
          expect(rmRecursive).not.toHaveBeenCalled();
          expect(rename).not.toHaveBeenCalledWith(`${root}/old`, `${root}/new`);
          // And the move actually landed.
          expect(await base.fs.readUtf8(`${root}/new/f.txt`)).toBe('data');
        });
      });
    });

    describe('Given an adapter without renameDirectory and a directory holding a file and an empty subdirectory', () => {
      describe('When renameInWorkingTree moves it', () => {
        it('Then the empty subdirectory survives at the destination', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old/emp`);
          await base.fs.writeUtf8(`${root}/old/f.txt`, 'data');
          const ctx: Context = { ...base, fs: withoutDirectoryRename(base.fs) };

          // Act
          await renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          expect((await base.fs.lstat(`${root}/new/emp`)).isDirectory).toBe(true);
          expect(await base.fs.exists(`${root}/old`)).toBe(false);
        });
      });
    });

    describe('Given an adapter without renameDirectory and a two-level directory', () => {
      describe('When renameInWorkingTree moves it', () => {
        it('Then the whole subtree is read before the first rename, every directory is made and nothing is removed recursively', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old/s`);
          await base.fs.writeUtf8(`${root}/old/a`, 'a');
          await base.fs.writeUtf8(`${root}/old/s/b`, 'b');
          const calls: Array<readonly [string, string]> = [];
          const logged =
            <A extends string>(op: string, fn: (path: A, ...rest: never[]) => Promise<unknown>) =>
            (path: A, ...rest: never[]) => {
              calls.push([op, path]);
              return fn.call(base.fs, path, ...rest);
            };
          const fs = {
            ...withoutDirectoryRename(base.fs),
            lstat: logged('lstat', base.fs.lstat),
            readdir: logged('readdir', base.fs.readdir),
            mkdir: logged('mkdir', base.fs.mkdir),
            rename: logged('rename', base.fs.rename),
            rmRecursive: logged('rmRecursive', base.fs.rmRecursive),
          } as unknown as FileSystem;
          const ctx: Context = { ...base, fs };

          // Act
          await renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          const ops = calls.map(([op]) => op);
          const firstRename = ops.indexOf('rename');
          const deepestRead = calls.findIndex(
            ([op, path]) => op === 'lstat' && path === `${root}/old/s/b`,
          );
          expect(deepestRead).toBeGreaterThanOrEqual(0);
          expect(firstRename).toBeGreaterThan(deepestRead);
          expect(calls).toContainEqual(['mkdir', `${root}/new`]);
          expect(calls).toContainEqual(['mkdir', `${root}/new/s`]);
          expect(ops).not.toContain('rmRecursive');
        });
      });
    });

    describe('Given an adapter without renameDirectory whose readdir faults on a nested directory', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then the fault propagates and no rename happened', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old/s`);
          await base.fs.writeUtf8(`${root}/old/a`, 'a');
          const fault = permissionDenied(`${root}/old/s`);
          const rename = vi.fn(base.fs.rename);
          const readdir = async (path: string) => {
            if (path === `${root}/old/s`) throw fault;
            return base.fs.readdir(path);
          };
          const ctx: Context = {
            ...base,
            fs: { ...withoutDirectoryRename(base.fs), readdir, rename },
          };

          // Act
          const outcome = renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          await expect(outcome).rejects.toBe(fault);
          expect(rename).not.toHaveBeenCalled();
          expect(await base.fs.exists(`${root}/old/a`)).toBe(true);
        });
      });
    });

    describe('Given an adapter without renameDirectory and an entry that appears in the source after the move', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then the late entry is kept', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old`);
          await base.fs.writeUtf8(`${root}/old/a`, 'a');
          const rename = async (from: string, to: string) => {
            await base.fs.rename(from, to);
            await base.fs.writeUtf8(`${root}/old/late`, 'late');
          };
          const ctx: Context = { ...base, fs: { ...withoutDirectoryRename(base.fs), rename } };

          // Act
          await renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          expect(await base.fs.readUtf8(`${root}/new/a`)).toBe('a');
          expect(await base.fs.readUtf8(`${root}/old/late`)).toBe('late');
        });
      });
    });

    describe('Given an adapter without renameDirectory whose rename faults on the second leaf', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then that fault rejects, the first leaf moved, the second stayed, and every write lies under the destination', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old`);
          await base.fs.writeUtf8(`${root}/old/a`, 'a');
          await base.fs.writeUtf8(`${root}/old/b`, 'b');
          const fault = permissionDenied(`${root}/old/b`);
          const written: string[] = [];
          const rename = async (from: string, to: string) => {
            if (from === `${root}/old/b`) throw fault;
            written.push(to);
            await base.fs.rename(from, to);
          };
          const mkdir = async (path: string) => {
            written.push(path);
            await base.fs.mkdir(path);
          };
          const ctx: Context = {
            ...base,
            fs: { ...withoutDirectoryRename(base.fs), rename, mkdir },
          };

          // Act
          const outcome = renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          await expect(outcome).rejects.toBe(fault);
          expect(await base.fs.exists(`${root}/new/a`)).toBe(true);
          expect(await base.fs.exists(`${root}/old/b`)).toBe(true);
          expect(await base.fs.exists(`${root}/old`)).toBe(true);
          expect(written.every((p) => p === `${root}/new` || p.startsWith(`${root}/new/`))).toBe(
            true,
          );
        });
      });
    });

    describe('Given a directory and an adapter with renameDirectory', () => {
      describe('When renameInWorkingTree moves it', () => {
        it('Then it renames the directory once and reads nothing beneath it', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old`);
          await base.fs.writeUtf8(`${root}/old/f.txt`, 'data');
          const renameDirectory = vi.fn(
            base.fs.renameDirectory as NonNullable<FileSystem['renameDirectory']>,
          );
          const readdir = vi.fn(base.fs.readdir);
          const rmRecursive = vi.fn(base.fs.rmRecursive);
          const rename = vi.fn(base.fs.rename);
          const ctx: Context = {
            ...base,
            fs: { ...base.fs, renameDirectory, readdir, rmRecursive, rename },
          };

          // Act
          await renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          expect(renameDirectory).toHaveBeenCalledTimes(1);
          expect(renameDirectory).toHaveBeenCalledWith(`${root}/old`, `${root}/new`);
          expect(readdir).not.toHaveBeenCalled();
          expect(rmRecursive).not.toHaveBeenCalled();
          expect(rename).not.toHaveBeenCalled();
          expect(await base.fs.readUtf8(`${root}/new/f.txt`)).toBe('data');
        });
      });
    });

    describe('Given renameDirectory refusing PATH_TOO_LONG for the absolute source', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then the error names the repository-relative destination', async () => {
          // Arrange
          const base = createMemoryContext();
          await base.fs.mkdir(`${base.layout.workDir}/old`);
          const renameDirectory = vi.fn(async () => {
            throw pathTooLong('/abs/old');
          });
          const ctx: Context = { ...base, fs: { ...base.fs, renameDirectory } };

          // Act
          const err = await expectError(
            () => renameInWorkingTree(ctx, 'old', 'new'),
            'PATH_TOO_LONG',
          );

          // Assert
          expect(err.data).toEqual({ code: 'PATH_TOO_LONG', path: 'new' });
        });
      });
    });

    describe('Given renameDirectory refusing PERMISSION_DENIED', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then that very error is rethrown', async () => {
          // Arrange
          const base = createMemoryContext();
          await base.fs.mkdir(`${base.layout.workDir}/old`);
          const fault = permissionDenied('/abs/old');
          const renameDirectory = vi.fn(async () => {
            throw fault;
          });
          const ctx: Context = { ...base, fs: { ...base.fs, renameDirectory } };

          // Act
          const outcome = renameInWorkingTree(ctx, 'old', 'new');

          // Assert
          await expect(outcome).rejects.toBe(fault);
        });
      });
    });

    describe('Given a symlink to a directory as the source', () => {
      describe('When renameInWorkingTree moves it', () => {
        it('Then it goes through rename, never renameDirectory', async () => {
          // Arrange
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/real`);
          await base.fs.symlink('real', `${root}/link`);
          const renameDirectory = vi.fn(
            base.fs.renameDirectory as NonNullable<FileSystem['renameDirectory']>,
          );
          const rename = vi.fn(base.fs.rename);
          const ctx: Context = { ...base, fs: { ...base.fs, renameDirectory, rename } };

          // Act
          await renameInWorkingTree(ctx, 'link', 'moved');

          // Assert
          expect(rename).toHaveBeenCalledWith(`${root}/link`, `${root}/moved`);
          expect(renameDirectory).not.toHaveBeenCalled();
        });
      });
    });

    describe("Given a root-level target whose parent is the work-tree root '/'", () => {
      describe('When renameInWorkingTree moves a leaf to it', () => {
        it('Then it skips the empty-parent mkdir and renames straight into the root', async () => {
          // Arrange — a '/' work dir (browser/OPFS root) makes `dirname(dst)` empty. The
          // guard must NOT `mkdir('')` (the fs validator rejects an empty path). This is the
          // only reachable input where the L143 guard differs from always-mkdir.
          const base = createMemoryContext();
          const lstat = vi.fn<(p: string) => Promise<FileStat>>(() => Promise.resolve(leafStat()));
          const mkdir = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
          const rename = vi.fn<(a: string, b: string) => Promise<void>>(() => Promise.resolve());
          const ctx: Context = {
            ...base,
            layout: { ...base.layout, workDir: '/' },
            fs: { ...base.fs, lstat, mkdir, rename },
          };

          // Act
          await renameInWorkingTree(ctx, 'oldname', 'newname');

          // Assert — no mkdir for the empty parent; the leaf renamed straight into the root
          // (kills the L143 `true` / StringLiteral / `=== ''` mutants, which would mkdir('')).
          expect(mkdir).not.toHaveBeenCalled();
          expect(rename).toHaveBeenCalledWith('/oldname', '/newname');
        });
      });
    });
  });
});

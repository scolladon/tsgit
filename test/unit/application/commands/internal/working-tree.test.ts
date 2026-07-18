import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  materializeFile,
  readFile,
  removeFile,
  renameInWorkingTree,
  validatePath,
} from '../../../../../src/application/commands/internal/working-tree.js';
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
          const sut = validatePath('src/foo.ts');

          // Assert
          expect(sut).toBe('src/foo.ts');
        });
      });
    });

    describe("Given '/abs/path'", () => {
      describe('When validatePath', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('/abs/path'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe("Given '../escape'", () => {
      describe('When validatePath', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('../escape'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe("Given 'a/../b'", () => {
      describe('When validatePath', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('a/../b'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a path containing NUL byte', () => {
      describe('When validatePath', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('a\0b'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe("Given 'foo/.git/config' (lowercase .git)", () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/.git/config'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe("Given 'foo/.GIT/config' (uppercase .GIT)", () => {
      describe('When validatePath', () => {
        it('Then throws (case-insensitive)', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/.GIT/config'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe("Given 'foo/.git ' (trailing space)", () => {
      describe('When validatePath', () => {
        it('Then throws (NTFS-safe)', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/.git /file'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe("Given 'foo/.git.' (trailing dot)", () => {
      describe('When validatePath', () => {
        it('Then throws (NTFS-safe)', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/.git./file'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a path 4097 bytes long', () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange
          const tooLong = `${'a'.repeat(4097)}`;
          // Assert
          await expectError(() => validatePath(tooLong), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a 256-byte component', () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange
          const bigComponent = 'b'.repeat(256);
          // Assert
          await expectError(() => validatePath(`a/${bigComponent}/c`), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a control character (\\\\x01) in component', () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/bar\x01baz'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given an empty string', () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange + Assert
          await expectError(() => validatePath(''), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a path with backslash separator (Windows-style)', () => {
      describe('When validatePath', () => {
        it('Then throws (use POSIX separators)', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('a\\b'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a 4096-byte path with components ≤255', () => {
      describe('When validatePath', () => {
        it('Then succeeds (boundary)', () => {
          // Arrange — kills `byteLength(input) >= MAX_PATH_BYTES` boundary mutants.
          // 16 segments × 255 = 4080, plus 15 separators = 4095. Total 4095 ≤ 4096.
          const big = 'a'.repeat(255);
          const path = Array.from({ length: 16 }, () => big).join('/');
          // Assert
          expect(path.length).toBe(4095);

          // Act + Assert — exactly one byte under the cap must NOT throw.
          expect(() => validatePath(path)).not.toThrow();
        });
      });
    });

    describe('Given a 4097-byte path', () => {
      describe('When validatePath', () => {
        it('Then throws (one over the cap)', async () => {
          // Arrange
          const path = 'a'.repeat(4097);
          // Assert
          await expectError(() => validatePath(path), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a component of exactly 255 bytes', () => {
      describe('When validatePath', () => {
        it('Then succeeds (boundary)', () => {
          // Arrange
          const path = `a/${'b'.repeat(255)}/c`;
          // Assert
          expect(() => validatePath(path)).not.toThrow();
        });
      });
    });

    describe('Given a control character at exactly 0x1F', () => {
      describe('When validatePath', () => {
        it('Then throws (boundary kill for `code <= 0x1f`)', async () => {
          // Arrange + Assert
          await expectError(
            () => validatePath(`foo/bar${String.fromCharCode(0x1f)}baz`),
            'PATHSPEC_OUTSIDE_REPO',
          );
        });
      });
    });

    describe('Given a component containing `:` (NTFS Alternate Data Stream / Windows drive)', () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/.git:$DATA/x'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a component starting with a Windows drive letter (`C:rel`)', () => {
      describe('When validatePath', () => {
        it('Then throws', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('C:relative/file'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given `.git` followed by mixed dots and spaces', () => {
      describe('When validatePath', () => {
        it('Then throws (defensive NTFS strip)', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/.git . . /file'), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });

    describe('Given a path with trailing slash', () => {
      describe('When validatePath', () => {
        it('Then throws (kills `startsWith` vs `endsWith` direction mutant)', async () => {
          // Arrange + Assert
          await expectError(() => validatePath('foo/'), 'PATHSPEC_OUTSIDE_REPO');
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

    describe('Given mode 100755', () => {
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
        it('Then throws CHECKOUT_OVERWRITE_DIRTY listing that path (treated as a divergence)', async () => {
          // Arrange — the contract says: if the working tree state doesn't match what we wrote, refuse.
          // Missing-when-expected qualifies as divergence; safer than silently succeeding.
          const ctx = createMemoryContext();
          const path = 'missing.txt' as FilePath;

          // Act
          const err = await expectError(() => removeFile(ctx, path), 'CHECKOUT_OVERWRITE_DIRTY');

          // Assert — the offending path is reported (kills L96 ArrayDeclaration `[]`).
          const data = err.data;
          if (data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
            expect(data.localChanges).toEqual([path]);
            expect(data.untracked).toEqual([]);
          }
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

  describe('readFile', () => {
    describe('Given a file at the path', () => {
      describe('When readFile', () => {
        it('Then returns its bytes', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = 'src/data.bin' as FilePath;
          const data = new Uint8Array([1, 2, 3, 4]);
          await ctx.fs.write(`${ctx.layout.workDir}/${path}`, data);

          // Act
          const sut = await readFile(ctx, path);

          // Assert
          expect(sut).toEqual(data);
        });
      });
    });

    describe('Given an invalid path', () => {
      describe('When readFile', () => {
        it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Assert
          await expectError(() => readFile(ctx, '../oops' as FilePath), 'PATHSPEC_OUTSIDE_REPO');
        });
      });
    });
  });

  describe('renameInWorkingTree', () => {
    describe('Given a directory containing a leaf file', () => {
      describe('When renameInWorkingTree moves the directory', () => {
        it('Then it recurses leaf-by-leaf — readdir, mkdir the leaf parent, rename each leaf, rmRecursive the shell', async () => {
          // Arrange — the memory adapter's `rename` moves a whole subtree in one call,
          // so end-state alone cannot tell recursion from a direct directory rename.
          // Spies pin the portable leaf-by-leaf primitive the directory branch must use.
          const base = createMemoryContext();
          const root = base.layout.workDir;
          await base.fs.mkdir(`${root}/old`);
          await base.fs.writeUtf8(`${root}/old/f.txt`, 'data');
          const readdir = vi.fn(base.fs.readdir);
          const mkdir = vi.fn(base.fs.mkdir);
          const rmRecursive = vi.fn(base.fs.rmRecursive);
          const rename = vi.fn(base.fs.rename);
          const ctx: Context = { ...base, fs: { ...base.fs, readdir, mkdir, rmRecursive, rename } };

          // Act
          await renameInWorkingTree(ctx, 'old', 'new');

          // Assert — the directory branch ran: entries were listed, the leaf's parent was
          // created, the leaf was renamed, and the emptied shell was removed. The directory
          // node itself is never renamed directly (kills the L129 skip-recursion mutants and
          // the L143 never-mkdir mutants).
          expect(readdir).toHaveBeenCalledWith(`${root}/old`);
          expect(mkdir).toHaveBeenCalledWith(`${root}/new`);
          expect(rename).toHaveBeenCalledWith(`${root}/old/f.txt`, `${root}/new/f.txt`);
          expect(rmRecursive).toHaveBeenCalledWith(`${root}/old`);
          expect(rename).not.toHaveBeenCalledWith(`${root}/old`, `${root}/new`);
          // And the move actually landed.
          expect(await base.fs.readUtf8(`${root}/new/f.txt`)).toBe('data');
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

import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  materializeFile,
  readFile,
  removeFile,
  validatePath,
} from '../../../../../src/application/commands/internal/working-tree.js';
import {
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../../../../src/domain/index.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileHandle, FileSystem } from '../../../../../src/ports/file-system.js';

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
    it("Given 'src/foo.ts', When validatePath, Then returns it as a FilePath", () => {
      // Act
      const sut = validatePath('src/foo.ts');

      // Assert
      expect(sut).toBe('src/foo.ts');
    });

    it("Given '/abs/path', When validatePath, Then throws PATHSPEC_OUTSIDE_REPO", async () => {
      await expectError(() => validatePath('/abs/path'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it("Given '../escape', When validatePath, Then throws PATHSPEC_OUTSIDE_REPO", async () => {
      await expectError(() => validatePath('../escape'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it("Given 'a/../b', When validatePath, Then throws PATHSPEC_OUTSIDE_REPO", async () => {
      await expectError(() => validatePath('a/../b'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a path containing NUL byte, When validatePath, Then throws PATHSPEC_OUTSIDE_REPO', async () => {
      await expectError(() => validatePath('a\0b'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it("Given 'foo/.git/config' (lowercase .git), When validatePath, Then throws", async () => {
      await expectError(() => validatePath('foo/.git/config'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it("Given 'foo/.GIT/config' (uppercase .GIT), When validatePath, Then throws (case-insensitive)", async () => {
      await expectError(() => validatePath('foo/.GIT/config'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it("Given 'foo/.git ' (trailing space), When validatePath, Then throws (NTFS-safe)", async () => {
      await expectError(() => validatePath('foo/.git /file'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it("Given 'foo/.git.' (trailing dot), When validatePath, Then throws (NTFS-safe)", async () => {
      await expectError(() => validatePath('foo/.git./file'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a path 4097 bytes long, When validatePath, Then throws', async () => {
      const tooLong = `${'a'.repeat(4097)}`;
      await expectError(() => validatePath(tooLong), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a 256-byte component, When validatePath, Then throws', async () => {
      const bigComponent = 'b'.repeat(256);
      await expectError(() => validatePath(`a/${bigComponent}/c`), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a control character (\\x01) in component, When validatePath, Then throws', async () => {
      await expectError(() => validatePath('foo/bar\x01baz'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given an empty string, When validatePath, Then throws', async () => {
      await expectError(() => validatePath(''), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a path with backslash separator (Windows-style), When validatePath, Then throws (use POSIX separators)', async () => {
      await expectError(() => validatePath('a\\b'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a 4096-byte path with components ≤255, When validatePath, Then succeeds (boundary)', () => {
      // Arrange — kills `byteLength(input) >= MAX_PATH_BYTES` boundary mutants.
      // 16 segments × 255 = 4080, plus 15 separators = 4095. Total 4095 ≤ 4096.
      const big = 'a'.repeat(255);
      const path = Array.from({ length: 16 }, () => big).join('/');
      expect(path.length).toBe(4095);

      // Act + Assert — exactly one byte under the cap must NOT throw.
      expect(() => validatePath(path)).not.toThrow();
    });

    it('Given a 4097-byte path, When validatePath, Then throws (one over the cap)', async () => {
      const path = 'a'.repeat(4097);
      await expectError(() => validatePath(path), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a component of exactly 255 bytes, When validatePath, Then succeeds (boundary)', () => {
      const path = `a/${'b'.repeat(255)}/c`;
      expect(() => validatePath(path)).not.toThrow();
    });

    it('Given a control character at exactly 0x1F, When validatePath, Then throws (boundary kill for `code <= 0x1f`)', async () => {
      await expectError(
        () => validatePath(`foo/bar${String.fromCharCode(0x1f)}baz`),
        'PATHSPEC_OUTSIDE_REPO',
      );
    });

    it('Given a component containing `:` (NTFS Alternate Data Stream / Windows drive), When validatePath, Then throws', async () => {
      await expectError(() => validatePath('foo/.git:$DATA/x'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a component starting with a Windows drive letter (`C:rel`), When validatePath, Then throws', async () => {
      await expectError(() => validatePath('C:relative/file'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given `.git` followed by mixed dots and spaces, When validatePath, Then throws (defensive NTFS strip)', async () => {
      await expectError(() => validatePath('foo/.git . . /file'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a path with trailing slash, When validatePath, Then throws (kills `startsWith` vs `endsWith` direction mutant)', async () => {
      await expectError(() => validatePath('foo/'), 'PATHSPEC_OUTSIDE_REPO');
    });

    it('Given a path with leading slash, When validatePath, Then thrown error.data.path is the original input (kills StringLiteral on factory arg)', async () => {
      const err = await expectError(() => validatePath('/abs'), 'PATHSPEC_OUTSIDE_REPO');
      const data = err.data;
      if (data.code === 'PATHSPEC_OUTSIDE_REPO') {
        expect(data.path).toBe('/abs');
      }
    });
  });

  describe('materializeFile', () => {
    it("Given mode 100644 + content 'abc', When materializeFile, Then file written with content", async () => {
      // Arrange
      const ctx = createMemoryContext();
      const path = 'src/file.txt' as FilePath;

      // Act
      await materializeFile(ctx, path, new TextEncoder().encode('abc'), '100644');

      // Assert
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('abc');
    });

    it('Given mode 100755, When materializeFile, Then file written (executable mode honored where supported)', async () => {
      // Arrange — memory FS has no permission model, so we just verify it was written.
      const ctx = createMemoryContext();
      const path = 'bin/run.sh' as FilePath;

      // Act
      await materializeFile(ctx, path, new TextEncoder().encode('#!/bin/sh\n'), '100755');

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(true);
    });

    it('Given mode 120000 on a platform without symlink support (memory), When materializeFile, Then writes a regular file with link target as content (no trailing newline)', async () => {
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

    it('Given mode 160000 (gitlink), When materializeFile, Then throws UNSUPPORTED_OPERATION with gitlink operation/reason', async () => {
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

    it('Given mode 40000 (tree), When materializeFile, Then throws UNSUPPORTED_OPERATION with directory-mode reason', async () => {
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

    it('Given mode 100644, When materializeFile, Then chmod is called with 0o644 (not 0o755)', async () => {
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

    it('Given mode 100755, When materializeFile, Then chmod is called with 0o755 (not 0o644)', async () => {
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

    it('Given mode 120000 (symlink), When materializeFile, Then chmod is never called', async () => {
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

    it('Given openWithNoFollow throws UNSUPPORTED_OPERATION, When materializeFile, Then it falls back to a plain write', async () => {
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

    it('Given openWithNoFollow throws a non-UNSUPPORTED TsgitError, When materializeFile, Then it rethrows that error', async () => {
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

    it('Given openWithNoFollow throws a plain non-TsgitError, When materializeFile, Then it rethrows (not a TsgitError → no fallback)', async () => {
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
      expect(caught).toBe(sentinel);
      // No fallback write occurred.
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe('');
    });

    it("Given a path containing '.git', When materializeFile, Then throws PATHSPEC_OUTSIDE_REPO before any I/O", async () => {
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

  describe('removeFile', () => {
    it('Given a regular file we wrote, When removeFile, Then it is removed', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const path = 'src/foo.txt' as FilePath;
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, 'data');

      // Act
      await removeFile(ctx, path);

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(false);
    });

    it('Given a directory at the path, When removeFile, Then throws CHECKOUT_OVERWRITE_DIRTY listing that path', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const dir = 'subdir' as FilePath;
      await ctx.fs.mkdir(`${ctx.layout.workDir}/${dir}`);

      // Act
      const err = await expectError(() => removeFile(ctx, dir), 'CHECKOUT_OVERWRITE_DIRTY');

      // Assert — the offending path is reported (kills L99 ArrayDeclaration `[]`).
      const data = err.data;
      if (data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
        expect(data.paths).toEqual([dir]);
      }
    });

    it('Given a missing file, When removeFile, Then throws CHECKOUT_OVERWRITE_DIRTY listing that path (treated as a divergence)', async () => {
      // Arrange — the contract says: if the working tree state doesn't match what we wrote, refuse.
      // Missing-when-expected qualifies as divergence; safer than silently succeeding.
      const ctx = createMemoryContext();
      const path = 'missing.txt' as FilePath;

      // Act
      const err = await expectError(() => removeFile(ctx, path), 'CHECKOUT_OVERWRITE_DIRTY');

      // Assert — the offending path is reported (kills L96 ArrayDeclaration `[]`).
      const data = err.data;
      if (data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
        expect(data.paths).toEqual([path]);
      }
    });

    it('Given a symlink at the path, When removeFile, Then it is removed (covers the !isSymbolicLink guard)', async () => {
      // Arrange — a symlink leaf is a legitimate removal target, not a divergence.
      const ctx = createMemoryContext();
      const path = 'a-symlink' as FilePath;
      await ctx.fs.symlink('target', `${ctx.layout.workDir}/${path}`);

      // Act
      await removeFile(ctx, path);

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)).toBe(false);
    });

    it('Given a path that fails validation, When removeFile, Then throws PATHSPEC_OUTSIDE_REPO before any I/O', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      await expectError(() => removeFile(ctx, '../escape' as FilePath), 'PATHSPEC_OUTSIDE_REPO');
    });
  });

  describe('readFile', () => {
    it('Given a file at the path, When readFile, Then returns its bytes', async () => {
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

    it('Given an invalid path, When readFile, Then throws PATHSPEC_OUTSIDE_REPO', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      await expectError(() => readFile(ctx, '../oops' as FilePath), 'PATHSPEC_OUTSIDE_REPO');
    });
  });
});

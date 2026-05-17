/**
 * Unit tests for the `.git/shallow` reader/writer primitive.
 *
 * The primitive is a thin filesystem helper. Tests probe:
 *  - missing file → empty set
 *  - happy round-trip with multiple oids
 *  - canonical line endings + sort order
 *  - lock-rename atomicity
 *  - empty resulting set → file deleted
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { readShallow, updateShallow } from '../../../../src/application/primitives/shallow-file.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));
const OID_C = ObjectId.from('c'.repeat(40));

describe('shallow-file', () => {
  describe('readShallow', () => {
    it('Given no .git/shallow file, When read, Then returns an empty Set', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);

      // Act
      const sut = await readShallow(ctx);

      // Assert
      expect(sut.size).toBe(0);
    });

    it('Given a .git/shallow with two oids, When read, Then returns a Set of size 2', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n${OID_B}\n`);

      // Act
      const sut = await readShallow(ctx);

      // Assert
      expect(sut.size).toBe(2);
      expect(sut.has(OID_A)).toBe(true);
      expect(sut.has(OID_B)).toBe(true);
    });

    it('Given a .git/shallow with only a trailing newline, When read, Then returns an empty Set', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, '\n');

      // Act
      const sut = await readShallow(ctx);

      // Assert
      expect(sut.size).toBe(0);
    });

    it('Given a .git/shallow with whitespace between oids, When read, Then ignores blank lines', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n\n${OID_B}\n`);

      // Act
      const sut = await readShallow(ctx);

      // Assert
      expect(sut.size).toBe(2);
    });

    it('Given a .git/shallow with malformed lines (non-oid), When read, Then skips them silently', async () => {
      // Arrange — kill the `if (!isShallowOid(trimmed)) continue` survivor.
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `not-an-oid\n${OID_A}\nzzz\n`);

      // Act
      const sut = await readShallow(ctx);

      // Assert
      expect(sut.size).toBe(1);
      expect(sut.has(OID_A)).toBe(true);
    });

    it('Given readUtf8 throws a non-FILE_NOT_FOUND error, When readShallow runs, Then the error propagates', async () => {
      // Arrange — kill the `if (isFileNotFound(err)) return new Set()` survivor.
      const ctx = createMemoryContext();
      const boomCtx = {
        ...ctx,
        fs: {
          ...ctx.fs,
          readUtf8: async (): Promise<string> => {
            throw new Error('disk boom');
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await readShallow(boomCtx);
      } catch (err) {
        caught = err;
      }

      // Assert — non-FILE_NOT_FOUND must surface as-is, not get swallowed.
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('disk boom');
    });
  });

  describe('updateShallow', () => {
    it('Given a fresh repo, When updateShallow adds two oids, Then file holds them sorted', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);

      // Act
      await updateShallow(ctx, { shallow: [OID_B, OID_A], unshallow: [] });

      // Assert
      const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
      // sorted lex: a < b
      expect(written).toBe(`${OID_A}\n${OID_B}\n`);
    });

    it('Given an existing shallow file, When updateShallow removes one oid via unshallow, Then the file no longer carries it', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n${OID_B}\n`);

      // Act
      await updateShallow(ctx, { shallow: [], unshallow: [OID_A] });

      // Assert
      const sut = await readShallow(ctx);
      expect(sut.has(OID_A)).toBe(false);
      expect(sut.has(OID_B)).toBe(true);
    });

    it('Given an existing shallow file, When updateShallow empties the set via unshallow, Then the file is deleted', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);

      // Act
      await updateShallow(ctx, { shallow: [], unshallow: [OID_A] });

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
    });

    it('Given an empty starting state, When updateShallow with empty inputs, Then no file is created', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);

      // Act
      await updateShallow(ctx, { shallow: [], unshallow: [] });

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
    });

    it('Given a stale .lock file from a crashed prior write, When updateShallow runs, Then throws (lock contention surfaces)', async () => {
      // Arrange — simulate a hung lock.
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow.lock`, '');

      // Act & Assert
      let caught: unknown;
      try {
        await updateShallow(ctx, { shallow: [OID_A], unshallow: [] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      // We accept either FILE_EXISTS (raw write-exclusive failure surface) or
      // a wrapped lock error. Both indicate the contention path fired.
      const code = (caught as TsgitError).data.code;
      expect(['FILE_EXISTS', 'RESOURCE_LOCKED']).toContain(code);
    });

    it('Given a round-trip (write + read), When the read fires, Then the resulting Set matches the input', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);

      // Act
      await updateShallow(ctx, { shallow: [OID_A, OID_B, OID_C], unshallow: [] });
      const sut = await readShallow(ctx);

      // Assert
      expect(sut.size).toBe(3);
      expect([...sut].sort()).toEqual([OID_A, OID_B, OID_C]);
    });

    it('Given shallow that re-adds an existing oid, When updateShallow runs, Then no duplicate (Set semantics)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.mkdir(ctx.layout.gitDir);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);

      // Act
      await updateShallow(ctx, { shallow: [OID_A], unshallow: [] });

      // Assert — file still contains exactly one line for OID_A.
      const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
      expect(written).toBe(`${OID_A}\n`);
    });
  });
});

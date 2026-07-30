import { describe, expect, it } from 'vitest';
import {
  invalidateShallowSet,
  isShallowRepository,
  loadShallowSet,
} from '../../../../../src/application/primitives/internal/shallow-set.js';
import { shallowFilePath } from '../../../../../src/application/primitives/path-layout.js';
import { updateShallow } from '../../../../../src/application/primitives/shallow-file.js';
import {
  notADirectory,
  permissionDenied,
  type TsgitError,
} from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext } from '../fixtures.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;

describe('loadShallowSet / isShallowRepository', () => {
  describe('Given no .git/shallow file', () => {
    describe('When both accessors run', () => {
      it('Then loadShallowSet returns an empty set', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = loadShallowSet;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.size).toBe(0);
      });

      it('Then isShallowRepository returns false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = isShallowRepository;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a 0-byte .git/shallow file', () => {
    describe('When both accessors run', () => {
      it('Then loadShallowSet returns an empty set', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), '');
        const sut = loadShallowSet;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.size).toBe(0);
      });

      it('Then isShallowRepository returns true', async () => {
        // Arrange — the divergent-signals pin: presence, not content, decides.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), '');
        const sut = isShallowRepository;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a .git/shallow file with two entries', () => {
    describe('When loadShallowSet runs', () => {
      it('Then returns both oids', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), `${OID_A}\n${OID_B}\n`);
        const sut = loadShallowSet;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual(new Set([OID_A, OID_B]));
      });
    });
  });

  describe('Given loadShallowSet and isShallowRepository are both called on one Context', () => {
    describe('When the underlying shallow file is read', () => {
      it('Then ctx.fs.readUtf8 is called exactly once (memoised)', async () => {
        // Arrange
        const base = await buildSeededContext();
        await base.fs.writeUtf8(shallowFilePath(base.layout.gitDir), `${OID_A}\n`);
        const { ctx, calls } = instrumentedContext(base);

        // Act
        await loadShallowSet(ctx);
        await isShallowRepository(ctx);
        await loadShallowSet(ctx);

        // Assert
        const shallowReads = calls().filter(
          (call) => call.method === 'readUtf8' && call.path.endsWith('/shallow'),
        );
        expect(shallowReads.length).toBe(1);
      });
    });
  });

  describe('Given invalidateShallowSet is called after a memoised read', () => {
    describe('When loadShallowSet runs again', () => {
      it('Then the file is re-read and the new content is observed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), `${OID_A}\n`);
        const before = await loadShallowSet(ctx);
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), `${OID_A}\n${OID_B}\n`);
        const sut = invalidateShallowSet;

        // Act
        sut(ctx);
        const after = await loadShallowSet(ctx);

        // Assert
        expect(before).toEqual(new Set([OID_A]));
        expect(after).toEqual(new Set([OID_A, OID_B]));
      });
    });
  });

  describe('Given a Context that has already memoised an empty shallow set', () => {
    describe('When updateShallow writes a new boundary through the same Context', () => {
      it('Then loadShallowSet observes the write without a manual invalidation', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const before = await loadShallowSet(ctx);

        // Act
        await updateShallow(ctx, { shallow: [OID_A], unshallow: [] });
        const after = await loadShallowSet(ctx);

        // Assert
        expect(before.size).toBe(0);
        expect(after).toEqual(new Set([OID_A]));
      });
    });

    describe('When updateShallow deletes the file back to empty through the same Context', () => {
      it('Then loadShallowSet observes the empty set without a manual invalidation', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await updateShallow(ctx, { shallow: [OID_A], unshallow: [] });
        await loadShallowSet(ctx);

        // Act
        await updateShallow(ctx, { shallow: [], unshallow: [OID_A] });
        const after = await loadShallowSet(ctx);

        // Assert
        expect(after.size).toBe(0);
      });
    });
  });

  describe('Given a malformed .git/shallow file (a blank line)', () => {
    describe('When loadShallowSet runs', () => {
      it('Then rejects with SHALLOW_FILE_MALFORMED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), '\n');
        const sut = loadShallowSet;

        // Act & Assert
        let caught: unknown;
        try {
          await sut(ctx);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('SHALLOW_FILE_MALFORMED');
      });
    });

    describe('When isShallowRepository runs', () => {
      it('Then rejects with SHALLOW_FILE_MALFORMED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(shallowFilePath(ctx.layout.gitDir), '\n');
        const sut = isShallowRepository;

        // Act & Assert
        let caught: unknown;
        try {
          await sut(ctx);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('SHALLOW_FILE_MALFORMED');
      });
    });
  });

  describe('Given a git dir whose path component is not a directory', () => {
    describe('When both accessors run', () => {
      it('Then loadShallowSet treats NOT_A_DIRECTORY as absent and returns an empty set', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            readUtf8: async () => {
              throw notADirectory(shallowFilePath(base.layout.gitDir));
            },
          },
        };
        const sut = loadShallowSet;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.size).toBe(0);
      });

      it('Then isShallowRepository treats NOT_A_DIRECTORY as absent and returns false', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            readUtf8: async () => {
              throw notADirectory(shallowFilePath(base.layout.gitDir));
            },
          },
        };
        const sut = isShallowRepository;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a read that fails with a non-absence error', () => {
    describe('When loadShallowSet runs', () => {
      it('Then the foreign error propagates unchanged', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            readUtf8: async () => {
              throw permissionDenied(shallowFilePath(base.layout.gitDir));
            },
          },
        };
        const sut = loadShallowSet;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a malformed .git/shallow file later rewritten well-formed', () => {
    describe('When loadShallowSet runs again without an explicit invalidation', () => {
      it('Then the rejection was not memoised and the new set is returned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const path = shallowFilePath(ctx.layout.gitDir);
        await ctx.fs.writeUtf8(path, 'not-an-oid\n');
        const sut = loadShallowSet;
        await sut(ctx).catch(() => undefined);
        await ctx.fs.writeUtf8(path, `${OID_A}\n`);

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.has(OID_A)).toBe(true);
      });
    });
  });
});

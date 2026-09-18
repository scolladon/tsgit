import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  invalidateHeadSlot,
  readHeadFile,
  validateHead,
} from '../../../../../src/application/primitives/internal/head-file.js';
import { permissionDenied, type TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import { instrumentedContext, refuseReadOnSymlink, withNodeIdentity } from '../fixtures.js';

const headPath = (ctx: Context): string => `${ctx.layout.gitDir}/HEAD`;

const seedRegularHead = async (ctx: Context, content = 'ref: refs/heads/main\n'): Promise<void> => {
  await ctx.fs.writeUtf8(headPath(ctx), content);
};

describe('internal/head-file', () => {
  describe('validateHead', () => {
    describe('Given a regular-file HEAD with valid content', () => {
      describe('When validateHead runs', () => {
        it('Then it returns kind file with the decoded content', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRegularHead(ctx, 'ref: refs/heads/main\n');
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
        });
      });
    });

    describe('Given a symlinked HEAD', () => {
      describe('When validateHead runs', () => {
        it('Then it returns kind symlink with the raw link text, never dereferencing', async () => {
          // Arrange
          const base = createMemoryContext();
          await base.fs.symlink('refs/heads/main', headPath(base));
          const ctx = refuseReadOnSymlink(base, headPath(base));
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual({ kind: 'symlink', linkText: 'refs/heads/main' });
        });
      });
    });

    describe('Given an absent HEAD', () => {
      describe('When validateHead runs', () => {
        it('Then it returns kind unusable carrying the FILE_NOT_FOUND cause', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.kind).toBe('unusable');
          if (result.kind === 'unusable') {
            expect((result.cause as TsgitError).data.code).toBe('FILE_NOT_FOUND');
          }
        });
      });
    });

    describe('Given HEAD is unreadable at the lstat probe (EACCES-equivalent)', () => {
      describe('When validateHead runs', () => {
        it('Then it returns kind unusable carrying the PERMISSION_DENIED cause', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base);
          const target = headPath(base);
          const ctx: Context = {
            ...base,
            fs: {
              ...base.fs,
              lstat: async (path: string) => {
                if (path === target) throw permissionDenied(path);
                return base.fs.lstat(path);
              },
            },
          };
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.kind).toBe('unusable');
          if (result.kind === 'unusable') {
            expect((result.cause as TsgitError).data.code).toBe('PERMISSION_DENIED');
          }
        });
      });
    });
  });

  describe('the ino discriminator', () => {
    describe('Given a regular HEAD proxied with a Node-shaped ino !== 0 identity', () => {
      describe('When validateHead runs', () => {
        it('Then it reads through openWithNoFollow/handle.stat/read/close and never readUtf8', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base);
          const { ctx: proxied } = withNodeIdentity(base, headPath(base));
          const { ctx, calls } = instrumentedContext(proxied);
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
          const methods = calls().map((c) => c.method);
          expect(methods).toContain('openWithNoFollow');
          expect(methods).not.toContain('readUtf8');
        });
      });
    });

    describe('Given a regular HEAD on the plain memory adapter (ino === 0)', () => {
      describe('When validateHead runs', () => {
        it('Then it reads through readUtf8 and never opens a handle', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base);
          const { ctx, calls } = instrumentedContext(base);
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
          const methods = calls().map((c) => c.method);
          expect(methods).toContain('readUtf8');
          expect(methods).not.toContain('openWithNoFollow');
        });
      });
    });
  });

  describe('identity across two validateHead calls', () => {
    describe('Given an ino !== 0 proxied HEAD unchanged between two calls', () => {
      describe('When the second validateHead runs', () => {
        it('Then it issues lstat only — no readlink, readUtf8 or openWithNoFollow', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base);
          const { ctx: proxied } = withNodeIdentity(base, headPath(base));
          const { ctx, calls } = instrumentedContext(proxied);
          const sut = validateHead;
          await sut(ctx);

          // Act
          const before = calls().length;
          const result = await sut(ctx);
          const duringSecondCall = calls().slice(before);

          // Assert
          expect(result).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
          expect(duringSecondCall).toEqual([{ method: 'lstat', path: headPath(ctx) }]);
        });
      });
    });

    type MutableIdentity = {
      mtimeNs: bigint;
      ctimeNs: bigint;
      ino: number;
      size: number | undefined;
    };
    const identityFieldCases: ReadonlyArray<{
      readonly field: string;
      readonly mutate: (id: MutableIdentity) => void;
    }> = [
      { field: 'mtimeNs', mutate: (id) => (id.mtimeNs += 1n) },
      { field: 'ctimeNs', mutate: (id) => (id.ctimeNs += 1n) },
      { field: 'ino', mutate: (id) => (id.ino += 1) },
      { field: 'size', mutate: (id) => (id.size = 999) },
    ];

    describe.each(identityFieldCases)(
      'Given only $field changes between two calls',
      ({ mutate }) => {
        describe('When the second validateHead runs', () => {
          it('Then the identity mismatch forces a content re-read', async () => {
            // Arrange
            const base = createMemoryContext();
            await seedRegularHead(base);
            const { ctx, identity } = withNodeIdentity(base, headPath(base));
            const { ctx: instrumented, calls } = instrumentedContext(ctx);
            const sut = validateHead;
            await sut(instrumented);

            // Act
            mutate(identity);
            await sut(instrumented);

            // Assert — a re-read opens a second handle; an unchanged identity
            // would have skipped straight from `lstat` to the cached result.
            const openCount = calls().filter((c) => c.method === 'openWithNoFollow').length;
            expect(openCount).toBe(2);
          });
        });
      },
    );
  });

  describe('readHeadFile', () => {
    describe('Given validateHead already populated a trusted slot for this Context', () => {
      describe('When readHeadFile runs', () => {
        it('Then it returns the cached head with zero fs calls', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base);
          const { ctx, calls } = instrumentedContext(base);
          await validateHead(ctx);
          const sut = readHeadFile;
          const before = calls().length;

          // Act
          const result = await sut(ctx);
          const duringCall = calls().slice(before);

          // Assert
          expect(result).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
          expect(duringCall).toEqual([]);
        });
      });
    });

    describe('Given a primitive-only sequence that never calls validateHead', () => {
      describe('When readHeadFile runs twice in a row', () => {
        it('Then each call re-validates by lstat — neither is trusted', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base);
          const { ctx, calls } = instrumentedContext(base);
          const sut = readHeadFile;

          // Act
          await sut(ctx);
          const firstLstats = calls().filter((c) => c.method === 'lstat').length;
          await sut(ctx);
          const secondLstats = calls().filter((c) => c.method === 'lstat').length - firstLstats;

          // Assert
          expect(firstLstats).toBe(1);
          expect(secondLstats).toBe(1);
        });
      });
    });

    describe('Given a gate validated HEAD on the memory adapter and HEAD was rewritten raw afterwards', () => {
      describe('When readHeadFile runs before the next gate', () => {
        it('Then it still serves the pre-rewrite content — the next validateHead sees the rewrite', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base, 'ref: refs/heads/main\n');
          const { ctx, calls } = instrumentedContext(base);
          await validateHead(ctx);
          await ctx.fs.writeUtf8(headPath(ctx), 'ref: refs/heads/other\n');
          const before = calls().length;

          // Act
          const stale = await readHeadFile(ctx);
          const duringStaleRead = calls().slice(before);
          const fresh = await validateHead(ctx);

          // Assert — gate to gate: the raw rewrite is invisible until the next gate
          expect(stale).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
          expect(duringStaleRead).toEqual([]);
          expect(fresh).toEqual({ kind: 'file', content: 'ref: refs/heads/other\n' });
        });
      });
    });

    describe('Given a gate validated a Node-identity HEAD and HEAD was rewritten raw with a new inode afterwards', () => {
      describe('When readHeadFile runs before the next gate', () => {
        it('Then it still serves the pre-rewrite content — the next validateHead sees the rewrite', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base, 'ref: refs/heads/main\n');
          const { ctx: proxied, identity } = withNodeIdentity(base, headPath(base));
          const { ctx, calls } = instrumentedContext(proxied);
          await validateHead(ctx);
          await ctx.fs.writeUtf8(headPath(ctx), 'ref: refs/heads/other\n');
          // A lock-and-rename changes the inode — the same identity the gate would observe.
          identity.ino += 1;
          const before = calls().length;

          // Act
          const stale = await readHeadFile(ctx);
          const duringStaleRead = calls().slice(before);
          const fresh = await validateHead(ctx);

          // Assert — gate to gate: the raw rewrite is invisible until the next gate
          expect(stale).toEqual({ kind: 'file', content: 'ref: refs/heads/main\n' });
          expect(duringStaleRead).toEqual([]);
          expect(fresh).toEqual({ kind: 'file', content: 'ref: refs/heads/other\n' });
        });
      });
    });
  });

  describe('invalidateHeadSlot', () => {
    describe('Given a trusted slot from a prior validateHead call', () => {
      describe('When invalidateHeadSlot runs and readHeadFile is called again', () => {
        it('Then readHeadFile re-reads instead of serving the stale slot', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRegularHead(base, 'ref: refs/heads/main\n');
          const { ctx, calls } = instrumentedContext(base);
          await validateHead(ctx);
          await ctx.fs.writeUtf8(headPath(ctx), 'ref: refs/heads/other\n');
          const sut = invalidateHeadSlot;
          const before = calls().length;

          // Act
          sut(ctx);
          const result = await readHeadFile(ctx);
          const duringCall = calls().slice(before);

          // Assert
          expect(result).toEqual({ kind: 'file', content: 'ref: refs/heads/other\n' });
          expect(duringCall.some((c) => c.method === 'lstat')).toBe(true);
        });
      });
    });
  });

  describe('HEAD deleted between two commands', () => {
    describe('Given a trusted slot from a prior validateHead call', () => {
      describe('When HEAD is deleted and validateHead runs again', () => {
        it('Then it refuses unusable instead of serving the stale slot', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRegularHead(ctx);
          await validateHead(ctx);
          await ctx.fs.rm(headPath(ctx));
          const sut = validateHead;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.kind).toBe('unusable');
        });
      });
    });
  });
});

import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertAcceptedRepository,
  assertOperationalRepository,
  assertRepository,
} from '../../../../../src/application/primitives/internal/repo-state.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedRepo = async (ctx: Context, head = 'ref: refs/heads/main\n'): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, head);
};

const catchError = async (thunk: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await thunk();
  } catch (err) {
    return err as TsgitError;
  }
  throw new Error('expected thunk to throw');
};

describe('assertAcceptedRepository trust gate', () => {
  describe('Given a layout carrying neither untrusted nor implicitBare', () => {
    describe('When assertAcceptedRepository, assertRepository and assertOperationalRepository run', () => {
      it('Then all three resolve to the repo root', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);

        // Act
        const accepted = await assertAcceptedRepository(ctx);
        const repository = await assertRepository(ctx);
        const operational = await assertOperationalRepository(ctx);

        // Assert
        expect(accepted).toBe(ctx.layout.workDir);
        expect(repository).toBe(ctx.layout.workDir);
        expect(operational).toBe(ctx.layout.workDir);
      });
    });
  });

  describe('Given a layout carrying untrusted', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then it throws DUBIOUS_OWNERSHIP naming the work tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const untrusted: Context = { ...ctx, layout: { ...ctx.layout, untrusted: true } };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({ code: 'DUBIOUS_OWNERSHIP', path: ctx.layout.workDir });
      });
    });

    describe('When assertRepository runs', () => {
      it('Then it does not refuse', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const untrusted: Context = { ...ctx, layout: { ...ctx.layout, untrusted: true } };

        // Act
        const result = await assertRepository(untrusted);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });

    describe('When assertOperationalRepository runs', () => {
      it('Then it refuses, chaining through the accepted tier', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const untrusted: Context = { ...ctx, layout: { ...ctx.layout, untrusted: true } };

        // Act
        const caught = await catchError(() => assertOperationalRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data.code).toBe('DUBIOUS_OWNERSHIP');
      });
    });
  });

  describe('Given a layout carrying implicitBare', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then it throws IMPLICIT_BARE_REPOSITORY naming the gitDir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const implicitBareCtx: Context = { ...ctx, layout: { ...ctx.layout, implicitBare: true } };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(implicitBareCtx));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({
          code: 'IMPLICIT_BARE_REPOSITORY',
          gitDir: ctx.layout.gitDir,
        });
      });
    });

    describe('When assertRepository runs', () => {
      it('Then it does not refuse', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const implicitBareCtx: Context = { ...ctx, layout: { ...ctx.layout, implicitBare: true } };

        // Act
        const result = await assertRepository(implicitBareCtx);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });

    describe('When assertOperationalRepository runs', () => {
      it('Then it refuses', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const implicitBareCtx: Context = { ...ctx, layout: { ...ctx.layout, implicitBare: true } };

        // Act
        const caught = await catchError(() => assertOperationalRepository(implicitBareCtx));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data.code).toBe('IMPLICIT_BARE_REPOSITORY');
      });
    });
  });

  describe('Given a layout carrying both untrusted and implicitBare', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then it throws IMPLICIT_BARE_REPOSITORY — the measured ordering, and trustedDirectories does not lift it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const both: Context = {
          ...ctx,
          layout: { ...ctx.layout, untrusted: true, implicitBare: true },
        };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(both));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data.code).toBe('IMPLICIT_BARE_REPOSITORY');
      });
    });

    describe('When assertRepository runs', () => {
      it('Then it does not refuse', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const both: Context = {
          ...ctx,
          layout: { ...ctx.layout, untrusted: true, implicitBare: true },
        };

        // Act
        const result = await assertRepository(both);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });

    describe('When assertOperationalRepository runs', () => {
      it('Then it refuses', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const both: Context = {
          ...ctx,
          layout: { ...ctx.layout, untrusted: true, implicitBare: true },
        };

        // Act
        const caught = await catchError(() => assertOperationalRepository(both));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data.code).toBe('IMPLICIT_BARE_REPOSITORY');
      });
    });
  });

  describe('Given untrusted with a foreignPath different from path', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then the thrown data.foreignPath names it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const untrusted: Context = {
          ...ctx,
          layout: { ...ctx.layout, untrusted: true, foreignPath: '/etc' },
        };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({
          code: 'DUBIOUS_OWNERSHIP',
          path: ctx.layout.workDir,
          foreignPath: '/etc',
        });
      });
    });
  });

  describe('Given untrusted with a foreignPath equal to path', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then the thrown data has no foreignPath key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const workDir = ctx.layout.workDir;
        if (workDir === undefined)
          throw new Error('expected the default layout to carry a workDir');
        const untrusted: Context = {
          ...ctx,
          layout: { ...ctx.layout, untrusted: true, foreignPath: workDir },
        };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({ code: 'DUBIOUS_OWNERSHIP', path: ctx.layout.workDir });
      });
    });
  });

  describe('Given untrusted with no foreignPath', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then the thrown data has no foreignPath key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const untrusted: Context = { ...ctx, layout: { ...ctx.layout, untrusted: true } };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({ code: 'DUBIOUS_OWNERSHIP', path: ctx.layout.workDir });
      });
    });
  });

  describe('Given untrusted on a bare layout with no workDir', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then path is the gitdir, not the work tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const { workDir: _workDir, ...bareLayout } = ctx.layout;
        const untrusted: Context = {
          ...ctx,
          layout: { ...bareLayout, bare: true, untrusted: true },
        };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({ code: 'DUBIOUS_OWNERSHIP', path: ctx.layout.gitDir });
      });
    });
  });

  describe('Given a garbage HEAD and untrusted', () => {
    describe('When assertAcceptedRepository runs', () => {
      it('Then it throws NOT_A_REPOSITORY — discovery failure runs ahead of both refusals', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, 'garbage');
        const untrusted: Context = { ...ctx, layout: { ...ctx.layout, untrusted: true } };

        // Act
        const caught = await catchError(() => assertAcceptedRepository(untrusted));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });
});

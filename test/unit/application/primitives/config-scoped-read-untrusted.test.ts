import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import {
  __resetSectionsCacheForTests,
  getConfigValue,
  readConfigSections,
} from '../../../../src/application/primitives/config-scoped-read.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

/** A context carrying an ownership-trust-gate refusal — the repository config scope is dropped. */
const untrustedCtx = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, untrusted: true },
});

/** A context carrying an implicit-bare trust-gate refusal — the repository config scope is dropped. */
const implicitBareCtx = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, implicitBare: true },
});

const catchError = async (thunk: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await thunk();
  } catch (err) {
    return err as TsgitError;
  }
  throw new Error('expected thunk to throw');
};

describe('primitives/config-scoped-read — the repository scope on a refused layout', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given a layout carrying untrusted, with a planted local key', () => {
    describe('When getConfigValue reads the merged view', () => {
      it('Then the key is reported absent', async () => {
        // Arrange
        const ctx = untrustedCtx(createMemoryContext());
        await seed(ctx, '[user]\n\tname = ada\n');

        // Act
        const result = await getConfigValue({ ctx, key: 'user.name' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: undefined });
      });
    });

    describe('When readConfigSections reads the merged view', () => {
      it('Then no local-scoped section is present', async () => {
        // Arrange
        const ctx = untrustedCtx(createMemoryContext());
        await seed(ctx, '[user]\n\tname = ada\n');

        // Act
        const result = await readConfigSections({ ctx });

        // Assert
        expect(result.map(({ scope }) => scope)).not.toContain('local');
      });
    });

    describe('When readConfigSections is asked for the explicit worktree scope', () => {
      it('Then it throws CONFIG_SCOPE_NOT_AVAILABLE naming the scope and the shared reason', async () => {
        // Arrange
        const ctx = untrustedCtx(createMemoryContext());
        await seed(ctx, '[user]\n\tname = ada\n');

        // Act
        const caught = await catchError(() => readConfigSections({ ctx, scope: 'worktree' }));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'worktree',
          reason: 'repository-not-accepted',
        });
      });
    });

    describe('When readConfigSections is asked for the explicit global scope', () => {
      it('Then the guard does not overreach — it resolves without the trust-gate reason', async () => {
        // Arrange
        const ctx = untrustedCtx(createMemoryContext());
        await seed(ctx, '[user]\n\tname = ada\n');
        let caught: TsgitError | undefined;

        // Act
        let result: unknown;
        try {
          result = await readConfigSections({ ctx, scope: 'global' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught).toBeUndefined();
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a layout carrying untrusted', () => {
    describe('When readConfigSections is asked for the explicit local scope', () => {
      it('Then it throws CONFIG_SCOPE_NOT_AVAILABLE naming the scope and the shared reason', async () => {
        // Arrange
        const ctx = untrustedCtx(createMemoryContext());

        // Act
        const caught = await catchError(() => readConfigSections({ ctx, scope: 'local' }));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'local',
          reason: 'repository-not-accepted',
        });
      });
    });
  });

  describe('Given a layout carrying implicitBare', () => {
    describe('When readConfigSections is asked for the explicit local scope', () => {
      it('Then it throws CONFIG_SCOPE_NOT_AVAILABLE naming the scope and the shared reason', async () => {
        // Arrange
        const ctx = implicitBareCtx(createMemoryContext());

        // Act
        const caught = await catchError(() => readConfigSections({ ctx, scope: 'local' }));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'local',
          reason: 'repository-not-accepted',
        });
      });
    });
  });
});

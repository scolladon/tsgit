import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { resolveNotesRef } from '../../../../src/application/primitives/resolve-notes-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { RefName } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const CUSTOM_REF = 'refs/notes/custom' as RefName;
const DEFAULT_REF = 'refs/notes/commits' as RefName;

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('Given resolveNotesRef', () => {
  describe('When an explicit ref is provided', () => {
    it('Then returns the explicit ref without consulting env or config', async () => {
      // Arrange
      const env = { get: (_name: string) => 'refs/notes/from-env' };
      const ctx = createMemoryContext({ env });
      await seedConfig(ctx, '[core]\n  notesRef = refs/notes/from-config\n');
      const sut = resolveNotesRef;

      // Act
      const result = await sut(ctx, CUSTOM_REF);

      // Assert
      expect(result).toBe(CUSTOM_REF);
    });
  });

  describe('When no explicit ref but GIT_NOTES_REF is set in env', () => {
    it('Then returns the env ref', async () => {
      // Arrange
      const env = {
        get: (name: string) => (name === 'GIT_NOTES_REF' ? 'refs/notes/from-env' : undefined),
      };
      const ctx = createMemoryContext({ env });
      const sut = resolveNotesRef;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toBe('refs/notes/from-env');
    });
  });

  describe('When no explicit ref, no env, but core.notesRef is configured', () => {
    it('Then returns the config ref', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, '[core]\n  notesRef = refs/notes/from-config\n');
      const sut = resolveNotesRef;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toBe('refs/notes/from-config');
    });
  });

  describe('When no explicit ref, no env, no config', () => {
    it('Then returns the default refs/notes/commits', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = resolveNotesRef;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toBe(DEFAULT_REF);
    });
  });

  describe('When the resolved ref is invalid', () => {
    it('Then throws TsgitError with INVALID_REF code', async () => {
      // Arrange
      const env = { get: (name: string) => (name === 'GIT_NOTES_REF' ? '//invalid//' : undefined) };
      const ctx = createMemoryContext({ env });
      const sut = resolveNotesRef;

      // Act + Assert
      try {
        await sut(ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('INVALID_REF');
      }
    });
  });

  describe('When env is absent (browser context)', () => {
    it('Then falls back to config notesRef', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, '[core]\n  notesRef = refs/notes/browser-config\n');
      const sut = resolveNotesRef;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toBe('refs/notes/browser-config');
    });
  });
});

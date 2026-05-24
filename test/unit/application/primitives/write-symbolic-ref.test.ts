import { describe, expect, it } from 'vitest';

import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('writeSymbolicRef', () => {
  describe('Given name=HEAD and target=refs/heads/main', () => {
    describe('When writeSymbolicRef', () => {
      it('Then .git/HEAD contains the documented bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const name = 'HEAD' as RefName;
        const target = 'refs/heads/main' as RefName;

        // Act
        await writeSymbolicRef(ctx, name, target);

        // Assert
        const content = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(content).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given an existing direct-oid HEAD', () => {
    describe('When writeSymbolicRef', () => {
      it('Then HEAD is overwritten as a symbolic ref', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/HEAD`,
          '0123456789abcdef0123456789abcdef01234567\n',
        );

        // Act
        await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/main' as RefName);

        // Assert
        const content = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(content).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given name with leading slash', () => {
    describe('When writeSymbolicRef', () => {
      it('Then throws INVALID_REF', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act & Assert
        try {
          await writeSymbolicRef(ctx, '/HEAD' as RefName, 'refs/heads/main' as RefName);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });

  describe('Given target with whitespace', () => {
    describe('When writeSymbolicRef', () => {
      it('Then throws INVALID_REF', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act & Assert
        try {
          await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/has space' as RefName);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });
});

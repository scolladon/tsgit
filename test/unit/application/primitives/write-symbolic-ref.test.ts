import { describe, expect, it } from 'vitest';

import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

/** The refusal git's refname_is_safe gate raises — its text without the name. */
const BAD_NAME_REFUSAL = { code: 'INVALID_REF', reason: 'refusing to update ref with bad name' };

/** Runs `act` and returns what it threw (undefined when it resolved). */
async function refusalOf(act: () => Promise<void>): Promise<unknown> {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('writeSymbolicRef', () => {
  describe('Given name=HEAD and target=refs/heads/main', () => {
    describe('When writeSymbolicRef', () => {
      it('Then .git/HEAD contains the documented bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const name = 'HEAD' as RefName;
        const target = 'refs/heads/main' as RefName;
        const sut = writeSymbolicRef;

        // Act
        await sut(ctx, name, target);

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
        const sut = writeSymbolicRef;

        // Act
        await sut(ctx, 'HEAD' as RefName, 'refs/heads/main' as RefName);

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
        const sut = writeSymbolicRef;

        // Act + Assert
        try {
          await sut(ctx, '/HEAD' as RefName, 'refs/heads/main' as RefName);
          throw new Error('expected throw');
        } catch (err) {
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
        const sut = writeSymbolicRef;

        // Act + Assert
        try {
          await sut(ctx, 'HEAD' as RefName, 'refs/heads/has space' as RefName);
          throw new Error('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });

  describe('Given the name main-worktree/HEAD', () => {
    describe('When writeSymbolicRef points it at refs/heads/side', () => {
      it('Then it refuses INVALID_REF and writes nothing under main-worktree/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = writeSymbolicRef;

        // Act
        const refusal = await refusalOf(() =>
          sut(ctx, 'main-worktree/HEAD' as RefName, 'refs/heads/side' as RefName),
        );

        // Assert
        expect((refusal as TsgitError).data).toEqual(BAD_NAME_REFUSAL);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/main-worktree`)).toBe(false);
      });
    });
  });

  describe('Given the name worktrees/wt/HEAD naming refs/heads/side', () => {
    describe('When writeSymbolicRef points it at refs/heads/main', () => {
      it('Then it refuses INVALID_REF and the admin HEAD keeps refs/heads/side', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const adminHead = `${ctx.layout.gitDir}/worktrees/wt/HEAD`;
        await ctx.fs.writeUtf8(adminHead, 'ref: refs/heads/side\n');
        const sut = writeSymbolicRef;

        // Act
        const refusal = await refusalOf(() =>
          sut(ctx, 'worktrees/wt/HEAD' as RefName, 'refs/heads/main' as RefName),
        );

        // Assert
        expect((refusal as TsgitError).data).toEqual(BAD_NAME_REFUSAL);
        expect(await ctx.fs.readUtf8(adminHead)).toBe('ref: refs/heads/side\n');
      });
    });
  });

  describe("Given the name refs/.x, which git's refname_is_safe accepts", () => {
    describe('When writeSymbolicRef points it at refs/heads/main', () => {
      it('Then the loose file holds the symbolic ref', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = writeSymbolicRef;

        // Act
        await sut(ctx, 'refs/.x' as RefName, 'refs/heads/main' as RefName);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/.x`)).toBe(
          'ref: refs/heads/main\n',
        );
      });
    });
  });

  describe('Given the name refs/a/', () => {
    describe('When writeSymbolicRef points it at refs/heads/main', () => {
      it('Then it refuses with the bad-name reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = writeSymbolicRef;

        // Act
        const refusal = await refusalOf(() =>
          sut(ctx, 'refs/a/' as RefName, 'refs/heads/main' as RefName),
        );

        // Assert
        expect((refusal as TsgitError).data).toEqual(BAD_NAME_REFUSAL);
      });
    });
  });
});

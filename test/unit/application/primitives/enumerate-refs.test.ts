import { describe, expect, it } from 'vitest';
import { enumerateRefs } from '../../../../src/application/primitives/enumerate-refs.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const OID_C = 'c'.repeat(40) as ObjectId;

/** The linked worktree's own (admin) gitdir under the common dir's `worktrees/`. */
const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

/** Reframe a seeded main-repo Context as a linked-worktree child Context. */
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

describe('enumerateRefs', () => {
  describe('Given a repo with only HEAD', () => {
    describe('When enumerateRefs', () => {
      it('Then returns just HEAD', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result).toEqual(['HEAD']);
      });
    });
  });

  describe('Given no HEAD file', () => {
    describe('When enumerateRefs', () => {
      it('Then HEAD is not included', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given loose refs under refs/**', () => {
    describe('When enumerateRefs', () => {
      it('Then every loose ref is returned', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: OID_A },
            { name: 'refs/remotes/origin/main' as RefName, id: OID_B },
          ],
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect([...result].sort()).toEqual(
          ['HEAD', 'refs/heads/main', 'refs/remotes/origin/main'].sort(),
        );
      });
    });
  });

  describe('Given packed-refs entries', () => {
    describe('When enumerateRefs', () => {
      it('Then packed refs are included', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/v1.0.0' as RefName, id: OID_C }],
        });

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result).toContain('refs/tags/v1.0.0');
      });
    });
  });

  describe('Given a ref present both loose and packed', () => {
    describe('When enumerateRefs', () => {
      it('Then it appears exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_A }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: OID_B }],
        });

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result.filter((r) => r === 'refs/heads/main')).toHaveLength(1);
      });
    });
  });

  describe('Given a worktree child Context with a shared ref in the common dir and a per-worktree ref in the admin dir', () => {
    describe('When enumerateRefs', () => {
      it('Then both are returned, each exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_A }],
        });
        const sut = asWorktreeChild(ctx);
        await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/bisect/bad`, `${OID_B}\n`);

        // Act
        const result = await enumerateRefs(sut);

        // Assert
        expect([...result].sort()).toEqual(['refs/bisect/bad', 'refs/heads/main'].sort());
      });
    });
  });

  describe('Given a plain Context whose gitDir equals its commonDir', () => {
    describe('When enumerateRefs', () => {
      it('Then a ref present in both walk roots is still returned exactly once', async () => {
        // Arrange — gitDir === commonDir (no `commonDir` override), so the
        // two-root walk collapses onto the same directory: the dedup proof.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_A }],
        });

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result.filter((r) => r === 'refs/heads/main')).toHaveLength(1);
      });
    });
  });
});

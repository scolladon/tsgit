import { describe, expect, it } from 'vitest';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { appendReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const IDENTITY: AuthorIdentity = {
  name: 'A',
  email: 'a@b.c',
  timestamp: 1,
  timezoneOffset: '+0000',
};

const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

// Reframe a seeded main-repo Context as a linked-worktree child Context.
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

describe('common-dir ref + reflog split', () => {
  describe('Given a shared loose ref under the common dir', () => {
    describe('When the child Context resolves it', () => {
      it('Then the ref resolves from the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_A }],
        });
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await getRefStore(sut).resolveDirect('refs/heads/main' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: OID_A });
      });
    });
  });

  describe('Given a shared packed ref under the common dir', () => {
    describe('When the child Context resolves it', () => {
      it('Then the packed ref resolves from the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: OID_B }],
        });
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await getRefStore(sut).resolveDirect('refs/tags/v1' as RefName);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: OID_B });
      });
    });
  });

  describe('Given a worktree child Context', () => {
    describe('When it writes a shared ref', () => {
      it('Then the ref file lands under the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        await getRefStore(sut).writeLoose('refs/heads/feature' as RefName, OID_A);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(true);
        expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/heads/feature`)).toBe(false);
      });
    });

    describe('When it writes a per-worktree ref', () => {
      it('Then the ref file lands under the worktree gitdir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        await getRefStore(sut).writeLoose('ORIG_HEAD' as RefName, OID_A);

        // Assert
        expect(await ctx.fs.exists(`${adminDir(ctx)}/ORIG_HEAD`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });

    describe('When it appends a per-worktree HEAD reflog', () => {
      it('Then logs/HEAD lands under the worktree gitdir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        await appendReflog(sut, 'HEAD' as RefName, {
          oldId: ZERO_OID,
          newId: OID_A,
          identity: IDENTITY,
          message: 'commit: x',
        });

        // Assert
        expect(await ctx.fs.exists(`${adminDir(ctx)}/logs/HEAD`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
      });
    });

    describe('When it appends a shared-ref reflog', () => {
      it('Then logs/refs/heads/<name> lands under the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        await appendReflog(sut, 'refs/heads/main' as RefName, {
          oldId: ZERO_OID,
          newId: OID_A,
          identity: IDENTITY,
          message: 'commit: y',
        });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/heads/main`)).toBe(true);
        expect(await ctx.fs.exists(`${adminDir(ctx)}/logs/refs/heads/main`)).toBe(false);
      });
    });
  });
});

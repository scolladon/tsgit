import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveOidPrefix } from '../../../../src/application/primitives/resolve-oid-prefix.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

// Reframe a seeded main-repo Context as a linked-worktree child: its `gitDir`
// becomes an (empty) admin dir while `commonDir` points at the seeded gitDir, so
// shared objects must resolve through `commonDir`. The in-memory fs is shared.
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: {
    ...ctx.layout,
    gitDir: `${ctx.layout.gitDir}/worktrees/wt`,
    commonDir: ctx.layout.gitDir,
  },
});

const idOf = async (ctx: Context, blob: Blob): Promise<ObjectId> =>
  (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;

describe('common-dir object resolution', () => {
  describe('Given a loose object under the common dir and a worktree child Context', () => {
    describe('When readObject runs on the child', () => {
      it('Then the object resolves from the common dir', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await idOf(ctx, blob);
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await readObject(sut, id);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a packed object under the common dir and a worktree child Context', () => {
    describe('When readObject runs on the child', () => {
      it('Then the packed object resolves from the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'shared', [
          { kind: 'base', type: 'blob', content: new Uint8Array([7, 8, 9]) },
        ]);
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await readObject(sut, id as ObjectId);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a loose object under the common dir and a worktree child Context', () => {
    describe('When resolveOidPrefix runs on the child', () => {
      it('Then the abbreviated id resolves from the common dir', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([4, 2]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await idOf(ctx, blob);
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await resolveOidPrefix(sut, id.slice(0, 8));

        // Assert
        expect(result).toBe(id);
      });
    });
  });
});

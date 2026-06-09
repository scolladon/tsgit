import { describe, expect, it } from 'vitest';
import { worktreeList } from '../../../../src/application/commands/worktree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const OID_MAIN = 'a'.repeat(40) as ObjectId;

const seedRepo = async (ctx: Context): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
};

describe('worktreeList', () => {
  describe('Given a repository with only the main worktree', () => {
    describe('When worktreeList runs', () => {
      it('Then it returns the structured entries', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedRepo(ctx);

        // Act
        const result = await worktreeList(ctx);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({ branch: 'refs/heads/main', main: true });
      });
    });
  });

  describe('Given a path that is not a repository', () => {
    describe('When worktreeList runs', () => {
      it('Then it throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act & Assert
        try {
          await worktreeList(ctx);
          expect.unreachable();
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
        }
      });
    });
  });
});

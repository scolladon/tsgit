import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { checkoutMetadataFor } from '../../../../../src/application/commands/internal/checkout-metadata.js';
import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';

const COMMIT = '1111111111111111111111111111111111111111' as ObjectId;

const repoWithMain = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${COMMIT}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('checkoutMetadataFor', () => {
  describe.each([
    { label: 'a branch name', rev: 'main', expected: { ref: 'refs/heads/main', treeish: COMMIT } },
    { label: 'HEAD', rev: 'HEAD', expected: { ref: 'refs/heads/main', treeish: COMMIT } },
    { label: 'an object id', rev: COMMIT, expected: { treeish: COMMIT } },
  ])('Given $label', ({ rev, expected }) => {
    describe('When the checkout metadata is derived', () => {
      it('Then it names the commit and the ref git resolves the revision to', async () => {
        // Arrange
        const ctx = await repoWithMain();
        const sut = checkoutMetadataFor;

        // Act
        const result = await sut(ctx, rev, COMMIT);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

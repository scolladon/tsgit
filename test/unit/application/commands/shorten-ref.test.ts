import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { shortenUnambiguousRef } from '../../../../src/application/commands/internal/shorten-ref.js';
import { seedRepo } from './fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const repoWithRefs = async (names: ReadonlyArray<string>) => {
  const ctx = createMemoryContext();
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] });
  const id = commitIds[0] as string;
  await seedRepo(ctx, {
    refs: { 'refs/heads/main': id, ...Object.fromEntries(names.map((name) => [name, id])) },
  });
  return ctx;
};

// Expected values are `git rev-parse --abbrev-ref <ref>` on git 2.55 over the same refs.
describe('shortenUnambiguousRef', () => {
  describe.each([
    ['refs/remotes/origin/HEAD', 'origin'],
    ['refs/remotes/origin/main', 'origin/main'],
    ['refs/remotes/HEAD', 'remotes/HEAD'],
  ] as const)('Given the ref %s', (ref, expected) => {
    describe('When it is shortened', () => {
      it('Then it is spelt as git spells it', async () => {
        // Arrange
        const ctx = await repoWithRefs([ref]);
        const sut = shortenUnambiguousRef;

        // Act
        const result = await sut(ctx, ref);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { readLocalPushRefs } from '../../../../../src/application/commands/internal/local-push-refs.js';
import { seedRepo } from '../fixtures.js';

const OID = '1'.repeat(40);

describe('readLocalPushRefs', () => {
  describe('Given branches, a tag, a chain of symrefs and a symref loop', () => {
    describe('When the local push refs are read', () => {
      it('Then every ref is listed and each symref maps onto where five hops at most lead it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {
          head: 'refs/heads/main',
          refs: {
            'refs/heads/main': OID,
            'refs/tags/lt': OID,
            'refs/remotes/origin/HEAD': 'ref: refs/remotes/origin/alias',
            'refs/remotes/origin/alias': 'ref: refs/remotes/origin/main',
            'refs/remotes/origin/main': OID,
            'refs/x/a': 'ref: refs/x/b',
            'refs/x/b': 'ref: refs/x/a',
          },
        });
        const sut = readLocalPushRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.names).toEqual([
          'refs/heads/main',
          'refs/remotes/origin/HEAD',
          'refs/remotes/origin/alias',
          'refs/remotes/origin/main',
          'refs/tags/lt',
          'refs/x/a',
          'refs/x/b',
        ]);
        expect(Object.fromEntries(result.symrefs)).toEqual({
          HEAD: 'refs/heads/main',
          'refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
          'refs/remotes/origin/alias': 'refs/remotes/origin/main',
          'refs/x/a': 'refs/x/b',
          'refs/x/b': 'refs/x/a',
        });
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When the local push refs are read', () => {
      it('Then HEAD maps onto no ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { head: OID, refs: { 'refs/heads/main': OID } });
        const sut = readLocalPushRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.symrefs.has('HEAD')).toBe(false);
      });
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { expandRef } from '../../../../../src/application/commands/internal/refname-ambiguity.js';
import * as configRead from '../../../../../src/application/primitives/config-read.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';

vi.mock('../../../../../src/application/primitives/config-read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof configRead>()),
  findLastEntries: vi.fn(async () => [undefined, undefined]),
}));

const ID = 'a'.repeat(40) as ObjectId;

describe('expandRef', () => {
  describe('Given a name every namespace resolves, with the ambiguity check on', () => {
    describe('When it is expanded', () => {
      it('Then every namespace is listed and the setting is read once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const resolve = async (candidate: RefName | 'HEAD') =>
          ({ kind: 'found', id: ID, ref: candidate as RefName }) as const;
        const settingsReads = vi.mocked(configRead.findLastEntries);
        settingsReads.mockClear();
        const sut = expandRef;

        // Act
        const result = await sut(ctx, 'main', resolve);

        // Assert
        expect(result.map((found) => found.ref)).toEqual([
          'main',
          'refs/main',
          'refs/tags/main',
          'refs/heads/main',
          'refs/remotes/main',
          'refs/remotes/main/HEAD',
        ]);
        expect(settingsReads).toHaveBeenCalledTimes(1);
      });
    });
  });
});

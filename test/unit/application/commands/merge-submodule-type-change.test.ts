import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { seedIndex } from './add-index-fixtures.js';
import { recordGitlink } from './submodule-fixtures.js';

const AUTHOR = { name: 'Ada', email: 'a@x', timestamp: 100, timezoneOffset: '+0000' };

describe('merge — a submodule against a file', () => {
  describe('Given a submodule moved on our side and replaced by a file on theirs', () => {
    describe('When merge runs', () => {
      it('Then the submodule is left as the empty directory git leaves and the merge stops in conflict', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await recordGitlink(ctx, 'sub', '1'.repeat(40) as ObjectId);
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await seedIndex(ctx, [
          { path: 'k', text: 'k\n' },
          { path: 'sub', text: 'file\n' },
        ]);
        await commit(ctx, { message: 'file', author: AUTHOR });
        await checkout(ctx, { rev: 'main' });
        await recordGitlink(ctx, 'sub', '2'.repeat(40) as ObjectId);

        // Act
        const sut = mergeRun;
        const result = await sut(ctx, { rev: 'theirs', author: AUTHOR });

        // Assert
        expect(result.kind).toBe('conflict');
        expect((await ctx.fs.lstat(`${ctx.layout.workDir}/sub`)).isDirectory).toBe(true);
        expect(await ctx.fs.readdir(`${ctx.layout.workDir}/sub`)).toEqual([]);
      });
    });
  });
});

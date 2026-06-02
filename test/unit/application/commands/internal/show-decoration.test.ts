import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { buildDecorationMap } from '../../../../../src/application/commands/internal/show-decoration.js';
import { revParse } from '../../../../../src/application/commands/rev-parse.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import { decorationLabels } from '../../../../../src/domain/show/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seed = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'x\n');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'c1', author });
  const head = await revParse(ctx, 'HEAD');
  return { ctx, head };
};

const labelsFor = (
  map: Awaited<ReturnType<typeof buildDecorationMap>>,
  oid: ObjectId,
): ReadonlyArray<string> => {
  const entry = map.get(oid);
  return entry === undefined ? [] : decorationLabels(entry);
};

describe('Given the decoration map builder', () => {
  describe('When HEAD is on a branch with a tag and a second branch at the tip', () => {
    it('Then the labels lead with HEAD -> branch, descending by full refname', async () => {
      // Arrange
      const { ctx, head } = await seed();
      await updateRef(ctx, 'refs/tags/v1.0' as RefName, head, { reflogMessage: 'tag' });
      await updateRef(ctx, 'refs/heads/feature' as RefName, head, { reflogMessage: 'branch' });

      // Act
      const map = await buildDecorationMap(ctx);

      // Assert
      expect(labelsFor(map, head)).toEqual(['HEAD -> main', 'tag: v1.0', 'feature']);
    });
  });

  describe('When HEAD is detached at the commit', () => {
    it('Then a bare HEAD leads the labels', async () => {
      // Arrange — detach HEAD by writing the oid directly.
      const { ctx, head } = await seed();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${head}\n`);

      // Act
      const map = await buildDecorationMap(ctx);

      // Assert — only refs/heads/main remains a plain branch behind HEAD.
      expect(labelsFor(map, head)).toEqual(['HEAD', 'main']);
    });
  });

  describe('When a ref dangles (points at a missing object)', () => {
    it('Then it is skipped rather than failing the scan', async () => {
      // Arrange
      const { ctx, head } = await seed();
      const missing = '0123456789012345678901234567890123456789' as ObjectId;
      await updateRef(ctx, 'refs/heads/dangling' as RefName, missing, { reflogMessage: 'dangle' });

      // Act
      const map = await buildDecorationMap(ctx);

      // Assert — the dangling branch is absent; HEAD's main is intact.
      expect(labelsFor(map, head)).toEqual(['HEAD -> main']);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { checkout } from '../../../../../src/application/commands/checkout.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { forkPoint } from '../../../../../src/application/commands/internal/fork-point.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { appendReflog } from '../../../../../src/application/primitives/reflog-store.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'A',
  email: 'a@x',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const TRACKING = 'refs/remotes/origin/main' as RefName;

const commitFile = async (ctx: Context, path: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, path);
  await add(ctx, [path]);
  return (await commit(ctx, { message: path, author })).id;
};

/** a → b → c on main; d on a side branch from a. */
const history = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  const a = await commitFile(ctx, 'a');
  const b = await commitFile(ctx, 'b');
  const c = await commitFile(ctx, 'c');
  await checkout(ctx, { rev: a, detach: true });
  const d = await commitFile(ctx, 'd');
  return { ctx, a, b, c, d };
};

describe('forkPoint', () => {
  describe('Given a ref name git cannot hold, When the fork point is sought', () => {
    it('Then there is none', async () => {
      // Arrange
      const { ctx, c } = await history();

      // Act
      const result = await forkPoint(ctx, 'refs/remotes/origin/s*' as RefName, c);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a missing ref, When the fork point is sought', () => {
    it('Then there is none', async () => {
      // Arrange
      const { ctx, c } = await history();

      // Act
      const result = await forkPoint(ctx, TRACKING, c);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a ref with no reflog at an ancestor, When the fork point is sought', () => {
    it('Then it is the ref tip', async () => {
      // Arrange
      const { ctx, b, c } = await history();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${TRACKING}`, `${b}\n`);

      // Act
      const result = await forkPoint(ctx, TRACKING, c);

      // Assert
      expect(result).toBe(b);
    });
  });

  describe('Given a ref rewritten away from the commit it once held, When the fork point is sought', () => {
    it('Then it is the reflog value the commit builds on', async () => {
      // Arrange
      const { ctx, a, b, c, d } = await history();
      await updateRef(ctx, TRACKING, a, { reflogMessage: 'fetch' });
      await updateRef(ctx, TRACKING, b, { reflogMessage: 'fetch' });
      await updateRef(ctx, TRACKING, d, { reflogMessage: 'fetch: forced-update' });

      // Act
      const result = await forkPoint(ctx, TRACKING, c);

      // Assert
      expect(result).toBe(b);
    });
  });

  describe('Given a reflog naming an object that is not there, When the fork point is sought', () => {
    it('Then that value is skipped', async () => {
      // Arrange
      const { ctx, b, c } = await history();
      await updateRef(ctx, TRACKING, b, { reflogMessage: 'fetch' });
      const ghost = 'f'.repeat(40) as ObjectId;
      await appendReflog(ctx, TRACKING, { oldId: b, newId: ghost, identity: author, message: 'x' });

      // Act
      const result = await forkPoint(ctx, TRACKING, c);

      // Assert
      expect(result).toBe(b);
    });
  });

  describe('Given a ref that only ever held a commit off the local history, When the fork point is sought', () => {
    it('Then there is none, the merge base being no reflog value', async () => {
      // Arrange
      const { ctx, c, d } = await history();
      await updateRef(ctx, TRACKING, d, { reflogMessage: 'fetch' });

      // Act
      const result = await forkPoint(ctx, TRACKING, c);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a reflog naming an object that is no commit, When the fork point is sought', () => {
    it('Then that value is skipped', async () => {
      // Arrange
      const { ctx, b, c } = await history();
      await updateRef(ctx, TRACKING, b, { reflogMessage: 'fetch' });
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode('hi'),
      });
      await appendReflog(ctx, TRACKING, {
        oldId: b,
        newId: blob,
        identity: author,
        message: 'x',
      });

      // Act
      const result = await forkPoint(ctx, TRACKING, c);

      // Assert
      expect(result).toBe(b);
    });
  });

  describe('Given two reflog values that are both merge bases of the commit, When the fork point is sought', () => {
    it('Then there is none, a fork point being the one and only merge base', async () => {
      // Arrange
      const { ctx, b, d } = await history();
      await updateRef(ctx, TRACKING, b, { reflogMessage: 'fetch' });
      await updateRef(ctx, TRACKING, d, { reflogMessage: 'fetch: forced-update' });
      const parent = await readObject(ctx, b);
      if (parent.type !== 'commit') throw new Error('expected a commit');
      const merge = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: { ...parent.data, parents: [d, b] },
      });

      // Act
      const result = await forkPoint(ctx, TRACKING, merge);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

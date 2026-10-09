import { describe, expect, it, type Mock, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchDelete } from '../../../../src/application/commands/branch.js';
import { init } from '../../../../src/application/commands/init.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { getRefStore, refExists } from '../../../../src/application/primitives/ref-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MAIN = 'refs/heads/main' as RefName;
const TOPIC = 'refs/heads/topic' as RefName;
const UPSTREAM = 'refs/heads/up' as RefName;

const MERGED_TO_UPSTREAM =
  "deleting branch 'topic' that has been merged to\n         'refs/heads/up', but not yet merged to HEAD";

interface Seeded {
  readonly ctx: Context;
  readonly logs: string[];
  /** The logger's `warn`, spied on for the metadata each warning carries. */
  readonly warn: Mock<(message: string, data?: unknown) => void>;
  readonly tree: ObjectId;
  readonly root: ObjectId;
  /** The commit HEAD stands on. */
  readonly head: ObjectId;
  /** A sibling of `head` over the same root. */
  readonly side: ObjectId;
}

const writeCommitOn = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
) =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author, committer: author, message, extraHeaders: [] },
  });

const seed = async (): Promise<Seeded> => {
  const logs: string[] = [];
  const warn = vi.fn((message: string, _data?: unknown) => {
    logs.push(`warning: ${message}`);
  });
  const base = createMemoryContext();
  const ctx = {
    ...base,
    logger: {
      warn,
      error: (message: string) => logs.push(`error: ${message}`),
    },
  } as Context;
  await init(ctx);
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const root = await writeCommitOn(ctx, tree, [], 'root');
  const head = await writeCommitOn(ctx, tree, [root], 'head');
  const side = await writeCommitOn(ctx, tree, [root], 'side');
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'setSymbolic', name: 'HEAD' as RefName, target: MAIN },
    { kind: 'set', name: MAIN, id: head },
  ]);
  return { ctx, logs, warn, tree, root, head, side };
};

const plantRef = (ctx: Context, name: RefName, id: ObjectId): Promise<unknown> =>
  getRefStore(ctx).applyRefUpdates([{ kind: 'set', name, id }]);

const configureUpstream = async (ctx: Context, merge: string): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const current = await ctx.fs.readUtf8(path);
  await ctx.fs.writeUtf8(path, `${current}[branch "topic"]\n\tremote = .\n\tmerge = ${merge}\n`);
  invalidateConfigCache(ctx);
};

const refusalCode = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data.code;
  }
  return undefined;
};

describe('Given a branch its upstream contains but HEAD does not', () => {
  describe('When branch delete runs unforced', () => {
    it('Then it warns that HEAD has not merged it and removes the ref', async () => {
      // Arrange
      const { ctx, logs, warn, side } = await seed();
      await plantRef(ctx, TOPIC, side);
      await plantRef(ctx, UPSTREAM, side);
      await configureUpstream(ctx, UPSTREAM);
      const sut = branchDelete;

      // Act
      const result = await sut(ctx, { name: 'topic' });

      // Assert
      expect(result).toEqual({ name: TOPIC });
      expect(logs).toEqual([`warning: ${MERGED_TO_UPSTREAM}`]);
      expect(warn).toHaveBeenCalledWith(MERGED_TO_UPSTREAM, {
        branch: 'topic',
        upstream: UPSTREAM,
        merged: true,
      });
    });
  });
});

describe('Given a branch HEAD contains but its upstream does not', () => {
  describe('When branch delete runs unforced', () => {
    it('Then it warns that HEAD alone has merged it and refuses', async () => {
      // Arrange
      const { ctx, logs, warn, head, side } = await seed();
      await plantRef(ctx, TOPIC, head);
      await plantRef(ctx, UPSTREAM, side);
      await configureUpstream(ctx, UPSTREAM);
      const sut = branchDelete;

      // Act
      const result = await refusalCode(() => sut(ctx, { name: 'topic' }));

      // Assert
      expect(result).toBe('BRANCH_NOT_FULLY_MERGED');
      expect(logs).toEqual([
        "warning: not deleting branch 'topic' that is not yet merged to\n         'refs/heads/up', even though it is merged to HEAD",
      ]);
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        branch: 'topic',
        upstream: UPSTREAM,
        merged: false,
      });
    });
  });
});

describe('Given an upstream named through a symbolic ref', () => {
  describe('When branch delete runs unforced on a branch only the upstream contains', () => {
    it('Then the warning names the ref the symbolic chain ends at', async () => {
      // Arrange
      const { ctx, logs, side } = await seed();
      await plantRef(ctx, TOPIC, side);
      await plantRef(ctx, UPSTREAM, side);
      await getRefStore(ctx).applyRefUpdates([
        { kind: 'setSymbolic', name: 'refs/heads/sym' as RefName, target: UPSTREAM },
      ]);
      await configureUpstream(ctx, 'refs/heads/sym');
      const sut = branchDelete;

      // Act
      await sut(ctx, { name: 'topic' });

      // Assert
      expect(logs).toEqual([`warning: ${MERGED_TO_UPSTREAM}`]);
    });
  });
});

describe('Given an upstream standing on the commit HEAD stands on', () => {
  describe('When branch delete runs unforced', () => {
    it('Then it removes the ref without a warning', async () => {
      // Arrange
      const { ctx, logs, head } = await seed();
      await plantRef(ctx, TOPIC, head);
      await plantRef(ctx, UPSTREAM, head);
      await configureUpstream(ctx, UPSTREAM);
      const sut = branchDelete;

      // Act
      await sut(ctx, { name: 'topic' });

      // Assert
      expect(await refExists(ctx, TOPIC)).toBe(false);
      expect(logs).toEqual([]);
    });
  });
});

describe('Given an upstream standing on a tree', () => {
  describe('When branch delete runs unforced on a branch HEAD contains', () => {
    it('Then it reports the tree, measures against HEAD and removes the ref', async () => {
      // Arrange
      const { ctx, logs, root, tree } = await seed();
      await plantRef(ctx, TOPIC, root);
      await plantRef(ctx, UPSTREAM, tree);
      await configureUpstream(ctx, UPSTREAM);
      const sut = branchDelete;

      // Act
      await sut(ctx, { name: 'topic' });

      // Assert
      expect(await refExists(ctx, TOPIC)).toBe(false);
      expect(logs).toEqual([`error: object ${tree} is a tree, not a commit`]);
    });
  });
});

describe('Given an unborn HEAD and an upstream that contains the branch', () => {
  describe('When branch delete runs unforced', () => {
    it('Then it warns that HEAD has not merged it and removes the ref', async () => {
      // Arrange
      const { ctx, logs, side } = await seed();
      await getRefStore(ctx).applyRefUpdates([
        { kind: 'setSymbolic', name: 'HEAD' as RefName, target: 'refs/heads/unborn' as RefName },
      ]);
      await plantRef(ctx, TOPIC, side);
      await plantRef(ctx, UPSTREAM, side);
      await configureUpstream(ctx, UPSTREAM);
      const sut = branchDelete;

      // Act
      await sut(ctx, { name: 'topic' });

      // Assert
      expect(await refExists(ctx, TOPIC)).toBe(false);
      expect(logs).toEqual([`warning: ${MERGED_TO_UPSTREAM}`]);
    });
  });
});

describe('Given a branch merging two refs, the first containing it and the second not', () => {
  describe('When branch delete runs unforced', () => {
    it('Then it judges the first, the upstream, and removes the ref with its warning', async () => {
      // Arrange
      const { ctx, logs, root, side } = await seed();
      await plantRef(ctx, TOPIC, side);
      await plantRef(ctx, UPSTREAM, side);
      await plantRef(ctx, 'refs/heads/other' as RefName, root);
      await configureUpstream(ctx, `${UPSTREAM}\n\tmerge = refs/heads/other`);
      const sut = branchDelete;

      // Act
      const result = await sut(ctx, { name: 'topic' });

      // Assert
      expect(result).toEqual({ name: TOPIC });
      expect(logs).toEqual([`warning: ${MERGED_TO_UPSTREAM}`]);
    });
  });
});

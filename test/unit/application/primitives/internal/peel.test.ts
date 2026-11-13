import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import * as objectTypeTable from '../../../../../src/application/primitives/internal/object-type-table.js';
import { createObjectTypeTable } from '../../../../../src/application/primitives/internal/object-type-table.js';
import { peel, peelToTreeOrBlob } from '../../../../../src/application/primitives/internal/peel.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  writeForgedTagLoop,
  writeRawObjectBytes,
  writeSelfHashedLooseWithDeclaredSize,
} from '../fixtures.js';

interface Logging {
  readonly ctx: Context;
  readonly logged: string[];
  readonly contexts: unknown[];
}

const logging = async (): Promise<Logging> => {
  const logged: string[] = [];
  const contexts: unknown[] = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: {
      error: (message: string, context?: Readonly<Record<string, unknown>>) => {
        logged.push(message);
        contexts.push(context);
      },
    },
  };
  await init(ctx);
  return { ctx, logged, contexts };
};

const caught = async (run: () => Promise<unknown>): Promise<TsgitError['data'] | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('peel', () => {
  describe('Given a blob and a named peel to a commit', () => {
    describe('When it is peeled', () => {
      it('Then it logs the name, the wanted kind and the kind reached, and refuses', async () => {
        // Arrange
        const { ctx, logged, contexts } = await logging();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('a\n'),
        });
        const sut = peel;

        // Act
        const result = await caught(() =>
          sut(ctx, createObjectTypeTable(), blob, 'commit', 'rev^{commit}'),
        );

        // Assert
        expect({ result, logged, contexts }).toEqual({
          result: { code: 'OBJECT_NOT_FOUND', id: blob },
          logged: ['rev^{commit}: expected commit type, but the object dereferences to blob type'],
          contexts: [{ name: 'rev^{commit}', expected: 'commit', type: 'blob' }],
        });
      });
    });
  });

  describe('Given a forged tag naming itself and a named peel to a commit', () => {
    describe('When it is peeled', () => {
      it('Then it refuses without reporting a kind mismatch', async () => {
        // Arrange
        const { ctx, logged } = await logging();
        const loop = await writeForgedTagLoop(ctx);
        const sut = peel;

        // Act
        const result = await caught(() =>
          sut(ctx, createObjectTypeTable(), loop, 'commit', 'loop^{commit}'),
        );

        // Assert
        expect({ result, logged }).toEqual({
          result: { code: 'OBJECT_NOT_FOUND', id: loop },
          logged: [],
        });
      });
    });
  });

  describe('Given a blob terminal that overruns its size claim past the header window', () => {
    const OVERRUN_BODY = Uint8Array.from({ length: 200 }, (_, i) => i);
    const DECLARED_SIZE = 5;

    describe('When peel targets a commit from the blob itself', () => {
      it('Then it refuses OBJECT_NOT_FOUND for the blob id without reading its body', async () => {
        // Arrange
        const { ctx } = await logging();
        const liar = await writeSelfHashedLooseWithDeclaredSize(
          ctx,
          'blob',
          DECLARED_SIZE,
          OVERRUN_BODY,
        );
        const sut = peel;

        // Act
        const result = await caught(() => sut(ctx, createObjectTypeTable(), liar, 'commit'));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: liar });
      });
    });

    describe('When peel targets a commit from an annotated tag over the blob', () => {
      it('Then it refuses OBJECT_NOT_FOUND for the blob the chain ends at', async () => {
        // Arrange
        const { ctx } = await logging();
        const liar = await writeSelfHashedLooseWithDeclaredSize(
          ctx,
          'blob',
          DECLARED_SIZE,
          OVERRUN_BODY,
        );
        const tag = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: { object: liar, objectType: 'blob', tagName: 't', message: 'm', extraHeaders: [] },
        });
        const sut = peel;

        // Act
        const result = await caught(() => sut(ctx, createObjectTypeTable(), tag, 'commit'));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: liar });
      });
    });
  });

  describe('Given an honest blob terminal', () => {
    describe('When peel targets a commit', () => {
      it('Then it refuses OBJECT_NOT_FOUND for the blob id', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('honest\n'),
        });
        const sut = peel;

        // Act
        const result = await caught(() => sut(ctx, createObjectTypeTable(), blob, 'commit'));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: blob });
      });
    });
  });

  describe.each([
    { label: 'non-hex', objectId: 'z'.repeat(40) },
    { label: 'truncated', objectId: 'abc' },
  ])('Given a tag whose object line is $label', ({ objectId }) => {
    describe('When it is peeled to a commit', () => {
      it("Then it refuses OBJECT_NOT_FOUND on the tag's id", async () => {
        // Arrange
        const { ctx } = await logging();
        const bytes = new TextEncoder().encode(
          `object ${objectId}\ntype commit\ntag x\ntagger A <a@a> 0 +0000\n\nmsg\n`,
        );
        const tag = await writeRawObjectBytes(ctx, 'tag', bytes);
        const sut = peel;

        // Act
        const result = await caught(() => sut(ctx, createObjectTypeTable(), tag, 'commit'));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: tag });
      });
    });
  });

  describe('Given a hop whose read fails without an error code', () => {
    describe('When it is peeled', () => {
      it('Then the failure propagates unchanged', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('x\n'),
        });
        const tag = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: { object: blob, objectType: 'blob', tagName: 't', message: 'm', extraHeaders: [] },
        });
        const failure = new Error('boom');
        vi.spyOn(objectTypeTable, 'parseTypedPeelHop').mockRejectedValue(failure);
        const sut = peel;
        let result: unknown;

        // Act
        try {
          await sut(ctx, createObjectTypeTable(), tag, 'commit');
        } catch (error) {
          result = error;
        }
        vi.restoreAllMocks();

        // Assert
        expect(result).toBe(failure);
      });
    });
  });

  describe('Given a blob id and peel toward a tree', () => {
    describe('When it is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the blob', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('a\n'),
        });
        const sut = peel;

        // Act
        const result = await caught(() => sut(ctx, undefined, blob, 'tree'));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: blob });
      });
    });
  });
});

describe('peelToTreeOrBlob', () => {
  const MISSING = '1'.repeat(40) as ObjectId;

  const blobOf = (ctx: Context, text: string): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      id: '' as ObjectId,
      content: new TextEncoder().encode(text),
    });

  const tagOf = (
    ctx: Context,
    object: ObjectId,
    objectType: 'blob' | 'commit' | 'tag' | 'tree',
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'tag',
      id: '' as ObjectId,
      data: { object, objectType, tagName: 't', message: 'm', extraHeaders: [] },
    });

  const emptyTree = (ctx: Context): Promise<ObjectId> =>
    writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });

  const commitOfEmptyTree = async (ctx: Context) => {
    const tree = await emptyTree(ctx);
    const who = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
    const commit = await createCommit(ctx, {
      tree,
      parents: [],
      author: who,
      committer: who,
      message: 'm',
    });
    return { commit, tree };
  };

  describe('Given a blob id', () => {
    describe('When it is peeled', () => {
      it('Then it answers the blob kind and id', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await blobOf(ctx, 'a\n');
        const sut = peelToTreeOrBlob;

        // Act
        const result = await sut(ctx, undefined, blob);

        // Assert
        expect(result).toEqual({ kind: 'blob', id: blob });
      });
    });
  });

  describe('Given an annotated tag naming an annotated tag naming a blob', () => {
    describe('When it is peeled', () => {
      it('Then it answers the blob kind and id', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await blobOf(ctx, 'a\n');
        const inner = await tagOf(ctx, blob, 'blob');
        const outer = await tagOf(ctx, inner, 'tag');
        const sut = peelToTreeOrBlob;

        // Act
        const result = await sut(ctx, undefined, outer);

        // Assert
        expect(result).toEqual({ kind: 'blob', id: blob });
      });
    });
  });

  describe('Given a commit', () => {
    describe('When it is peeled', () => {
      it('Then it answers the commit-tree kind and its root tree id', async () => {
        // Arrange
        const { ctx } = await logging();
        const { commit, tree } = await commitOfEmptyTree(ctx);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await sut(ctx, undefined, commit);

        // Assert
        expect(result).toEqual({ kind: 'commit-tree', id: tree });
      });
    });
  });

  describe('Given an annotated tag naming a commit', () => {
    describe('When it is peeled', () => {
      it('Then it answers the commit-tree kind and its root tree id', async () => {
        // Arrange
        const { ctx } = await logging();
        const { commit, tree } = await commitOfEmptyTree(ctx);
        const tag = await tagOf(ctx, commit, 'commit');
        const sut = peelToTreeOrBlob;

        // Act
        const result = await sut(ctx, undefined, tag);

        // Assert
        expect(result).toEqual({ kind: 'commit-tree', id: tree });
      });
    });
  });

  describe('Given an annotated tag naming a tree', () => {
    describe('When it is peeled', () => {
      it('Then it answers the tree kind and the tree id', async () => {
        // Arrange
        const { ctx } = await logging();
        const tree = await emptyTree(ctx);
        const tag = await tagOf(ctx, tree, 'tree');
        const sut = peelToTreeOrBlob;

        // Act
        const result = await sut(ctx, undefined, tag);

        // Assert
        expect(result).toEqual({ kind: 'tree', id: tree });
      });
    });
  });

  describe('Given a tree id', () => {
    describe('When it is peeled', () => {
      it('Then it answers the tree kind and id', async () => {
        // Arrange
        const { ctx } = await logging();
        const tree = await emptyTree(ctx);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await sut(ctx, undefined, tree);

        // Assert
        expect(result).toEqual({ kind: 'tree', id: tree });
      });
    });
  });

  describe('Given a tag whose object line is non-hex', () => {
    describe('When it is peeled', () => {
      it("Then it refuses OBJECT_NOT_FOUND on the tag's id", async () => {
        // Arrange
        const { ctx } = await logging();
        const bytes = new TextEncoder().encode(
          `object ${'z'.repeat(40)}\ntype commit\ntag x\ntagger A <a@a> 0 +0000\n\nmsg\n`,
        );
        const tag = await writeRawObjectBytes(ctx, 'tag', bytes);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, tag));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: tag });
      });
    });
  });

  describe('Given a forged tag naming itself', () => {
    describe('When it is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the start id', async () => {
        // Arrange
        const { ctx } = await logging();
        const loop = await writeForgedTagLoop(ctx);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, loop));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: loop });
      });
    });
  });

  describe('Given a tag naming a missing object', () => {
    describe('When it is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the missing id', async () => {
        // Arrange
        const { ctx } = await logging();
        const tag = await tagOf(ctx, MISSING, 'blob');
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, tag));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: MISSING });
      });
    });
  });

  describe('Given a commit whose tree header names a blob', () => {
    const commitOver = async (ctx: Context, tree: ObjectId): Promise<ObjectId> => {
      const who = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
      return createCommit(ctx, { tree, parents: [], author: who, committer: who, message: 'm' });
    };

    describe('When the commit is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the commit', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await blobOf(ctx, 'a\n');
        const commit = await commitOver(ctx, blob);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, commit));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: commit });
      });
    });

    describe('When an annotated tag naming the commit is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the commit', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await blobOf(ctx, 'a\n');
        const commit = await commitOver(ctx, blob);
        const tag = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commit,
            objectType: 'commit',
            tagName: 't',
            message: 'm',
            extraHeaders: [],
          },
        });
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, tag));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: commit });
      });
    });
  });

  describe('Given a commit whose tree header names a tag of a blob', () => {
    const commitOver = async (ctx: Context, tree: ObjectId): Promise<ObjectId> => {
      const who = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
      return createCommit(ctx, { tree, parents: [], author: who, committer: who, message: 'm' });
    };

    describe('When the commit is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the commit', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await blobOf(ctx, 'a\n');
        const commit = await commitOver(ctx, await tagOf(ctx, blob, 'blob'));
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, commit));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: commit });
      });
    });

    describe('When a commit naming that commit as its tree is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the outer commit', async () => {
        // Arrange
        const { ctx } = await logging();
        const blob = await blobOf(ctx, 'a\n');
        const inner = await commitOver(ctx, await tagOf(ctx, blob, 'blob'));
        const outer = await commitOver(ctx, inner);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, outer));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: outer });
      });
    });

    describe('When a commit whose tree is missing is peeled', () => {
      it('Then it refuses OBJECT_NOT_FOUND on the commit', async () => {
        // Arrange
        const { ctx } = await logging();
        const commit = await commitOver(ctx, MISSING);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, commit));

        // Assert
        expect(result).toEqual({ code: 'OBJECT_NOT_FOUND', id: commit });
      });
    });

    describe('When a commit whose tree header names a tag missing its type line is peeled', () => {
      it('Then the tag parse fault propagates unchanged', async () => {
        // Arrange
        const { ctx } = await logging();
        const bytes = new TextEncoder().encode(`object ${MISSING}\n`);
        const malformed = await writeRawObjectBytes(ctx, 'tag', bytes);
        const commit = await commitOver(ctx, malformed);
        const sut = peelToTreeOrBlob;

        // Act
        const result = await caught(() => sut(ctx, undefined, commit));

        // Assert
        expect(result).toMatchObject({ code: 'INVALID_TAG' });
      });
    });
  });
});

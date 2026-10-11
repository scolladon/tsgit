import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assignObjectType,
  createObjectTypeTable,
  parseTypedObject,
  parseTypedObjectOrAbsent,
  parseTypedPeelHop,
  typeWalkedCommit,
} from '../../../../../src/application/primitives/internal/object-type-table.js';
import * as readObjectModule from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { Commit, ObjectId, Tag } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ID = 'a'.repeat(40) as ObjectId;

const logging = (): { readonly ctx: Context; readonly logged: string[] } => {
  const logged: string[] = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: { error: (message: string) => logged.push(message) },
  };
  return { ctx, logged };
};

describe('assignObjectType', () => {
  describe('Given an id typed a blob in a table', () => {
    describe('When the same table types it a commit', () => {
      it('Then the typing conflicts', () => {
        // Arrange
        const { ctx, logged } = logging();
        const table = createObjectTypeTable();
        const sut = assignObjectType;
        sut(ctx, table, ID, 'blob');

        // Act
        const result = sut(ctx, table, ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({
          result: false,
          logged: [`object ${ID} is a blob, not a commit`],
        });
      });
    });

    describe('When the same table types it a blob again', () => {
      it('Then it agrees without writing the table', () => {
        // Arrange
        const { ctx, logged } = logging();
        const table = createObjectTypeTable();
        const sut = assignObjectType;
        sut(ctx, table, ID, 'blob');
        const writes = vi.spyOn(table, 'set');

        // Act
        const result = sut(ctx, table, ID, 'blob');

        // Assert
        expect({ result, logged, writes: writes.mock.calls.length }).toEqual({
          result: true,
          logged: [],
          writes: 0,
        });
        expect(table.get(ID)).toBe('blob');
      });
    });

    describe('When another table types it a commit', () => {
      it('Then the earlier typing does not carry over', () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = assignObjectType;
        sut(ctx, createObjectTypeTable(), ID, 'blob');

        // Act
        const result = sut(ctx, createObjectTypeTable(), ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({ result: true, logged: [] });
      });
    });
  });

  describe('Given no table', () => {
    describe('When an id is typed twice differently', () => {
      it('Then nothing conflicts', () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = assignObjectType;
        sut(ctx, undefined, ID, 'blob');

        // Act
        const result = sut(ctx, undefined, ID, 'commit');

        // Assert
        expect({ result, logged }).toEqual({ result: true, logged: [] });
      });
    });
  });
});

describe('parseTypedObjectOrAbsent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given an absent object', () => {
    describe('When it is parsed', () => {
      it('Then it answers undefined, logging nothing', async () => {
        // Arrange
        const { ctx, logged } = logging();
        const sut = parseTypedObjectOrAbsent;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), ID);

        // Assert
        expect({ result, logged }).toEqual({ result: undefined, logged: [] });
      });
    });
  });

  describe('Given a read that fails other than on an absent object', () => {
    describe('When it is parsed', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const { ctx } = logging();
        const fault = new Error('unexpected');
        vi.spyOn(readObjectModule, 'readObject').mockRejectedValue(fault);
        const sut = parseTypedObjectOrAbsent;

        // Act
        const caught = await sut(ctx, createObjectTypeTable(), ID).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });
});

const loggingWithMeta = (): {
  readonly ctx: Context;
  readonly logged: Array<{ readonly message: string; readonly meta: unknown }>;
} => {
  const logged: Array<{ readonly message: string; readonly meta: unknown }> = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: { error: (message: string, meta?: unknown) => logged.push({ message, meta }) },
  };
  return { ctx, logged };
};

const OTHER = 'b'.repeat(40) as ObjectId;
const WHO = { name: 'A', email: 'a@x', timestamp: 1, timezoneOffset: '+0000' };

describe('assignObjectType logging context', () => {
  describe('Given an id typed a blob in a table', () => {
    describe('When the table types it a commit', () => {
      it('Then the logged context names the id, the known and the asked type', () => {
        // Arrange
        const { ctx, logged } = loggingWithMeta();
        const table = createObjectTypeTable();
        const sut = assignObjectType;
        sut(ctx, table, ID, 'blob');

        // Act
        sut(ctx, table, ID, 'commit');

        // Assert
        expect(logged).toEqual([
          {
            message: `object ${ID} is a blob, not a commit`,
            meta: { id: ID, known: 'blob', type: 'commit' },
          },
        ]);
      });
    });
  });
});

describe('parseTypedObject', () => {
  describe('Given a tag declaring a commit for a target the table typed a blob', () => {
    describe('When the tag is parsed', () => {
      it('Then the bad pointer is logged with the tag and its target', async () => {
        // Arrange
        const { ctx, logged } = loggingWithMeta();
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: OTHER,
            objectType: 'commit',
            tagName: 'v1',
            message: 'm\n',
            extraHeaders: [],
          },
        };
        const tagId = await writeObject(ctx, tag);
        const table = createObjectTypeTable();
        assignObjectType(ctx, table, OTHER, 'blob');
        logged.length = 0;
        const sut = parseTypedObject;

        // Act
        const result = await sut(ctx, table, tagId);

        // Assert
        expect({ result, logged }).toEqual({
          result: undefined,
          logged: [
            {
              message: `object ${OTHER} is a blob, not a commit`,
              meta: { id: OTHER, known: 'blob', type: 'commit' },
            },
            {
              message: `bad tag pointer to ${OTHER} in ${tagId}`,
              meta: { id: tagId, target: OTHER },
            },
          ],
        });
      });
    });
  });
});

describe('typeWalkedCommit', () => {
  describe('Given a commit whose tree the table typed a blob', () => {
    describe('When the commit is typed', () => {
      it('Then the bad pointer is logged with the commit and its tree', async () => {
        // Arrange
        const { ctx, logged } = loggingWithMeta();
        const table = createObjectTypeTable();
        assignObjectType(ctx, table, OTHER, 'blob');
        logged.length = 0;
        const commit: Commit = {
          type: 'commit',
          id: ID,
          data: {
            tree: OTHER,
            parents: [],
            author: WHO,
            committer: WHO,
            message: 'm\n',
            extraHeaders: [],
          },
        };
        const sut = typeWalkedCommit;

        // Act
        const result = await sut(ctx, table, commit);

        // Assert
        expect({ result, logged }).toEqual({
          result: false,
          logged: [
            {
              message: `object ${OTHER} is a blob, not a tree`,
              meta: { id: OTHER, known: 'blob', type: 'tree' },
            },
            {
              message: `bad tree pointer ${OTHER} in commit ${ID}`,
              meta: { id: ID, target: OTHER },
            },
          ],
        });
      });
    });
  });
});

describe('parseTypedPeelHop', () => {
  describe('Given a stored blob', () => {
    describe('When it is read as a peel hop', () => {
      it('Then only its type is kept, its content left unparsed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([0x68, 0x69]),
        });
        const sut = parseTypedPeelHop;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), blobId);

        // Assert
        expect(result).toEqual({ type: 'blob' });
      });
    });
  });
});

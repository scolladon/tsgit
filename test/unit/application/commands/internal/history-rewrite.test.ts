import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  readCommitData,
  requireSymbolicHead,
  subjectOf,
  treeOf,
} from '../../../../../src/application/commands/internal/history-rewrite.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = { name: 'T', email: 't@x', timestamp: 1, timezoneOffset: '+0000' };

/** Init a repo with one root commit on `main`; return ctx + the commit id. */
const seedCommit = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const { id } = await commit(ctx, { message: 'first', author });
  return { ctx, head: id };
};

describe('history-rewrite helpers', () => {
  describe('readCommitData', () => {
    describe('Given a commit oid', () => {
      describe('When read', () => {
        it('Then returns its CommitData with the tree and no parents', async () => {
          // Arrange
          const { ctx, head } = await seedCommit();
          const obj = await readObject(ctx, head);
          const expectedTree = obj.type === 'commit' ? obj.data.tree : undefined;

          // Act
          const sut = await readCommitData(ctx, head);

          // Assert
          expect(sut.tree).toBe(expectedTree);
          expect(sut.parents).toEqual([]);
          expect(sut.message).toContain('first');
        });
      });
    });

    describe('Given a non-commit (blob) oid', () => {
      describe('When read', () => {
        it('Then throws UNEXPECTED_OBJECT_TYPE naming commit vs blob', async () => {
          // Arrange
          const { ctx } = await seedCommit();
          const blobId = await writeObject(ctx, {
            type: 'blob',
            id: '' as ObjectId,
            content: new TextEncoder().encode('not a commit'),
          });

          // Act
          let caught: TsgitError | undefined;
          try {
            await readCommitData(ctx, blobId);
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught?.data).toMatchObject({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit',
            actual: 'blob',
            id: blobId,
          });
        });
      });
    });
  });

  describe('treeOf', () => {
    describe('Given a commit oid', () => {
      describe('When read', () => {
        it('Then returns the oid of the commit tree', async () => {
          // Arrange
          const { ctx, head } = await seedCommit();
          const obj = await readObject(ctx, head);
          const expectedTree = obj.type === 'commit' ? obj.data.tree : undefined;

          // Act
          const sut = await treeOf(ctx, head);

          // Assert
          expect(sut).toBe(expectedTree);
          const tree = await readObject(ctx, sut);
          expect(tree.type).toBe('tree');
        });
      });
    });
  });

  describe('subjectOf', () => {
    describe('Given a multi-line message', () => {
      describe('When the subject is taken', () => {
        it('Then returns the first line only', () => {
          // Arrange
          const message = 'subject line\n\nbody paragraph\nmore body';

          // Act
          const sut = subjectOf(message);

          // Assert
          expect(sut).toBe('subject line');
        });
      });
    });

    describe('Given a single-line message', () => {
      describe('When the subject is taken', () => {
        it('Then returns it unchanged', () => {
          // Arrange
          const message = 'solo subject';

          // Act
          const sut = subjectOf(message);

          // Assert
          expect(sut).toBe('solo subject');
        });
      });
    });

    describe('Given an empty message', () => {
      describe('When the subject is taken', () => {
        it('Then returns the empty string', () => {
          // Arrange
          const message = '';

          // Act
          const sut = subjectOf(message);

          // Assert
          expect(sut).toBe('');
        });
      });
    });
  });

  describe('requireSymbolicHead', () => {
    describe('Given a symbolic HEAD', () => {
      describe('When the branch is required', () => {
        it('Then returns the branch RefName', async () => {
          // Arrange
          const { ctx } = await seedCommit();

          // Act
          const sut = await requireSymbolicHead(ctx, 'demo');

          // Assert
          expect(sut).toBe('refs/heads/main' as RefName);
        });
      });
    });

    describe('Given a detached HEAD', () => {
      describe('When the branch is required', () => {
        it('Then throws UNSUPPORTED_OPERATION carrying the verb and reason', async () => {
          // Arrange
          const { ctx, head } = await seedCommit();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${head}\n`);

          // Act
          let caught: TsgitError | undefined;
          try {
            await requireSymbolicHead(ctx, 'demo --abort');
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught?.data).toMatchObject({
            code: 'UNSUPPORTED_OPERATION',
            operation: 'demo --abort',
            reason: 'cannot run with detached HEAD',
          });
        });
      });
    });
  });
});

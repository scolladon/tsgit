import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { evaluateRevision, revParse } from '../../../../src/application/commands/rev-parse.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

interface PeelRepo {
  readonly ctx: Context;
  readonly errors: string[];
  readonly ids: Readonly<
    Record<'blob' | 'tree' | 'root' | 'head' | 'tagOfCommit' | 'tagOfTree', ObjectId>
  >;
}

const writeCommit = (ctx: Context, tree: ObjectId, parents: ReadonlyArray<ObjectId>) => {
  const data: CommitData = {
    tree,
    parents: [...parents],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'c',
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
};

const writeTag = (ctx: Context, target: ObjectId, objectType: 'commit' | 'tree', tagName: string) =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: { object: target, objectType, tagName, message: 'tag', extraHeaders: [] },
  });

/** `root` ← `head` on main; `tc` an annotated tag of `head`, `tt` one of its tree. */
const peelRepo = async (): Promise<PeelRepo> => {
  const errors: string[] = [];
  const base = createMemoryContext();
  const ctx = { ...base, logger: { error: (message: string) => errors.push(message) } } as Context;
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode('a\n'),
  });
  const tree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry(FILE_MODE.REGULAR, 'f', blob)],
  });
  const root = await writeCommit(ctx, tree, []);
  const head = await writeCommit(ctx, tree, [root]);
  const tagOfCommit = await writeTag(ctx, head, 'commit', 'tc');
  const tagOfTree = await writeTag(ctx, tree, 'tree', 'tt');
  const refs = { 'refs/heads/main': head, 'refs/tags/tc': tagOfCommit, 'refs/tags/tt': tagOfTree };
  for (const [name, id] of Object.entries(refs))
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return { ctx, errors, ids: { blob, tree, root, head, tagOfCommit, tagOfTree } };
};

const failureCode = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data.code;
  }
  return undefined;
};

describe('Given a peel operator that cannot reach its kind', () => {
  describe.each([
    {
      arg: 'HEAD^{tree}^{commit}',
      message:
        'HEAD^{tree}^{commit}: expected commit type, but the object dereferences to tree type',
    },
    {
      arg: 'HEAD^{tree}^{tag}',
      message: 'HEAD^{tree}^{tag}: expected tag type, but the object dereferences to tree type',
    },
    {
      arg: 'HEAD^{blob}',
      message: 'HEAD^{blob}: expected blob type, but the object dereferences to tree type',
    },
    {
      arg: 'tt^{commit}',
      message: 'tt^{commit}: expected commit type, but the object dereferences to tree type',
    },
    { arg: 'HEAD:f^{tree}~1', message: undefined },
  ])('When revParse reads $arg', ({ arg, message }) => {
    it('Then it reports the mismatch on each of the two reads before refusing', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = revParse;

      // Act
      const result = await failureCode(() => sut(ctx, arg));

      // Assert
      expect(result).toBeDefined();
      expect(errors).toEqual(message === undefined ? [] : [message, message]);
    });
  });

  describe('When the failing peel is followed by further operators', () => {
    it('Then the message names the expression up to that peel', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = evaluateRevision;

      // Act
      await failureCode(() => sut(ctx, 'HEAD^{tree}^{blob}~1'));

      // Assert
      expect(errors).toEqual([
        'HEAD^{tree}^{blob}: expected blob type, but the object dereferences to tree type',
      ]);
    });
  });

  describe('When the failing peel follows a reflog selector', () => {
    it('Then the message names the whole expression up to that peel', async () => {
      // Arrange
      const { ctx, errors, ids } = await peelRepo();
      const zero = '0'.repeat(40);
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/logs/refs/heads/main`,
        `${zero} ${ids.head} Test <test@example.com> 1700000000 +0000\tcommit\n`,
      );
      const sut = evaluateRevision;

      // Act
      await failureCode(() => sut(ctx, 'main@{0}^{tree}^{commit}^'));

      // Assert
      expect(errors).toEqual([
        'main@{0}^{tree}^{commit}: expected commit type, but the object dereferences to tree type',
      ]);
    });
  });
});

describe('Given a parent or ancestor operator on an object that peels to no commit', () => {
  describe.each(['HEAD^{tree}^', 'HEAD^{tree}~1', 'HEAD^{tree}^0', 'HEAD^{tree}~0'])(
    'When evaluateRevision reads %s',
    (arg) => {
      it('Then it reports the object as git names it, once, and refuses', async () => {
        // Arrange
        const { ctx, errors, ids } = await peelRepo();
        const sut = evaluateRevision;

        // Act
        const result = await failureCode(() => sut(ctx, arg));

        // Assert
        expect(result).toBe('OBJECT_NOT_FOUND');
        expect(errors).toEqual([`object ${ids.tree} is a tree, not a commit`]);
      });
    },
  );

  describe('When evaluateRevision reads a tag of a tree with a parent operator', () => {
    it('Then it names the tag it was given and the kind it peels to', async () => {
      // Arrange
      const { ctx, errors, ids } = await peelRepo();
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, 'tt^'));

      // Assert
      expect(result).toBe('OBJECT_NOT_FOUND');
      expect(errors).toEqual([`object ${ids.tagOfTree} is a tree, not a commit`]);
    });
  });
});

describe('Given a parent or ancestor operator on a commit-ish', () => {
  describe.each([
    { arg: 'HEAD^0', expected: 'head' },
    { arg: 'HEAD~0', expected: 'head' },
    { arg: 'tc^0', expected: 'head' },
    { arg: 'tc~0', expected: 'head' },
    { arg: 'tc^', expected: 'root' },
    { arg: 'tc~1', expected: 'root' },
    { arg: 'tc^1^0', expected: 'root' },
  ] as const)('When evaluateRevision reads $arg', ({ arg, expected }) => {
    it('Then it peels tags to the commit before walking, as git does', async () => {
      // Arrange
      const { ctx, errors, ids } = await peelRepo();
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toBe(ids[expected]);
      expect(errors).toEqual([]);
    });
  });

  describe('When evaluateRevision asks for a parent the commit lacks', () => {
    it('Then it refuses without reporting an error', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, 'HEAD^2'));

      // Assert
      expect(result).toBe('OBJECT_NOT_FOUND');
      expect(errors).toEqual([]);
    });
  });
});

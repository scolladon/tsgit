import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  evaluateRevision,
  resolveRevision,
  revParse,
} from '../../../../src/application/commands/rev-parse.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeForgedTagLoop } from '../primitives/fixtures.js';

const AUTHOR = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const ABSENT_OID = '1'.repeat(40) as ObjectId;

interface PeelRepo {
  readonly ctx: Context;
  readonly errors: string[];
  readonly ids: Readonly<
    Record<
      'blob' | 'tree' | 'root' | 'head' | 'tagOfCommit' | 'tagOfTree' | 'tagOfTag' | 'dangling',
      ObjectId
    >
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

const writeTag = (
  ctx: Context,
  target: ObjectId,
  objectType: 'commit' | 'tree' | 'tag',
  tagName: string,
) =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: { object: target, objectType, tagName, message: 'tag', extraHeaders: [] },
  });

/**
 * `root` ← `head` on main; `tc` an annotated tag of `head`, `tt` one of its
 * tree, `tc2` one of `tc`, and `bad` one naming an absent commit.
 */
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
  const tagOfTag = await writeTag(ctx, tagOfCommit, 'tag', 'tc2');
  const dangling = await writeTag(ctx, ABSENT_OID, 'commit', 'bad');
  const refs = {
    'refs/heads/main': head,
    'refs/tags/tc': tagOfCommit,
    'refs/tags/tt': tagOfTree,
    'refs/tags/tc2': tagOfTag,
    'refs/tags/bad': dangling,
  };
  for (const [name, id] of Object.entries(refs))
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return {
    ctx,
    errors,
    ids: { blob, tree, root, head, tagOfCommit, tagOfTree, tagOfTag, dangling },
  };
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
  ])('When resolveRevision reads $arg', ({ arg, message }) => {
    it('Then it reports the mismatch on each of the two reads before refusing', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = resolveRevision;

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

describe('Given objects behind zero or more tags', () => {
  describe.each([
    { arg: 'HEAD^{}', expected: 'head' },
    { arg: 'tc^{}', expected: 'head' },
    { arg: 'tc2^{}', expected: 'head' },
    { arg: 'tt^{}', expected: 'tree' },
    { arg: 'tc2^{}^', expected: 'root' },
    { arg: 'HEAD^{object}', expected: 'head' },
    { arg: 'tc2^{object}', expected: 'tagOfTag' },
    { arg: 'bad^{object}', expected: 'dangling' },
  ] as const)('When resolveRevision reads $arg', ({ arg, expected }) => {
    it('Then ^{} peels every tag and ^{object} keeps the object, as git does', async () => {
      // Arrange
      const { ctx, errors, ids } = await peelRepo();
      const sut = resolveRevision;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toBe(ids[expected]);
      expect(errors).toEqual([]);
    });
  });

  describe('When resolveRevision peels a tag naming an absent object with ^{}', () => {
    it('Then it reports the missing object under the tag name on each read and refuses', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = resolveRevision;

      // Act
      const result = await failureCode(() => sut(ctx, 'bad^{}'));

      // Assert
      expect(result).toBe('OBJECT_NOT_FOUND');
      expect(errors).toEqual([
        "missing object referenced by 'bad'",
        "missing object referenced by 'bad'",
      ]);
    });
  });

  describe('When evaluateRevision peels a tag naming an absent object to a commit', () => {
    it('Then it refuses without a message, as git does', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, 'bad^{commit}'));

      // Assert
      expect(result).toBe('OBJECT_NOT_FOUND');
      expect(errors).toEqual([]);
    });
  });

  describe('When evaluateRevision keeps an absent object with ^{object}', () => {
    it('Then it refuses without a message', async () => {
      // Arrange
      const { ctx, errors } = await peelRepo();
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, `${ABSENT_OID}^{object}`));

      // Assert
      expect(result).toBe('OBJECT_NOT_FOUND');
      expect(errors).toEqual([]);
    });
  });
});

describe('Given a six-deep chain of tags over a commit', () => {
  describe('When resolveRevision peels its outermost tag to the tree', () => {
    it('Then it peels every tag, as git does', async () => {
      // Arrange
      const { ctx, ids } = await peelRepo();
      let tip: ObjectId = ids.tagOfCommit;
      for (let level = 2; level <= 6; level += 1)
        tip = await writeTag(ctx, tip, 'tag', `d${level}`);
      const sut = resolveRevision;

      // Act
      const result = await sut(ctx, `${tip}^{tree}`);

      // Assert
      expect(result).toBe(ids.tree);
    });
  });
});

describe('Given a forged tag naming itself', () => {
  describe('When evaluateRevision peels it to a commit', () => {
    it('Then it refuses the looping chain as naming no object', async () => {
      // Arrange
      const { ctx } = await peelRepo();
      const loop = await writeForgedTagLoop(ctx);
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, `${loop}^{commit}`));

      // Assert
      expect(result).toBe('OBJECT_NOT_FOUND');
    });
  });
});

describe('revParse: object types assigned during one invocation', () => {
  /** `refs/tags/tm` naming a tag that declares `type commit` for a blob. */
  const seedMistypedTag = async (): Promise<{
    readonly ctx: Context;
    readonly errors: string[];
    readonly blob: ObjectId;
  }> => {
    const errors: string[] = [];
    const base = createMemoryContext();
    await init(base);
    const ctx: Context = { ...base, logger: { error: (message: string) => errors.push(message) } };
    const blob = await writeObject(ctx, {
      type: 'blob',
      id: '' as ObjectId,
      content: new TextEncoder().encode('hi\n'),
    });
    const tag = await writeTag(ctx, blob, 'commit', 'tm');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/tm`, `${tag}\n`);
    return { ctx, errors, blob };
  };

  describe.each([
    ['tm^{commit}', (blob: ObjectId) => [`object ${blob} is a commit, not a blob`]],
    [
      'tm^{}',
      (blob: ObjectId) => [
        `object ${blob} is a commit, not a blob`,
        "missing object referenced by 'tm'",
      ],
    ],
  ])('Given a tag declaring a commit for a blob, When revParse reads %s', (expression, once) => {
    it('Then each read logs the typing error the blob conflicts with', async () => {
      // Arrange
      const { ctx, errors, blob } = await seedMistypedTag();
      const sut = revParse;

      // Act
      let caught: unknown;
      try {
        await sut(ctx, expression);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect({ code: (caught as TsgitError).data.code, errors }).toEqual({
        code: 'OBJECT_NOT_FOUND',
        errors: [...once(blob), ...once(blob)],
      });
    });
  });
});

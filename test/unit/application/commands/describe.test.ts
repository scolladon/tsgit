import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { describe as describeCmd } from '../../../../src/application/commands/describe.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  CommitData,
  ObjectId,
  TagData,
} from '../../../../src/domain/objects/index.js';
import { RefName } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const ident = (timestamp: number): AuthorIdentity => ({
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp,
  timezoneOffset: '+0000',
});

const seed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

let clock = 1_700_000_000;

const commitFile = async (ctx: Context, name: string): Promise<ObjectId> => {
  clock += 60;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}.txt`, `${name}\n`);
  await add(ctx, [`${name}.txt`]);
  const result = await commit(ctx, {
    message: name,
    author: ident(clock),
    committer: ident(clock),
  });
  return result.id;
};

const annotatedTag = async (
  ctx: Context,
  name: string,
  target: ObjectId,
  taggerTime: number,
): Promise<void> => {
  const data: TagData = {
    object: target,
    objectType: 'commit',
    tagName: name,
    tagger: ident(taggerTime),
    message: `${name}\n`,
    extraHeaders: [],
  };
  const tagOid = await writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
  await tagCreate(ctx, { name, target: tagOid });
};

const treeOf = async (ctx: Context, commitOid: ObjectId): Promise<ObjectId> => {
  const object = await readObject(ctx, commitOid);
  if (object.type !== 'commit') throw new Error('expected a commit');
  return object.data.tree;
};

const writeCommit = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> => {
  clock += 60;
  const data: CommitData = {
    tree,
    parents,
    author: ident(clock),
    committer: ident(clock),
    message: `${message}\n`,
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
};

const catchError = async (run: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError) return err;
    throw err;
  }
  throw new Error('expected a TsgitError to be thrown');
};

describe('describe', () => {
  describe('Given the target commit itself is annotated-tagged', () => {
    describe('When describe runs at HEAD', () => {
      it('Then it reports the tag at distance 0, exact', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut).toEqual({
          tag: RefName.from('refs/tags/v1.0'),
          name: 'v1.0',
          distance: 0,
          oid: head,
          exact: true,
          dirty: false,
        });
      });
    });
  });

  describe('Given an annotated tag two commits behind HEAD', () => {
    describe('When describe runs', () => {
      it('Then the distance counts the commits between tag and HEAD', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        await commitFile(ctx, 'c2');
        await commitFile(ctx, 'c3');

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut.name).toBe('v1.0');
        expect(sut.distance).toBe(2);
        expect(sut.exact).toBe(false);
      });
    });
  });

  describe('Given a nearer and a farther annotated tag', () => {
    describe('When describe runs', () => {
      it('Then the nearer tag wins', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'v2.0', c2, clock);
        await commitFile(ctx, 'c3');

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut.name).toBe('v2.0');
        expect(sut.distance).toBe(1);
      });
    });
  });

  describe('Given only a lightweight tag in default mode', () => {
    describe('When describe runs without tags', () => {
      it('Then it refuses with NO_ANNOTATED_NAMES', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await tagCreate(ctx, { name: 'light', target: c1 });
        const head = await commitFile(ctx, 'c2');

        // Act
        const sut = await catchError(() => describeCmd(ctx));

        // Assert
        expect(sut.data).toEqual({ code: 'NO_ANNOTATED_NAMES', oid: head });
      });
    });

    describe('When describe runs with tags: true', () => {
      it('Then the lightweight tag is found', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await tagCreate(ctx, { name: 'light', target: c1 });
        await commitFile(ctx, 'c2');

        // Act
        const sut = await describeCmd(ctx, undefined, { tags: true });

        // Assert
        expect(sut.name).toBe('light');
        expect(sut.distance).toBe(1);
      });
    });
  });

  describe('Given a branch tip and an older annotated tag with all: true', () => {
    describe('When describe runs at the branch tip', () => {
      it('Then the depth-0 branch name beats the deeper tag', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const c2 = await commitFile(ctx, 'c2');
        await getRefStore(ctx).writeLoose(RefName.from('refs/heads/feat'), c2);

        // Act
        const sut = await describeCmd(ctx, c2, { all: true });

        // Assert
        expect(sut.name).toBe('heads/feat');
        expect(sut.tag).toBe(RefName.from('refs/heads/feat'));
        expect(sut.distance).toBe(0);
      });
    });
  });

  describe('Given a merge whose two parents each carry a tag', () => {
    describe('When describe runs with firstParent', () => {
      it('Then only the first-parent tag is reachable', async () => {
        // Arrange — base, then two divergent commits (each tagged), then a merge
        // with parents [first, second]. firstParent follows only `first`.
        const ctx = await seed();
        const base = await commitFile(ctx, 'base');
        const tree = await treeOf(ctx, base);
        const second = await writeCommit(ctx, tree, [base], 'second');
        await annotatedTag(ctx, 'feat-tag', second, clock);
        const first = await writeCommit(ctx, tree, [base], 'first');
        await annotatedTag(ctx, 'main-tag', first, clock);
        const merge = await writeCommit(ctx, tree, [first, second], 'merge');

        // Act
        const sut = await describeCmd(ctx, merge, { firstParent: true });

        // Assert
        expect(sut.name).toBe('main-tag');
        expect(sut.distance).toBe(1);
      });
    });

    describe('When describe runs over both parents', () => {
      it('Then a second-parent tag is reachable', async () => {
        // Arrange — same shape; the default walk sees both parents.
        const ctx = await seed();
        const base = await commitFile(ctx, 'base');
        const tree = await treeOf(ctx, base);
        const second = await writeCommit(ctx, tree, [base], 'second');
        await annotatedTag(ctx, 'feat-tag', second, clock);
        const merge = await writeCommit(ctx, tree, [base, second], 'merge');

        // Act
        const sut = await describeCmd(ctx, merge);

        // Assert
        expect(sut.name).toBe('feat-tag');
      });
    });
  });

  describe('Given no tags and always: true', () => {
    describe('When describe runs', () => {
      it('Then it falls back to the target oid with no tag', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const sut = await describeCmd(ctx, undefined, { always: true });

        // Assert
        expect(sut).toEqual({
          tag: undefined,
          name: '',
          distance: 0,
          oid: head,
          exact: false,
          dirty: false,
        });
      });
    });
  });

  describe('Given no tags and no always', () => {
    describe('When describe runs', () => {
      it('Then it refuses with NO_NAMES', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const sut = await catchError(() => describeCmd(ctx));

        // Assert
        expect(sut.data).toEqual({ code: 'NO_NAMES', oid: head });
      });
    });
  });

  describe('Given an annotated tag that does not reach the target', () => {
    describe('When describe runs on an ancestor of the tag', () => {
      it('Then it refuses with NO_REACHABLE_NAMES', async () => {
        // Arrange — the tag sits on c2, but we describe its ancestor c1, which
        // the tag does not reach.
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'v2.0', c2, clock);

        // Act
        const sut = await catchError(() => describeCmd(ctx, c1));

        // Assert
        expect(sut.data).toEqual({ code: 'NO_REACHABLE_NAMES', oid: c1 });
      });
    });
  });

  describe('Given exactMatch on an untagged commit', () => {
    describe('When describe runs', () => {
      it('Then it refuses with NO_EXACT_MATCH', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const head = await commitFile(ctx, 'c2');

        // Act
        const sut = await catchError(() => describeCmd(ctx, undefined, { exactMatch: true }));

        // Assert
        expect(sut.data).toEqual({ code: 'NO_EXACT_MATCH', oid: head });
      });
    });
  });

  describe('Given exactMatch with always on an untagged commit', () => {
    describe('When describe runs', () => {
      it('Then it falls back instead of refusing', async () => {
        // Arrange
        const ctx = await seed();
        await commitFile(ctx, 'c1');
        const head = await commitFile(ctx, 'c2');

        // Act
        const sut = await describeCmd(ctx, undefined, { exactMatch: true, always: true });

        // Assert
        expect(sut.tag).toBeUndefined();
        expect(sut.oid).toBe(head);
      });
    });
  });

  describe('Given the candidate cap of 1 over two tags', () => {
    describe('When describe runs with candidates: 1', () => {
      it('Then it still reports the nearest tag with the exact distance', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'v2.0', c2, clock);
        await commitFile(ctx, 'c3');

        // Act
        const sut = await describeCmd(ctx, undefined, { candidates: 1 });

        // Assert
        expect(sut.name).toBe('v2.0');
        expect(sut.distance).toBe(1);
      });
    });
  });

  describe('Given two annotated tags on one commit with different tagger dates', () => {
    describe('When describe runs', () => {
      it('Then the newer tagger date wins even when its name sorts later', async () => {
        // Arrange — `aaa` sorts first but is older; `bbb` sorts later but newer.
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'aaa', head, 1_000);
        await annotatedTag(ctx, 'bbb', head, 2_000);

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut.name).toBe('bbb');
      });
    });
  });

  describe('Given match and exclude globs', () => {
    describe('When describe filters candidate tags', () => {
      it('Then only matching, non-excluded tags are considered', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'rc-1', c2, clock);
        await commitFile(ctx, 'c3');

        // Act
        const sut = await describeCmd(ctx, undefined, { match: 'v*', exclude: 'rc*' });

        // Assert — rc-1 (nearer) is filtered out, leaving v1.0.
        expect(sut.name).toBe('v1.0');
        expect(sut.distance).toBe(2);
      });
    });
  });

  describe('Given a working tree with a tracked change and dirty: true', () => {
    describe('When describe runs', () => {
      it('Then the result is marked dirty', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c1.txt`, 'changed\n');

        // Act
        const sut = await describeCmd(ctx, undefined, { dirty: true });

        // Assert
        expect(sut.dirty).toBe(true);
        expect(sut.name).toBe('v1.0');
      });
    });
  });

  describe('Given a clean working tree and dirty: true', () => {
    describe('When describe runs', () => {
      it('Then the result is not dirty', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const sut = await describeCmd(ctx, undefined, { dirty: true });

        // Assert
        expect(sut.dirty).toBe(false);
      });
    });
  });

  describe('Given an untracked file only and dirty: true', () => {
    describe('When describe runs', () => {
      it('Then untracked files do not count as dirty', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/untracked.txt`, 'u\n');

        // Act
        const sut = await describeCmd(ctx, undefined, { dirty: true });

        // Assert
        expect(sut.dirty).toBe(false);
      });
    });
  });

  describe('Given dirty: true together with an explicit commit-ish', () => {
    describe('When describe runs', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const sut = await catchError(() => describeCmd(ctx, head, { dirty: true }));

        // Assert
        expect(sut.data).toMatchObject({ code: 'INVALID_OPTION', option: 'dirty' });
      });
    });
  });

  describe('Given a negative candidates count', () => {
    describe('When describe runs', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const ctx = await seed();
        await commitFile(ctx, 'c1');

        // Act
        const sut = await catchError(() => describeCmd(ctx, undefined, { candidates: -1 }));

        // Assert
        expect(sut.data).toMatchObject({ code: 'INVALID_OPTION', option: 'candidates' });
      });
    });
  });

  describe('Given a tag that peels to a tree, not a commit', () => {
    describe('When describe runs', () => {
      it('Then the tree tag is skipped and the commit tag is used', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const tree = await treeOf(ctx, c1);
        const treeTag: TagData = {
          object: tree,
          objectType: 'tree',
          tagName: 'tree-tag',
          tagger: ident(clock),
          message: 'tree\n',
          extraHeaders: [],
        };
        const treeTagOid = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: treeTag,
        });
        await tagCreate(ctx, { name: 'tree-tag', target: treeTagOid });
        await commitFile(ctx, 'c2');

        // Act
        const sut = await describeCmd(ctx);

        // Assert — the tree tag peels to a tree and is dropped, leaving v1.0.
        expect(sut.name).toBe('v1.0');
      });
    });
  });

  describe('Given a symbolic ref among the refs under all', () => {
    describe('When describe runs with all: true', () => {
      it('Then the symbolic ref is skipped', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await writeSymbolicRef(
          ctx,
          RefName.from('refs/remotes/origin/HEAD'),
          RefName.from('refs/heads/main'),
        );

        // Act
        const sut = await describeCmd(ctx, c1, { all: true });

        // Assert — the symbolic origin/HEAD is skipped; heads/main resolves directly.
        expect(sut.name).toBe('heads/main');
        expect(sut.exact).toBe(true);
      });
    });
  });

  describe('Given a tree object as the target', () => {
    describe('When describe runs', () => {
      it('Then it refuses (a tree reaches no tagged commit)', async () => {
        // Arrange
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);
        const tree = await treeOf(ctx, c1);

        // Act
        const sut = await catchError(() => describeCmd(ctx, tree));

        // Assert
        expect(sut.data).toMatchObject({ code: 'NO_REACHABLE_NAMES' });
      });
    });
  });
});

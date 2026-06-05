import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { describe as describeCmd } from '../../../../src/application/commands/describe.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
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

const tagObjectRef = async (
  ctx: Context,
  name: string,
  object: ObjectId,
  objectType: TagData['objectType'],
  taggerTime: number,
): Promise<ObjectId> => {
  const data: TagData = {
    object,
    objectType,
    tagName: name,
    tagger: ident(taggerTime),
    message: `${name}\n`,
    extraHeaders: [],
  };
  const oid = await writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
  await tagCreate(ctx, { name, target: oid });
  return oid;
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

  describe('Given a staged-only tracked change and dirty: true', () => {
    describe('When describe runs', () => {
      it('Then the result is marked dirty (the staged column counts)', async () => {
        // Arrange — change c1.txt and stage it, so the working tree matches the
        // index but the index differs from HEAD (git's `D `/`M ` staged column).
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c1.txt`, 'changed\n');
        await add(ctx, ['c1.txt']);

        // Act
        const sut = await describeCmd(ctx, undefined, { dirty: true });

        // Assert
        expect(sut.dirty).toBe(true);
        expect(sut.name).toBe('v1.0');
      });
    });
  });

  describe('Given a staged-only tracked change and broken: true', () => {
    describe('When describe runs', () => {
      it('Then the staged change is still detected as dirty', async () => {
        // Arrange — broken also routes through the dirtiness check; a staged-only
        // change must register there too.
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c1.txt`, 'changed\n');
        await add(ctx, ['c1.txt']);

        // Act
        const sut = await describeCmd(ctx, undefined, { broken: true });

        // Assert
        expect(sut.dirty).toBe(true);
      });
    });
  });

  describe('Given a conflicted index (mid-merge) and dirty: true', () => {
    describe('When describe runs', () => {
      it('Then the unmerged paths count as dirty', async () => {
        // Arrange — a content/content merge conflict leaves stages 1/2/3 in the
        // index; git's `diff-index HEAD` reports a mid-merge index as dirty even
        // though no path appears in the staged or working-tree columns.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
        await add(ctx, ['file.txt']);
        const base = await commit(ctx, { message: 'base', author: ident(clock) });
        await annotatedTag(ctx, 'v1.0', base.id, clock);
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author: ident(clock) });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author: ident(clock) });
        await mergeRun(ctx, { rev: 'feature', author: ident(clock) });

        // Act
        const sut = await describeCmd(ctx, undefined, { dirty: true });

        // Assert
        expect(sut.dirty).toBe(true);
        expect(sut.name).toBe('v1.0');
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
        expect(sut.data).toMatchObject({
          code: 'INVALID_OPTION',
          option: 'dirty',
          reason: 'option dirty and commit-ishes cannot be used together',
        });
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
        expect(sut.data).toMatchObject({
          code: 'INVALID_OPTION',
          option: 'candidates',
          reason: 'expected a non-negative integer, got -1',
        });
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
        // And describing the tree oid itself refuses — the dropped tree tag must
        // not be mapped onto the tree (which would let it exact-match).
        const onTree = await catchError(() => describeCmd(ctx, tree));
        expect(onTree.data).toMatchObject({ code: 'NO_REACHABLE_NAMES' });
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

  describe('Given candidates: 0 on an exactly-tagged HEAD', () => {
    describe('When describe runs', () => {
      it('Then 0 is a valid count and the exact tag is returned', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const sut = await describeCmd(ctx, undefined, { candidates: 0 });

        // Assert
        expect(sut).toMatchObject({ name: 'v1.0', distance: 0, exact: true });
      });
    });
  });

  describe('Given exactMatch on an exactly-tagged commit', () => {
    describe('When describe runs', () => {
      it('Then it returns that tag at distance 0', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const sut = await describeCmd(ctx, undefined, { exactMatch: true });

        // Assert
        expect(sut).toMatchObject({ name: 'v1.0', distance: 0, exact: true });
      });
    });
  });

  describe('Given a lightweight tag on HEAD itself in default mode', () => {
    describe('When describe runs', () => {
      it('Then the lightweight tag does not satisfy the exact short-circuit', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await tagCreate(ctx, { name: 'light', target: head });

        // Act
        const sut = await catchError(() => describeCmd(ctx));

        // Assert — a priority-1 tag must not exact-match in annotated-only mode.
        expect(sut.data).toEqual({ code: 'NO_ANNOTATED_NAMES', oid: head });
      });
    });
  });

  describe('Given broken: true with an explicit commit-ish', () => {
    describe('When describe runs', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const sut = await catchError(() => describeCmd(ctx, head, { broken: true }));

        // Assert
        expect(sut.data).toMatchObject({ code: 'INVALID_OPTION', option: 'dirty' });
      });
    });
  });

  describe('Given broken: true with a tracked change', () => {
    describe('When describe runs', () => {
      it('Then it reports dirty', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c1.txt`, 'changed\n');

        // Act
        const sut = await describeCmd(ctx, undefined, { broken: true });

        // Assert
        expect(sut.dirty).toBe(true);
      });
    });
  });

  describe('Given a tracked change but neither dirty nor broken', () => {
    describe('When describe runs', () => {
      it('Then the result is not marked dirty (the check is gated)', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c1.txt`, 'changed\n');

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut.dirty).toBe(false);
      });
    });
  });

  describe('Given a capped search over a merge with a tagged sibling branch', () => {
    describe('When describe runs with candidates: 1', () => {
      it('Then the winner depth is finalised past the cap (counts the sibling)', async () => {
        // Arrange — M = mergeRun(a1, b1), each tagged. b1 is newer so its tag is
        // found first (and capped as the winner); a1 is the gave-up commit whose
        // branch the finish phase must still count into the winner's depth.
        const ctx = await seed();
        const base = await commitFile(ctx, 'base');
        const tree = await treeOf(ctx, base);
        const a1 = await writeCommit(ctx, tree, [base], 'a1');
        await annotatedTag(ctx, 'tag-a', a1, clock);
        const b1 = await writeCommit(ctx, tree, [base], 'b1');
        await annotatedTag(ctx, 'tag-b', b1, clock);
        const merge = await writeCommit(ctx, tree, [a1, b1], 'merge');

        // Act
        const sut = await describeCmd(ctx, merge, { candidates: 1 });

        // Assert — |tag-b..merge| = { merge, a1 } = 2.
        expect(sut.name).toBe('tag-b');
        expect(sut.distance).toBe(2);
      });
    });
  });

  describe('Given a detached HEAD and all: true', () => {
    describe('When describe runs', () => {
      it('Then HEAD is excluded as a name (only real refs count)', async () => {
        // Arrange — detach HEAD onto c1; `refs/heads/main` still names c1.
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${c1}\n`);

        // Act
        const sut = await describeCmd(ctx, c1, { all: true });

        // Assert — git never names a commit `HEAD`; only `heads/main` qualifies.
        expect(sut.name).toBe('heads/main');
      });
    });
  });

  describe('Given a tag chain deeper than the peel bound', () => {
    describe('When describe runs', () => {
      it('Then the over-deep tag is dropped at the peel bound', async () => {
        // Arrange — seven nested annotated tags on c1 with increasing dates. The
        // outermost (t7) exceeds the peel depth and must be dropped, so the
        // newest still-peelable tag (t6) wins rather than t7.
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        let prev = c1;
        let prevType: TagData['objectType'] = 'commit';
        for (let i = 1; i <= 7; i += 1) {
          prev = await tagObjectRef(ctx, `t${i}`, prev, prevType, 1_000 + i);
          prevType = 'tag';
        }

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut.name).toBe('t6');
      });
    });
  });

  describe('Given a nested annotated tag and a sibling tag on one commit', () => {
    describe('When describe runs', () => {
      it('Then the outermost tagger date drives the dedup', async () => {
        // Arrange — c1 carries `outer` (a tag of a tag, outermost date 3000),
        // `inner` (its inner tag, date 1000), and `sibling` (date 2000). The
        // newest outermost date (outer, 3000) must win.
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        const innerOid = await tagObjectRef(ctx, 'inner', c1, 'commit', 1_000);
        await tagObjectRef(ctx, 'sibling', c1, 'commit', 2_000);
        await tagObjectRef(ctx, 'outer', innerOid, 'tag', 3_000);

        // Act
        const sut = await describeCmd(ctx);

        // Assert
        expect(sut.name).toBe('outer');
      });
    });
  });
});

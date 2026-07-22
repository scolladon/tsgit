import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import {
  type DescribeOptions,
  describe as describeCmd,
} from '../../../../src/application/commands/describe.js';
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

  describe('Given a newer-dated tag farther than an older nearer tag across a merge', () => {
    // `side` sits on a newer commit (met first in date order) but is
    // structurally farther; `near` is older yet nearer. git's early-termination
    // freezes the candidate set once every name is collected, sorts on the
    // FROZEN partial depths (a `side`/`near` tie at depth 2), breaks the tie on
    // found order (`side` met first), then finalises only the winner's depth
    // (`side` 2 → its exact 3). So default describe keeps the farther, first-met
    // `side` — matching git — and `--candidates=1` does the same with one slot.
    const buildSplit = async (ctx: Context): Promise<ObjectId> => {
      const base = await commitFile(ctx, 'base');
      const tree = await treeOf(ctx, base);
      const n1 = await writeCommit(ctx, tree, [base], 'n1');
      const n2 = await writeCommit(ctx, tree, [n1], 'n2');
      await annotatedTag(ctx, 'near', n2, clock);
      const s1 = await writeCommit(ctx, tree, [base], 's1');
      await annotatedTag(ctx, 'side', s1, clock);
      return writeCommit(ctx, tree, [n2, s1], 'merge');
    };

    describe('When describe runs with the default candidate budget', () => {
      it('Then the farther, first-met tag wins at its finalised distance', async () => {
        // Arrange
        const ctx = await seed();
        const merge = await buildSplit(ctx);

        // Act
        const sut = await describeCmd(ctx, merge);

        // Assert — frozen-depth tie broken by found order (side), then the
        // winner's depth is finalised from 2 to its exact 3.
        expect(sut.name).toBe('side');
        expect(sut.distance).toBe(3);
      });
    });

    describe('When describe runs with candidates: 1', () => {
      it('Then the cap spends its slot on the farther, first-met tag', async () => {
        // Arrange
        const ctx = await seed();
        const merge = await buildSplit(ctx);

        // Act
        const sut = await describeCmd(ctx, merge, { candidates: 1 });

        // Assert
        expect(sut.name).toBe('side');
        expect(sut.distance).toBe(3);
      });
    });
  });

  describe('Given a lightweight tag keeps the name count above the qualifying set', () => {
    // Same inversion topology as above, but a lightweight tag on `n1` lifts the
    // total name count to 3 while only two annotated tags qualify. The collected
    // count can never reach the total, so the gave-up freeze never fires; the
    // walk runs to its natural end on full depths and the exhaustively-nearest
    // `near` wins — exactly as git does (it counts lightweight tags in its name
    // total too, so its gave-up break is likewise never reached).
    const buildSplitWithLightweight = async (ctx: Context): Promise<ObjectId> => {
      const base = await commitFile(ctx, 'base');
      const tree = await treeOf(ctx, base);
      const n1 = await writeCommit(ctx, tree, [base], 'n1');
      await tagCreate(ctx, { name: 'light', target: n1 });
      const n2 = await writeCommit(ctx, tree, [n1], 'n2');
      await annotatedTag(ctx, 'near', n2, clock);
      const s1 = await writeCommit(ctx, tree, [base], 's1');
      await annotatedTag(ctx, 'side', s1, clock);
      return writeCommit(ctx, tree, [n2, s1], 'merge');
    };

    describe('When describe runs with the default candidate budget', () => {
      it('Then the walk runs to the end and the nearest annotated tag wins', async () => {
        // Arrange
        const ctx = await seed();
        const merge = await buildSplitWithLightweight(ctx);

        // Act
        const sut = await describeCmd(ctx, merge);

        // Assert
        expect(sut.name).toBe('near');
        expect(sut.distance).toBe(2);
      });
    });
  });

  describe('Given three tags where a later-met tag is nearer than the first-met one', () => {
    // `t2` is met first (newest) but `t1` is structurally nearer. With the full
    // budget every name is collected before the freeze, and the frozen sort makes
    // the nearer `t1` win; with a single slot the walk spends it on the first-met
    // `t2` and finalises that. So the candidate budget changes the answer — the
    // cap is load-bearing, not just the total-name count.
    const buildThreeTagSplit = async (ctx: Context): Promise<ObjectId> => {
      const base = await commitFile(ctx, 'base');
      const tree = await treeOf(ctx, base);
      const b0 = await writeCommit(ctx, tree, [base], 'b0');
      await annotatedTag(ctx, 't0', b0, clock);
      const b1a = await writeCommit(ctx, tree, [b0], 'b1a');
      const b1b = await writeCommit(ctx, tree, [b1a], 'b1b');
      await annotatedTag(ctx, 't1', b1b, clock);
      const b2a = await writeCommit(ctx, tree, [base], 'b2a');
      const b2b = await writeCommit(ctx, tree, [b2a], 'b2b');
      await annotatedTag(ctx, 't2', b2b, clock);
      return writeCommit(ctx, tree, [base, b2b, b1b], 'merge');
    };

    describe('When describe runs with the default candidate budget', () => {
      it('Then the frozen sort picks the nearer, later-met tag', async () => {
        // Arrange
        const ctx = await seed();
        const merge = await buildThreeTagSplit(ctx);

        // Act
        const sut = await describeCmd(ctx, merge);

        // Assert
        expect(sut.name).toBe('t1');
        expect(sut.distance).toBe(3);
      });
    });

    describe('When describe runs with candidates: 1', () => {
      it('Then the single slot is spent on the first-met tag instead', async () => {
        // Arrange
        const ctx = await seed();
        const merge = await buildThreeTagSplit(ctx);

        // Act
        const sut = await describeCmd(ctx, merge, { candidates: 1 });

        // Assert
        expect(sut.name).toBe('t2');
        expect(sut.distance).toBe(4);
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
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author: ident(clock) });
        await checkout(ctx, { rev: 'main' });
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

describe('describe --contains', () => {
  describe('Given an annotated tag a commit ahead of the target', () => {
    describe('When describe runs with contains', () => {
      it('Then it delegates to name-rev and names the containing tag', async () => {
        // Arrange
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', c1, clock);

        // Act
        const sut = await describeCmd(ctx, c0, { contains: true });

        // Assert
        expect(sut).toEqual({
          oid: c0,
          ref: RefName.from('refs/tags/v1.0'),
          tagDeref: true,
          steps: [{ kind: 'ancestor', count: 1 }],
        });
      });
    });
  });

  describe('Given a commit reachable only from a branch', () => {
    describe('When describe runs with contains and all', () => {
      it('Then it considers every ref and names the branch', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const sut = await describeCmd(ctx, head, { contains: true, all: true });

        // Assert
        expect(sut.ref).toBe(RefName.from('refs/heads/main'));
      });
    });

    describe('When describe runs with contains in the default tags mode', () => {
      it('Then it refuses (no tag contains the commit)', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const sut = await catchError(() => describeCmd(ctx, head, { contains: true }));

        // Assert
        expect(sut.data).toMatchObject({ code: 'CANNOT_DESCRIBE', oid: head });
      });

      it('Then with always it returns an undefined-ref result instead', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const sut = await describeCmd(ctx, head, { contains: true, always: true });

        // Assert
        expect(sut).toEqual({ oid: head, ref: undefined, tagDeref: false, steps: [] });
      });
    });
  });

  describe('Given two tags and a contains match pattern', () => {
    describe('When describe runs with contains and match', () => {
      it('Then the match is scoped to refs/tags and filters the names', async () => {
        // Arrange
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'release-1', c1, clock);
        await annotatedTag(ctx, 'beta-1', c1, clock);

        // Act
        const sut = await describeCmd(ctx, c0, { contains: true, match: 'release-*' });

        // Assert
        expect(sut.ref).toBe(RefName.from('refs/tags/release-1'));
      });
    });
  });

  describe('Given contains combined with an ancestor-walk option', () => {
    const cases: ReadonlyArray<[string, DescribeOptions]> = [
      ['candidates', { candidates: 1 }],
      ['exactMatch', { exactMatch: true }],
      ['firstParent', { firstParent: true }],
      ['dirty', { dirty: true }],
      ['broken', { broken: true }],
    ];
    for (const [option, extra] of cases) {
      describe(`When describe runs with contains and ${option}`, () => {
        it('Then it refuses with INVALID_OPTION', async () => {
          // Arrange
          const ctx = await seed();
          await commitFile(ctx, 'c1');

          // Act
          const sut = await catchError(() =>
            describeCmd(ctx, undefined, { contains: true, ...extra }),
          );

          // Assert
          expect(sut.data).toMatchObject({
            code: 'INVALID_OPTION',
            option,
            reason: `option ${option} cannot be combined with contains`,
          });
        });
      });
    }
  });
});

const withCountedObjectReads = (ctx: Context): { counted: Context; reads: () => number } => {
  let count = 0;
  const baseFs = ctx.fs;
  const countedFs: Context['fs'] = {
    ...baseFs,
    read: (path) => {
      if (path.includes('objects/')) {
        count += 1;
      }
      return baseFs.read(path);
    },
  };
  return { counted: { ...ctx, fs: countedFs }, reads: () => count };
};

describe('Given a deep chain with an annotated tag three commits below HEAD', () => {
  const arrange = async (): Promise<{ counted: Context; reads: () => number }> => {
    const ctx = await seed();
    const oids: ObjectId[] = [];
    for (let i = 0; i < 30; i += 1) {
      oids.push(await commitFile(ctx, `c${i}`));
    }
    const target = oids[26] as ObjectId;
    clock += 60;
    await annotatedTag(ctx, 'near', target, clock);
    return withCountedObjectReads(ctx);
  };

  describe('When describing HEAD', () => {
    it('Then the near tag is selected at distance three', async () => {
      // Arrange
      const { counted } = await arrange();

      // Act
      const result = await describeCmd(counted);

      // Assert
      expect(result.name).toBe('near');
      expect(result.distance).toBe(3);
    });

    it('Then the walk stops at the covered last path instead of reading the whole chain', async () => {
      // Arrange
      const { counted, reads } = await arrange();

      // Act
      await describeCmd(counted);

      // Assert
      expect(reads()).toBe(7);
    });
  });
});

describe('Given only a lightweight tag on a deep chain in tags mode', () => {
  describe('When describing HEAD', () => {
    it('Then no annotated candidate exists so the walk reads the full chain', async () => {
      // Arrange
      const ctx = await seed();
      const oids: ObjectId[] = [];
      for (let i = 0; i < 10; i += 1) {
        oids.push(await commitFile(ctx, `l${i}`));
      }
      await tagCreate(ctx, { name: 'light', target: oids[6] as ObjectId });
      await tagCreate(ctx, { name: 'light-deep', target: oids[0] as ObjectId });
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const result = await describeCmd(counted, undefined, { tags: true });

      // Assert
      expect(result.name).toBe('light');
      expect(result.distance).toBe(3);
      expect(reads()).toBe(13);
    });
  });
});

describe('Given two annotated tags tied on sibling legs above a deep ancestry', () => {
  describe('When describing the merge of both legs', () => {
    it('Then the finalisation stops once the last path is covered by the winner', async () => {
      // Arrange
      const ctx = await seed();
      for (let i = 0; i < 5; i += 1) {
        await commitFile(ctx, `deep${i}`);
      }
      const base = await commitFile(ctx, 'base');
      const tree = await treeOf(ctx, base);
      const x = await writeCommit(ctx, tree, [base], 'x');
      const y = await writeCommit(ctx, tree, [base], 'y');
      const m = await writeCommit(ctx, tree, [x, y], 'm');
      clock += 60;
      await annotatedTag(ctx, 'tx', x, clock);
      clock += 60;
      await annotatedTag(ctx, 'ty', y, clock);
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const result = await describeCmd(counted, m);

      // Assert
      expect(result.name).toBe('ty');
      expect(result.distance).toBe(2);
      expect(reads()).toBe(8);
    });
  });
});

describe('Given a frozen winner whose coverage reaches the frontier only later', () => {
  describe('When describing the merge of a tagged leg and an untagged leg', () => {
    it('Then the finalisation walks past the uncovered frontier and stops once it is covered', async () => {
      // Arrange
      const ctx = await seed();
      for (let i = 0; i < 5; i += 1) {
        await commitFile(ctx, `deep${i}`);
      }
      const base = await commitFile(ctx, 'base');
      const tree = await treeOf(ctx, base);
      const side = await writeCommit(ctx, tree, [base], 'side');
      const x = await writeCommit(ctx, tree, [base], 'x');
      const m = await writeCommit(ctx, tree, [x, side], 'm');
      clock += 60;
      await annotatedTag(ctx, 'tx', x, clock);
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const result = await describeCmd(counted, m);

      // Assert
      expect(result.name).toBe('tx');
      expect(result.distance).toBe(2);
      expect(reads()).toBe(6);
    });
  });
});

describe('Given an annotated tag on a side leg that does not cover the deeper chain', () => {
  describe('When describing the merge of both legs', () => {
    it('Then the collection keeps walking past frontier-empty pops the tag does not cover', async () => {
      // Arrange
      const ctx = await seed();
      const root = await commitFile(ctx, 'root');
      const tree = await treeOf(ctx, root);
      const x1 = await writeCommit(ctx, tree, [root], 'x1');
      const x2 = await writeCommit(ctx, tree, [x1], 'x2');
      const y = await writeCommit(ctx, tree, [root], 'y');
      const m = await writeCommit(ctx, tree, [x2, y], 'm');
      clock += 60;
      await annotatedTag(ctx, 'ty', y, clock);
      clock += 60;
      await annotatedTag(ctx, 't-root', root, clock);
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const result = await describeCmd(counted, m);

      // Assert
      expect(result.name).toBe('ty');
      expect(result.distance).toBe(3);
      expect(reads()).toBe(9);
    });
  });
});

describe('Given a merged orphan history whose nearest-so-far tag does not cover the last path', () => {
  describe('When describing the merge commit', () => {
    it('Then the freeze elects the first-found tag and finalises its depth across the orphan side', async () => {
      // Arrange
      const ctx = await seed();
      const rb0 = await commitFile(ctx, 'rb0');
      const tree = await treeOf(ctx, rb0);
      const rb1 = await writeCommit(ctx, tree, [rb0], 'rb1');
      const rb2 = await writeCommit(ctx, tree, [rb1], 'rb2');
      const a0 = await writeCommit(ctx, tree, [], 'a0');
      const a1 = await writeCommit(ctx, tree, [a0], 'a1');
      const a2 = await writeCommit(ctx, tree, [a1], 'a2');
      const m = await writeCommit(ctx, tree, [a2, rb2], 'm');
      clock += 60;
      await annotatedTag(ctx, 'ta', a1, clock);
      clock += 60;
      await annotatedTag(ctx, 'tb', rb2, clock);

      // Act
      const result = await describeCmd(ctx, m);

      // Assert
      expect(result.name).toBe('ta');
      expect(result.distance).toBe(5);
    });
  });
});

describe('Given a lightweight tag defers the freeze while an uncovered orphan tail trails the tag', () => {
  describe('When describing the merge of the annotated leg and the orphan tail', () => {
    it('Then every uncovered orphan commit counts toward the distance', async () => {
      // Arrange — `light` lifts the name count to 2 so the single annotated
      // candidate never freezes; the collection walk therefore runs on past the
      // annotated `ta` down the uncovered orphan tail o2->o1->o0, whose commits
      // must each advance the distance. `ta` is newer than the orphan tail so it
      // registers before the tail is popped.
      const ctx = await seed();
      const base = await commitFile(ctx, 'base');
      const tree = await treeOf(ctx, base);
      const o0 = await writeCommit(ctx, tree, [], 'o0');
      const o1 = await writeCommit(ctx, tree, [o0], 'o1');
      const o2 = await writeCommit(ctx, tree, [o1], 'o2');
      await tagCreate(ctx, { name: 'light', target: o0 });
      const a1 = await writeCommit(ctx, tree, [], 'a1');
      await annotatedTag(ctx, 'ta', a1, clock);
      const merge = await writeCommit(ctx, tree, [a1, o2], 'merge');

      // Act
      const result = await describeCmd(ctx, merge);

      // Assert — ta..merge = { merge, o2, o1, o0 } = 4.
      expect(result.name).toBe('ta');
      expect(result.distance).toBe(4);
    });
  });
});

describe('Given a covered base is popped while an uncovered leg is still queued', () => {
  describe('When describing the merge of the tagged leg and the uncovered leg', () => {
    it('Then the uncovered leg still counts toward the winner distance', async () => {
      // Arrange — the covered region (baseC, W) is newer than the uncovered leg
      // u2->u1->u0, so it drains first; when the covered baseC is popped the
      // uncovered u2 is the sole queued commit. Reaching a covered pop must not
      // stop the finalisation while an uncovered commit remains reachable.
      const ctx = await seed();
      const seedC = await commitFile(ctx, 'seedC');
      const tree = await treeOf(ctx, seedC);
      const u0 = await writeCommit(ctx, tree, [], 'u0');
      const u1 = await writeCommit(ctx, tree, [u0], 'u1');
      const u2 = await writeCommit(ctx, tree, [u1], 'u2');
      const baseC = await writeCommit(ctx, tree, [], 'baseC');
      const w = await writeCommit(ctx, tree, [baseC], 'w');
      await annotatedTag(ctx, 'w', w, clock);
      const merge = await writeCommit(ctx, tree, [w, u2], 'merge');

      // Act
      const result = await describeCmd(ctx, merge);

      // Assert — w..merge = { merge, u2, u1, u0 } = 4.
      expect(result.name).toBe('w');
      expect(result.distance).toBe(4);
    });
  });
});

describe('Given two equal-depth tags whose winner leg is popped while the rival leg is still queued', () => {
  describe('When describing the merge that reaches the winner leg and the rival leg', () => {
    it('Then the rival-tag commits still count toward the winner distance', async () => {
      // Arrange — two tags tie at depth 4; the newer `win` (met first in date
      // order) takes the tie. During finalisation the walk pops `win`'s covered
      // commits while the rival `lose` leg — reachable from the merge but not
      // from `win` — is still queued with its own reach marks. The finalisation
      // break must not fire on a covered pop merely because every queued commit
      // is a rival-only commit; each rival commit must advance the distance.
      const ctx = await seed();
      const root = await commitFile(ctx, 'root');
      const tree = await treeOf(ctx, root);
      const b1 = await writeCommit(ctx, tree, [root], 'b1');
      const b2 = await writeCommit(ctx, tree, [root], 'b2');
      const loseTip = await writeCommit(ctx, tree, [b1], 'loseTip');
      const winTip = await writeCommit(ctx, tree, [b2], 'winTip');
      await annotatedTag(ctx, 'lose', loseTip, clock);
      await annotatedTag(ctx, 'win', winTip, clock);
      await writeCommit(ctx, tree, [b1, loseTip], 'dangling');
      const inner = await writeCommit(ctx, tree, [b1, winTip], 'inner');
      const head = await writeCommit(ctx, tree, [inner, loseTip], 'head');

      // Act
      const result = await describeCmd(ctx, head);

      // Assert — win..head = { head, inner, loseTip, b1 } = 4; an early
      // finalisation break would drop the rival leg and report 3.
      expect(result.name).toBe('win');
      expect(result.distance).toBe(4);
    });
  });
});

describe('Given no names and a deep history to walk', () => {
  describe('When describe refuses', () => {
    it('Then it bails without walking the history', async () => {
      // Arrange — no tags, so the candidate set freezes empty on the first step.
      const ctx = await seed();
      for (let i = 0; i < 8; i += 1) {
        await commitFile(ctx, `n${i}`);
      }
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const error = await catchError(() => describeCmd(counted));

      // Assert — the empty freeze stops immediately; it never descends the chain.
      expect(error.data).toMatchObject({ code: 'NO_NAMES' });
      expect(reads()).toBe(2);
    });
  });
});

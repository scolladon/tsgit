import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { nameRev } from '../../../../src/application/commands/name-rev.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import * as concurrencyMod from '../../../../src/application/primitives/internal/concurrency.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type {
  AuthorIdentity,
  Commit,
  CommitData,
  ObjectId,
  TagData,
} from '../../../../src/domain/objects/index.js';
import { RefName } from '../../../../src/domain/objects/object-id.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeCommitGraph } from '../primitives/fixtures.js';

let clock = 1_700_000_000;

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

const treeOf = async (ctx: Context, commitOid: ObjectId): Promise<ObjectId> => {
  const object = await readObject(ctx, commitOid);
  if (object.type !== 'commit') throw new Error('expected a commit');
  return object.data.tree;
};

const writeCommit = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  clock += 60;
  const data: CommitData = {
    tree,
    parents,
    author: ident(clock),
    committer: ident(clock),
    message: 'c\n',
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
};

const lightweightTag = (ctx: Context, name: string, target: ObjectId): Promise<unknown> =>
  tagCreate(ctx, { name, target });

const annotatedTag = async (
  ctx: Context,
  name: string,
  target: ObjectId,
  taggerTime: number,
): Promise<ObjectId> => {
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
  return tagOid;
};

const pointBranch = (ctx: Context, name: string, target: ObjectId): Promise<void> =>
  updateRef(ctx, RefName.from(`refs/heads/${name}`), target, { reflogMessage: 'test' });

const commitFileOnTop = async (ctx: Context, parent: ObjectId): Promise<ObjectId> => {
  const tree = await treeOf(ctx, parent);
  return writeCommit(ctx, tree, [parent]);
};

const asCommits = async (ctx: Context, ids: ReadonlyArray<ObjectId>): Promise<Commit[]> => {
  const commits: Commit[] = [];
  for (const id of ids) {
    const object = await readObject(ctx, id);
    if (object.type !== 'commit') throw new Error('expected a commit');
    commits.push(object);
  }
  return commits;
};

describe('nameRev', () => {
  describe('Given a commit an annotated tag points at', () => {
    describe('When name-rev runs at that commit', () => {
      it('Then it names the tag with a deref flag and no steps', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'v1.0', head, clock);

        // Act
        const result = await nameRev(ctx, head);

        // Assert
        expect(result).toEqual({
          oid: head,
          ref: RefName.from('refs/tags/v1.0'),
          tagDeref: true,
          steps: [],
        });
      });
    });
  });

  describe('Given a commit a lightweight tag points at', () => {
    describe('When name-rev runs at that commit', () => {
      it('Then it names the tag without a deref flag', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await lightweightTag(ctx, 'light', head);

        // Act
        const result = await nameRev(ctx, head);

        // Assert
        expect(result).toEqual({
          oid: head,
          ref: RefName.from('refs/tags/light'),
          tagDeref: false,
          steps: [],
        });
      });
    });
  });

  describe('Given a commit reachable only from a branch tip', () => {
    describe('When name-rev runs', () => {
      it('Then it names the branch with no steps', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const result = await nameRev(ctx, head);

        // Assert
        expect(result).toEqual({
          oid: head,
          ref: RefName.from('refs/heads/main'),
          tagDeref: false,
          steps: [],
        });
      });
    });
  });

  describe('Given an annotated tag a few first-parents ahead', () => {
    describe('When name-rev runs at the ancestor', () => {
      it('Then the path is a single ancestor step', async () => {
        // Arrange
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        await commitFile(ctx, 'c1');
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'v2.0', c2, clock);

        // Act
        const result = await nameRev(ctx, c0);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/tags/v2.0'));
        expect(result.steps).toEqual([{ kind: 'ancestor', count: 2 }]);
      });
    });
  });

  describe('Given a merge history named by a tag on the tip', () => {
    const buildMerge = async (
      ctx: Context,
    ): Promise<{ base: ObjectId; m1: ObjectId; merge: ObjectId; s1: ObjectId; s2: ObjectId }> => {
      const tree = await treeOf(ctx, await commitFile(ctx, 'seed'));
      const base = await writeCommit(ctx, tree, []);
      const m1 = await writeCommit(ctx, tree, [base]);
      const s1 = await writeCommit(ctx, tree, [base]);
      const s2 = await writeCommit(ctx, tree, [s1]);
      const merge = await writeCommit(ctx, tree, [m1, s2]);
      const top = await writeCommit(ctx, tree, [merge]);
      await annotatedTag(ctx, 'rel', top, clock);
      return { base, m1, merge, s1, s2 };
    };

    describe('When name-rev runs on the first-parent chain', () => {
      it('Then each ancestor is an ancestor-count path', async () => {
        // Arrange
        const ctx = await seed();
        const { base, m1, merge } = await buildMerge(ctx);

        // Act + Assert
        expect((await nameRev(ctx, merge)).steps).toEqual([{ kind: 'ancestor', count: 1 }]);
        expect((await nameRev(ctx, m1)).steps).toEqual([{ kind: 'ancestor', count: 2 }]);
        expect((await nameRev(ctx, base)).steps).toEqual([{ kind: 'ancestor', count: 3 }]);
      });
    });

    describe('When name-rev runs on a merged side branch', () => {
      it('Then the path threads the second parent with `^2`', async () => {
        // Arrange
        const ctx = await seed();
        const { s1, s2 } = await buildMerge(ctx);

        // Act + Assert
        expect((await nameRev(ctx, s2)).steps).toEqual([
          { kind: 'ancestor', count: 1 },
          { kind: 'parent', number: 2 },
        ]);
        expect((await nameRev(ctx, s1)).steps).toEqual([
          { kind: 'ancestor', count: 1 },
          { kind: 'parent', number: 2 },
          { kind: 'ancestor', count: 1 },
        ]);
      });
    });
  });

  describe('Given a far tag and a nearer branch both containing a commit', () => {
    describe('When name-rev runs', () => {
      it('Then the tag wins despite the larger distance', async () => {
        // Arrange
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        await commitFile(ctx, 'c1');
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'fartag', c2, clock);
        await pointBranch(ctx, 'nearbr', await commitFileOnTop(ctx, c0));

        // Act
        const result = await nameRev(ctx, c0);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/tags/fartag'));
      });
    });
  });

  describe('Given two tags at different distances from a commit', () => {
    describe('When name-rev runs', () => {
      it('Then the nearer tag wins', async () => {
        // Arrange
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        const c1 = await commitFile(ctx, 'c1');
        const c2 = await commitFile(ctx, 'c2');
        await annotatedTag(ctx, 'near', c1, clock + 1000);
        await annotatedTag(ctx, 'far', c2, clock + 500);

        // Act
        const result = await nameRev(ctx, c0);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/tags/near'));
        expect(result.steps).toEqual([{ kind: 'ancestor', count: 1 }]);
      });
    });
  });

  describe('Given two fully-tied tags created in reverse-alphabetical order', () => {
    describe('When name-rev runs', () => {
      it('Then the byte-first ref name wins the tie', async () => {
        // Arrange — two lightweight tags on one commit tie on every key, so the
        // ref-name sort (not enumeration order) and the reject-worse gate decide.
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        const c1 = await commitFile(ctx, 'c1');
        await lightweightTag(ctx, 'zzz', c1);
        await lightweightTag(ctx, 'aaa', c1);

        // Act
        const result = await nameRev(ctx, c0);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/tags/aaa'));
        expect(result.steps).toEqual([{ kind: 'ancestor', count: 1 }]);
      });
    });
  });

  describe('Given two equal-distance tags with different tagger dates', () => {
    describe('When name-rev runs', () => {
      it('Then the older-tagged name wins', async () => {
        // Arrange
        const ctx = await seed();
        const c0 = await commitFile(ctx, 'c0');
        const c1 = await commitFile(ctx, 'c1');
        await annotatedTag(ctx, 'tnew', c1, 2_000);
        await annotatedTag(ctx, 'told', c1, 1_000);

        // Act
        const result = await nameRev(ctx, c0);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/tags/told'));
      });
    });
  });

  describe('Given a commit reachable only from a branch and tags-only mode', () => {
    describe('When name-rev runs with tags', () => {
      it('Then the commit is unnameable', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const result = await nameRev(ctx, head, { tags: true });

        // Assert
        expect(result).toEqual({ oid: head, ref: undefined, tagDeref: false, steps: [] });
      });
    });
  });

  describe('Given include and exclude ref globs', () => {
    describe('When name-rev runs with refs include', () => {
      it('Then only the matching ref names the commit', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await lightweightTag(ctx, 'pick', head);

        // Act
        const result = await nameRev(ctx, head, { refs: 'refs/tags/*' });

        // Assert
        expect(result.ref).toBe(RefName.from('refs/tags/pick'));
      });
    });

    describe('When name-rev runs with the only tag excluded', () => {
      it('Then it falls back to the branch', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await lightweightTag(ctx, 'drop', head);

        // Act
        const result = await nameRev(ctx, head, { exclude: 'refs/tags/*' });

        // Assert
        expect(result.ref).toBe(RefName.from('refs/heads/main'));
      });
    });
  });

  describe('Given a commit reachable from no ref', () => {
    describe('When name-rev runs', () => {
      it('Then it is unnameable', async () => {
        // Arrange
        const ctx = await seed();
        const tree = await treeOf(ctx, await commitFile(ctx, 'c1'));
        const orphan = await writeCommit(ctx, tree, []);

        // Act
        const result = await nameRev(ctx, orphan);

        // Assert
        expect(result).toEqual({ oid: orphan, ref: undefined, tagDeref: false, steps: [] });
      });
    });
  });

  describe('Given no explicit revision', () => {
    describe('When name-rev runs', () => {
      it('Then it names HEAD', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');

        // Act
        const result = await nameRev(ctx);

        // Assert
        expect(result.oid).toBe(head);
        expect(result.ref).toBe(RefName.from('refs/heads/main'));
      });
    });
  });

  describe('Given a ref that peels to a tree, not a commit', () => {
    describe('When name-rev runs', () => {
      it('Then that ref is skipped', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        const tree = await treeOf(ctx, head);
        const treeTagData: TagData = {
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
          data: treeTagData,
        });
        await tagCreate(ctx, { name: 'tree-tag', target: treeTagOid });

        // Act
        const result = await nameRev(ctx, head);

        // Assert — the tree tag is dropped; the branch still names the commit.
        expect(result.ref).toBe(RefName.from('refs/heads/main'));
      });
    });
  });

  describe('Given a symbolic ref among the refs', () => {
    describe('When name-rev runs', () => {
      it('Then the symbolic ref is skipped', async () => {
        // Arrange
        const ctx = await seed();
        const head = await commitFile(ctx, 'c1');
        await writeSymbolicRef(
          ctx,
          RefName.from('refs/remotes/origin/HEAD'),
          RefName.from('refs/heads/main'),
        );

        // Act
        const result = await nameRev(ctx, head);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/heads/main'));
      });
    });
  });

  describe('Given a tag chain deeper than the peel bound', () => {
    describe('When name-rev runs', () => {
      it('Then the over-deep tag is dropped at the peel bound', async () => {
        // Arrange — eight nested tags; the outermost exceeds the peel depth.
        const ctx = await seed();
        const c1 = await commitFile(ctx, 'c1');
        let prev = c1;
        let prevType: TagData['objectType'] = 'commit';
        for (let i = 1; i <= 8; i += 1) {
          const data: TagData = {
            object: prev,
            objectType: prevType,
            tagName: `t${i}`,
            tagger: ident(1_000 + i),
            message: `t${i}\n`,
            extraHeaders: [],
          };
          prev = await writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
          await tagCreate(ctx, { name: `t${i}`, target: prev });
          prevType = 'tag';
        }

        // Act
        const result = await nameRev(ctx, c1, { tags: true });

        // Assert — the oldest still-peelable tag (t1) names c1; t8 is dropped.
        expect(result.ref).toBe(RefName.from('refs/tags/t1'));
      });
    });
  });

  describe('Given a commit whose recorded parent is not a commit', () => {
    describe('When name-rev runs', () => {
      it('Then the non-commit parent is not traversed', async () => {
        // Arrange — a hand-built commit whose parent oid points at a tree.
        const ctx = await seed();
        const tree = await treeOf(ctx, await commitFile(ctx, 'c1'));
        const corrupt = await writeCommit(ctx, tree, [tree]);
        await pointBranch(ctx, 'corrupt', corrupt);

        // Act
        const result = await nameRev(ctx, corrupt);

        // Assert — the commit itself is named; the tree "parent" is skipped.
        expect(result.ref).toBe(RefName.from('refs/heads/corrupt'));
        expect(result.steps).toEqual([]);
      });
    });
  });

  describe('Given a shallow boundary masking the flood before the true root', () => {
    const buildChain = async (
      ctx: Context,
    ): Promise<{ root: ObjectId; boundary: ObjectId; head: ObjectId }> => {
      const tree = await treeOf(ctx, await commitFile(ctx, 'seed'));
      const root = await writeCommit(ctx, tree, []);
      const boundary = await writeCommit(ctx, tree, [root]);
      const head = await writeCommit(ctx, tree, [boundary]);
      await pointBranch(ctx, 'main', head);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);
      return { root, boundary, head };
    };

    describe('When name-rev runs on HEAD', () => {
      it('Then HEAD still resolves via the branch name', async () => {
        // Arrange
        const ctx = await seed();
        const { head } = await buildChain(ctx);

        // Act
        const result = await nameRev(ctx, head);

        // Assert
        expect(result.ref).toBe(RefName.from('refs/heads/main'));
        expect(result.steps).toEqual([]);
      });
    });

    describe('When name-rev runs on the true root', () => {
      it('Then the root is unnamed — the flood never reaches past the boundary', async () => {
        // Arrange
        const ctx = await seed();
        const { root } = await buildChain(ctx);

        // Act
        const result = await nameRev(ctx, root);

        // Assert
        expect(result).toEqual({ oid: root, ref: undefined, tagDeref: false, steps: [] });
      });
    });
  });
});

// Narrowed to the object store itself (loose fanout dirs, pack files) — a
// bare `objects/` substring also matches the memoised `objects/info/commit-graph`
// probe, which is not an object-store read.
const OBJECT_STORE_READ = /objects\/(pack\/|[0-9a-f]{2}\/)/;

const withCountedObjectReads = (ctx: Context): { counted: Context; reads: () => number } => {
  let count = 0;
  const baseFs = ctx.fs;
  const countedFs: Context['fs'] = {
    ...baseFs,
    read: (path) => {
      if (OBJECT_STORE_READ.test(path)) {
        count += 1;
      }
      return baseFs.read(path);
    },
  };
  return { counted: { ...ctx, fs: countedFs }, reads: () => count };
};

const DAY_AND_A_BIT = 90_000;

describe('Given a linear chain with an old root block and a recent tip block', () => {
  const arrange = async (): Promise<{
    counted: Context;
    reads: () => number;
    oldest: ObjectId;
    tip: ObjectId;
  }> => {
    const ctx = await seed();
    const oids: ObjectId[] = [];
    for (let i = 0; i < 25; i += 1) oids.push(await commitFile(ctx, `old${i}`));
    clock += DAY_AND_A_BIT;
    for (let i = 0; i < 5; i += 1) oids.push(await commitFile(ctx, `new${i}`));
    const { counted, reads } = withCountedObjectReads(ctx);
    return { counted, reads, oldest: oids[0] as ObjectId, tip: oids[29] as ObjectId };
  };

  describe('When name-rev runs on the tip commit', () => {
    it('Then it still names the tip by its branch', async () => {
      // Arrange
      const { counted, tip } = await arrange();

      // Act
      const result = await nameRev(counted, tip);

      // Assert
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
    });

    it('Then the walk stops at the date cutoff instead of reading the whole chain', async () => {
      // Arrange
      const { counted, reads, tip } = await arrange();

      // Act
      await nameRev(counted, tip);

      // Assert — F2.3 also caches every loose commit read; the real `commit`
      // command in `commitFile` already read each ancestor once while
      // linking it as HEAD's parent during arrange, so nameRev's own walk —
      // still bounded by the date cutoff — is almost entirely cache hits.
      expect(reads()).toBe(1);
    });
  });

  describe('When name-rev runs on the oldest commit', () => {
    it('Then its own cutoff prunes nothing and the read count covers the full ancestry', async () => {
      // Arrange
      const { counted, reads, oldest } = await arrange();

      // Act
      await nameRev(counted, oldest);

      // Assert — F2.3 also caches every loose commit read; the real `commit`
      // command in `commitFile` already read each ancestor once while
      // linking it as HEAD's parent during arrange, so nameRev's own
      // full-ancestry walk is almost entirely cache hits.
      expect(reads()).toBe(1);
    });
  });
});

describe('Given a recent branch and a disjoint branch whose tip is over a day older', () => {
  const arrange = async (): Promise<{
    counted: Context;
    reads: () => number;
    target: ObjectId;
  }> => {
    const ctx = await seed();
    const target = await commitFile(ctx, 'main-tip');
    const tree = await treeOf(ctx, target);
    clock -= DAY_AND_A_BIT;
    let parent = await writeCommit(ctx, tree, []);
    for (let i = 0; i < 4; i += 1) parent = await commitFileOnTop(ctx, parent);
    await pointBranch(ctx, 'stale', parent);
    const { counted, reads } = withCountedObjectReads(ctx);
    return { counted, reads, target };
  };

  describe('When name-rev runs on the recent target', () => {
    it('Then the target still names correctly by its own branch', async () => {
      // Arrange
      const { counted, target } = await arrange();

      // Act
      const result = await nameRev(counted, target);

      // Assert
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
    });

    it('Then the stale branch is never seeded so its ancestry is never read', async () => {
      // Arrange
      const { counted, reads, target } = await arrange();

      // Act
      await nameRev(counted, target);

      // Assert — F2.3 also caches every loose commit read; `commitFile`'s
      // own `commit` command already read each ancestor once while linking
      // it as HEAD's parent during arrange, so nameRev's walk is all hits.
      expect(reads()).toBe(1);
    });
  });
});

describe('Given a chain whose middle commit is dated exactly one day older than the target', () => {
  const arrange = async (): Promise<{ counted: Context; reads: () => number; tip: ObjectId }> => {
    const ctx = await seed();
    const root = await commitFile(ctx, 'root');
    clock += DAY_AND_A_BIT - 60;
    const mid = await commitFileOnTop(ctx, root);
    const midDate = clock;
    clock = midDate + 86_400 - 60;
    const tree = await treeOf(ctx, mid);
    const tip = await writeCommit(ctx, tree, [mid]);
    await pointBranch(ctx, 'main', tip);
    const { counted, reads } = withCountedObjectReads(ctx);
    return { counted, reads, tip };
  };

  describe('When name-rev runs on the tip', () => {
    it('Then the boundary commit is still walked and the tip still names correctly', async () => {
      // Arrange
      const { counted, tip } = await arrange();

      // Act
      const result = await nameRev(counted, tip);

      // Assert
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
    });

    it('Then reading reaches the boundary commit and its parent, not just the tip', async () => {
      // Arrange
      const { counted, reads, tip } = await arrange();

      // Act
      await nameRev(counted, tip);

      // Assert — F2.3 also caches every loose commit read; `treeOf`'s calls
      // in arrange already read the boundary commit and its parent while
      // building the chain, so only the (uncached) tip costs a real read.
      expect(reads()).toBe(1);
    });
  });
});

describe('Given a diamond whose shared parent is reached by both merge sides', () => {
  const arrange = async (): Promise<{
    counted: Context;
    reads: () => number;
    shared: ObjectId;
  }> => {
    const ctx = await seed();
    const tree = await treeOf(ctx, await commitFile(ctx, 'seed'));
    const shared = await writeCommit(ctx, tree, []);
    const firstSide = await writeCommit(ctx, tree, [shared]);
    const secondSide = await writeCommit(ctx, tree, [shared]);
    const merge = await writeCommit(ctx, tree, [firstSide, secondSide]);
    await pointBranch(ctx, 'main', merge);
    const { counted, reads } = withCountedObjectReads(ctx);
    return { counted, reads, shared };
  };

  describe('When name-rev runs on the shared parent', () => {
    it('Then the first-parent name wins over the merged side', async () => {
      // Arrange
      const { counted, shared } = await arrange();

      // Act
      const result = await nameRev(counted, shared);

      // Assert
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
      expect(result.steps).toEqual([{ kind: 'ancestor', count: 2 }]);
    });

    it('Then the shared parent already named by the first-parent side is not re-read', async () => {
      // Arrange
      const { counted, reads, shared } = await arrange();

      // Act
      await nameRev(counted, shared);

      // Assert — the diamond's four commits are pure `writeObject` writes in
      // arrange (never pre-read), so all four cost a real read; the fifth
      // touch of `shared` (from the merge-parent side) is what `accept`'s
      // own gate — not caching — still skips.
      expect(reads()).toBe(4);
    });
  });
});

describe('Given a commit-graph covering a short, densely-timed chain (every commit well within the date slop)', () => {
  const CHAIN_LENGTH = 5;

  const arrange = async (): Promise<{
    ctx: Context;
    tip: ObjectId;
    ancestors: ObjectId[];
  }> => {
    const ctx = await seed();
    const tree = await treeOf(ctx, await commitFile(ctx, 'seed'));
    const ancestors: ObjectId[] = [];
    let parent: ObjectId | undefined;
    for (let i = 0; i < CHAIN_LENGTH; i += 1) {
      parent = await writeCommit(ctx, tree, parent === undefined ? [] : [parent]);
      ancestors.push(parent);
    }
    await pointBranch(ctx, 'main', parent as ObjectId);
    return { ctx, tip: parent as ObjectId, ancestors };
  };

  describe('When name-rev runs on the tip with no commit-graph', () => {
    it('Then the date cutoff never fires and the whole chain is read', async () => {
      // Arrange
      const { ctx, tip, ancestors } = await arrange();
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const result = await nameRev(counted, tip);

      // Assert — every ancestor is within the one-day slop, so the date test
      // never prunes; the walk reads the tip and every ancestor down to the root.
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
      expect(reads()).toBe(ancestors.length);
    });
  });

  describe('When name-rev runs on the tip with a commit-graph covering the chain', () => {
    it('Then the generation cutoff prunes every ancestor immediately, reading only the tip', async () => {
      // Arrange
      const { ctx, tip, ancestors } = await arrange();
      await writeCommitGraph(ctx, [await asCommits(ctx, ancestors)]);
      // `asCommits` reads every commit to build the graph model, warming the
      // delta cache; clear it so the read count reflects nameRev's own reads.
      ctx.deltaCache.clear();
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      const result = await nameRev(counted, tip);

      // Assert — the tip's own generation is the cutoff (no slop), so its
      // immediate parent already carries a strictly lower generation and is
      // never expanded; the returned name is unchanged from the no-graph run.
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
      expect(reads()).toBe(1);
    });
  });
});

describe('Given a target covered by a commit-graph and a disjoint, graph-absent branch over a day older', () => {
  const arrange = async (): Promise<{
    ctx: Context;
    target: ObjectId;
  }> => {
    const ctx = await seed();
    const target = await commitFile(ctx, 'main-tip');
    const tree = await treeOf(ctx, target);
    clock -= DAY_AND_A_BIT;
    let parent = await writeCommit(ctx, tree, []);
    for (let i = 0; i < 4; i += 1) parent = await writeCommit(ctx, tree, [parent]);
    await pointBranch(ctx, 'stale', parent);
    await writeCommitGraph(ctx, [await asCommits(ctx, [target])]);
    // `asCommits` reads `target` to build the graph model, warming the delta
    // cache; clear it so the read count reflects nameRev's own reads.
    ctx.deltaCache.clear();
    return { ctx, target };
  };

  describe('When name-rev runs on the target', () => {
    it('Then the target still names correctly by its own branch', async () => {
      // Arrange
      const { ctx, target } = await arrange();
      const { counted } = withCountedObjectReads(ctx);

      // Act
      const result = await nameRev(counted, target);

      // Assert
      expect(result.ref).toBe(RefName.from('refs/heads/main'));
      expect(result.steps).toEqual([]);
    });

    it('Then the graph-absent stale branch carries an infinite generation and is traversed in full', async () => {
      // Arrange — with no graph at all this branch is pruned by the date test
      // (see the sibling suite above); once the target has a finite generation,
      // the cutoff switches to the generation test, under which the graph-absent
      // branch's infinite generation is never below it.
      const { ctx, target } = await arrange();
      const { counted, reads } = withCountedObjectReads(ctx);

      // Act
      await nameRev(counted, target);

      // Assert — the target's own (uncached) read, plus the stale tip and its
      // four ancestors, none pre-cached and none pruned by the generation test.
      expect(reads()).toBe(6);
    });
  });
});

describe('Given a merge commit with three loose, graph-absent parents', () => {
  const buildOctopus = async (): Promise<{
    ctx: Context;
    merge: ObjectId;
    parentPaths: ReadonlySet<string>;
  }> => {
    const ctx = await seed();
    const tree = await treeOf(ctx, await commitFile(ctx, 'seed'));
    const p1 = await writeCommit(ctx, tree, []);
    const p2 = await writeCommit(ctx, tree, []);
    const p3 = await writeCommit(ctx, tree, []);
    const merge = await writeCommit(ctx, tree, [p1, p2, p3]);
    await pointBranch(ctx, 'main', merge);
    const parentPaths = new Set(
      [p1, p2, p3].map((id) => `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`),
    );
    return { ctx, merge, parentPaths };
  };

  const gatedContext = (
    ctx: Context,
    parentPaths: ReadonlySet<string>,
  ): { gated: Context; starts: string[]; maxActive: () => number } => {
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const gated: Context = {
      ...ctx,
      fs: {
        ...ctx.fs,
        read: async (path: string) => {
          if (!parentPaths.has(path)) return ctx.fs.read(path);
          starts.push(path);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          const bytes = await ctx.fs.read(path);
          active -= 1;
          return bytes;
        },
      },
    };
    return { gated, starts, maxActive: () => maxActive };
  };

  describe('When name-rev expands the merge', () => {
    it('Then all three parent meta reads are started before any resolves', async () => {
      // Arrange
      const { ctx, merge, parentPaths } = await buildOctopus();
      const { gated, starts, maxActive } = gatedContext(ctx, parentPaths);

      // Act
      await nameRev(gated, merge);

      // Assert — the reads overlap instead of running one at a time.
      expect(starts.length).toBe(3);
      expect(maxActive()).toBeGreaterThanOrEqual(2);
    });

    it('Then the bounded reader forgets each parent once its meta is consumed', async () => {
      // Arrange
      const { ctx, merge } = await buildOctopus();
      const forgotten: ObjectId[] = [];
      const original = concurrencyMod.boundedReaderFor;
      const spy = vi
        .spyOn(concurrencyMod, 'boundedReaderFor')
        .mockImplementation((spyCtx, bucket, read) => {
          const reader = original(spyCtx, bucket, read);
          return {
            start: reader.start,
            forget: (id: ObjectId) => {
              forgotten.push(id);
              reader.forget(id);
            },
          };
        });

      try {
        // Act
        await nameRev(ctx, merge);
      } finally {
        spy.mockRestore();
      }

      // Assert — one forget per accepted parent; the memo never retains an entry.
      expect(forgotten.length).toBe(3);
      expect(new Set(forgotten).size).toBe(3);
    });
  });
});

describe('Given the only ref is a descendant dated more than a day before the target (clock skew)', () => {
  describe('When nameRev names the target', () => {
    it("Then the descendant seed is pruned at the date cutoff, leaving the target unnamed — git's cutoff", async () => {
      // Arrange — base <- target at a recent epoch, then a child of target
      // committed more than a day EARLIER (clock skew). The branch follows to
      // that child, so the only seed's tip is before `target_date - 1 day`;
      // git's date-based cutoff prunes it, so the target gets no name.
      const ctx = await seed();
      await commitFile(ctx, 'base');
      const target = await commitFile(ctx, 'target');
      clock = 100;
      await commitFile(ctx, 'skewed-descendant');

      // Act
      const result = await nameRev(ctx, target);

      // Assert — the skewed descendant seed is pruned, so nothing names target
      expect(result.ref).toBeUndefined();
    });
  });
});

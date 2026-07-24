import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { log } from '../../../../src/application/commands/log.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId;

const seedThree = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content, message] of [
    ['a.txt', 'a', 'first'],
    ['b.txt', 'b', 'second'],
    ['c.txt', 'c', 'third'],
  ] as const) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
    await add(ctx, [path]);
    await commit(ctx, { message, author });
  }
  return ctx;
};

/**
 * Write a loose commit object with an exact committer timestamp. Used by the
 * `before` filter tests where each commit must sit at a distinct second so the
 * threshold comparison can be exercised precisely.
 */
const writeCommitAt = (
  ctx: Context,
  parents: ReadonlyArray<ObjectId>,
  timestamp: number,
  message: string,
): Promise<ObjectId> => {
  const identity: AuthorIdentity = {
    name: 'Ada',
    email: 'ada@example.com',
    timestamp,
    timezoneOffset: '+0000',
  };
  const data: CommitData = {
    tree: TREE_OID,
    parents: [...parents],
    author: identity,
    committer: identity,
    message,
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
};

/** Seed a 3-commit first-parent chain with distinct committer timestamps. */
const seedTimestampChain = async () => {
  const ctx = createMemoryContext();
  const c1 = await writeCommitAt(ctx, [], 1000, 'oldest');
  const c2 = await writeCommitAt(ctx, [c1], 2000, 'middle');
  const c3 = await writeCommitAt(ctx, [c2], 3000, 'newest');
  await seedRepo(ctx, { refs: { 'refs/heads/main': c3 } });
  return { ctx, c1, c2, c3 };
};

/**
 * Seed a diamond: base `A`, two branches `B`/`C` off `A`, merge `D` with parents
 * `[B, C]`. Strictly-increasing committer dates `a<b<c<d` make the date order
 * unambiguous and distinct from the first-parent spine (`D → B → A`).
 */
const seedDiamond = async () => {
  const ctx = createMemoryContext();
  const a = await writeCommitAt(ctx, [], 1000, 'A');
  const b = await writeCommitAt(ctx, [a], 2000, 'B');
  const c = await writeCommitAt(ctx, [a], 3000, 'C');
  const d = await writeCommitAt(ctx, [b, c], 4000, 'D');
  await seedRepo(ctx, { refs: { 'refs/heads/main': d } });
  return { ctx, a, b, c, d };
};

/** Write an annotated tag object pointing at a commit `target`. */
const writeAnnotatedTag = (ctx: Context, target: ObjectId, name: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: target,
      objectType: 'commit',
      tagName: name,
      message: 'tag',
      extraHeaders: [],
    },
  });

describe('log', () => {
  describe('Given three commits', () => {
    describe('When log', () => {
      it('Then returns them in newest-first order', async () => {
        // Arrange
        const ctx = await seedThree();

        // Act
        const sut = await log(ctx);

        // Assert
        expect(sut.map((e) => e.message)).toEqual(['third\n', 'second\n', 'first\n']);
      });
    });
  });

  describe('Given a diamond history (merge of two branches)', () => {
    describe('When log runs with the default order', () => {
      it('Then yields every parent newest-committer-date first', async () => {
        // Arrange
        const ctx = (await seedDiamond()).ctx;

        // Act
        const sut = await log(ctx);

        // Assert — all four commits, committer-date desc; a first-parent default
        // walk would drop `C` (it is off the first-parent spine).
        expect(sut.map((e) => e.message)).toEqual(['D', 'C', 'B', 'A']);
      });
    });

    describe("When log runs with order 'first-parent'", () => {
      it('Then follows only the first parent of the merge', async () => {
        // Arrange
        const ctx = (await seedDiamond()).ctx;

        // Act
        const sut = await log(ctx, { order: 'first-parent' });

        // Assert — `D → B` (parents[0]) → `A`; `C` is off the spine. The default
        // (date) walk would re-add `C`.
        expect(sut.map((e) => e.message)).toEqual(['D', 'B', 'A']);
      });
    });
  });

  describe('Given limit=2', () => {
    describe('When log', () => {
      it('Then yields exactly 2', async () => {
        // Arrange
        const ctx = await seedThree();

        // Act
        const sut = await log(ctx, { limit: 2 });

        // Assert
        expect(sut).toHaveLength(2);
      });
    });
  });

  describe('Given excluding contains the parent commit', () => {
    describe('When log', () => {
      it('Then commits up to (but not including) the parent are returned', async () => {
        // Arrange
        const ctx = await seedThree();
        const all = await log(ctx);
        // Exclude the oldest commit (its parents are []); only the newest two should remain.
        const oldest = all[all.length - 1] as { readonly id: string };

        // Act
        const sut = await log(ctx, { excluding: [oldest.id] });

        // Assert — the excluded commit is not yielded.
        expect(sut.find((e) => e.id === oldest.id)).toBeUndefined();
      });
    });
  });

  describe("Given rev='main' (ref name, not HEAD)", () => {
    describe('When log', () => {
      it('Then resolves the named branch', async () => {
        // Arrange
        const ctx = await seedThree();

        // Act
        const sut = await log(ctx, { rev: 'main' });

        // Assert — same shape as default HEAD-driven log; kills `rev === 'HEAD'` mutants.
        expect(sut.length).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe('Given rev is a 40-hex oid', () => {
    describe('When log', () => {
      it('Then walks from that oid directly (no ref lookup)', async () => {
        // Arrange
        const ctx = await seedThree();
        const all = await log(ctx);
        const oldest = all[all.length - 1] as { readonly id: string };

        // Act — walk from the oldest commit; should yield only itself.
        const sut = await log(ctx, { rev: oldest.id });

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.id).toBe(oldest.id);
      });
    });
  });

  describe('Given an unborn branch (no commits)', () => {
    describe('When log', () => {
      it('Then throws (HEAD ref is missing)', async () => {
        // Arrange — a fresh init produces an unborn `refs/heads/main`; HEAD points at it but the ref does not exist.
        const ctx = await seedThree();
        // Wipe the ref to simulate the unborn-branch state.
        await ctx.fs.rm(`${ctx.layout.gitDir}/refs/heads/main`);

        // Act
        let caught: unknown;
        try {
          await log(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — unborn HEAD still refuses; the grammar resolver reports
        // OBJECT_NOT_FOUND (consistent with show/readFileAt), not REF_NOT_FOUND.
        expect(caught).toBeInstanceOf(Error);
        const data = (caught as { data?: { code?: string } }).data;
        expect(data?.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given before strictly above the middle timestamp', () => {
    describe('When log', () => {
      it('Then only commits older than before are yielded', async () => {
        // Arrange — chain at 1000/2000/3000; threshold 2500s excludes the newest only.
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx, { before: new Date(2500 * 1000) });

        // Assert — kills ConditionalExpression true/false, BlockStatement{},
        // `>=`→`<` (which would yield only `newest`), and `/`→`*` (the huge
        // millisecond threshold would never exclude anything).
        expect(sut.map((e) => e.message)).toEqual(['middle', 'oldest']);
      });
    });
  });

  describe('Given before exactly equal to a commit timestamp', () => {
    describe('When log', () => {
      it('Then that commit is excluded (>= boundary)', async () => {
        // Arrange — threshold 2000s equals the `middle` commit's timestamp.
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx, { before: new Date(2000 * 1000) });

        // Assert — `>=` excludes the commit AT the boundary; `>` would keep it.
        expect(sut.map((e) => e.message)).toEqual(['oldest']);
      });
    });
  });

  describe('Given before is undefined', () => {
    describe('When log', () => {
      it('Then no commit is filtered out', async () => {
        // Arrange — exercises the `before !== undefined` guard short-circuit.
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx);

        // Assert
        expect(sut.map((e) => e.message)).toEqual(['newest', 'middle', 'oldest']);
      });
    });
  });

  describe('Given excluding is omitted', () => {
    describe('When log', () => {
      it('Then every commit is yielded (default empty exclusion)', async () => {
        // Arrange
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx);

        // Assert — the default `[]` excludes nothing.
        expect(sut).toHaveLength(3);
      });
    });
  });

  describe('Given rev is a branch name whose 40-hex suffix is hex', () => {
    describe('When log', () => {
      it('Then it resolves as a ref not an oid', async () => {
        // Arrange — branch name = 'r' + <40-hex>; the `^` anchor keeps this off the
        // oid fast-path. Dropping `^` (`/[0-9a-f]{40}$/`) would match the suffix and
        // return the 41-char string as an oid, making the walk fail.
        const ctx = createMemoryContext();
        const target = await writeCommitAt(ctx, [], 1000, 'target');
        const decoyOid = await writeCommitAt(ctx, [], 1500, 'decoy');
        const branchName = `r${decoyOid}`;
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': target, [`refs/heads/${branchName}`]: target },
        });

        // Act
        const sut = await log(ctx, { rev: branchName });

        // Assert — resolved via the branch ref; mutant would throw on a 41-char oid.
        expect(sut.map((e) => e.message)).toEqual(['target']);
      });
    });
  });

  describe('Given rev is a branch name whose 40-hex prefix is hex', () => {
    describe('When log', () => {
      it('Then it resolves as a ref not an oid', async () => {
        // Arrange — branch name = <40-hex> + 'r'; the `$` anchor keeps this off the
        // oid fast-path. Dropping `$` (`/^[0-9a-f]{40}/`) would match the prefix and
        // return the 41-char string as an oid, making the walk fail.
        const ctx = createMemoryContext();
        const target = await writeCommitAt(ctx, [], 1000, 'target');
        const decoyOid = await writeCommitAt(ctx, [], 1500, 'decoy');
        const branchName = `${decoyOid}r`;
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': target, [`refs/heads/${branchName}`]: target },
        });

        // Act
        const sut = await log(ctx, { rev: branchName });

        // Assert — resolved via the branch ref; mutant would throw on a 41-char oid.
        expect(sut.map((e) => e.message)).toEqual(['target']);
      });
    });
  });

  describe('Given rev is a tag short name', () => {
    describe('When log', () => {
      it('Then it resolves via refs/tags/<name>', async () => {
        // Arrange — only `refs/tags/v1` carries the commit; neither the literal
        // name nor `refs/heads/v1` exist.
        const ctx = createMemoryContext();
        const target = await writeCommitAt(ctx, [], 1000, 'tagged');
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': target, 'refs/tags/v1': target },
        });

        // Act
        const sut = await log(ctx, { rev: 'v1' });

        // Assert — kills the `refs/tags/${rev}` → `` StringLiteral mutant, which
        // would drop the only resolvable candidate and throw.
        expect(sut.map((e) => e.message)).toEqual(['tagged']);
      });
    });
  });

  describe("Given rev is a grammar selector 'HEAD~2'", () => {
    describe('When log', () => {
      it('Then resolves the ancestor and walks from there', async () => {
        // Arrange — chain oldest(c1)←middle(c2)←newest(c3); HEAD→c3, so HEAD~2 is c1.
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx, { rev: 'HEAD~2' });

        // Assert — walks from the oldest only (the bespoke resolver had no `~` grammar).
        expect(sut.map((e) => e.message)).toEqual(['oldest']);
      });
    });
  });

  describe('Given rev is an annotated tag', () => {
    describe('When log', () => {
      it('Then peels the tag to its commit before walking', async () => {
        // Arrange — annotated tag `v9` over the oldest commit.
        const ctx = createMemoryContext();
        const c1 = await writeCommitAt(ctx, [], 1000, 'oldest');
        const c2 = await writeCommitAt(ctx, [c1], 2000, 'newest');
        const tagId = await writeAnnotatedTag(ctx, c1, 'v9');
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': c2, 'refs/tags/v9': tagId },
        });

        // Act
        const sut = await log(ctx, { rev: 'v9' });

        // Assert — peeled to c1; without the peel the walk reads the tag object,
        // skips it as a non-commit, and yields nothing.
        expect(sut.map((e) => e.message)).toEqual(['oldest']);
      });
    });
  });

  describe('Given excluding uses a grammar selector', () => {
    describe('When log', () => {
      it('Then resolves it and stops at that commit', async () => {
        // Arrange — HEAD→c3; HEAD~1 is the middle commit.
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx, { excluding: ['HEAD~1'] });

        // Assert — only the newest remains (middle + its ancestor are excluded).
        expect(sut.map((e) => e.message)).toEqual(['newest']);
      });
    });
  });

  describe('Given rev is unresolvable', () => {
    describe('When log', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedTimestampChain();

        // Act
        let caught: unknown;
        try {
          await log(ctx, { rev: 'no-such-rev' });
        } catch (err) {
          caught = err;
        }

        // Assert — the grammar resolver refuses an unknown rev (was REF_NOT_FOUND
        // via the bespoke resolver; now OBJECT_NOT_FOUND, matching show/readFileAt).
        expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given an excluding entry is unresolvable', () => {
    describe('When log', () => {
      it('Then throws OBJECT_NOT_FOUND (no longer silently skipped)', async () => {
        // Arrange
        const { ctx } = await seedTimestampChain();

        // Act
        let caught: unknown;
        try {
          await log(ctx, { excluding: ['no-such-rev'] });
        } catch (err) {
          caught = err;
        }

        // Assert — faithful: a bad exclusion refuses rather than being dropped.
        expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given excluding is a ref name resolving to a commit', () => {
    describe('When log', () => {
      it('Then that commit is excluded', async () => {
        // Arrange — chain oldest→middle→newest; exclude the `middle` commit via a
        // full ref name so the walk stops there.
        const ctx = createMemoryContext();
        const c1 = await writeCommitAt(ctx, [], 1000, 'oldest');
        const c2 = await writeCommitAt(ctx, [c1], 2000, 'middle');
        const c3 = await writeCommitAt(ctx, [c2], 3000, 'newest');
        await seedRepo(ctx, {
          refs: { 'refs/heads/main': c3, 'refs/heads/cut': c2 },
        });

        // Act
        const sut = await log(ctx, { excluding: ['refs/heads/cut'] });

        // Assert — `excluding` resolved as a ref name; mutants that treat it as a
        // raw oid (regex/ConditionalExpression) or skip the resolve (BlockStatement{})
        // would push the wrong value and yield `middle` + `oldest` too.
        expect(sut.map((e) => e.message)).toEqual(['newest']);
      });
    });
  });

  describe('Given diamond root, single-parent commits, merge', () => {
    describe('When log filters by parent count', () => {
      // Diamond: A(root, 0 parents) ← B(1), A ← C(1), merge D(parents=[B,C], 2).
      // Each row isolates one guard/boundary: an option-ignored mutant, a
      // flipped `>=`/`<=` at the B(1) boundary, an impossible band, filter
      // applied before (not after) limit, and the filter left inactive.
      it.each([
        {
          label: 'maxParents:0 keeps only the root commit',
          options: { maxParents: 0 },
          expected: ['A'],
        },
        {
          label: 'minParents:2 keeps only the merge commit',
          options: { minParents: 2 },
          expected: ['D'],
        },
        {
          label: 'maxParents:1 keeps all non-merge commits (B at the boundary IS kept)',
          options: { maxParents: 1 },
          expected: ['C', 'B', 'A'],
        },
        {
          label: 'minParents:1 keeps all non-root commits (B at the boundary IS kept)',
          options: { minParents: 1 },
          expected: ['D', 'C', 'B'],
        },
        {
          label: 'an impossible band (minParents:2, maxParents:1) yields nothing',
          options: { minParents: 2, maxParents: 1 },
          expected: [],
        },
        {
          label: 'maxParents:1 with limit:1 filters before limiting',
          options: { maxParents: 1, limit: 1 },
          expected: ['C'],
        },
        {
          label: 'neither bound set leaves the default walk unchanged',
          options: {},
          expected: ['D', 'C', 'B', 'A'],
        },
      ])('Then $label', async ({ options, expected }) => {
        // Arrange
        const { ctx } = await seedDiamond();

        // Act
        const sut = await log(ctx, options);

        // Assert
        expect(sut.map((e) => e.message)).toEqual(expected);
      });
    });
  });

  describe('Given an octopus merge (3 parents)', () => {
    describe('When log runs with minParents:3', () => {
      it('Then only the octopus commit is yielded', async () => {
        // Arrange — base diamond plus E off A; octopus O with 3 parents
        const ctx = createMemoryContext();
        const a = await writeCommitAt(ctx, [], 1000, 'A');
        const b = await writeCommitAt(ctx, [a], 2000, 'B');
        const c = await writeCommitAt(ctx, [a], 3000, 'C');
        const e = await writeCommitAt(ctx, [a], 4000, 'E');
        const o = await writeCommitAt(ctx, [b, c, e], 5000, 'O');
        await seedRepo(ctx, { refs: { 'refs/heads/main': o } });

        // Act
        const sut = await log(ctx, { minParents: 3 });

        // Assert — only O(3 parents) passes; proves numeric band not boolean isMerge
        expect(sut.map((e) => e.message)).toEqual(['O']);
      });
    });
  });

  describe('Given before and maxParents both set', () => {
    describe('When log', () => {
      it('Then both filters apply independently', async () => {
        // Arrange — timestamp chain: oldest(c1,t=1000,0 parents), middle(c2,t=2000,1 parent),
        // newest(c3,t=3000,1 parent). minParents:1 + before:2500s: before excludes newest
        // (t=3000 >= 2500), minParents:1 excludes root oldest (0 parents).
        // Only middle (1 parent, t=2000 < 2500s) passes both.
        const { ctx, c1, c2, c3 } = await seedTimestampChain();

        // Act
        const sut = await log(ctx, { before: new Date(2500 * 1000), minParents: 1 });

        // Assert
        expect(sut.map((e) => e.message)).toEqual(['middle']);
        void c1;
        void c2;
        void c3;
      });
    });
  });

  describe('Given excluding and minParents both set', () => {
    describe('When log', () => {
      it('Then both filters apply', async () => {
        // Arrange — timestamp chain: oldest(0 parents), middle(1 parent), newest(1 parent)
        // excluding=['HEAD~1'] stops at middle; minParents:1 excludes roots
        // Only newest (1 parent, not excluded) passes
        const { ctx } = await seedTimestampChain();

        // Act
        const sut = await log(ctx, { excluding: ['HEAD~1'], minParents: 1 });

        // Assert — HEAD~1 = middle; walk stops there; newest has 1 parent and passes
        expect(sut.map((e) => e.message)).toEqual(['newest']);
      });
    });
  });
});

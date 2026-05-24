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

describe('log', () => {
  describe('Given three commits', () => {
    describe('When log', () => {
      it('Then returns them in newest-first order', async () => {
        // Arrange
        const ctx = await seedThree();

        // Act
        const sut = await log(ctx);

        // Assert
        expect(sut.map((e) => e.message)).toEqual(['third', 'second', 'first']);
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

  describe("Given from='main' (ref name, not HEAD)", () => {
    describe('When log', () => {
      it('Then resolves the named branch', async () => {
        // Arrange
        const ctx = await seedThree();

        // Act
        const sut = await log(ctx, { from: 'main' });

        // Assert — same shape as default HEAD-driven log; kills `from === 'HEAD'` mutants.
        expect(sut.length).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe('Given from is a 40-hex oid', () => {
    describe('When log', () => {
      it('Then walks from that oid directly (no ref lookup)', async () => {
        // Arrange
        const ctx = await seedThree();
        const all = await log(ctx);
        const oldest = all[all.length - 1] as { readonly id: string };

        // Act — walk from the oldest commit; should yield only itself.
        const sut = await log(ctx, { from: oldest.id });

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

        // Assert — error must name the missing HEAD ref, not just be defined.
        expect(caught).toBeInstanceOf(Error);
        const data = (caught as { data?: { code?: string } }).data;
        expect(data?.code).toBe('REF_NOT_FOUND');
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

  describe('Given from is a branch name whose 40-hex suffix is hex', () => {
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
        const sut = await log(ctx, { from: branchName });

        // Assert — resolved via the branch ref; mutant would throw on a 41-char oid.
        expect(sut.map((e) => e.message)).toEqual(['target']);
      });
    });
  });

  describe('Given from is a branch name whose 40-hex prefix is hex', () => {
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
        const sut = await log(ctx, { from: branchName });

        // Assert — resolved via the branch ref; mutant would throw on a 41-char oid.
        expect(sut.map((e) => e.message)).toEqual(['target']);
      });
    });
  });

  describe('Given from is a tag short name', () => {
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
        const sut = await log(ctx, { from: 'v1' });

        // Assert — kills the `refs/tags/${from}` → `` StringLiteral mutant, which
        // would drop the only resolvable candidate and throw.
        expect(sut.map((e) => e.message)).toEqual(['tagged']);
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
});

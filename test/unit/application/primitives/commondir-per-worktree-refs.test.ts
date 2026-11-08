/**
 * The per-worktree half of the write-surface sweep: the six sites that must
 * route through `perWorktreeRefDir(ctx, name)` instead of the stale
 * `ctx.layout.gitDir` for a linked-worktree child Context. Each site gets two
 * tests — a shared-ref case (must resolve under the common dir) and either a
 * per-worktree-ref case (`updateRef`/`writeSymbolicRef`, which accept an
 * arbitrary `RefName`) or an admin-dir-decoy case (the fixed-classification
 * commands, which only ever operate on shared ref names) — so a revert
 * mutant on either half of the substitution is caught.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate, branchDelete } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { fetch } from '../../../../src/application/commands/fetch.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagDelete } from '../../../../src/application/commands/tag.js';
import { validateHead } from '../../../../src/application/primitives/internal/head-file.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HttpTransport } from '../../../../src/ports/http-transport.js';
import { buildSeededContext } from './fixtures.js';
import { buildSyntheticPack } from './pack-fixture.js';

const ENCODER = new TextEncoder();
const ID_A = 'a'.repeat(40) as ObjectId;

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** Writes a real, hash-valid parentless commit — `updateRef` now verifies
 *  every non-delete write target. */
async function writeCommit(ctx: Context, message: string): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: emptyTreeOid(ctx.hashConfig),
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message,
      extraHeaders: [],
    },
  });
}

/** The linked worktree's own (admin) gitdir under the common dir's `worktrees/`. */
const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

/** Reframe a seeded main-repo Context as a linked-worktree child Context. */
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

/**
 * Complete the child's registration the way `git worktree add` does: its own
 * (admin) `HEAD` and `gitdir` pointer, plus the main checkout's own `HEAD`
 * under the common dir. Commands that enumerate the repository's worktrees
 * read all three.
 */
const seedAdminHead = async (ctx: Context): Promise<void> => {
  await ctx.fs.writeUtf8(`${adminDir(ctx)}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${adminDir(ctx)}/gitdir`, `${ctx.layout.workDir}/wt/.git\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
};

/**
 * Reframe a seeded main-repo Context so gitDir and commonDir sit in
 * unrelated, disjoint subtrees — proving the split is parameterised on
 * `ctx.layout.commonDir` alone, never hard-coded to the `worktrees/<id>`
 * admin-dir shape `asWorktreeChild` uses.
 */
const asOverriddenCommonDir = (ctx: Context): Context => ({
  ...ctx,
  layout: {
    ...ctx.layout,
    gitDir: `${ctx.layout.workDir}/wt/.git`,
    commonDir: `${ctx.layout.workDir}/shared`,
  },
});

/** Give the disjoint child's own gitdir the `HEAD` file operational commands require. */
const seedOverriddenAdminHead = (ctx: Context): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/wt/.git/HEAD`, 'ref: refs/heads/main\n');

/**
 * Smart-HTTP v1 advertisement + NAK/side-band-1 pack response for one branch.
 * The service-header line and the ref-advertisement body are each their own
 * flush-terminated pkt-line block — that's the wire shape upload-pack.ts
 * expects (a bare header pkt with no following flush is rejected as
 * MISSING_SERVICE_HEADER).
 */
const fakeFetchRemote = (
  advertisedRefs: ReadonlyArray<{ readonly name: string; readonly id: ObjectId }>,
  packBytes: Uint8Array,
): HttpTransport => {
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const refLines = advertisedRefs.map((r, idx) =>
    idx === 0
      ? ENCODER.encode(`${r.id} ${r.name}\0side-band-64k ofs-delta\n`)
      : ENCODER.encode(`${r.id} ${r.name}\n`),
  );
  const refsBody = encodePktStream(refLines);
  const advertisement = new Uint8Array(header.length + refsBody.length);
  advertisement.set(header, 0);
  advertisement.set(refsBody, header.length);

  const channel1 = new Uint8Array(packBytes.length + 1);
  channel1[0] = 0x01;
  channel1.set(packBytes, 1);
  const packResponse = encodePktStream([ENCODER.encode('NAK\n'), channel1]);

  return {
    request: async (req) => {
      const body = req.url.includes('info/refs') ? advertisement : packResponse;
      return {
        statusCode: 200,
        headers: {},
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice());
            controller.close();
          },
        }),
      };
    },
  };
};

describe('common-dir per-worktree-ref sweep', () => {
  describe('updateRef', () => {
    describe('Given a worktree child Context', () => {
      describe('When updateRef writes a shared ref', () => {
        it('Then the ref lands under the common dir, not the admin dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = updateRef;
          const commit = await writeCommit(child, 'shared ref');

          // Act
          await sut(child, 'refs/heads/x' as RefName, commit, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/x`)).toBe(true);
          expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/heads/x`)).toBe(false);
        });
      });

      describe('When updateRef writes a per-worktree ref', () => {
        it('Then the ref lands under the admin dir, not the common dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = updateRef;
          const commit = await writeCommit(child, 'per-worktree ref');

          // Act
          await sut(child, 'refs/bisect/bad' as RefName, commit, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/bisect/bad`)).toBe(true);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/bisect/bad`)).toBe(false);
        });
      });
    });

    describe('Given a Context whose gitDir and commonDir sit in unrelated, disjoint subtrees', () => {
      describe('When updateRef writes a shared ref', () => {
        it('Then the ref lands under the commonDir, not the gitDir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asOverriddenCommonDir(ctx);
          const sut = updateRef;
          await seedOverriddenAdminHead(ctx);
          const commit = await writeCommit(child, 'disjoint shared ref');

          // Act
          await sut(child, 'refs/heads/x' as RefName, commit, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${child.layout.commonDir}/refs/heads/x`)).toBe(true);
          expect(await ctx.fs.exists(`${child.layout.gitDir}/refs/heads/x`)).toBe(false);
        });
      });

      describe('When updateRef writes a per-worktree ref', () => {
        it('Then the ref lands under the gitDir, not the commonDir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asOverriddenCommonDir(ctx);
          const sut = updateRef;
          await seedOverriddenAdminHead(ctx);
          const commit = await writeCommit(child, 'disjoint per-worktree ref');

          // Act
          await sut(child, 'refs/bisect/bad' as RefName, commit, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${child.layout.gitDir}/refs/bisect/bad`)).toBe(true);
          expect(await ctx.fs.exists(`${child.layout.commonDir}/refs/bisect/bad`)).toBe(false);
        });
      });
    });

    describe('Given a main worktree and a linked worktree wt with their own HEADs', () => {
      type HeadShape = 'branch' | 'detached';
      interface WorktreePair {
        readonly a: ObjectId;
        readonly b: ObjectId;
      }

      const headContent = (shape: HeadShape, branch: string, id: ObjectId): string =>
        shape === 'branch' ? `ref: refs/heads/${branch}\n` : `${id}\n`;

      async function seedWorktreePair(
        ctx: Context,
        heads: { readonly main: HeadShape; readonly wt: HeadShape },
      ): Promise<WorktreePair> {
        const a = await writeCommit(ctx, 'A');
        const b = await writeCommit(ctx, 'B');
        await getRefStore(ctx).applyRefUpdates(
          ['refs/heads/main', 'refs/heads/side', 'refs/bisect/s'].map((name) => ({
            kind: 'set' as const,
            name: name as RefName,
            id: a,
          })),
        );
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, headContent(heads.main, 'main', a));
        await ctx.fs.writeUtf8(`${adminDir(ctx)}/HEAD`, headContent(heads.wt, 'side', a));
        await ctx.fs.writeUtf8(`${adminDir(ctx)}/gitdir`, `${ctx.layout.workDir}/wt/.git\n`);
        await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/bisect/t`, `${a}\n`);
        return { a, b };
      }

      const refValue = (ctx: Context, name: string) =>
        getRefStore(ctx).resolveDirect(name as RefName);
      const direct = (id: ObjectId) => ({ kind: 'direct', id });
      const strayDirExists = (ctx: Context): Promise<boolean> =>
        ctx.fs.exists(`${ctx.layout.gitDir}/main-worktree`);
      const OPTIONS = { reflogMessage: 'probe' };
      const logLines = async (ctx: Context, log: string): Promise<ReadonlyArray<string>> => {
        if (!(await ctx.fs.exists(log))) return [];
        return (await ctx.fs.readUtf8(log)).split('\n').filter((line) => line !== '');
      };
      const headLogLineCount = async (ctx: Context): Promise<number> =>
        (await logLines(ctx, `${ctx.layout.gitDir}/logs/HEAD`)).length;
      const adminHeadLog = (ctx: Context): string => `${adminDir(ctx)}/logs/HEAD`;
      /** The log `git worktree add` gives the linked HEAD, which a prefixed write appends to. */
      const seedAdminHeadLog = (ctx: Context, id: ObjectId): Promise<void> =>
        ctx.fs.writeUtf8(adminHeadLog(ctx), `${'0'.repeat(40)} ${id} T <t@e> 0 +0000\tseed\n`);
      /** Where the log of `worktrees/wt/HEAD` lands when the name is spelled as a path. */
      const strayLogDirExists = (ctx: Context): Promise<boolean> =>
        ctx.fs.exists(`${ctx.layout.gitDir}/logs/worktrees`);
      const probeEntryOf = (oldId: ObjectId, newId: ObjectId): RegExp =>
        new RegExp(`^${oldId} ${newId} .*\tprobe$`);
      const refusalOf = async (write: () => Promise<void>): Promise<unknown> => {
        try {
          await write();
        } catch (error) {
          return (error as TsgitError).data;
        }
        return undefined;
      };

      describe('When updateRef writes main-worktree/HEAD from the linked worktree with both HEADs on branches', () => {
        it('Then refs/heads/main holds B, refs/heads/side keeps A and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'main-worktree/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(b));
          expect(await refValue(ctx, 'refs/heads/side')).toEqual(direct(a));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/HEAD from the main worktree with the main HEAD detached', () => {
        it('Then the common HEAD file holds B, refs/heads/main keeps A and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'detached', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(ctx, 'main-worktree/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe(`${b}\n`);
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(a));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/HEAD from the linked worktree with the main HEAD detached', () => {
        it('Then the common HEAD file holds B, refs/heads/main keeps A and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'detached', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'main-worktree/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe(`${b}\n`);
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(a));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/refs/bisect/x from the main worktree', () => {
        it('Then the common refs/bisect/x holds B and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(ctx, 'main-worktree/refs/bisect/x' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(ctx, 'refs/bisect/x')).toEqual(direct(b));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/refs/bisect/x from the linked worktree', () => {
        it('Then the common refs/bisect/x holds B and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'main-worktree/refs/bisect/x' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(ctx, 'refs/bisect/x')).toEqual(direct(b));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/HEAD with noDeref from the linked worktree', () => {
        it('Then the common HEAD file holds B detached, refs/heads/main keeps A and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'main-worktree/HEAD' as RefName, b, {
            ...OPTIONS,
            noDeref: true,
          });

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe(`${b}\n`);
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(a));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/HEAD with noDeref from the main worktree', () => {
        it('Then the common HEAD file holds B detached, refs/heads/main keeps A and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(ctx, 'main-worktree/HEAD' as RefName, b, { ...OPTIONS, noDeref: true });

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe(`${b}\n`);
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(a));
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes refs/heads/x, a common file naming main-worktree/HEAD, from the linked worktree', () => {
        it('Then refs/heads/main holds B, x stays symbolic and nothing is written under main-worktree/', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/x`, 'ref: main-worktree/HEAD\n');
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'refs/heads/x' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(b));
          expect(await refValue(ctx, 'refs/heads/x')).toEqual({
            kind: 'symbolic',
            target: 'main-worktree/HEAD',
          });
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes worktrees/wt/refs/bisect/y from the main worktree', () => {
        it("Then the admin dir's refs/bisect/y holds B", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(ctx, 'worktrees/wt/refs/bisect/y' as RefName, b, OPTIONS);

          // Assert
          expect(await ctx.fs.readUtf8(`${adminDir(ctx)}/refs/bisect/y`)).toBe(`${b}\n`);
        });
      });

      describe('When updateRef writes worktrees/wt/refs/bisect/y from the linked worktree', () => {
        it("Then the admin dir's refs/bisect/y holds B", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'worktrees/wt/refs/bisect/y' as RefName, b, OPTIONS);

          // Assert
          expect(await ctx.fs.readUtf8(`${adminDir(ctx)}/refs/bisect/y`)).toBe(`${b}\n`);
        });
      });

      describe('When updateRef writes worktrees/wt/HEAD from the main worktree with both HEADs on branches', () => {
        it("Then refs/heads/side holds B and its log and the admin dir's HEAD log gain the entry", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          await seedAdminHeadLog(ctx, a);
          const sut = updateRef;

          // Act
          await sut(ctx, 'worktrees/wt/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(ctx, 'refs/heads/side')).toEqual(direct(b));
          expect(await logLines(ctx, `${ctx.layout.gitDir}/logs/refs/heads/side`)).toEqual([
            expect.stringMatching(probeEntryOf(a, b)),
          ]);
          expect((await logLines(ctx, adminHeadLog(ctx)))[1]).toMatch(probeEntryOf(a, b));
          expect(await strayLogDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes worktrees/wt/HEAD from the linked worktree with its HEAD detached', () => {
        it("Then the admin HEAD file holds B and the admin dir's HEAD log gains the entry", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'detached' });
          await seedAdminHeadLog(ctx, a);
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'worktrees/wt/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await ctx.fs.readUtf8(`${adminDir(ctx)}/HEAD`)).toBe(`${b}\n`);
          expect((await logLines(ctx, adminHeadLog(ctx)))[1]).toMatch(probeEntryOf(a, b));
          expect(await strayLogDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes worktrees/wt/HEAD with noDeref from the linked worktree', () => {
        it("Then the admin HEAD file holds B, the admin dir's HEAD log gains the entry and refs/heads/side keeps A", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          await seedAdminHeadLog(ctx, a);
          const sut = updateRef;

          // Act
          await sut(asWorktreeChild(ctx), 'worktrees/wt/HEAD' as RefName, b, {
            ...OPTIONS,
            noDeref: true,
          });

          // Assert
          expect(await ctx.fs.readUtf8(`${adminDir(ctx)}/HEAD`)).toBe(`${b}\n`);
          expect(await refValue(ctx, 'refs/heads/side')).toEqual(direct(a));
          expect((await logLines(ctx, adminHeadLog(ctx)))[1]).toMatch(probeEntryOf(a, b));
          expect(await strayLogDirExists(ctx)).toBe(false);
        });
      });

      describe.each([
        { name: 'main-worktree/refs/heads/main', cwd: 'the linked worktree', child: true },
        { name: 'worktrees/wt/refs/heads/side', cwd: 'the main worktree', child: false },
        { name: 'worktrees/nope/HEAD', cwd: 'the main worktree', child: false },
        { name: 'worktrees/nope/refs/bisect/z', cwd: 'the main worktree', child: false },
      ])('When updateRef writes $name from $cwd', ({ name, child }) => {
        it('Then a new common-dir file at that spelled path holds B', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const cwd = child ? asWorktreeChild(ctx) : ctx;
          const sut = updateRef;

          // Act
          await sut(cwd, name as RefName, b, OPTIONS);

          // Assert
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${name}`)).toBe(`${b}\n`);
        });
      });

      describe('When updateRef writes main-worktree/HEAD from the main worktree after the detached main HEAD was read once', () => {
        it("Then a later resolveDirect('HEAD') answers B", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'detached', wt: 'branch' });
          await validateHead(ctx);
          const sut = updateRef;

          // Act
          await sut(ctx, 'main-worktree/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(ctx, 'HEAD')).toEqual(direct(b));
        });
      });

      describe('When updateRef writes main-worktree/HEAD with noDeref from the main worktree after its HEAD was read once', () => {
        it("Then a later resolveDirect('HEAD') answers B directly", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          await validateHead(ctx);
          const sut = updateRef;

          // Act
          await sut(ctx, 'main-worktree/HEAD' as RefName, b, { ...OPTIONS, noDeref: true });

          // Assert
          expect(await refValue(ctx, 'HEAD')).toEqual(direct(b));
        });
      });

      describe('When updateRef writes worktrees/wt/HEAD from the linked worktree after its detached HEAD was read once', () => {
        it("Then a later resolveDirect('HEAD') of the linked worktree answers B", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'detached' });
          const child = asWorktreeChild(ctx);
          await validateHead(child);
          const sut = updateRef;

          // Act
          await sut(child, 'worktrees/wt/HEAD' as RefName, b, OPTIONS);

          // Assert
          expect(await refValue(child, 'HEAD')).toEqual(direct(b));
        });
      });

      describe('When updateRef writes main-worktree/HEAD from the main worktree with its HEAD on main', () => {
        it('Then it refuses REF_LOCKED naming main-worktree/HEAD and nothing changes', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const logLinesBefore = await headLogLineCount(ctx);
          const sut = updateRef;

          // Act
          const refusal = await refusalOf(() =>
            sut(ctx, 'main-worktree/HEAD' as RefName, b, OPTIONS),
          );

          // Assert
          expect(refusal).toEqual({ code: 'REF_LOCKED', name: 'main-worktree/HEAD' });
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(a));
          expect(await headLogLineCount(ctx)).toBe(logLinesBefore);
          expect(await strayDirExists(ctx)).toBe(false);
        });
      });

      describe('When updateRef writes main-worktree/HEAD from the main worktree expecting B while main holds A', () => {
        it('Then the compare-and-swap refuses first with REF_UPDATE_CONFLICT', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          const refusal = await refusalOf(() =>
            sut(ctx, 'main-worktree/HEAD' as RefName, b, { ...OPTIONS, expected: b }),
          );

          // Assert
          expect(refusal).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'main-worktree/HEAD',
            expected: b,
            actual: a,
          });
        });
      });

      describe('When updateRef writes worktrees/wt/HEAD from the linked worktree with its HEAD on side', () => {
        it('Then it refuses REF_LOCKED naming worktrees/wt/HEAD and side keeps A', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          const refusal = await refusalOf(() =>
            sut(asWorktreeChild(ctx), 'worktrees/wt/HEAD' as RefName, b, OPTIONS),
          );

          // Assert
          expect(refusal).toEqual({ code: 'REF_LOCKED', name: 'worktrees/wt/HEAD' });
          expect(await refValue(ctx, 'refs/heads/side')).toEqual(direct(a));
        });
      });

      describe('When updateRef writes refs/heads/x, a common file naming main-worktree/HEAD, from the main worktree', () => {
        it('Then it refuses REF_LOCKED naming refs/heads/x, main keeps A and x gains no log', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/x`, 'ref: main-worktree/HEAD\n');
          const sut = updateRef;

          // Act
          const refusal = await refusalOf(() => sut(ctx, 'refs/heads/x' as RefName, b, OPTIONS));

          // Assert
          expect(refusal).toEqual({ code: 'REF_LOCKED', name: 'refs/heads/x' });
          expect(await refValue(ctx, 'refs/heads/main')).toEqual(direct(a));
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/heads/x`)).toBe(false);
        });
      });

      describe('When applyRefUpdates deletes worktrees/wt/HEAD from the linked worktree after its HEAD was read once', () => {
        it("Then a later resolveDirect('HEAD') of the linked worktree answers missing", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await seedWorktreePair(ctx, { main: 'branch', wt: 'detached' });
          const child = asWorktreeChild(ctx);
          await validateHead(child);
          const sut = getRefStore(child);

          // Act
          await sut.applyRefUpdates([{ kind: 'delete', name: 'worktrees/wt/HEAD' as RefName }]);

          // Assert
          expect(await sut.resolveDirect('HEAD' as RefName)).toEqual({ kind: 'missing' });
        });
      });

      describe('When applyRefUpdates deletes main-worktree/refs/bisect/s from the main worktree', () => {
        it('Then the common refs/bisect/s is gone', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = getRefStore(ctx);

          // Act
          await sut.applyRefUpdates([
            { kind: 'delete', name: 'main-worktree/refs/bisect/s' as RefName },
          ]);

          // Assert
          expect(await refValue(ctx, 'refs/bisect/s')).toEqual({ kind: 'missing' });
        });
      });

      describe('When updateRef writes worktrees/nope, an id with no admin dir and no name after it, from the main worktree', () => {
        it('Then it refuses FILE_NOT_FOUND on the lock inside that dir and creates no worktrees/nope', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          const refusal = await refusalOf(() => sut(ctx, 'worktrees/nope' as RefName, b, OPTIONS));

          // Assert
          expect(refusal).toEqual({
            code: 'FILE_NOT_FOUND',
            path: `${ctx.layout.gitDir}/worktrees/nope/.lock`,
          });
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/worktrees/nope`)).toBe(false);
        });
      });

      describe('When updateRef writes worktrees/wt, the linked admin dir with no name after it, from the main worktree', () => {
        it('Then it refuses FILE_EXISTS on the smallest ref under that dir and leaves its HEAD alone', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { b } = await seedWorktreePair(ctx, { main: 'branch', wt: 'branch' });
          const sut = updateRef;

          // Act
          const refusal = await refusalOf(() => sut(ctx, 'worktrees/wt' as RefName, b, OPTIONS));

          // Assert
          expect(refusal).toEqual({ code: 'FILE_EXISTS', path: `${adminDir(ctx)}/HEAD` });
          expect(await ctx.fs.readUtf8(`${adminDir(ctx)}/HEAD`)).toBe('ref: refs/heads/side\n');
        });
      });
    });
  });

  describe('writeSymbolicRef', () => {
    describe('Given a worktree child Context', () => {
      describe('When writeSymbolicRef writes a shared symref', () => {
        it('Then it lands under the common dir, not the admin dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = writeSymbolicRef;

          // Act
          await sut(child, 'refs/remotes/origin/HEAD' as RefName, 'refs/heads/main' as RefName);

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/HEAD`)).toBe(true);
          expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/remotes/origin/HEAD`)).toBe(false);
        });
      });

      describe('When writeSymbolicRef writes HEAD (a per-worktree ref)', () => {
        it('Then it lands under the admin dir, not the common dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = writeSymbolicRef;

          // Act
          await sut(child, 'HEAD' as RefName, 'refs/heads/main' as RefName);

          // Assert
          expect(await ctx.fs.exists(`${adminDir(ctx)}/HEAD`)).toBe(true);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)).toBe(false);
        });
      });
    });
  });

  describe('branchDelete', () => {
    describe('Given a worktree child Context with the branch under the common dir', () => {
      describe('When branchDelete runs', () => {
        it('Then the branch is deleted from the common dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = branchDelete;
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/feature`, `${ID_A}\n`);

          // Act — forced: the planted tip is no commit HEAD can reach, and
          // the unforced valve would refuse it before any ref dir is touched.
          await sut(child, { name: 'feature', force: true });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(false);
        });
      });
    });

    describe('Given a worktree child Context with only an admin-dir decoy branch', () => {
      describe('When branchDelete runs', () => {
        it('Then it throws BRANCH_NOT_FOUND — the common dir is checked, not the decoy', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = branchDelete;
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/heads/feature`, `${ID_A}\n`);

          // Act + Assert
          try {
            await sut(child, { name: 'feature' });
            expect.unreachable();
          } catch (err) {
            expect((err as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
          }
        });
      });
    });
  });

  describe('tagDelete', () => {
    describe('Given a worktree child Context with the tag under the common dir', () => {
      describe('When tagDelete runs', () => {
        it('Then the tag is deleted from the common dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = tagDelete;
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${ID_A}\n`);

          // Act
          await sut(child, { name: 'v1' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/tags/v1`)).toBe(false);
        });
      });
    });

    describe('Given a worktree child Context with only an admin-dir decoy tag', () => {
      describe('When tagDelete runs', () => {
        it('Then it throws TAG_NOT_FOUND — the common dir is checked, not the decoy', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const child = asWorktreeChild(ctx);
          const sut = tagDelete;
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/tags/v1`, `${ID_A}\n`);

          // Act + Assert
          try {
            await sut(child, { name: 'v1' });
            expect.unreachable();
          } catch (err) {
            expect((err as TsgitError).data.code).toBe('TAG_NOT_FOUND');
          }
        });
      });
    });
  });

  describe("checkout's branch probe", () => {
    describe('Given a worktree child Context with a real commit and branch under the common dir', () => {
      describe('When checkout switches to that branch', () => {
        it('Then it succeeds, reading the branch ref from the common dir', async () => {
          // Arrange
          const base = createMemoryContext();
          await init(base);
          await base.fs.writeUtf8(`${base.layout.workDir}/a.txt`, 'a');
          await add(base, ['a.txt']);
          const committed = await commit(base, { message: 'c1', author: AUTHOR });
          await branchCreate(base, { name: 'feature' });
          const child = asWorktreeChild(base);
          const sut = checkout;
          await seedAdminHead(base);

          // Act
          const result = await sut(child, { rev: 'feature', force: true });

          // Assert
          expect(result.branch).toBe('refs/heads/feature');
          expect(result.id).toBe(committed.id);
        });
      });
    });

    describe('Given a worktree child Context with only an admin-dir decoy branch ref', () => {
      describe('When checkout switches to that branch', () => {
        it('Then it refuses as an unmatched pathspec — the common dir is checked, not the decoy', async () => {
          // Arrange — HEAD (admin) must resolve so switchBranch reaches the
          // branchRef existence check for 'ghost' rather than failing earlier.
          const ctx = await buildSeededContext({
            refs: [{ name: 'refs/heads/main' as RefName, id: ID_A }],
          });
          const child = asWorktreeChild(ctx);
          const sut = checkout;
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/heads/ghost`, `${ID_A}\n`);

          // Act + Assert
          try {
            await sut(child, { rev: 'ghost' });
            expect.unreachable();
          } catch (err) {
            expect((err as TsgitError).data.code).toBe('PATHSPEC_NO_MATCH');
          }
        });
      });
    });
  });

  describe("fetch's readExistingRef", () => {
    describe('Given a worktree child Context with an existing shared remote-tracking ref', () => {
      describe('When fetch advances that ref to a new oid', () => {
        it('Then updatedRefs.oldId is read from the common dir, not the (absent) admin dir', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const oldOid = 'b'.repeat(40) as ObjectId;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oldOid}\n`);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[remote "origin"]\n  url = https://example.com/r.git\n  fetch = +refs/heads/*:refs/remotes/origin/*\n',
          );
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENCODER.encode('per-worktree-refs fetch a\n') },
          ]);
          const newOid = built.ids[0] as ObjectId;
          const transport = fakeFetchRemote(
            [{ name: 'refs/heads/main', id: newOid }],
            built.packBytes,
          );
          const child: Context = { ...asWorktreeChild(ctx), transport };
          await seedAdminHead(ctx);
          const sut = fetch;

          // Act
          const result = await sut(child, {});

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated?.oldId).toBe(oldOid);
          expect(updated?.newId).toBe(newOid);
        });
      });
    });

    describe('Given a worktree child Context with only an admin-dir decoy remote-tracking ref', () => {
      describe('When fetch advances the (common-dir-absent) ref', () => {
        it('Then updatedRefs.oldId is undefined — the admin-dir decoy is not read as the old value', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const decoyOid = 'f'.repeat(40) as ObjectId;
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/remotes/origin/main`, `${decoyOid}\n`);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[remote "origin"]\n  url = https://example.com/r.git\n  fetch = +refs/heads/*:refs/remotes/origin/*\n',
          );
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENCODER.encode('per-worktree-refs fetch b\n') },
          ]);
          const newOid = built.ids[0] as ObjectId;
          const transport = fakeFetchRemote(
            [{ name: 'refs/heads/main', id: newOid }],
            built.packBytes,
          );
          const child: Context = { ...asWorktreeChild(ctx), transport };
          await seedAdminHead(ctx);
          const sut = fetch;

          // Act
          const result = await sut(child, {});

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated?.oldId).toBeUndefined();
          expect(updated?.newId).toBe(newOid);
        });
      });
    });
  });
});

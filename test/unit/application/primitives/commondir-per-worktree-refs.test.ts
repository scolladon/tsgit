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
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
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

/** The linked worktree's own (admin) gitdir under the common dir's `worktrees/`. */
const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

/** Reframe a seeded main-repo Context as a linked-worktree child Context. */
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

/** Give the child's own (admin) gitdir the `HEAD` file operational commands require. */
const seedAdminHead = (ctx: Context): Promise<void> =>
  ctx.fs.writeUtf8(`${adminDir(ctx)}/HEAD`, 'ref: refs/heads/main\n');

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
          const sut = asWorktreeChild(ctx);

          // Act
          await updateRef(sut, 'refs/heads/x' as RefName, ID_A, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/x`)).toBe(true);
          expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/heads/x`)).toBe(false);
        });
      });

      describe('When updateRef writes a per-worktree ref', () => {
        it('Then the ref lands under the admin dir, not the common dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const sut = asWorktreeChild(ctx);

          // Act
          await updateRef(sut, 'refs/bisect/bad' as RefName, ID_A, { reflogMessage: 'test' });

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
          const sut = asOverriddenCommonDir(ctx);
          await seedOverriddenAdminHead(ctx);

          // Act
          await updateRef(sut, 'refs/heads/x' as RefName, ID_A, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${sut.layout.commonDir}/refs/heads/x`)).toBe(true);
          expect(await ctx.fs.exists(`${sut.layout.gitDir}/refs/heads/x`)).toBe(false);
        });
      });

      describe('When updateRef writes a per-worktree ref', () => {
        it('Then the ref lands under the gitDir, not the commonDir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const sut = asOverriddenCommonDir(ctx);
          await seedOverriddenAdminHead(ctx);

          // Act
          await updateRef(sut, 'refs/bisect/bad' as RefName, ID_A, { reflogMessage: 'test' });

          // Assert
          expect(await ctx.fs.exists(`${sut.layout.gitDir}/refs/bisect/bad`)).toBe(true);
          expect(await ctx.fs.exists(`${sut.layout.commonDir}/refs/bisect/bad`)).toBe(false);
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
          const sut = asWorktreeChild(ctx);

          // Act
          await writeSymbolicRef(
            sut,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/heads/main' as RefName,
          );

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/HEAD`)).toBe(true);
          expect(await ctx.fs.exists(`${adminDir(ctx)}/refs/remotes/origin/HEAD`)).toBe(false);
        });
      });

      describe('When writeSymbolicRef writes HEAD (a per-worktree ref)', () => {
        it('Then it lands under the admin dir, not the common dir', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const sut = asWorktreeChild(ctx);

          // Act
          await writeSymbolicRef(sut, 'HEAD' as RefName, 'refs/heads/main' as RefName);

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
          const sut = asWorktreeChild(ctx);
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/feature`, `${ID_A}\n`);

          // Act
          await branchDelete(sut, { name: 'feature' });

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
          const sut = asWorktreeChild(ctx);
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/heads/feature`, `${ID_A}\n`);

          // Act + Assert
          try {
            await branchDelete(sut, { name: 'feature' });
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
          const sut = asWorktreeChild(ctx);
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${ID_A}\n`);

          // Act
          await tagDelete(sut, { name: 'v1' });

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
          const sut = asWorktreeChild(ctx);
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/tags/v1`, `${ID_A}\n`);

          // Act + Assert
          try {
            await tagDelete(sut, { name: 'v1' });
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
          const sut = asWorktreeChild(base);
          await seedAdminHead(base);

          // Act
          const result = await checkout(sut, { rev: 'feature', force: true });

          // Assert
          expect(result.branch).toBe('refs/heads/feature');
          expect(result.id).toBe(committed.id);
        });
      });
    });

    describe('Given a worktree child Context with only an admin-dir decoy branch ref', () => {
      describe('When checkout switches to that branch', () => {
        it('Then it throws BRANCH_NOT_FOUND — the common dir is checked, not the decoy', async () => {
          // Arrange — HEAD (admin) must resolve so switchBranch reaches the
          // branchRef existence check for 'ghost' rather than failing earlier.
          const ctx = await buildSeededContext({
            refs: [{ name: 'refs/heads/main' as RefName, id: ID_A }],
          });
          const sut = asWorktreeChild(ctx);
          await seedAdminHead(ctx);
          await ctx.fs.writeUtf8(`${adminDir(ctx)}/refs/heads/ghost`, `${ID_A}\n`);

          // Act + Assert
          try {
            await checkout(sut, { rev: 'ghost' });
            expect.unreachable();
          } catch (err) {
            expect((err as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
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
            '[remote "origin"]\n  url = https://example.com/r.git\n',
          );
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENCODER.encode('per-worktree-refs fetch a\n') },
          ]);
          const newOid = built.ids[0] as ObjectId;
          const transport = fakeFetchRemote(
            [{ name: 'refs/heads/main', id: newOid }],
            built.packBytes,
          );
          const sut: Context = { ...asWorktreeChild(ctx), transport };
          await seedAdminHead(ctx);

          // Act
          const result = await fetch(sut, {});

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
            '[remote "origin"]\n  url = https://example.com/r.git\n',
          );
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENCODER.encode('per-worktree-refs fetch b\n') },
          ]);
          const newOid = built.ids[0] as ObjectId;
          const transport = fakeFetchRemote(
            [{ name: 'refs/heads/main', id: newOid }],
            built.packBytes,
          );
          const sut: Context = { ...asWorktreeChild(ctx), transport };
          await seedAdminHead(ctx);

          // Act
          const result = await fetch(sut, {});

          // Assert
          const updated = result.updatedRefs.find((r) => r.name === 'refs/remotes/origin/main');
          expect(updated?.oldId).toBeUndefined();
          expect(updated?.newId).toBe(newOid);
        });
      });
    });
  });
});

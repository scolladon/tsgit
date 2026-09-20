/**
 * The name a detaching `checkout` and a `tag` target accept. git resolves
 * both through its revision ladder rather than as a literal ref path, and
 * `checkout` looks at `refs/heads/<name>` before that ladder — so an
 * ambiguous short name detaches onto the BRANCH there while `tag` takes the
 * TAG the ladder reaches first.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ABBREVIATED_LENGTH = 7;
const HEADS = 'refs/heads/';

interface Fixture {
  readonly ctx: Context;
  /** `refs/heads/amb`, `refs/remotes/org/tgt`. */
  readonly branchId: ObjectId;
  /** `refs/tags/amb`, `refs/tags/release`. */
  readonly tagId: ObjectId;
}

/** Two commits, with `amb` both a branch and a tag — pointing at different
 *  commits so the resolution order is observable. */
const seedAmbiguity = async (): Promise<Fixture> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const first = await commit(ctx, { message: 'first', author: AUTHOR });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'b');
  await add(ctx, ['a.txt']);
  const second = await commit(ctx, { message: 'second', author: AUTHOR });
  const reflogMessage = 'plant';
  await updateRef(ctx, 'refs/heads/amb' as RefName, first.id, { reflogMessage });
  await updateRef(ctx, 'refs/tags/amb' as RefName, second.id, { reflogMessage });
  await updateRef(ctx, 'refs/tags/release' as RefName, second.id, { reflogMessage });
  await updateRef(ctx, 'refs/remotes/org/tgt' as RefName, first.id, { reflogMessage });
  return { ctx, branchId: first.id, tagId: second.id };
};

const headRaw = async (ctx: Context): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);

const lastHeadMessage = async (ctx: Context): Promise<string | undefined> =>
  (await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message;

describe('checkout — a name no branch carries', () => {
  describe('Given a short name only a tag carries', () => {
    describe('When checkout switches to it without asking to detach', () => {
      it('Then it detaches onto the tag and logs the name as given', async () => {
        // Arrange
        const { ctx, tagId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'release' });

        // Assert
        expect(result).toMatchObject({ branch: undefined, detached: true, id: tagId });
        expect(await headRaw(ctx)).toBe(`${tagId}\n`);
        expect(await lastHeadMessage(ctx)).toBe('checkout: moving from main to release');
      });
    });
  });

  describe('Given a remote-tracking ref named by its short path', () => {
    describe('When checkout switches to it without asking to detach', () => {
      it('Then it detaches onto the tracking ref', async () => {
        // Arrange
        const { ctx, branchId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'org/tgt' });

        // Assert
        expect(result).toMatchObject({ branch: undefined, detached: true, id: branchId });
        expect(await lastHeadMessage(ctx)).toBe('checkout: moving from main to org/tgt');
      });
    });
  });

  describe('Given an abbreviated object id', () => {
    describe('When checkout switches to it', () => {
      it('Then it detaches and logs the abbreviation exactly as typed', async () => {
        // Arrange
        const { ctx, tagId } = await seedAmbiguity();
        const abbreviated = tagId.slice(0, ABBREVIATED_LENGTH);
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: abbreviated });

        // Assert
        expect(result.id).toBe(tagId);
        expect(await lastHeadMessage(ctx)).toBe(`checkout: moving from main to ${abbreviated}`);
      });
    });
  });

  describe('Given a full object id', () => {
    describe('When checkout switches to it', () => {
      it('Then it logs the full id, as git echoes the argument', async () => {
        // Arrange
        const { ctx, tagId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        await sut(ctx, { rev: tagId });

        // Assert
        expect(await lastHeadMessage(ctx)).toBe(`checkout: moving from main to ${tagId}`);
      });
    });
  });

  describe('Given a short name that is a branch', () => {
    describe('When checkout switches to it', () => {
      it('Then it stays on the branch', async () => {
        // Arrange
        const { ctx, branchId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'amb' });

        // Assert
        expect(result).toMatchObject({ branch: `${HEADS}amb`, detached: false, id: branchId });
        expect(await headRaw(ctx)).toBe(`ref: ${HEADS}amb\n`);
      });
    });
  });

  describe('Given a name no namespace carries', () => {
    describe('When checkout switches to it', () => {
      it('Then it refuses, naming the branch it looked for', async () => {
        // Arrange
        const { ctx } = await seedAmbiguity();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { rev: 'nope' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'BRANCH_NOT_FOUND',
          name: `${HEADS}nope`,
        });
      });
    });
  });
});

describe('checkout and tag — the name a target argument stands for', () => {
  describe('Given a short name that is both a branch and a tag', () => {
    describe('When checkout detaches onto it', () => {
      it('Then it lands on the branch, which checkout looks at first', async () => {
        // Arrange
        const { ctx, branchId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'amb', detach: true });

        // Assert
        expect(result.id).toBe(branchId);
        expect(result.detached).toBe(true);
      });
    });

    describe('When a tag is created over it', () => {
      it('Then it names the tag the revision ladder reaches first', async () => {
        // Arrange
        const { ctx, tagId } = await seedAmbiguity();
        const sut = tagCreate;

        // Act
        await sut(ctx, { name: 'fresh', target: 'amb' });

        // Assert
        expect(await resolveRef(ctx, 'refs/tags/fresh' as RefName)).toBe(tagId);
      });
    });

    describe('When a tag is created over its fully qualified branch path', () => {
      it('Then it names the branch', async () => {
        // Arrange
        const { ctx, branchId } = await seedAmbiguity();
        const sut = tagCreate;

        // Act
        await sut(ctx, { name: 'fresh', target: 'heads/amb' });

        // Assert
        expect(await resolveRef(ctx, 'refs/tags/fresh' as RefName)).toBe(branchId);
      });
    });
  });

  describe('Given a short name that is only a tag', () => {
    describe('When checkout detaches onto it', () => {
      it('Then it lands on the tag', async () => {
        // Arrange
        const { ctx, tagId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'release', detach: true });

        // Assert
        expect(result.id).toBe(tagId);
      });
    });
  });

  describe('Given a remote-tracking ref named by its short path', () => {
    describe('When checkout detaches onto it', () => {
      it('Then it lands on the tracking ref', async () => {
        // Arrange
        const { ctx, branchId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'org/tgt', detach: true });

        // Assert
        expect(result.id).toBe(branchId);
      });
    });
  });

  describe('Given an abbreviated object id that names no ref', () => {
    describe('When checkout detaches onto it', () => {
      it('Then it lands on the object it abbreviates', async () => {
        // Arrange
        const { ctx, tagId } = await seedAmbiguity();
        const sut = checkout;

        // Act
        const result = await sut(ctx, {
          rev: tagId.slice(0, ABBREVIATED_LENGTH),
          detach: true,
        });

        // Assert
        expect(result.id).toBe(tagId);
      });
    });

    describe('When a tag is created over it', () => {
      it('Then it names the object it abbreviates', async () => {
        // Arrange
        const { ctx, branchId } = await seedAmbiguity();
        const sut = tagCreate;

        // Act
        await sut(ctx, { name: 'fresh', target: branchId.slice(0, ABBREVIATED_LENGTH) });

        // Assert
        expect(await resolveRef(ctx, 'refs/tags/fresh' as RefName)).toBe(branchId);
      });
    });
  });
});

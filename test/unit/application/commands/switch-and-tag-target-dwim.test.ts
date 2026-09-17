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
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ABBREVIATED_LENGTH = 7;

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

/**
 * `branchList` / `tagList` over a symbolic ref whose chain does not resolve
 * for reading — deeper than the reading walk, dangling, or looping. git's
 * `branch` and `tag -l` drop such an entry and exit 0; these rows pin that
 * on both backends.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchList } from '../../../../src/application/commands/branch.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagList } from '../../../../src/application/commands/tag.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const HEADS = 'refs/heads/';
const TAGS = 'refs/tags/';
/** One hop past the reading walk's cap: git reads five refs, tsgit four hops. */
const OVER_DEEP_HOPS = 5;

const memoryRepo = async (): Promise<Context> => {
  const ctx = await createMemoryContext();
  await init(ctx);
  return ctx;
};

const reftableRepo = async (): Promise<Context> => {
  const ctx = withReftableStorage(await createMemoryContext());
  await init(ctx);
  return ctx;
};

const BACKENDS = [
  { backend: 'files', build: memoryRepo },
  { backend: 'reftable', build: reftableRepo },
] as const;

const writeCommit = (ctx: Context): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: emptyTreeOid(ctx.hashConfig),
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'c1',
      extraHeaders: [],
    },
  });

/** `<prefix>chain0 → chain1 → … → chainN → <prefix>tip`: `hops` symbolic
 *  reads before the direct one. */
const plantChain = async (ctx: Context, prefix: string, hops: number): Promise<void> => {
  const id = await writeCommit(ctx);
  await updateRef(ctx, `${prefix}tip` as RefName, id, { reflogMessage: 'plant' });
  const last = `${prefix}tip` as RefName;
  for (let step = hops - 1; step >= 0; step -= 1) {
    const target = step === hops - 1 ? last : (`${prefix}chain${step + 1}` as RefName);
    await writeSymbolicRef(ctx, `${prefix}chain${step}` as RefName, target);
  }
};

const branchNames = async (ctx: Context): Promise<ReadonlyArray<RefName>> =>
  (await branchList(ctx)).branches.map((branch) => branch.name);

const tagNames = async (ctx: Context): Promise<ReadonlyArray<RefName>> =>
  (await tagList(ctx)).tags.map((tag) => tag.name);

describe('ref listing — a chain that does not resolve for reading', () => {
  describe.each(BACKENDS)('$backend backend', ({ build }) => {
    describe('Given a branch symref chain one hop past the reading walk', () => {
      describe('When branchList runs', () => {
        it('Then the over-deep head is omitted and every readable branch is listed', async () => {
          // Arrange
          const ctx = await build();
          await plantChain(ctx, HEADS, OVER_DEEP_HOPS);

          // Act
          const names = await branchNames(ctx);

          // Assert
          expect(names).not.toContain(`${HEADS}chain0` as RefName);
          expect(names).toContain(`${HEADS}chain1` as RefName);
          expect(names).toContain(`${HEADS}tip` as RefName);
        });
      });
    });

    describe('Given a branch symref pointing at a name that does not exist', () => {
      describe('When branchList runs', () => {
        it('Then the dangling branch is omitted', async () => {
          // Arrange
          const ctx = await build();
          const id = await writeCommit(ctx);
          await updateRef(ctx, `${HEADS}kept` as RefName, id, { reflogMessage: 'plant' });
          await writeSymbolicRef(ctx, `${HEADS}dang` as RefName, `${HEADS}gone` as RefName);

          // Act
          const names = await branchNames(ctx);

          // Assert
          expect(names).toEqual([`${HEADS}kept` as RefName]);
        });
      });
    });

    describe('Given two branch symrefs naming each other', () => {
      describe('When branchList runs', () => {
        it('Then both looping branches are omitted', async () => {
          // Arrange
          const ctx = await build();
          const id = await writeCommit(ctx);
          await updateRef(ctx, `${HEADS}kept` as RefName, id, { reflogMessage: 'plant' });
          await writeSymbolicRef(ctx, `${HEADS}cyc1` as RefName, `${HEADS}cyc2` as RefName);
          await writeSymbolicRef(ctx, `${HEADS}cyc2` as RefName, `${HEADS}cyc1` as RefName);

          // Act
          const names = await branchNames(ctx);

          // Assert
          expect(names).toEqual([`${HEADS}kept` as RefName]);
        });
      });
    });

    describe('Given a tag symref chain one hop past the reading walk', () => {
      describe('When tagList runs', () => {
        it('Then the over-deep head is omitted and every readable tag is listed', async () => {
          // Arrange
          const ctx = await build();
          await plantChain(ctx, TAGS, OVER_DEEP_HOPS);

          // Act
          const names = await tagNames(ctx);

          // Assert
          expect(names).not.toContain(`${TAGS}chain0` as RefName);
          expect(names).toContain(`${TAGS}chain1` as RefName);
          expect(names).toContain(`${TAGS}tip` as RefName);
        });
      });
    });

    describe('Given a tag symref pointing at a name that does not exist', () => {
      describe('When tagList runs', () => {
        it('Then the dangling tag is omitted', async () => {
          // Arrange
          const ctx = await build();
          const id = await writeCommit(ctx);
          await updateRef(ctx, `${TAGS}kept` as RefName, id, { reflogMessage: 'plant' });
          await writeSymbolicRef(ctx, `${TAGS}dang` as RefName, `${HEADS}gone` as RefName);

          // Act
          const names = await tagNames(ctx);

          // Assert
          expect(names).toEqual([`${TAGS}kept` as RefName]);
        });
      });
    });

    describe('Given a branch whose symref target resolves within the reading walk', () => {
      describe('When branchList runs', () => {
        it('Then it is listed at the chain tip value', async () => {
          // Arrange
          const ctx = await build();
          await plantChain(ctx, HEADS, OVER_DEEP_HOPS - 1);
          const tip = await getRefStore(ctx).resolveDirect(`${HEADS}tip` as RefName);

          // Act
          const { branches } = await branchList(ctx);

          // Assert
          const head = branches.find((branch) => branch.name === `${HEADS}chain0`);
          expect(tip.kind).toBe('direct');
          expect(head?.id).toBe(tip.kind === 'direct' ? tip.id : undefined);
        });
      });
    });
  });
});

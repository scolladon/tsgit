import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../../../src/adapters/node/node-adapter.js';
import {
  createRefStore,
  type RefUpdate,
} from '../../../../src/application/primitives/ref-store.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from './reftable-fixtures.js';

const ID = 'a'.repeat(40) as ObjectId;
const OTHER_ID = 'c'.repeat(40) as ObjectId;
const REMOTES = 'refs/remotes';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const nodeContext = async (): Promise<Context> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-transaction-names-'));
  tempRoots.push(root);
  return createNodeContext({ workDir: root });
};

type Backend = 'files' | 'reftable';

const BACKENDS = [
  { label: 'files on memory', backend: 'files', build: async () => createMemoryContext() },
  { label: 'files on node', backend: 'files', build: nodeContext },
  {
    label: 'reftable on memory',
    backend: 'reftable',
    build: async () => withReftableStorage(createMemoryContext()),
  },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly backend: Backend;
  readonly build: () => Promise<Context>;
}>;

const ref = (short: string): RefName => `${REMOTES}/${short}` as RefName;
const set = (short: string, expected?: ObjectId): RefUpdate =>
  expected === undefined
    ? { kind: 'set', name: ref(short), id: ID }
    : { kind: 'set', name: ref(short), id: ID, expected };
const del = (short: string): RefUpdate => ({ kind: 'delete', name: ref(short) });

interface Row {
  readonly label: string;
  readonly existing: readonly string[];
  readonly updates: readonly RefUpdate[];
  readonly refusal: Readonly<Record<Backend, { readonly code: string; readonly blocking: string }>>;
}

const both = (code: string, blocking: string): Row['refusal'] => ({
  files: { code, blocking },
  reftable: { code, blocking },
});

const ROWS: readonly Row[] = [
  {
    label: 'creating d while deleting the existing d/x',
    existing: ['d/x'],
    updates: [set('d'), del('d/x')],
    refusal: both('FILE_EXISTS', 'd/x'),
  },
  {
    label: 'deleting the existing d/x before creating d',
    existing: ['d/x'],
    updates: [del('d/x'), set('d')],
    refusal: both('FILE_EXISTS', 'd/x'),
  },
  {
    label: 'creating e/x while deleting the existing e',
    existing: ['e'],
    updates: [set('e/x'), del('e')],
    refusal: both('NOT_A_DIRECTORY', 'e'),
  },
  {
    label: 'creating f and f/x together',
    existing: [],
    updates: [set('f'), set('f/x')],
    refusal: both('FILE_EXISTS', 'f/x'),
  },
  {
    label: 'creating g/x before g',
    existing: [],
    updates: [set('g/x'), set('g')],
    refusal: {
      files: { code: 'FILE_EXISTS', blocking: 'g/x' },
      reftable: { code: 'NOT_A_DIRECTORY', blocking: 'g' },
    },
  },
  {
    label: 'creating h while deleting the absent h/x',
    existing: [],
    updates: [set('h'), del('h/x')],
    refusal: both('FILE_EXISTS', 'h/x'),
  },
  {
    label: 'deleting the absent j before creating j/x',
    existing: [],
    updates: [del('j'), set('j/x')],
    refusal: both('FILE_EXISTS', 'j/x'),
  },
  {
    label: 'creating a/y, a and a/b',
    existing: [],
    updates: [set('a/y'), set('a'), set('a/b')],
    refusal: {
      files: { code: 'FILE_EXISTS', blocking: 'a/b' },
      reftable: { code: 'NOT_A_DIRECTORY', blocking: 'a' },
    },
  },
  {
    label: 'creating m/x, m and k over the existing k/z',
    existing: ['k/z'],
    updates: [set('m/x'), set('m'), set('k')],
    refusal: {
      files: { code: 'FILE_EXISTS', blocking: 'm/x' },
      reftable: { code: 'NOT_A_DIRECTORY', blocking: 'm' },
    },
  },
  {
    label: 'creating k over the existing k/z before m/x and m',
    existing: ['k/z'],
    updates: [set('k'), set('m/x'), set('m')],
    refusal: both('FILE_EXISTS', 'k/z'),
  },
  {
    label: 'updating the existing v while creating v/w',
    existing: ['v'],
    updates: [set('v', ID), set('v/w')],
    refusal: both('NOT_A_DIRECTORY', 'v'),
  },
  {
    label: 'creating q and q/x before e/x/y under the existing e',
    existing: ['e'],
    updates: [set('q'), set('q/x'), set('e/x/y')],
    refusal: {
      files: { code: 'NOT_A_DIRECTORY', blocking: 'e' },
      reftable: { code: 'FILE_EXISTS', blocking: 'q/x' },
    },
  },
  {
    label: 'creating p/e/x/y under the existing p/e while logging p',
    existing: ['p/e'],
    updates: [
      set('p/e/x/y'),
      { kind: 'reflogOnly', name: ref('p'), reflog: { oldId: ID, newId: ID, message: 'm' } },
    ],
    refusal: both('NOT_A_DIRECTORY', 'p'),
  },
  {
    label: 'deleting the existing n/x while creating n/x/w',
    existing: ['n/x'],
    updates: [del('n/x'), set('n/x/w')],
    refusal: both('NOT_A_DIRECTORY', 'n/x'),
  },
];

/** `w` packed and `w/x` loose — a files-backend-only shape: neither backend
 *  lets a ref be created under an existing one, so `w` can only have been
 *  packed before `w/x` was written straight to disk. */
const seedSplitRefs = async (ctx: Context): Promise<void> => {
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/packed-refs`,
    `# pack-refs with: peeled fully-peeled sorted \n${ID} ${ref('w')}\n`,
  );
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref('w/x')}`, `${ID}\n`);
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  return undefined;
};

/** `shorts` existing with NO loose file behind them — `packed-refs` on the
 *  files backend, the stack on reftable. */
const seedUnlooseRefs = async (
  ctx: Context,
  backend: Backend,
  shorts: readonly string[],
): Promise<void> => {
  if (backend === 'reftable') {
    await createRefStore(ctx).applyRefUpdates(shorts.map((short) => set(short)));
    return;
  }
  const lines = [...shorts]
    .map((short) => `${ID} ${ref(short)}\n`)
    .sort()
    .join('');
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/packed-refs`,
    `# pack-refs with: peeled fully-peeled sorted \n${lines}`,
  );
};

interface SingleRow {
  readonly label: string;
  readonly existing: readonly string[];
  readonly update: RefUpdate;
  readonly code: string;
  readonly blocking: string;
}

const SINGLE_ROWS: readonly SingleRow[] = [
  {
    label: 'creating k/z under the existing k',
    existing: ['k'],
    update: set('k/z'),
    code: 'NOT_A_DIRECTORY',
    blocking: 'k',
  },
  {
    label: 'pointing k/sym at a ref under the existing k',
    existing: ['k'],
    update: { kind: 'setSymbolic', name: ref('k/sym'), target: 'refs/heads/main' as RefName },
    code: 'NOT_A_DIRECTORY',
    blocking: 'k',
  },
  {
    label: 'deleting the absent e above the existing e/x',
    existing: ['e/x'],
    update: del('e'),
    code: 'FILE_EXISTS',
    blocking: 'e/x',
  },
  {
    label: 'deleting the absent d/x/y under the existing d/x',
    existing: ['d/x'],
    update: del('d/x/y'),
    code: 'NOT_A_DIRECTORY',
    blocking: 'd/x',
  },
];

interface PriorityRow {
  readonly label: string;
  readonly updates: readonly RefUpdate[];
  readonly refusal: Readonly<
    Record<Backend, { readonly code: string; readonly blocking?: string }>
  >;
}

/** One transaction carrying a name conflict AND a value mismatch. The files
 *  backend raises each name it checks while taking that name's lock in update
 *  order, and only afterwards the names it checks in one batch; the reftable
 *  backend verifies every value first. */
const PRIORITY_ROWS: readonly PriorityRow[] = [
  {
    label: 'the mismatch first, a name checked under its lock after it',
    updates: [set('m', OTHER_ID), set('v/w')],
    refusal: {
      files: { code: 'REF_UPDATE_CONFLICT' },
      reftable: { code: 'REF_UPDATE_CONFLICT' },
    },
  },
  {
    label: 'a pair of colliding creates first, the mismatch after them',
    updates: [set('f'), set('f/x'), set('m', OTHER_ID)],
    refusal: {
      files: { code: 'REF_UPDATE_CONFLICT' },
      reftable: { code: 'REF_UPDATE_CONFLICT' },
    },
  },
  {
    label: 'a pair checked under their locks first, the mismatch after them',
    updates: [set('v/w'), set('v/w/y'), set('m', OTHER_ID)],
    refusal: {
      files: { code: 'NOT_A_DIRECTORY', blocking: 'v' },
      reftable: { code: 'REF_UPDATE_CONFLICT' },
    },
  },
  {
    label: 'the mismatch first, a pair checked under their locks after it',
    updates: [set('m', OTHER_ID), set('v/w'), set('v/w/y')],
    refusal: {
      files: { code: 'REF_UPDATE_CONFLICT' },
      reftable: { code: 'REF_UPDATE_CONFLICT' },
    },
  },
];

describe('ref-store — names that collide inside one transaction', () => {
  describe.each(BACKENDS)('$label', ({ backend, build }) => {
    describe.each(ROWS)('Given $label', ({ existing, updates, refusal }) => {
      describe('When applyRefUpdates applies the transaction', () => {
        it('Then it refuses naming the blocking ref and changes nothing', async () => {
          // Arrange
          const ctx = await build();
          const sut = createRefStore(ctx);
          await sut.applyRefUpdates(existing.map((short) => set(short)));
          const namesBefore = await sut.listRefNames(`${REMOTES}/` as RefName);

          // Act
          const data = await refusalOf(() => sut.applyRefUpdates(updates));

          // Assert
          const expected = refusal[backend];
          expect(data).toEqual({
            code: expected.code,
            path: `${ctx.layout.gitDir}/${ref(expected.blocking)}`,
          });
          expect(await sut.listRefNames(`${REMOTES}/` as RefName)).toEqual(namesBefore);
        });
      });
    });

    describe('Given an update of an absent ref that expects a value, beside the existing ref under it', () => {
      describe('When applyRefUpdates applies it', () => {
        it('Then the name is not checked and the compare-and-swap refuses', async () => {
          // Arrange
          const ctx = await build();
          const sut = createRefStore(ctx);
          await sut.applyRefUpdates([set('q/z')]);

          // Act
          const data = await refusalOf(() => sut.applyRefUpdates([set('q', OTHER_ID), set('q/z')]));

          // Assert
          expect(data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: ref('q'),
            expected: OTHER_ID,
            actual: 'absent',
          });
        });
      });
    });

    describe.each(SINGLE_ROWS)('Given $label', ({ existing, update, code, blocking }) => {
      describe('When applyRefUpdates applies that one update', () => {
        it('Then it refuses naming the blocking ref and changes nothing', async () => {
          // Arrange
          const ctx = await build();
          await seedUnlooseRefs(ctx, backend, existing);
          const sut = createRefStore(ctx);
          const namesBefore = await sut.listRefNames(`${REMOTES}/` as RefName);

          // Act
          const data = await refusalOf(() => sut.applyRefUpdates([update]));

          // Assert
          expect(data).toEqual({
            code,
            path: `${ctx.layout.gitDir}/${ref(blocking)}`,
          });
          expect(await sut.listRefNames(`${REMOTES}/` as RefName)).toEqual(namesBefore);
        });
      });
    });

    describe.skipIf(backend === 'reftable')(
      'Given a directory nothing can be removed from at one name',
      () => {
        describe.each([
          {
            label: 'that name before a pair of colliding creates',
            updates: [set('blk'), set('g'), set('g/x')],
            blocked: true,
          },
          {
            label: 'a pair of colliding creates before that name',
            updates: [set('g'), set('g/x'), set('blk')],
            blocked: true,
          },
          {
            label: 'that name before a value mismatch',
            updates: [set('blk'), set('g'), set('g/x'), set('m', OTHER_ID)],
            blocked: true,
          },
          {
            label: 'a value mismatch before that name',
            updates: [set('m', OTHER_ID), set('blk'), set('g'), set('g/x')],
            blocked: false,
          },
        ])('When applyRefUpdates applies $label', ({ updates, blocked }) => {
          it('Then it refuses with the one git raises while taking that lock', async () => {
            // Arrange
            const ctx = await build();
            const sut = createRefStore(ctx);
            await sut.applyRefUpdates([set('m')]);
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref('blk')}/x.lock`, '');

            // Act
            const data = await refusalOf(() => sut.applyRefUpdates(updates));

            // Assert
            expect(data).toEqual(
              blocked
                ? { code: 'DIRECTORY_NOT_EMPTY', path: `${ctx.layout.gitDir}/${ref('blk')}` }
                : { code: 'REF_UPDATE_CONFLICT', name: ref('m'), expected: OTHER_ID, actual: ID },
            );
          });
        });
      },
    );

    describe.skipIf(backend === 'reftable')(
      'Given a tree of empty directories before a name that refuses',
      () => {
        describe('When applyRefUpdates applies both', () => {
          it('Then the earlier tree is gone, as git leaves it after the same refusal', async () => {
            // Arrange
            const ctx = await build();
            const sut = createRefStore(ctx);
            await ctx.fs.mkdir(`${ctx.layout.gitDir}/${ref('e1')}/a/b`);
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref('blk')}/x.lock`, '');

            // Act
            await refusalOf(() =>
              sut.applyRefUpdates([set('e1'), set('blk'), set('g'), set('g/x')]),
            );

            // Assert
            expect(await ctx.fs.exists(`${ctx.layout.gitDir}/${ref('e1')}`)).toBe(false);
          });
        });
      },
    );

    describe.skipIf(backend === 'reftable')(
      'Given a packed ref above a loose ref of its own',
      () => {
        describe('When applyRefUpdates moves the loose ref under it', () => {
          it('Then the write goes through — git checks a name only when the ref is absent', async () => {
            // Arrange — neither store can create this shape; only a hand-written
            // `packed-refs` beside a loose file can.
            const ctx = await build();
            await seedUnlooseRefs(ctx, backend, ['k']);
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref('k/z')}`, `${ID}\n`);
            const sut = createRefStore(ctx);

            // Act
            await sut.applyRefUpdates([{ kind: 'set', name: ref('k/z'), id: OTHER_ID }]);

            // Assert
            expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${ref('k/z')}`)).toBe(
              `${OTHER_ID}\n`,
            );
          });
        });

        describe('When applyRefUpdates moves it with a value it requires', () => {
          it('Then the write goes through too', async () => {
            // Arrange
            const ctx = await build();
            await seedUnlooseRefs(ctx, backend, ['k']);
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref('k/z')}`, `${ID}\n`);
            const sut = createRefStore(ctx);

            // Act
            await sut.applyRefUpdates([
              { kind: 'set', name: ref('k/z'), id: OTHER_ID, expected: ID },
            ]);

            // Assert
            expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${ref('k/z')}`)).toBe(
              `${OTHER_ID}\n`,
            );
          });
        });
      },
    );

    describe.skipIf(backend === 'reftable')(
      'Given a packed ref above a packed ref of its own',
      () => {
        describe('When applyRefUpdates moves the one under it', () => {
          it('Then the write goes through — the packed store already answers for the name', async () => {
            // Arrange
            const ctx = await build();
            await seedUnlooseRefs(ctx, backend, ['k', 'k/z']);
            const sut = createRefStore(ctx);

            // Act
            await sut.applyRefUpdates([{ kind: 'set', name: ref('k/z'), id: OTHER_ID }]);

            // Assert
            expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${ref('k/z')}`)).toBe(
              `${OTHER_ID}\n`,
            );
          });
        });
      },
    );

    describe('Given an absent name no existing ref sits above or under', () => {
      describe('When applyRefUpdates deletes it alone', () => {
        it('Then the delete is a no-op', async () => {
          // Arrange
          const ctx = await build();
          await seedUnlooseRefs(ctx, backend, ['k']);
          const sut = createRefStore(ctx);

          // Act
          await sut.applyRefUpdates([del('unrelated')]);

          // Assert
          expect(await sut.listRefNames(`${REMOTES}/` as RefName)).toEqual([ref('k')]);
        });
      });
    });

    describe('Given one transaction carrying both a name conflict and a value mismatch', () => {
      describe.each(PRIORITY_ROWS)(
        'When applyRefUpdates applies $label',
        ({ updates, refusal }) => {
          it('Then it refuses with the one git reports for that backend', async () => {
            // Arrange
            const ctx = await build();
            const sut = createRefStore(ctx);
            await sut.applyRefUpdates([set('v'), set('m')]);

            // Act
            const data = await refusalOf(() => sut.applyRefUpdates(updates));

            // Assert
            const expected = refusal[backend];
            expect(data).toEqual(
              expected.blocking === undefined
                ? { code: expected.code, name: ref('m'), expected: OTHER_ID, actual: ID }
                : { code: expected.code, path: `${ctx.layout.gitDir}/${ref(expected.blocking)}` },
            );
          });
        },
      );
    });

    describe.skipIf(backend === 'reftable')('Given prefix-related names that all exist', () => {
      describe('When applyRefUpdates deletes both', () => {
        it('Then no name is checked and both are gone', async () => {
          // Arrange
          const ctx = await build();
          const sut = createRefStore(ctx);
          await seedSplitRefs(ctx);

          // Act
          await sut.applyRefUpdates([del('w'), del('w/x')]);

          // Assert
          expect(await sut.listRefNames(`${REMOTES}/` as RefName)).toEqual([]);
        });
      });
    });
  });
});

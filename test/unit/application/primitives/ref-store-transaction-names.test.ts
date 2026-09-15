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

/** `w` and `w/x` both existing, each written by its own update — one
 *  transaction could not create both. On the files backend `w` can only be
 *  packed. */
const seedSplitRefs = async (ctx: Context, backend: Backend): Promise<void> => {
  if (backend === 'reftable') {
    await createRefStore(ctx).applyRefUpdates([set('w')]);
    await createRefStore(ctx).applyRefUpdates([set('w/x')]);
    return;
  }
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

    describe('Given prefix-related names that all exist', () => {
      describe('When applyRefUpdates deletes both', () => {
        it('Then no name is checked and both are gone', async () => {
          // Arrange
          const ctx = await build();
          const sut = createRefStore(ctx);
          await seedSplitRefs(ctx, backend);

          // Act
          await sut.applyRefUpdates([del('w'), del('w/x')]);

          // Assert
          expect(await sut.listRefNames(`${REMOTES}/` as RefName)).toEqual([]);
        });
      });
    });
  });
});

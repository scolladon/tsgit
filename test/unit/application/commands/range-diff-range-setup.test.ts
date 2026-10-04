/**
 * `git range-diff A..B C..D` sets up each range as a revision walk would —
 * `handle_dotdot_1` parsing both ends into the one object table the process
 * keeps — and dies `Invalid revision range <A..B>` when either end fails to
 * parse, after the `error:` lines the failed parse prints.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { rangeDiff } from '../../../../src/application/commands/range-diff.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

interface Store {
  readonly ctx: Context;
  readonly logged: string[];
  readonly blob: ObjectId;
  readonly root: ObjectId;
  /** A commit, child of `root`, naming `blob` as its tree. */
  readonly blobTree: ObjectId;
}

const commitOf = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
  });

const store = async (): Promise<Store> => {
  const logged: string[] = [];
  const ctx: Context = {
    ...createMemoryContext(),
    logger: { error: (line: string) => logged.push(line) },
  };
  await init(ctx);
  const content = new TextEncoder().encode('a\n');
  const blob = await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content });
  const tree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry('100644' as FileMode, 'a', blob)],
  });
  const root = await commitOf(ctx, tree, [], 'root\n');
  const blobTree = await commitOf(ctx, blob, [root], 'tb\n');
  return { ctx, logged, blob, root, blobTree };
};

type Range = readonly [base: ObjectId, tip: ObjectId];

interface Scenario {
  readonly old: Range;
  readonly new: Range;
  readonly expected: { readonly expression: string; readonly logged: ReadonlyArray<string> };
}

interface Case {
  readonly label: string;
  readonly scenario: (repo: Store) => Scenario;
}

const CASES: ReadonlyArray<Case> = [
  {
    label: 'an old range whose base is a blob the tip names as its tree',
    scenario: ({ blob, root, blobTree }) => ({
      old: [blob, blobTree],
      new: [root, blobTree],
      expected: {
        expression: `${blob}..${blobTree}`,
        logged: [
          `object ${blob} is a blob, not a tree`,
          `bad tree pointer ${blob} in commit ${blobTree}`,
        ],
      },
    }),
  },
  {
    label: 'a new range whose base is a blob the old range typed a tree',
    scenario: ({ blob, root, blobTree }) => ({
      old: [root, blobTree],
      new: [blob, blobTree],
      expected: {
        expression: `${blob}..${blobTree}`,
        logged: [`object ${blob} is a tree, not a blob`],
      },
    }),
  },
  {
    label: 'an old range whose base is absent',
    scenario: ({ root }) => ({
      old: [MISSING, root],
      new: [root, root],
      expected: { expression: `${MISSING}..${root}`, logged: [] },
    }),
  },
  {
    label: 'a new range whose tip is absent',
    scenario: ({ root }) => ({
      old: [root, root],
      new: [root, MISSING],
      expected: { expression: `${root}..${MISSING}`, logged: [] },
    }),
  },
];

const refusalOf = async (
  { ctx, logged }: Store,
  { old, new: next }: Scenario,
): Promise<Scenario['expected'] | undefined> => {
  const sut = rangeDiff;
  try {
    await sut(ctx, {
      old: { base: old[0], tip: old[1] },
      new: { base: next[0], tip: next[1] },
    });
    return undefined;
  } catch (error) {
    const data = (
      error as { readonly data?: { readonly code?: string; readonly expression?: string } }
    ).data;
    if (data?.code !== 'INVALID_REVISION_RANGE' || data.expression === undefined) throw error;
    return { expression: data.expression, logged };
  }
};

describe('rangeDiff range setup', () => {
  describe.each(CASES)('Given $label', ({ scenario }) => {
    describe('When rangeDiff sets the ranges up', () => {
      it('Then it logs what git does and refuses the range git dies on', async () => {
        // Arrange
        const repo = await store();
        const built = scenario(repo);

        // Act
        const result = await refusalOf(repo, built);

        // Assert
        expect(result).toEqual(built.expected);
      });
    });
  });
});

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
  /** `root`'s tree. */
  readonly tree: ObjectId;
  readonly root: ObjectId;
  /** A commit, child of `root`, naming `blob` as its tree. */
  readonly blobTree: ObjectId;
  /** A commit, child of `root`, adding a file; `main` and `HEAD` point to it. */
  readonly second: ObjectId;
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
  const secondTree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [
      treeEntry('100644' as FileMode, 'a', blob),
      treeEntry('100644' as FileMode, 'b', blob),
    ],
  });
  const second = await commitOf(ctx, secondTree, [root], 'second\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${second}\n`);
  return { ctx, logged, blob, tree, root, blobTree, second };
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
    scenario: ({ root, second }) => ({
      old: [root, second],
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

type Spelt = readonly [base: string, tip: string];

const runRanges = async ({ ctx }: Store, old: Spelt, next: Spelt): Promise<unknown> => {
  const sut = rangeDiff;
  try {
    const entries = await sut(ctx, {
      old: { base: old[0], tip: old[1] },
      new: { base: next[0], tip: next[1] },
    });
    return entries.map((entry) => [entry.status, entry.old?.id, entry.new?.id]);
  } catch (error) {
    return (error as { readonly data?: unknown }).data;
  }
};

interface SpeltCase {
  readonly label: string;
  readonly ranges: (repo: Store) => { readonly old: Spelt; readonly new: Spelt };
  readonly expected: (repo: Store) => unknown;
}

const NOT_RANGES: ReadonlyArray<SpeltCase> = [
  {
    label: 'an old range from a commit to itself',
    ranges: ({ root, second }) => ({ old: [root, root], new: [root, second] }),
    expected: ({ root }) => ({ code: 'NEED_TWO_COMMIT_RANGES', expression: `${root}..${root}` }),
  },
  {
    label: 'a new range from a commit to itself',
    ranges: ({ root, second }) => ({ old: [root, second], new: [second, second] }),
    expected: ({ second }) => ({
      code: 'NEED_TWO_COMMIT_RANGES',
      expression: `${second}..${second}`,
    }),
  },
  {
    label: 'an old range from a tree to itself',
    ranges: ({ tree, root, second }) => ({ old: [tree, tree], new: [root, second] }),
    expected: ({ tree }) => ({ code: 'NEED_TWO_COMMIT_RANGES', expression: `${tree}..${tree}` }),
  },
  {
    label: 'an old range with no base, its tip what HEAD names',
    ranges: ({ root, second }) => ({ old: ['', second], new: [root, second] }),
    expected: ({ second }) => ({ code: 'NEED_TWO_COMMIT_RANGES', expression: `..${second}` }),
  },
];

const ACCEPTED: ReadonlyArray<SpeltCase> = [
  {
    label: 'an old range whose base is a tree',
    ranges: ({ tree, root, second }) => ({ old: [tree, second], new: [root, second] }),
    expected: ({ root, second }) => [
      ['only-old', root, undefined],
      ['unchanged', second, second],
    ],
  },
  {
    label: 'an old range whose tip is a tree',
    ranges: ({ tree, root, second }) => ({ old: [root, tree], new: [root, second] }),
    expected: ({ second }) => [['only-new', undefined, second]],
  },
  {
    label: 'an old range with no tip, read as HEAD',
    ranges: ({ root, second }) => ({ old: [root, ''], new: [root, second] }),
    expected: ({ second }) => [['unchanged', second, second]],
  },
];

const BAD_REVISIONS: ReadonlyArray<SpeltCase> = [
  {
    label: 'an old range whose base peels a commit to the blob it names as its tree',
    ranges: ({ blobTree, root, second }) => ({
      old: [`${blobTree}^{tree}`, second],
      new: [root, second],
    }),
    expected: ({ blobTree, second, blob }) => ({
      data: { code: 'REVPARSE_UNRESOLVED', expression: `${blobTree}^{tree}..${second}` },
      logged: [`object ${blob} is a tree, not a blob`],
    }),
  },
];

describe('rangeDiff range kinds', () => {
  describe.each(NOT_RANGES)('Given $label', ({ ranges, expected }) => {
    describe('When rangeDiff sets the ranges up', () => {
      it('Then it refuses for want of two commit ranges', async () => {
        // Arrange
        const repo = await store();
        const { old, new: next } = ranges(repo);

        // Act
        const result = await runRanges(repo, old, next);

        // Assert
        expect(result).toEqual(expected(repo));
      });
    });
  });

  describe.each(ACCEPTED)('Given $label', ({ ranges, expected }) => {
    describe('When rangeDiff compares the ranges', () => {
      it('Then it walks what git log lists for each', async () => {
        // Arrange
        const repo = await store();
        const { old, new: next } = ranges(repo);

        // Act
        const result = await runRanges(repo, old, next);

        // Assert
        expect(result).toEqual(expected(repo));
      });
    });
  });

  describe.each(BAD_REVISIONS)('Given $label', ({ ranges, expected }) => {
    describe('When rangeDiff sets the ranges up', () => {
      it('Then it logs the typing conflict and refuses the range as a bad revision', async () => {
        // Arrange
        const repo = await store();
        const { old, new: next } = ranges(repo);

        // Act
        const result = await runRanges(repo, old, next);

        // Assert
        expect({ data: result, logged: repo.logged }).toEqual(expected(repo));
      });
    });
  });
});

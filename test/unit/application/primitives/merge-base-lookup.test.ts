/**
 * `git merge-base` looks each argument up as a commit before it walks —
 * `lookup_commit_reference` against the one object table the invocation
 * builds — and dies `Not a valid commit name <x>` on the first that names none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeBase } from '../../../../src/application/primitives/merge-base.js';
import * as readObjectModule from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type {
  AuthorIdentity,
  FileMode,
  ObjectId,
  ObjectType,
} from '../../../../src/domain/objects/index.js';
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
  readonly tree: ObjectId;
  readonly otherTree: ObjectId;
  readonly commit: ObjectId;
}

const commitOf = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message = 'm\n',
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
  });

const tagOf = (ctx: Context, target: ObjectId, objectType: ObjectType): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: target,
      objectType,
      tagName: 't',
      tagger: AUTHOR,
      message: 'm\n',
      extraHeaders: [],
    },
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
  const otherTree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const commit = await commitOf(ctx, tree, []);
  return { ctx, logged, blob, tree, otherTree, commit };
};

interface Refusal {
  readonly name: ObjectId;
  readonly logged: ReadonlyArray<string>;
}

const refusalOf = async (
  { ctx, logged }: Store,
  args: ReadonlyArray<ObjectId>,
  octopus?: boolean,
): Promise<Refusal | undefined> => {
  const sut = mergeBase;
  try {
    await sut(ctx, args, octopus === undefined ? undefined : { octopus });
    return undefined;
  } catch (error) {
    const data = (error as { readonly data?: { readonly code?: string; readonly name?: ObjectId } })
      .data;
    if (data?.code !== 'INVALID_COMMIT_NAME' || data.name === undefined) throw error;
    return { name: data.name, logged };
  }
};

interface Scenario {
  readonly args: ReadonlyArray<ObjectId>;
  readonly expected: Refusal;
}

interface Case {
  readonly label: string;
  readonly scenario: (repo: Store) => Promise<Scenario>;
  readonly octopus?: boolean;
}

const notACommit = (id: ObjectId, type: string): string =>
  `object ${id} is a ${type}, not a commit`;

const CASES: ReadonlyArray<Case> = [
  {
    label: 'a tree after a commit',
    scenario: async ({ commit, tree }) => ({
      args: [commit, tree],
      expected: { name: tree, logged: [notACommit(tree, 'tree')] },
    }),
  },
  {
    label: 'a tree before a commit',
    scenario: async ({ commit, tree }) => ({
      args: [tree, commit],
      expected: { name: tree, logged: [notACommit(tree, 'tree')] },
    }),
  },
  {
    label: 'a blob',
    scenario: async ({ commit, blob }) => ({
      args: [commit, blob],
      expected: { name: blob, logged: [notACommit(blob, 'blob')] },
    }),
  },
  {
    label: 'an absent object',
    scenario: async ({ commit }) => ({
      args: [commit, MISSING],
      expected: { name: MISSING, logged: [] },
    }),
  },
  {
    label: 'an annotated tag of a tree',
    scenario: async ({ ctx, commit, tree }) => {
      const tag = await tagOf(ctx, tree, 'tree');
      return { args: [commit, tag], expected: { name: tag, logged: [notACommit(tag, 'tree')] } };
    },
  },
  {
    label: 'a tag declaring an absent commit',
    scenario: async ({ ctx, commit }) => {
      const tag = await tagOf(ctx, MISSING, 'commit');
      return {
        args: [commit, tag],
        expected: { name: tag, logged: [`Could not read ${MISSING}`] },
      };
    },
  },
  {
    label: 'a tag declaring an absent tag',
    scenario: async ({ ctx, commit }) => {
      const tag = await tagOf(ctx, MISSING, 'tag');
      return { args: [commit, tag], expected: { name: tag, logged: [] } };
    },
  },
  {
    label: 'a tag declaring a tree a commit, looked up first',
    scenario: async ({ ctx, commit, tree }) => {
      const tag = await tagOf(ctx, tree, 'commit');
      return {
        args: [tag, commit],
        expected: { name: tag, logged: [`Object ${tree} not a commit`] },
      };
    },
  },
  {
    label: 'a tag declaring a tree a commit, after a commit typed that tree',
    scenario: async ({ ctx, commit, tree }) => {
      const tag = await tagOf(ctx, tree, 'commit');
      const logged = [notACommit(tree, 'tree'), `bad tag pointer to ${tree} in ${tag}`];
      return { args: [commit, tag], expected: { name: tag, logged } };
    },
  },
  {
    label: 'a commit naming a tree as its parent',
    scenario: async ({ ctx, commit, tree }) => {
      const bad = await commitOf(ctx, tree, [tree], 'y\n');
      const logged = [notACommit(tree, 'tree'), `bad parent ${tree} in commit ${bad}`];
      return { args: [commit, bad], expected: { name: bad, logged } };
    },
  },
  {
    label: 'a blob an earlier commit typed a tree',
    scenario: async ({ ctx, blob }) => ({
      args: [await commitOf(ctx, blob, [], 'x\n'), blob],
      expected: { name: blob, logged: [notACommit(blob, 'tree')] },
    }),
  },
  {
    label: 'two trees under --octopus, looked up last first',
    scenario: async ({ commit, tree, otherTree }) => ({
      args: [commit, tree, otherTree],
      expected: { name: otherTree, logged: [notACommit(otherTree, 'tree')] },
    }),
    octopus: true,
  },
];

describe('mergeBase argument lookup', () => {
  describe.each(CASES)('Given $label', ({ scenario, octopus }) => {
    describe('When mergeBase looks its arguments up', () => {
      it('Then it logs what git does and refuses the first that names no commit', async () => {
        // Arrange
        const repo = await store();
        const { args, expected } = await scenario(repo);

        // Act
        const result = await refusalOf(repo, args, octopus);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a tag of a tag of a commit', () => {
    describe('When mergeBase looks it up', () => {
      it('Then it peels through both tags to the commit', async () => {
        // Arrange
        const { ctx, commit } = await store();
        const outer = await tagOf(ctx, await tagOf(ctx, commit, 'commit'), 'tag');
        const sut = mergeBase;

        // Act
        const result = await sut(ctx, [outer, commit]);

        // Assert
        expect(result).toEqual([commit]);
      });
    });
  });

  describe('Given typing an argument fails other than on an absent object', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('When mergeBase looks it up', () => {
      it('Then the fault propagates rather than refusing the name', async () => {
        // Arrange
        const { ctx, commit, tree } = await store();
        const fault = new Error('unexpected');
        vi.spyOn(readObjectModule, 'readObjectMetadata').mockRejectedValue(fault);
        const sut = mergeBase;

        // Act
        const caught = await sut(ctx, [commit, tree]).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });
});

/**
 * `branch -d`'s safety valve measured through annotated-tag chains.
 *
 * git's `branch_merged` never compares raw ref values: `check_branch_commit`
 * runs the branch tip through `lookup_commit_reference` and the reference
 * side (upstream, else HEAD) through the same lookup, so a ref standing on an
 * annotated tag is measured at the commit that tag names. A tip that names no
 * commit at all is the `couldn't look up commit object` refusal, not the
 * not-fully-merged one; a REFERENCE that names no commit falls back to HEAD,
 * and a HEAD that names none leaves nothing merged (all measured, git 2.55.0).
 *
 * `update-ref` types what it writes into `refs/heads/*`, so these ref values
 * only ever arrive in a repository written by something else — the refs here
 * are planted at the store, below that gate, exactly as a hand-edited or
 * foreign repository presents them.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchDelete } from '../../../../src/application/commands/branch.js';
import { init } from '../../../../src/application/commands/init.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { getRefStore, refExists } from '../../../../src/application/primitives/ref-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { FileMode } from '../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  ObjectId,
  ObjectType,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

type RefStorage = Context['layout']['refStorage'];

const MAIN = 'refs/heads/main' as RefName;
const TOPIC = 'refs/heads/topic' as RefName;
const UPSTREAM = 'refs/heads/up' as RefName;

const writeEmptyTree = (ctx: Context): Promise<ObjectId> =>
  writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });

const writeCommitOn = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author, committer: author, message, extraHeaders: [] },
  });

const writeBlob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: new TextEncoder().encode(text) });

/** `ctx` with every `error:` line it logs collected in order. */
const loggingErrors = (base: Context): { readonly ctx: Context; readonly errors: string[] } => {
  const errors: string[] = [];
  return { ctx: { ...base, logger: { error: (message: string) => errors.push(message) } }, errors };
};

const writeAnnotatedTag = (
  ctx: Context,
  object: ObjectId,
  objectType: ObjectType,
  tagName: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object,
      objectType,
      tagName,
      tagger: author,
      message: `${tagName}\n`,
      extraHeaders: [],
    },
  });

/** Points `name` at `id` at the store, below `update-ref`'s own typing gate. */
const plantRef = (ctx: Context, name: RefName, id: ObjectId): Promise<unknown> =>
  getRefStore(ctx).applyRefUpdates([{ kind: 'set', name, id }]);

const configureUpstream = async (ctx: Context, upstream: RefName): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const current = await ctx.fs.readUtf8(path);
  await ctx.fs.writeUtf8(path, `${current}[branch "topic"]\n\tremote = .\n\tmerge = ${upstream}\n`);
  invalidateConfigCache(ctx);
};

const appendCoreSetting = async (ctx: Context, setting: string): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  await ctx.fs.writeUtf8(path, `${await ctx.fs.readUtf8(path)}[core]\n\t${setting}\n`);
  invalidateConfigCache(ctx);
};

interface Seeded {
  readonly ctx: Context;
  readonly tree: ObjectId;
  /** The root commit — contained by `head`. */
  readonly root: ObjectId;
  /** The commit `refs/heads/main` (and so HEAD) stands on. */
  readonly head: ObjectId;
  /** A sibling of `head` over the same root — contained by neither. */
  readonly side: ObjectId;
}

const seed = async (refStorage: RefStorage): Promise<Seeded> => {
  const base = createMemoryContext();
  const ctx = refStorage === 'reftable' ? withReftableStorage(base) : base;
  await init(ctx);
  const tree = await writeEmptyTree(ctx);
  const root = await writeCommitOn(ctx, tree, [], 'root');
  const head = await writeCommitOn(ctx, tree, [root], 'head');
  const side = await writeCommitOn(ctx, tree, [root], 'side');
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'setSymbolic', name: 'HEAD' as RefName, target: MAIN },
    { kind: 'set', name: MAIN, id: head },
  ]);
  return { ctx, tree, root, head, side };
};

const refusalOf = async (run: () => Promise<unknown>): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe.each(['files', 'reftable'] as const)('branch delete — %s ref backend', (refStorage) => {
  describe('Given a branch standing on an annotated tag whose commit HEAD contains', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the tag peels to that commit and the ref is removed', async () => {
        // Arrange
        const { ctx, root } = await seed(refStorage);
        const tag = await writeAnnotatedTag(ctx, root, 'commit', 'merged');
        await plantRef(ctx, TOPIC, tag);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given a branch standing on an annotated tag whose commit HEAD does not contain', () => {
    describe('When branch delete runs unforced', () => {
      it('Then it refuses BRANCH_NOT_FULLY_MERGED and leaves the ref standing', async () => {
        // Arrange
        const { ctx, side } = await seed(refStorage);
        const tag = await writeAnnotatedTag(ctx, side, 'commit', 'unmerged');
        await plantRef(ctx, TOPIC, tag);
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data.code).toBe('BRANCH_NOT_FULLY_MERGED');
        expect(caught.data).toEqual({ code: 'BRANCH_NOT_FULLY_MERGED', name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });

  describe('Given a branch standing on a tag of a tag whose commit HEAD contains', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the whole chain peels and the ref is removed', async () => {
        // Arrange
        const { ctx, root } = await seed(refStorage);
        const inner = await writeAnnotatedTag(ctx, root, 'commit', 'inner');
        const outer = await writeAnnotatedTag(ctx, inner, 'tag', 'outer');
        await plantRef(ctx, TOPIC, outer);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given a branch standing on a tree', () => {
    describe('When branch delete runs unforced', () => {
      it('Then it refuses the type, not the merge, and leaves the ref standing', async () => {
        // Arrange
        const { ctx, tree } = await seed(refStorage);
        await plantRef(ctx, TOPIC, tree);
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(caught.data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: tree,
        });
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });

  describe('Given a branch standing on a tree', () => {
    describe('When branch delete runs with force', () => {
      it('Then the type is never consulted and the ref is removed', async () => {
        // Arrange
        const { ctx, tree } = await seed(refStorage);
        await plantRef(ctx, TOPIC, tree);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic', force: true });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given an upstream standing on an annotated tag whose commit contains the branch', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the upstream tag peels and the ref is removed', async () => {
        // Arrange
        const { ctx, root, head } = await seed(refStorage);
        await plantRef(ctx, TOPIC, root);
        await plantRef(ctx, UPSTREAM, await writeAnnotatedTag(ctx, head, 'commit', 'upstream'));
        await configureUpstream(ctx, UPSTREAM);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given a local upstream short name two namespaces carry, the ambiguity check off', () => {
    describe('When branch delete runs unforced on a branch only the first namespace contains', () => {
      it('Then the first namespace stands as the upstream and the ref is removed', async () => {
        // Arrange
        const { ctx, root, side } = await seed(refStorage);
        await plantRef(ctx, TOPIC, side);
        await plantRef(ctx, 'refs/tags/up' as RefName, side);
        await plantRef(ctx, UPSTREAM, root);
        await configureUpstream(ctx, 'up' as RefName);
        await appendCoreSetting(ctx, 'warnAmbiguousRefs = false');
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
      });
    });
  });

  describe('Given a local upstream short name a dangling tag symref shadows', () => {
    describe('When branch delete runs unforced on a branch the branch namespace contains', () => {
      it('Then it warns the skipped symref and the ref is removed', async () => {
        // Arrange
        const { ctx: base, side } = await seed(refStorage);
        const warnings: string[] = [];
        const ctx = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
        await plantRef(ctx, TOPIC, side);
        await plantRef(ctx, UPSTREAM, side);
        await getRefStore(ctx).applyRefUpdates([
          {
            kind: 'setSymbolic',
            name: 'refs/tags/up' as RefName,
            target: 'refs/tags/nope' as RefName,
          },
        ]);
        await configureUpstream(ctx, 'up' as RefName);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(warnings).toEqual([
          'ignoring dangling symref refs/tags/up',
          "deleting branch 'topic' that has been merged to\n         'refs/heads/up', but not yet merged to HEAD",
        ]);
      });
    });
  });

  describe('Given an upstream standing on a tree and a branch HEAD contains', () => {
    describe('When branch delete runs unforced', () => {
      it('Then HEAD stands in for the upstream that names no commit and the ref is removed', async () => {
        // Arrange
        const { ctx, root, tree } = await seed(refStorage);
        await plantRef(ctx, TOPIC, root);
        await plantRef(ctx, UPSTREAM, tree);
        await configureUpstream(ctx, UPSTREAM);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given HEAD standing on a branch whose value is a tree and no upstream', () => {
    describe('When branch delete runs unforced on a branch that commit-wise is merged', () => {
      it('Then nothing counts as merged and it refuses BRANCH_NOT_FULLY_MERGED', async () => {
        // Arrange
        const { ctx, root, tree } = await seed(refStorage);
        await plantRef(ctx, TOPIC, root);
        await plantRef(ctx, MAIN, tree);
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data.code).toBe('BRANCH_NOT_FULLY_MERGED');
        expect(caught.data).toEqual({ code: 'BRANCH_NOT_FULLY_MERGED', name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });

  describe("Given HEAD whose second parent is the object the tip's tree names", () => {
    describe('When branch delete runs unforced', () => {
      it('Then HEAD is typed first and the tip fails to parse, refusing COMMIT_PARSE_FAILED', async () => {
        // Arrange
        const seeded = await seed(refStorage);
        const { ctx, errors } = loggingErrors(seeded.ctx);
        const blob = await writeBlob(ctx, 'b');
        const tip = await writeCommitOn(ctx, blob, [], 'tip');
        const head = await writeCommitOn(ctx, seeded.tree, [seeded.root, blob], 'head');
        await plantRef(ctx, MAIN, head);
        await plantRef(ctx, TOPIC, tip);
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data).toEqual({ code: 'COMMIT_PARSE_FAILED', id: tip });
        expect(errors).toEqual([
          `object ${blob} is a commit, not a tree`,
          `bad tree pointer ${blob} in commit ${tip}`,
        ]);
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });

  describe("Given HEAD's parent whose own parent is the tree HEAD carries", () => {
    describe('When branch delete runs unforced on an unrelated tip', () => {
      it('Then the walk parses that parent against the table and refuses COMMIT_PARSE_FAILED on it', async () => {
        // Arrange
        const seeded = await seed(refStorage);
        const { ctx, errors } = loggingErrors(seeded.ctx);
        const { tree } = seeded;
        const parentTree = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'b', await writeBlob(ctx, 'b')),
        ]);
        const parent = await writeCommitOn(ctx, parentTree, [tree], 'parent');
        const head = await writeCommitOn(ctx, tree, [parent], 'head');
        const tip = await writeCommitOn(ctx, tree, [], 'tip');
        await plantRef(ctx, MAIN, head);
        await plantRef(ctx, TOPIC, tip);
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data).toEqual({ code: 'COMMIT_PARSE_FAILED', id: parent });
        expect(errors).toEqual([
          `object ${tree} is a tree, not a commit`,
          `bad parent ${tree} in commit ${parent}`,
        ]);
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });

  describe('Given a branch standing on a tree, logging errors', () => {
    describe('When branch delete runs with force', () => {
      it("Then the tip's failed lookup is logged and the ref is removed", async () => {
        // Arrange
        const seeded = await seed(refStorage);
        const { ctx, errors } = loggingErrors(seeded.ctx);
        await plantRef(ctx, TOPIC, seeded.tree);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic', force: true });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(errors).toEqual([`object ${seeded.tree} is a tree, not a commit`]);
      });
    });
  });
});

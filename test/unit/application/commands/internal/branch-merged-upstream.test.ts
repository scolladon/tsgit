/**
 * `branch -d`'s safety valve reached through `branch.<n>.merge`.
 *
 * git's `set_merge` asks every fetch refspec of the branch's remote to map
 * the merge value, and only the pseudo-remote `.` falls through to
 * `repo_dwim_ref` when none does. `query_refspecs` consults a spec only when
 * it names both sides, so a negative spec, a colon-free one, an empty source
 * and an empty destination are all passed over — and the whole remote table
 * is built, refspecs validated, before any of that runs.
 *
 * The valve is observed through the delete itself: an upstream that resolves
 * and contains the tip deletes the branch, while anything that leaves no
 * upstream hands the decision to HEAD, which here contains nothing.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { branchDelete } from '../../../../../src/application/commands/branch.js';
import { init } from '../../../../../src/application/commands/init.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import { getRefStore, refExists } from '../../../../../src/application/primitives/ref-store.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { withReftableStorage } from '../../primitives/reftable-fixtures.js';

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
const TRACKING = 'refs/remotes/o/up' as RefName;
const TAG_UP = 'refs/tags/up' as RefName;
const AMBIGUOUS_TAG = 'refs/tags/dup' as RefName;
const AMBIGUOUS_HEAD = 'refs/heads/dup' as RefName;
const WILDCARD_SPEC = 'refs/heads/*:refs/remotes/o/*';

interface Seeded {
  readonly ctx: Context;
  /** The commit `topic` stands on — contained by `up`, not by HEAD. */
  readonly tip: ObjectId;
}

/**
 * `topic` on one side of a fork and HEAD on the other, so HEAD standing in
 * for a missing upstream always refuses while the upstream always allows.
 */
const seed = async (refStorage: RefStorage): Promise<Seeded> => {
  const base = createMemoryContext();
  const ctx = refStorage === 'reftable' ? withReftableStorage(base) : base;
  await init(ctx);
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const root = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author, committer: author, message: 'root', extraHeaders: [] },
  });
  const tip = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [root], author, committer: author, message: 'tip', extraHeaders: [] },
  });
  const other = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [root], author, committer: author, message: 'other', extraHeaders: [] },
  });
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'setSymbolic', name: 'HEAD' as RefName, target: MAIN },
    { kind: 'set', name: MAIN, id: other },
    { kind: 'set', name: TOPIC, id: tip },
  ]);
  return { ctx, tip };
};

const plantRef = (ctx: Context, name: RefName, id: ObjectId): Promise<unknown> =>
  getRefStore(ctx).applyRefUpdates([{ kind: 'set', name, id }]);

const appendConfig = async (ctx: Context, section: string): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const current = await ctx.fs.readUtf8(path);
  await ctx.fs.writeUtf8(path, `${current}${section}`);
  invalidateConfigCache(ctx);
};

/** `branch.topic.remote` / `branch.topic.merge`, the pair git needs before it
 *  looks for an upstream at all. */
const configureTracking = (ctx: Context, remote: string, merge: string): Promise<void> =>
  appendConfig(ctx, `[branch "topic"]\n\tremote = ${remote}\n\tmerge = ${merge}\n`);

/** `remote.o.fetch`, one line per spec, in the order git reads them. */
const configureFetchSpecs = (ctx: Context, specs: ReadonlyArray<string>): Promise<void> =>
  appendConfig(ctx, `[remote "o"]\n${specs.map((spec) => `\tfetch = ${spec}\n`).join('')}`);

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

describe.each(['files', 'reftable'] as const)('branch merged — %s ref backend', (refStorage) => {
  describe('Given a local upstream named by a short name exactly one namespace holds', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the short name resolves to the full ref and the branch is removed', async () => {
        // Arrange
        const { ctx, tip } = await seed(refStorage);
        await plantRef(ctx, UPSTREAM, tip);
        await configureTracking(ctx, '.', 'up');
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given a local upstream named by a short name two namespaces hold', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the ambiguous name resolves to nothing and it refuses BRANCH_NOT_FULLY_MERGED', async () => {
        // Arrange
        const { ctx, tip } = await seed(refStorage);
        await plantRef(ctx, AMBIGUOUS_TAG, tip);
        await plantRef(ctx, AMBIGUOUS_HEAD, tip);
        await configureTracking(ctx, '.', 'dup');
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data).toEqual({ code: 'BRANCH_NOT_FULLY_MERGED', name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });

  describe('Given a remote whose first fetch refspec does not map the merge value', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the later refspec still maps it and the branch is removed', async () => {
        // Arrange
        const { ctx, tip } = await seed(refStorage);
        await plantRef(ctx, TRACKING, tip);
        await configureTracking(ctx, 'o', 'refs/heads/up');
        await configureFetchSpecs(ctx, ['refs/heads/other:refs/remotes/o/other', WILDCARD_SPEC]);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe.each([
    { shape: 'a negative refspec', spec: '^refs/heads/up' },
    { shape: 'a refspec with no destination', spec: 'refs/heads/up' },
    { shape: 'a refspec with an empty source', spec: '+:refs/remotes/o/head' },
    { shape: 'a refspec with an empty destination', spec: 'refs/heads/up:' },
  ])('Given a remote whose first fetch refspec is $shape', ({ spec }) => {
    describe('When branch delete runs unforced', () => {
      it('Then that refspec is passed over, the next one maps, and the branch is removed', async () => {
        // Arrange
        const { ctx, tip } = await seed(refStorage);
        await plantRef(ctx, TRACKING, tip);
        await configureTracking(ctx, 'o', 'refs/heads/up');
        await configureFetchSpecs(ctx, [spec, WILDCARD_SPEC]);
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });

  describe('Given an unusable fetch refspec on a remote the branch does not name', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the whole remote table refuses REFSPEC_INVALID and the branch stands', async () => {
        // Arrange
        const { ctx, tip } = await seed(refStorage);
        await plantRef(ctx, UPSTREAM, tip);
        await configureTracking(ctx, '.', 'refs/heads/up');
        await appendConfig(ctx, '[remote "bad"]\n\tfetch = refs/heads/*\n');
        const sut = branchDelete;

        // Act
        const caught = await refusalOf(() => sut(ctx, { name: 'topic' }));

        // Assert
        expect(caught.data).toEqual({
          code: 'REFSPEC_INVALID',
          raw: 'refs/heads/*',
          reason: 'not a valid refspec',
        });
        expect(await refExists(ctx, TOPIC)).toBe(true);
      });
    });
  });
});

describe('branch merged — an unreadable dwim candidate', () => {
  describe('Given a short upstream name one namespace holds and another holds unreadably', () => {
    describe('When branch delete runs unforced', () => {
      it('Then the unreadable candidate counts for nothing and the branch is removed', async () => {
        // Arrange
        const { ctx, tip } = await seed('files');
        await plantRef(ctx, UPSTREAM, tip);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${TAG_UP}`, 'not-an-object-id\n');
        await configureTracking(ctx, '.', 'up');
        const sut = branchDelete;

        // Act
        const result = await sut(ctx, { name: 'topic' });

        // Assert
        expect(result).toEqual({ name: TOPIC });
        expect(await refExists(ctx, TOPIC)).toBe(false);
      });
    });
  });
});

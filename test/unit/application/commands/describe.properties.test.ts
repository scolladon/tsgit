import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { describe as describeCmd } from '../../../../src/application/commands/describe.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type {
  AuthorIdentity,
  ObjectId,
  TagData,
  Tree,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { type TaggedDagModel, taggedDagArbitrary } from './arbitraries.js';

const BASE_TIMESTAMP = 1_700_000_000;
const PROPERTY_RUNS = 50;

const ident = (timestamp: number): AuthorIdentity => ({
  name: 'Prop Tester',
  email: 'prop@example.com',
  timestamp,
  timezoneOffset: '+0000',
});

const reachableFrom = (
  parentSets: ReadonlyArray<ReadonlyArray<number>>,
  start: number,
): ReadonlySet<number> => {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const index = queue.pop() as number;
    for (const parent of parentSets[index] ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return seen;
};

type ExpectedDescription = { readonly name: string; readonly distance: number };

/**
 * Independent oracle, sound for a single reachable tag: the freeze/selection
 * order cannot reorder one candidate, so describe's distance must equal the
 * number of commits reachable from the target but not from the tagged commit
 * (git's `rev-list --count target ^tag`). Multi-tag election order is pinned
 * by example tests against real-git verified outputs, not here.
 */
const expectedDescription = (model: TaggedDagModel): ExpectedDescription | undefined => {
  const target = model.parentSets.length - 1;
  const reachable = reachableFrom(model.parentSets, target);
  const tag = model.tags[0];
  if (tag === undefined || !reachable.has(tag.commitIndex)) return undefined;
  const covered = reachableFrom(model.parentSets, tag.commitIndex);
  const distance = [...reachable].filter((index) => !covered.has(index)).length;
  return { name: tag.name, distance };
};

const buildRepo = async (model: TaggedDagModel): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const tree = await writeObject(ctx, emptyTree);
  const oids: ObjectId[] = [];
  for (const [index, parents] of model.parentSets.entries()) {
    const identity = ident(BASE_TIMESTAMP + index * 60);
    const oid = await createCommit(ctx, {
      tree,
      parents: parents.map((parent) => oids[parent] as ObjectId),
      author: identity,
      committer: identity,
      message: `c${index}`,
    });
    oids.push(oid);
  }
  for (const dagTag of model.tags) {
    const data: TagData = {
      object: oids[dagTag.commitIndex] as ObjectId,
      objectType: 'commit',
      tagName: dagTag.name,
      tagger: ident(BASE_TIMESTAMP + model.parentSets.length * 60),
      message: `${dagTag.name}\n`,
      extraHeaders: [],
    };
    const tagOid = await writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
    await tagCreate(ctx, { name: dagTag.name, target: tagOid });
  }
  return { ctx, head: oids[oids.length - 1] as ObjectId };
};

describe('describe early termination', () => {
  describe('Given an arbitrary tagged DAG with a unique nearest annotated tag', () => {
    describe('When describing the newest commit', () => {
      it('Then the break-enabled selection matches the exhaustive reachability oracle', async () => {
        // Arrange
        const sut = fc.asyncProperty(taggedDagArbitrary, async (model) => {
          const expected = expectedDescription(model);
          fc.pre(expected !== undefined);
          const { ctx, head } = await buildRepo(model);

          // Act
          const result = await describeCmd(ctx, head);

          // Assert
          expect(result.name).toBe(expected?.name);
          expect(result.distance).toBe(expected?.distance);
        });

        await fc.assert(sut, { numRuns: PROPERTY_RUNS });
      });
    });
  });
});

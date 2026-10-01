import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveObjectSources } from '../../../../../src/application/primitives/internal/alternate-chain.js';

const PRIMARY = '/repo/.git/objects';
const NODE_COUNT = 9;
const NUM_RUNS = 100;
const MAX_DEPTH = 5;
const REACHABLE_HOLDER_DEPTH = MAX_DEPTH - 1;

const nodePath = (index: number): string => (index === 0 ? PRIMARY : `/repo/s/n${index}`);

const arbGraph = (): fc.Arbitrary<ReadonlyArray<ReadonlyArray<number>>> =>
  fc.array(fc.array(fc.nat({ max: NODE_COUNT - 1 }), { maxLength: 4 }), {
    minLength: NODE_COUNT,
    maxLength: NODE_COUNT,
  });

const contextFor = (graph: ReadonlyArray<ReadonlyArray<number>>) =>
  createMemoryContext({
    files: Object.fromEntries(
      graph.map((targets, index) => [
        `${nodePath(index)}/info/alternates`,
        new TextEncoder().encode(targets.map((t) => `${nodePath(t)}\n`).join('')),
      ]),
    ),
  });

const resolveGraph = async (graph: ReadonlyArray<ReadonlyArray<number>>) => {
  const ctx = contextFor(graph);
  return resolveObjectSources(ctx, { probe: () => ctx.fs, reader: () => ctx.fs });
};

describe('resolveObjectSources properties', () => {
  describe('Given an arbitrary directed graph of alternates files', () => {
    describe('When the chain is resolved', () => {
      it('Then it terminates with distinct stores, the primary first and local, depths within bounds', async () => {
        await fc.assert(
          fc.asyncProperty(arbGraph(), async (graph) => {
            // Arrange + Act
            const { sources } = await resolveGraph(graph);

            // Assert
            const dirs = sources.map((s) => s.objectsDir);
            expect(new Set(dirs).size).toBe(dirs.length);
            expect(sources[0]).toEqual({ objectsDir: PRIMARY, local: true, depth: -1 });
            expect(
              sources.slice(1).every((s) => !s.local && s.depth >= 0 && s.depth <= MAX_DEPTH),
            ).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then every store a shallow-enough source lists is itself a source', async () => {
        await fc.assert(
          fc.asyncProperty(arbGraph(), async (graph) => {
            // Arrange + Act
            const { sources } = await resolveGraph(graph);

            // Assert
            const dirs = new Set(sources.map((s) => s.objectsDir));
            const listedBy = (dir: string): ReadonlyArray<string> =>
              (graph[Number(dir === PRIMARY ? 0 : dir.slice('/repo/s/n'.length))] ?? []).map(
                nodePath,
              );
            for (const source of sources.filter((s) => s.depth <= REACHABLE_HOLDER_DEPTH)) {
              for (const listed of listedBy(source.objectsDir)) expect(dirs.has(listed)).toBe(true);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then each alternate follows an earlier source that lists it', async () => {
        await fc.assert(
          fc.asyncProperty(arbGraph(), async (graph) => {
            // Arrange + Act
            const { sources } = await resolveGraph(graph);

            // Assert
            const indexOf = (dir: string): number =>
              dir === PRIMARY ? 0 : Number(dir.slice('/repo/s/n'.length));
            sources.forEach((source, position) => {
              if (position === 0) return;
              const earlier = sources.slice(0, position).map((s) => indexOf(s.objectsDir));
              const named = earlier.some((i) =>
                graph[i]?.map(nodePath).includes(source.objectsDir),
              );
              expect(named).toBe(true);
            });
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

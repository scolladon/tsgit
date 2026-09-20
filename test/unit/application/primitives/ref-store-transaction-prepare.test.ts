import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  createRefStore,
  type RefUpdate,
} from '../../../../src/application/primitives/ref-store.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { instrumentedContext } from './fixtures.js';

const ID = 'a'.repeat(40) as ObjectId;
const NAMESPACE = 'refs/remotes/origin';

type Call = { readonly method: string; readonly path: string };

/** The three prefixes every name under `refs/remotes/origin/` shares. The
 *  prepare pass reads each AS A REF — the availability check asks which proper
 *  prefixes exist — and nothing else in the run opens them that way, so the
 *  count tells a per-run prepare pass from a per-update one. */
const sharedPrefixPaths = (ctx: Context): ReadonlySet<string> =>
  new Set([
    `${ctx.layout.gitDir}/refs`,
    `${ctx.layout.gitDir}/refs/remotes`,
    `${ctx.layout.gitDir}/${NAMESPACE}`,
  ]);

interface PrepareProbes {
  /** `openWithNoFollow` on a shared prefix: the availability check asking
   *  which proper prefixes exist as refs. Nothing else in the run opens them. */
  readonly prefixRefReads: number;
  /** `stat` on the refs root: the check asking whether a regular file sits at
   *  the topmost prefix. Applying an update never climbs to the root itself. */
  readonly rootDirectoryStats: number;
}

const prepareProbes = (ctx: Context, calls: ReadonlyArray<Call>): PrepareProbes => ({
  prefixRefReads: calls.filter(
    (call) => call.method === 'openWithNoFollow' && sharedPrefixPaths(ctx).has(call.path),
  ).length,
  rootDirectoryStats: calls.filter(
    (call) => call.method === 'stat' && call.path === `${ctx.layout.gitDir}/refs`,
  ).length,
});

const deletesOf = (count: number): RefUpdate[] =>
  Array.from({ length: count }, (_unused, index) => ({
    kind: 'delete' as const,
    name: `${NAMESPACE}/branch-${index}` as RefName,
  }));

const countPrepareProbes = async (count: number): Promise<PrepareProbes> => {
  const { ctx, calls } = instrumentedContext(createMemoryContext());
  await createRefStore(ctx).applyRefUpdates(deletesOf(count));
  return prepareProbes(ctx, calls());
};

describe('createRefStore().applyRefUpdates', () => {
  describe('Given a run of deletes whose names all share one namespace', () => {
    describe('When the transaction prepares', () => {
      it('Then it probes each shared prefix once for the run, not once per update', async () => {
        // Arrange — the same three shared prefixes, four times as many updates
        // in the second run.
        const expected: PrepareProbes = { prefixRefReads: 3, rootDirectoryStats: 1 };

        // Act
        const small = await countPrepareProbes(4);
        const large = await countPrepareProbes(16);

        // Assert
        expect(small).toEqual(expected);
        expect(large).toEqual(expected);
      });
    });
  });

  describe('Given a run of deletes of names that are already absent', () => {
    describe('When the transaction prepares', () => {
      it('Then every delete still applies as a no-op', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = createRefStore(ctx);
        await sut.applyRefUpdates([{ kind: 'set', name: `${NAMESPACE}/kept` as RefName, id: ID }]);

        // Act
        await sut.applyRefUpdates(deletesOf(3));

        // Assert
        const kept = await sut.resolveDirect(`${NAMESPACE}/kept` as RefName);
        expect(kept).toEqual({ kind: 'direct', id: ID });
      });
    });
  });

  describe('Given a run whose later update nests under an earlier one', () => {
    describe('When the transaction prepares', () => {
      it('Then the refusal names the earlier ref sitting under it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = createRefStore(ctx);
        const updates: RefUpdate[] = [
          { kind: 'set', name: `${NAMESPACE}/a/b` as RefName, id: ID },
          { kind: 'set', name: `${NAMESPACE}/a` as RefName, id: ID },
        ];

        // Act
        const refusal = await sut.applyRefUpdates(updates).catch((error: unknown) => error);

        // Assert
        expect(refusal).toBeInstanceOf(Error);
        expect((refusal as { data: { code: string; path: string } }).data).toEqual({
          code: 'FILE_EXISTS',
          path: `${ctx.layout.gitDir}/${NAMESPACE}/a/b`,
        });
      });
    });
  });
});

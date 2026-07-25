import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { findWouldOverwrite } from '../../../../src/application/primitives/find-would-overwrite.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { type ChangedPathSpec, changedPathSpecsArb } from './arbitraries.js';

const COMMITTED = 'committed\n';
const DIRTY = 'dirty\n';

const entryOf = (path: FilePath, id: ObjectId): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path,
});

/**
 * Materialise a changed-path scenario into a memory context, returning the
 * changed-path set and the stage-0 index that {@link findWouldOverwrite}
 * consumes. The scenario's `kind` drives the on-disk + index state per path.
 */
const materialise = async (
  ctx: Context,
  specs: ReadonlyArray<ChangedPathSpec>,
): Promise<{ readonly paths: ReadonlySet<FilePath>; readonly index: GitIndex }> => {
  const committedId = (await writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(COMMITTED),
    id: '' as ObjectId,
  })) as ObjectId;
  const entries: IndexEntry[] = [];
  const paths = new Set<FilePath>();
  for (const spec of specs) {
    paths.add(spec.path);
    const abs = `${ctx.layout.workDir}/${spec.path}`;
    if (spec.kind === 'tracked-clean') {
      entries.push(entryOf(spec.path, committedId));
      await ctx.fs.writeUtf8(abs, COMMITTED);
    } else if (spec.kind === 'tracked-dirty') {
      entries.push(entryOf(spec.path, committedId));
      await ctx.fs.writeUtf8(abs, DIRTY);
    } else if (spec.kind === 'untracked-present') {
      await ctx.fs.writeUtf8(abs, DIRTY);
    }
    // 'absent': neither tracked nor present.
  }
  return {
    paths,
    index: { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) },
  };
};

describe('findWouldOverwrite properties', () => {
  describe('Given an arbitrary changed-path set', () => {
    describe('When findWouldOverwrite classifies it', () => {
      it('Then an empty changed set yields both classes empty', async () => {
        // Arrange + Act + Assert
        const ctx = createMemoryContext();
        const { index } = await materialise(ctx, []);
        const result = await findWouldOverwrite(ctx, new Set<FilePath>(), index);
        expect(result.localChanges).toEqual([]);
        expect(result.untracked).toEqual([]);
      });

      it('Then every tracked-dirty path lands in localChanges', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(changedPathSpecsArb(), async (specs) => {
            const ctx = createMemoryContext();
            const { paths, index } = await materialise(ctx, specs);
            const result = await findWouldOverwrite(ctx, paths, index);
            for (const spec of specs) {
              if (spec.kind === 'tracked-dirty') {
                expect(result.localChanges).toContain(spec.path);
              }
            }
          }),
          { numRuns: 100 },
        );
      });

      it('Then every untracked-present path lands in untracked', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(changedPathSpecsArb(), async (specs) => {
            const ctx = createMemoryContext();
            const { paths, index } = await materialise(ctx, specs);
            const result = await findWouldOverwrite(ctx, paths, index);
            for (const spec of specs) {
              if (spec.kind === 'untracked-present') {
                expect(result.untracked).toContain(spec.path);
              }
            }
          }),
          { numRuns: 100 },
        );
      });

      it('Then no path appears in both classes', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(changedPathSpecsArb(), async (specs) => {
            const ctx = createMemoryContext();
            const { paths, index } = await materialise(ctx, specs);
            const result = await findWouldOverwrite(ctx, paths, index);
            const untrackedSet = new Set<FilePath>(result.untracked);
            for (const local of result.localChanges) {
              expect(untrackedSet.has(local)).toBe(false);
            }
          }),
          { numRuns: 100 },
        );
      });

      it('Then a clean-or-absent path is reported in neither class', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(changedPathSpecsArb(), async (specs) => {
            const ctx = createMemoryContext();
            const { paths, index } = await materialise(ctx, specs);
            const result = await findWouldOverwrite(ctx, paths, index);
            const reported = new Set<FilePath>([...result.localChanges, ...result.untracked]);
            for (const spec of specs) {
              if (spec.kind === 'tracked-clean' || spec.kind === 'absent') {
                expect(reported.has(spec.path)).toBe(false);
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeCollidingRenameSources } from '../../../../src/application/primitives/merge-colliding-rename-sources.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { FlatTree } from '../../../../src/domain/diff/flat-tree.js';
import type {
  ContentMergeContext,
  ContentMerger,
  MergeRenames,
} from '../../../../src/domain/merge/index.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: encode(content), id: '' as ObjectId });

const flat = (pairs: ReadonlyArray<readonly [string, ObjectId]>): FlatTree => ({
  entries: new Map(
    pairs.map(([path, id]) => [path as FilePath, { id, mode: FILE_MODE.REGULAR }] as const),
  ),
});

const RENAMES: MergeRenames = {
  ours: [],
  theirs: [{ oldPath: 'big' as FilePath, newPath: 'big2' as FilePath }],
};

/** theirs renames and edits `big`; ours edits `big` and adds `big2` — ort's rename/add. */
const renameAdd = async (ctx: Context) => {
  const [original, edited, renamed, added] = await Promise.all([
    blob(ctx, 'base\n'),
    blob(ctx, 'ours\n'),
    blob(ctx, 'theirs\n'),
    blob(ctx, 'added\n'),
  ]);
  return {
    base: flat([['big', original]]),
    ours: flat([
      ['big', edited],
      ['big2', added],
    ]),
    theirs: flat([['big2', renamed]]),
    ids: { original, edited, renamed },
  };
};

const merging = (
  result: Awaited<ReturnType<ContentMerger>>,
): { merger: ContentMerger; seen: ContentMergeContext[] } => {
  const seen: ContentMergeContext[] = [];
  return {
    seen,
    merger: (mergeCtx) => {
      seen.push(mergeCtx);
      return result;
    },
  };
};

const mergedText = async (ctx: Context, renames: MergeRenames): Promise<string> => {
  const merged = renames.theirs[0]?.mergedSource;
  if (merged === undefined) return '<none>';
  return new TextDecoder().decode((await readBlob(ctx, merged.id)).content);
};

describe('mergeCollidingRenameSources', () => {
  describe('Given a renamed source both sides changed whose destination the other side added', () => {
    describe('When its source merges cleanly', () => {
      it('Then the rename carries the stored merge result with the three-way mode', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, ours, theirs, ids } = await renameAdd(ctx);
        const { merger, seen } = merging({ status: 'clean', bytes: encode('merged\n') });
        const sut = mergeCollidingRenameSources;

        const unrelated = { oldPath: 'y' as FilePath, newPath: 'z' as FilePath };

        // Act
        const result = await sut(
          ctx,
          { base, ours, theirs },
          { ...RENAMES, ours: [unrelated] },
          merger,
        );

        // Assert
        expect(await mergedText(ctx, result)).toBe('merged\n');
        expect(result.theirs[0]?.mergedSource?.mode).toBe(FILE_MODE.REGULAR);
        expect(result.theirs[0]?.newPath).toBe('big2');
        expect(result.ours[0]).toBe(unrelated);
        expect(seen.map((m) => [m.path, m.baseId, m.ourId, m.theirId])).toEqual([
          ['big', ids.original, ids.edited, ids.renamed],
        ]);
      });
    });

    describe('When its source merge conflicts', () => {
      it('Then the rename carries the marked result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, ours, theirs } = await renameAdd(ctx);
        const { merger } = merging({
          status: 'conflict',
          conflictType: 'content',
          markedBytes: encode('<<<<<<<\n'),
        });
        const sut = mergeCollidingRenameSources;

        // Act
        const result = await sut(ctx, { base, ours, theirs }, RENAMES, merger);

        // Assert
        expect(await mergedText(ctx, result)).toBe('<<<<<<<\n');
      });
    });
  });

  describe('Given renames with no colliding source', () => {
    describe('When the sources are merged', () => {
      it('Then the renames come back as they were without a content merge', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, theirs, ids } = await renameAdd(ctx);
        const ours = flat([['big', ids.original]]);
        const { merger, seen } = merging({ status: 'clean', bytes: encode('merged\n') });
        const sut = mergeCollidingRenameSources;

        // Act
        const result = await sut(ctx, { base, ours, theirs }, RENAMES, merger);

        // Assert
        expect(result).toBe(RENAMES);
        expect(seen).toEqual([]);
      });
    });
  });
});

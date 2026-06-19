import { describe, expect, it } from 'vitest';
import { detectSimilarityRenames } from '../../../../src/application/primitives/detect-similarity-renames.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TreeDiff } from '../../../../src/domain/diff/diff-change.js';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import {
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  MAX_SCORE,
} from '../../../../src/domain/diff/similarity.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

const writeBlob = (ctx: Ctx, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

/** Build 10 lines, replacing line `n` (0-indexed) to make ~90% similar blobs. */
const tenLines = (changed: number): string =>
  Array.from({ length: 10 }, (_, i) => (i === changed ? `X line ${i}\n` : `line ${i}\n`)).join('');

describe('detectSimilarityRenames', () => {
  describe('Given a diff with no adds or deletes', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then returns the diff unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'content\n');
        const newId = await writeBlob(ctx, 'changed\n');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const sut = detectSimilarityRenames(ctx, diff);
        // Assert
        const result = await sut;
        expect(result.changes).toEqual(diff.changes);
      });
    });
  });

  describe('Given a diff whose add/delete pair has identical blob ids (exact R100)', () => {
    describe('When detectSimilarityRenames is called without threshold', () => {
      it('Then the exact pair is emitted as a rename with MAX_SCORE similarity', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'identical content\n');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act
        const sut = detectSimilarityRenames(ctx, diff);
        const result = await sut;
        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('rename');
        if (change?.type === 'rename') {
          expect(change.similarity.score).toBe(MAX_SCORE);
          expect(change.oldPath).toBe('src.txt');
          expect(change.newPath).toBe('dst.txt');
        }
      });
    });
  });

  describe('Given a leftover add/delete pair whose content is above the threshold', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the pair folds into a rename with the correct two-sided fields and similarity score', async () => {
        // Arrange — 1 of 10 lines changed → high similarity (~87%)
        const ctx = await buildSeededContext();
        const srcContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const srcId = await writeBlob(ctx, srcContent);
        const dstId = await writeBlob(ctx, dstContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: srcId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act
        const sut = detectSimilarityRenames(ctx, diff);
        const result = await sut;
        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('rename');
        if (change?.type === 'rename') {
          expect(change.oldId).toBe(srcId);
          expect(change.newId).toBe(dstId);
          expect(change.oldMode).toBe(FILE_MODE.REGULAR);
          expect(change.newMode).toBe(FILE_MODE.REGULAR);
          expect(change.oldPath).toBe('src.txt');
          expect(change.newPath).toBe('dst.txt');
          expect(change.similarity.maxScore).toBe(MAX_SCORE);
          expect(change.similarity.score).toBeGreaterThanOrEqual(DEFAULT_RENAME_THRESHOLD);
          expect(change.similarity.score).toBeLessThan(MAX_SCORE);
        }
      });
    });
  });

  describe('Given a leftover add/delete pair with score exactly at the threshold', () => {
    describe('When detectSimilarityRenames is called with that threshold', () => {
      it('Then the pair folds into a rename (inclusive >= threshold)', async () => {
        // Arrange — use a threshold so high we craft an "at exactly threshold" scenario
        // by setting threshold to the actual score we get
        const ctx = await buildSeededContext();
        // Use two blobs with known high similarity
        const srcContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const srcId = await writeBlob(ctx, srcContent);
        const dstId = await writeBlob(ctx, dstContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: srcId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // First get the actual score
        const preliminary = await detectSimilarityRenames(ctx, diff);
        const prelimChange = preliminary.changes[0];
        // Precondition: the pair must fold as a rename under the default threshold.
        // A non-rename here means the test fixture is broken, not a boundary to skip.
        expect(prelimChange?.type).toBe('rename');
        const actualScore = (prelimChange as { similarity: { score: number } }).similarity.score;

        // Act — run with threshold == actualScore: should pair (inclusive)
        const result = await detectSimilarityRenames(ctx, diff, { threshold: actualScore });
        // Assert
        expect(result.changes[0]?.type).toBe('rename');
      });
    });
  });

  describe('Given a leftover add/delete pair with score exactly one below the threshold', () => {
    describe('When detectSimilarityRenames is called with threshold = score + 1', () => {
      it('Then the pair does NOT fold — stays as separate add and delete', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const srcContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const srcId = await writeBlob(ctx, srcContent);
        const dstId = await writeBlob(ctx, dstContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: srcId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Get the actual score first
        const preliminary = await detectSimilarityRenames(ctx, diff);
        const prelimChange = preliminary.changes[0];
        // Precondition: the pair must fold as a rename under the default threshold.
        // A non-rename here means the test fixture is broken, not a boundary to skip.
        expect(prelimChange?.type).toBe('rename');
        const actualScore = (prelimChange as { similarity: { score: number } }).similarity.score;

        // Act — run with threshold = score + 1: should NOT pair
        const result = await detectSimilarityRenames(ctx, diff, { threshold: actualScore + 1 });
        // Assert
        const types = result.changes.map((c) => c.type);
        expect(types).toContain('delete');
        expect(types).toContain('add');
        expect(types).not.toContain('rename');
      });
    });
  });

  describe('Given num_create * num_src exceeds limit^2 (inexact-only candidates)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the inexact pass is skipped and all candidates remain as separate add/delete', async () => {
        // Arrange — 2 deletes * 2 adds = 4 > limit^2 (1^2=1): inexact pass skipped entirely
        // Git's formula: num_dst * num_src > rename_limit * rename_limit
        const ctx = await buildSeededContext();
        const del1Id = await writeBlob(ctx, 'del1 unique content that is long enough\n'.repeat(2));
        const del2Id = await writeBlob(ctx, 'del2 unique content that is long enough\n'.repeat(2));
        const add1Id = await writeBlob(
          ctx,
          'del1 unique content that is long enough\n'.repeat(2).replace('del1', 'add1'),
        );
        const add2Id = await writeBlob(
          ctx,
          'del2 unique content that is long enough\n'.repeat(2).replace('del2', 'add2'),
        );
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'd1.txt' as FilePath,
              oldId: del1Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'd2.txt' as FilePath,
              oldId: del2Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'a1.txt' as FilePath,
              newId: add1Id,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'a2.txt' as FilePath,
              newId: add2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act — limit=1; inexact candidates: 2 deletes * 2 adds = 4 > 1*1=1 → skip inexact
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });
        // Assert — no renames (all inexact, limit exceeded)
        const types = result.changes.map((c) => c.type);
        expect(types.every((t) => t === 'add' || t === 'delete')).toBe(true);
        expect(types.filter((t) => t === 'delete')).toHaveLength(2);
        expect(types.filter((t) => t === 'add')).toHaveLength(2);
      });
    });
  });

  describe('Given num_create * num_src exceeds limit^2 but there is an exact pair', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the exact pair still emits as R100 even when the inexact pass is skipped', async () => {
        // Arrange — exact pair + 2 inexact adds * 2 inexact deletes = 4 > limit^2 (1^2=1)
        const ctx = await buildSeededContext();
        const exactId = await writeBlob(ctx, 'exact same content here\n'.repeat(5));
        const del1Id = await writeBlob(ctx, 'delete source one content\n'.repeat(3));
        const del2Id = await writeBlob(ctx, 'delete source two content\n'.repeat(3));
        const add1Id = await writeBlob(ctx, 'delete source one content changed\n'.repeat(3));
        const add2Id = await writeBlob(ctx, 'delete source two content changed\n'.repeat(3));
        const diff: TreeDiff = {
          changes: [
            // exact pair
            {
              type: 'delete',
              oldPath: 'exact-src.txt' as FilePath,
              oldId: exactId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'exact-dst.txt' as FilePath,
              newId: exactId,
              newMode: FILE_MODE.REGULAR,
            },
            // inexact pairs that would push us over limit
            {
              type: 'delete',
              oldPath: 'd1.txt' as FilePath,
              oldId: del1Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'd2.txt' as FilePath,
              oldId: del2Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'a1.txt' as FilePath,
              newId: add1Id,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'a2.txt' as FilePath,
              newId: add2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act — limit=1; after exact pass: 2 del * 2 add = 4 > 1*1=1 → skip inexact
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });
        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        const rename = renames[0];
        if (rename?.type === 'rename') {
          expect(rename.similarity.score).toBe(MAX_SCORE);
          expect(rename.oldPath).toBe('exact-src.txt');
          expect(rename.newPath).toBe('exact-dst.txt');
        }
        const nonRenames = result.changes.filter((c) => c.type !== 'rename');
        expect(nonRenames).toHaveLength(4);
      });
    });
  });

  describe('Given limit=0 (unlimited)', () => {
    describe('When detectSimilarityRenames is called with many candidates', () => {
      it('Then the inexact pass runs regardless of candidate count', async () => {
        // Arrange — 1 delete * 1 add = 1 candidate, would exceed limit=0 but limit=0 means unlimited
        const ctx = await buildSeededContext();
        const srcContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const srcId = await writeBlob(ctx, srcContent);
        const dstId = await writeBlob(ctx, dstContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: srcId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act — limit=0 means unlimited
        const result = await detectSimilarityRenames(ctx, diff, { limit: 0 });
        // Assert — should find the inexact rename
        const types = result.changes.map((c) => c.type);
        expect(types).toContain('rename');
      });
    });
  });

  describe('Given a modify change alongside an add/delete rename candidate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the modify is passed through unchanged and is never a rename source', async () => {
        // Arrange — matrix #10: modify is never an inexact rename source
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, 'kept file old content for modify test\n'.repeat(3));
        const modNewId = await writeBlob(ctx, 'kept file new content for modify test\n'.repeat(3));
        const delId = await writeBlob(ctx, 'moved source content unique\n'.repeat(3));
        const addId = await writeBlob(ctx, 'moved source content unique modified\n'.repeat(3));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'kept.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'moved.txt' as FilePath,
              oldId: delId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'target.txt' as FilePath,
              newId: addId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act
        const result = await detectSimilarityRenames(ctx, diff);
        // Assert — 'modify' still present, rename is detected on the add/delete pair
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        expect(modifies[0]).toMatchObject({ type: 'modify', path: 'kept.txt' });
      });
    });
  });

  describe('Given copies: "on" and a modify change alongside an add with similar content', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the modify source folds into a copy WITHOUT consuming the modify', async () => {
        // Arrange — matrix #C1: a modified file acts as a copy source; the copy
        // is emitted but the modify SURVIVES (source is retained, not consumed).
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED line 0\n'));
        // dst is similar to the modify's preimage (modOldId)
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'COPY DST line 0\n'));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'kept.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'copied.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const sut = detectSimilarityRenames(ctx, diff, { copies: 'on' });
        const result = await sut;

        // Assert — modify still present AND copy was detected
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        expect(modifies[0]).toMatchObject({ type: 'modify', path: 'kept.txt' });

        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('kept.txt');
          expect(copies[0].newPath).toBe('copied.txt');
        }
      });
    });
  });

  describe('Given copies: "on" with an UNCHANGED source (matrix #C1b)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the unchanged file is NOT a copy source and the add remains as-is', async () => {
        // Arrange — matrix #C1b: plain -C only uses preimage of CHANGED files
        // An unchanged file is NOT a copy source under copies: "on".
        // The add stays as an add (no copy detected).
        const ctx = await buildSeededContext();
        // The "unchanged" file is not in the diff at all — it's absent from TreeDiff
        const unchangedContent = tenLines(0);
        const dstId = await writeBlob(ctx, unchangedContent); // same bytes as an "unchanged" file
        // No modify/delete in the diff for the "unchanged" source
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'copied.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — no copy detected; add remains unchanged
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(0);
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
      });
    });
  });

  describe('Given copies: "on" and a copy pair whose score is below copyThreshold', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the copy is NOT detected (add remains as add)', async () => {
        // Arrange — use a very high threshold so the copy score falls below it
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED line 0\n'));
        // dst is similar to preimage but we set copyThreshold = MAX_SCORE so it won't match
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'COPY DST\n'));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'kept.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'copied.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copyThreshold = MAX_SCORE means ONLY identical blobs qualify (impossible for different content)
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          copyThreshold: MAX_SCORE,
        });

        // Assert — no copy detected
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(0);
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
      });
    });
  });

  describe('Given copies: "off" (default)', () => {
    describe('When detectSimilarityRenames is called with a modify and a similar add', () => {
      it('Then no copy is detected and the add remains as-is', async () => {
        // Arrange — copies: "off" (default) means no copy detection runs
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED line 0\n'));
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'COPY DST\n'));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'kept.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'copied.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — default options: copies not set (off)
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — no copy, add stays
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(0);
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
      });
    });
  });

  describe('Given copies: "on" with both a rename candidate and a copy candidate for the same dst', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then rename sorts AHEAD of copy at equal score (rename wins)', async () => {
        // Arrange — a delete (rename source) and a modify (copy source) both match the same add.
        // Both should have identical content to dst, forcing equal scores;
        // the greedy sort must put rename candidates BEFORE copy candidates.
        const ctx = await buildSeededContext();
        const sharedContent = tenLines(0);
        // The add dst matches both the delete (rename candidate) and the modify's preimage (copy candidate)
        const dstId = await writeBlob(ctx, sharedContent);
        const delId = await writeBlob(ctx, sharedContent); // exact match → rename candidate (R100)
        const modOldId = await writeBlob(ctx, sharedContent); // exact match → copy candidate
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'MOD NEW\n'));

        const diff: TreeDiff = {
          changes: [
            // rename candidate: a delete with identical content to dst
            {
              type: 'delete',
              oldPath: 'del-src.txt' as FilePath,
              oldId: delId,
              oldMode: FILE_MODE.REGULAR,
            },
            // copy candidate: a modify whose preimage matches dst
            {
              type: 'modify',
              path: 'mod-src.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            // the destination
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — the rename candidate wins (rename sorts before copy at equal score)
        const renames = result.changes.filter((c) => c.type === 'rename');
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(renames).toHaveLength(1);
        expect(copies).toHaveLength(0); // copy candidate loses to the rename
        if (renames[0]?.type === 'rename') {
          expect(renames[0].newPath).toBe('dst.txt');
          expect(renames[0].oldPath).toBe('del-src.txt');
        }
        // The modify should still be present (not consumed — rename won the dst)
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
      });
    });
  });

  describe('Given copies: "harder" and an UNCHANGED file that is similar to an add', () => {
    describe('When detectSimilarityRenames is called with preimage', () => {
      it('Then the unchanged file IS a copy source and the add folds into a copy', async () => {
        // Arrange — an unchanged file (present in preimage but absent from the diff changes)
        // must appear as a copy source under copies: 'harder'.
        // Under copies: 'on' the unchanged file would NOT be a copy source.
        const ctx = await buildSeededContext();
        const unchangedContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'COPY DST line 0\n');
        const unchangedId = await writeBlob(ctx, unchangedContent);
        const dstId = await writeBlob(ctx, dstContent);
        // The preimage map contains the unchanged file (simulates what diff-trees passes)
        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['unchanged.txt' as FilePath, { id: unchangedId, mode: FILE_MODE.REGULAR }],
        ]);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'copied.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies: 'on' should NOT detect (unchanged not a source); preimage not passed
        const resultOn = await detectSimilarityRenames(ctx, diff, { copies: 'on' });
        // Act — copies: 'harder' SHOULD detect (unchanged IS a source under harder); preimage passed positionally
        const resultHarder = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder' },
          preimage,
        );

        // Assert — 'on': no copy (unchanged excluded)
        expect(resultOn.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(resultOn.changes.filter((c) => c.type === 'add')).toHaveLength(1);

        // Assert — 'harder': copy detected from unchanged source
        const copiesHarder = resultHarder.changes.filter((c) => c.type === 'copy');
        expect(copiesHarder).toHaveLength(1);
        if (copiesHarder[0]?.type === 'copy') {
          expect(copiesHarder[0].oldPath).toBe('unchanged.txt');
          expect(copiesHarder[0].newPath).toBe('copied.txt');
        }
        // No add remains (consumed by the copy)
        expect(resultHarder.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given copies: "harder" with limit that is exceeded only under harder (many preimage paths)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then limit is exceeded only under harder and falls back to copies:"on" source set', async () => {
        // Arrange — 1 add, 1 modified file (copy source under plain -C), 4 unchanged files
        // (added to preimage, not in diff changes).
        // Under copies:'on': num_src=1(modify), num_create=1 -> 1*1=1 <= limit^2(4) -> runs, finds copy
        // Under copies:'harder': num_src=5(1modify+4unchanged), num_create=1 -> 1*5=5 > 4 -> falls back to 'on' sources
        // After fallback: same result as 'on' (copy from modify still found)
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED line 0\n'));
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'COPY DST line 0\n'));
        // 4 unchanged files in preimage; each has unique content so they don't pair
        const unchanged1Id = await writeBlob(
          ctx,
          'unchanged1 unique content aaa bbb ccc\n'.repeat(5),
        );
        const unchanged2Id = await writeBlob(
          ctx,
          'unchanged2 unique content ddd eee fff\n'.repeat(5),
        );
        const unchanged3Id = await writeBlob(
          ctx,
          'unchanged3 unique content ggg hhh iii\n'.repeat(5),
        );
        const unchanged4Id = await writeBlob(
          ctx,
          'unchanged4 unique content jjj kkk lll\n'.repeat(5),
        );

        const preimage = new Map<FilePath, FlatTreeEntry>([
          // The modify preimage is also in the preimage map
          ['mod-src.txt' as FilePath, { id: modOldId, mode: FILE_MODE.REGULAR }],
          ['unchanged1.txt' as FilePath, { id: unchanged1Id, mode: FILE_MODE.REGULAR }],
          ['unchanged2.txt' as FilePath, { id: unchanged2Id, mode: FILE_MODE.REGULAR }],
          ['unchanged3.txt' as FilePath, { id: unchanged3Id, mode: FILE_MODE.REGULAR }],
          ['unchanged4.txt' as FilePath, { id: unchanged4Id, mode: FILE_MODE.REGULAR }],
        ]);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'mod-src.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'add-dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — limit=2 (limit^2=4):
        //   harder: 1 add * 5 harder-sources = 5 > 4 → falls back to 'on' (1 copy source: modify preimage)
        //           then: 1 add * 1 copy source = 1 ≤ 4 → inexact pass runs → FINDS copy
        //   on:     1 add * 1 copy source = 1 ≤ 4 → inexact pass runs → FINDS copy
        const resultHarder = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder', limit: 2 },
          preimage,
        );
        const resultOn = await detectSimilarityRenames(ctx, diff, { copies: 'on', limit: 2 });

        // Assert absolute outcomes: harder falls back to 'on', both find exactly 1 copy
        const copiesHarder = resultHarder.changes.filter((c) => c.type === 'copy');
        const copiesOn = resultOn.changes.filter((c) => c.type === 'copy');
        expect(copiesHarder).toHaveLength(1);
        expect(copiesOn).toHaveLength(1);

        // The modify survives in both cases
        expect(resultHarder.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
        expect(resultOn.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
        // The add is consumed by the copy in both cases
        expect(resultHarder.changes.filter((c) => c.type === 'add')).toHaveLength(0);
        expect(resultOn.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given copies: "harder" with a delete and an unchanged file both matching the same dst', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then rename wins over copy at equal score (matrix #C3 precedence)', async () => {
        // Arrange — del-src (deleted) and keep-src (unchanged in preimage) both have similar
        // content to new-dst. At equal score, rename sorts AHEAD of copy.
        const ctx = await buildSeededContext();
        const sharedContent = tenLines(0);
        // Destination is similar to both sources
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'CHANGED line 0\n'));
        const delId = await writeBlob(ctx, sharedContent); // rename candidate
        const keepId = await writeBlob(ctx, sharedContent); // copy candidate (unchanged)

        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['del-src.txt' as FilePath, { id: delId, mode: FILE_MODE.REGULAR }],
          ['keep-src.txt' as FilePath, { id: keepId, mode: FILE_MODE.REGULAR }],
        ]);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'del-src.txt' as FilePath,
              oldId: delId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'new-dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'harder' so keep-src.txt (unchanged) is also a copy source; preimage passed positionally
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'harder' }, preimage);

        // Assert — rename wins (del-src.txt → new-dst.txt); no copy for keep-src.txt → new-dst.txt
        const renames = result.changes.filter((c) => c.type === 'rename');
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(renames).toHaveLength(1);
        expect(copies).toHaveLength(0);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('del-src.txt');
          expect(renames[0].newPath).toBe('new-dst.txt');
        }
      });
    });
  });

  describe('Given breakRewrites is false (default)', () => {
    describe('When detectSimilarityRenames is called with a highly dissimilar modify', () => {
      it('Then the modify passes through unchanged without a broken datum', async () => {
        // Arrange — disjoint content: dissimilarity = MAX_SCORE (100%)
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(5));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const sut = detectSimilarityRenames(ctx, diff);
        const result = await sut;

        // Assert — no break: modify stays plain
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given breakRewrites with a dissimilar modify above the break-attempt gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the modify is split into a synthetic delete+add for the matrix', async () => {
        // Arrange — fully disjoint content: dissimilarity = MAX_SCORE >= DEFAULT_BREAK_SCORE
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(10));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(10));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — use break score that is definitely exceeded (MAX_SCORE dissimilarity)
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — the modify is kept broken with a dissimilarity datum
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeDefined();
          expect(change.broken?.score).toBe(MAX_SCORE);
          expect(change.broken?.maxScore).toBe(MAX_SCORE);
        }
      });
    });
  });

  describe('Given breakRewrites and dissimilarity exactly at the break-attempt gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then dissimilarity === score attempts the break (inclusive gate)', async () => {
        // Arrange — fully disjoint content: dissimilarity = MAX_SCORE
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(5));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — set breakScore = MAX_SCORE so dissimilarity === score (inclusive: should attempt)
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: MAX_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — break was attempted and kept broken (dissimilarity >= mergeScore)
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeDefined();
        }
      });
    });
  });

  describe('Given breakRewrites and dissimilarity exactly one below the break-attempt gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then dissimilarity === score - 1 does NOT attempt the break', async () => {
        // Arrange — fully disjoint content: dissimilarity = MAX_SCORE
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(5));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — set breakScore = MAX_SCORE + 1 so dissimilarity < score (NOT attempted)
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: MAX_SCORE + 1, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — no break: modify stays plain
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given breakRewrites and dissimilarity exactly at the keep-broken gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then dissimilarity === mergeScore keeps broken (inclusive gate)', async () => {
        // Arrange — fully disjoint: dissimilarity = MAX_SCORE; set mergeScore = MAX_SCORE
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(5));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — set mergeScore = MAX_SCORE so dissimilarity === mergeScore (inclusive: keep broken)
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: MAX_SCORE },
        });

        // Assert — kept broken at mergeScore boundary
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeDefined();
          expect(change.broken?.score).toBe(MAX_SCORE);
        }
      });
    });
  });

  describe('Given breakRewrites and dissimilarity exactly one below the keep-broken gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then dissimilarity at mergeScore - 1 re-merges to a plain modify', async () => {
        // Arrange — use fully disjoint content (dissimilarity = MAX_SCORE = 60000) and set
        // mergeScore to MAX_SCORE + 1 so that dissimilarity < mergeScore (re-merge path).
        // Also set breakScore=1 so the break is definitely attempted.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(5));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — mergeScore = MAX_SCORE + 1 means dissimilarity (MAX_SCORE) < mergeScore → re-merge
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: MAX_SCORE + 1 },
        });

        // Assert — re-merged: modify has no broken datum
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given breakRewrites with merge: 0 (maps to DEFAULT_MERGE_SCORE)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then merge:0 maps to DEFAULT_MERGE_SCORE (not zero) for the keep-broken gate', async () => {
        // Arrange — fully disjoint content: dissimilarity = MAX_SCORE
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(5));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — merge:0 must map to DEFAULT_MERGE_SCORE (36000), not 0.
        // dissimilarity = MAX_SCORE (60000) >= DEFAULT_MERGE_SCORE (36000) → keep broken.
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: 0 },
        });

        // Assert — kept broken; merge:0 did NOT map to "keep everything" nor "keep nothing"
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeDefined();
          expect(change.broken?.score).toBe(MAX_SCORE);
        }
      });
    });
  });

  describe('Given the git-faithful B2 fixture (total=20, shared=7, merge_score=39000 → 65%)', () => {
    describe('When detectSimilarityRenames is called with merge gate at 39000 (inclusive)', () => {
      it('Then broken.score equals 39000 and the modify is kept broken', async () => {
        // Arrange — breakContent('old',20,7) vs breakContent('new',20,7)
        // Verified against real git 2.54.0: `git diff -B --name-status` → M065
        // merge_score = (1420 - 497) * 60000 / 1420 = 39000 → 65%
        const makeBreakContent = (kind: 'old' | 'new', total: number, shared: number): string => {
          const lines: string[] = [];
          for (let i = 0; i < total; i++) {
            if (kind === 'old' || i < shared) {
              lines.push(
                `line-${String(i).padStart(3, '0')}: shared content alpha beta gamma delta epsilon zeta eta theta\n`,
              );
            } else {
              lines.push(
                `different-${String(i).padStart(3, '0')}: COMPLETELY NEW TEXT ZETA THETA KAPPA LAMBDA MU NU XI OMICRON PI RHO SIGMA\n`,
              );
            }
          }
          return lines.join('');
        };
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, makeBreakContent('old', 20, 7));
        const newId = await writeBlob(ctx, makeBreakContent('new', 20, 7));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — gate at 39000 (exactly the merge_score): inclusive → kept broken
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: 39000 },
        });

        // Assert — kept broken; exact score pins git's merge_score
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeDefined();
          expect(change.broken?.score).toBe(39000);
          expect(change.broken?.maxScore).toBe(MAX_SCORE);
        }
      });
    });

    describe('When detectSimilarityRenames is called with merge gate at 39001 (exclusive)', () => {
      it('Then the modify is re-merged to a plain modify', async () => {
        // Arrange — same fixture; gate raised above merge_score → re-merge
        const makeBreakContent = (kind: 'old' | 'new', total: number, shared: number): string => {
          const lines: string[] = [];
          for (let i = 0; i < total; i++) {
            if (kind === 'old' || i < shared) {
              lines.push(
                `line-${String(i).padStart(3, '0')}: shared content alpha beta gamma delta epsilon zeta eta theta\n`,
              );
            } else {
              lines.push(
                `different-${String(i).padStart(3, '0')}: COMPLETELY NEW TEXT ZETA THETA KAPPA LAMBDA MU NU XI OMICRON PI RHO SIGMA\n`,
              );
            }
          }
          return lines.join('');
        };
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, makeBreakContent('old', 20, 7));
        const newId = await writeBlob(ctx, makeBreakContent('new', 20, 7));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — gate at 39001 (just above merge_score 39000): 39000 < 39001 → re-merge
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: 39001 },
        });

        // Assert — re-merged: no broken datum
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given breakRewrites and a dissimilar modify whose delete-half is consumed by a rename', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the add-half remains as an add (half consumed, half stays as-is)', async () => {
        // Arrange — the delete half of the broken modify is similar to an add elsewhere,
        // so rename detection consumes the delete half. The add half stays as-is.
        const ctx = await buildSeededContext();
        const sharedContent = 'shared\ncontent\nfor\nrename\ntarget\n'.repeat(5);
        const disjointContent = 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(10);

        // file.txt: old=sharedContent, new=disjointContent → dissimilarity ~MAX_SCORE → break
        // The old half (sharedContent) will be renamed to rename-dst.txt
        const modOldId = await writeBlob(ctx, sharedContent);
        const modNewId = await writeBlob(ctx, disjointContent);
        // rename destination: very similar to sharedContent
        const renameDstId = await writeBlob(ctx, sharedContent);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'rename-dst.txt' as FilePath,
              newId: renameDstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — delete half consumed as rename; add half stays as an add
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].newPath).toBe('rename-dst.txt');
          expect(renames[0].oldPath).toBe('file.txt');
        }
        // Add half of the broken modify stays as an add
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
        if (adds[0]?.type === 'add') {
          expect(adds[0].newPath).toBe('file.txt');
          expect(adds[0].newId).toBe(modNewId);
        }
        // No broken modify
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(0);
      });
    });
  });

  describe('Given a 5x5 scenario with unambiguous per-pair best scores (matrix #8)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then all 5 pairs are detected as renames with no orphan', async () => {
        // Arrange — 5 src-dst pairs; each src-i is most similar to dst-i because
        // the "X line i" marker line in src-i maps to "Z line i" in dst-i, while
        // cross-index pairs share only 8/10 lines (lower score). Greedy naturally
        // picks src-i→dst-i for all 5 since same-index score dominates.
        const ctx = await buildSeededContext();
        const blobs: Array<{ srcId: ObjectId; dstId: ObjectId }> = [];
        for (let i = 0; i < 5; i++) {
          const srcContent = tenLines(i % 10);
          const dstContent = srcContent.replace(`X line ${i % 10}\n`, `Z line ${i % 10}\n`);
          const srcId = await writeBlob(ctx, srcContent);
          const dstId = await writeBlob(ctx, dstContent);
          blobs.push({ srcId, dstId });
        }
        const changes: TreeDiff['changes'] = [
          ...blobs.map(({ srcId }, i) => ({
            type: 'delete' as const,
            oldPath: `src-${i}.txt` as FilePath,
            oldId: srcId,
            oldMode: FILE_MODE.REGULAR,
          })),
          ...blobs.map(({ dstId }, i) => ({
            type: 'add' as const,
            newPath: `dst-${i}.txt` as FilePath,
            newId: dstId,
            newMode: FILE_MODE.REGULAR,
          })),
        ];
        const diff: TreeDiff = { changes };
        // Act
        const sut = detectSimilarityRenames(ctx, diff);
        const result = await sut;
        const renames = result.changes.filter((c) => c.type === 'rename');
        const adds = result.changes.filter((c) => c.type === 'add');
        const deletes = result.changes.filter((c) => c.type === 'delete');
        // Assert — all 5 pair because each src-i has the highest score with dst-i
        expect(renames).toHaveLength(5);
        expect(adds).toHaveLength(0);
        expect(deletes).toHaveLength(0);
      });
    });
  });

  describe('Given 5 near-equal sources for dst-A and src-E as the only viable source for dst-B (NUM_CANDIDATE_PER_DST cap)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then src-E is freed by the per-destination top-4 cap and pairs with dst-B', async () => {
        // Arrange — git caps candidates per destination at NUM_CANDIDATE_PER_DST=4.
        // 5 delete sources (src-aaa..src-eee), 2 add destinations (dst-primary, dst-secondary).
        //
        // Content design (spanhash similarity):
        //   shared-block: 10 common lines in EVERY file
        //   dst-primary:   shared-block + "UNIQUE-PRIMARY …"
        //   dst-secondary: shared-block + line-A + line-B + "UNIQUE-SECONDARY …"  (3 extra lines)
        //   src-aaa..ddd:  shared-block + "UNIQUE-SRC-X …" → 10/11 ≈ 91% match with dst-primary
        //   src-eee:       shared-block + line-A + line-B + "UNIQUE-SRC-E …"
        //                    → 12/13 match with dst-secondary (high score)
        //                    → 10/13 match with dst-primary  (lower score than src-aaa..ddd)
        //
        // git processes: for each dst (outer), for each src (inner, in filename order).
        // For dst-primary: src-aaa(91%), src-bbb(91%), src-ccc(91%), src-ddd(91%) fill the 4 slots.
        //   src-eee scores ≈77% with dst-primary (10/13) — lower than the 4 already in the slots.
        //   record_if_better drops src-eee from dst-primary's candidate list.
        // For dst-secondary: src-eee scores ≈92% (12/13) — highest; src-aaa..ddd score ≈77%.
        //
        // Without the cap: ALL 5 are in dst-primary's matrix. Greedy sort at equal scores
        //   for src-aaa..ddd vs dst-primary is undefined; src-eee might be consumed by
        //   dst-primary first, leaving dst-secondary unmatched.
        // With the cap: src-eee is excluded from dst-primary's matrix → pairs with dst-secondary.
        const ctx = await buildSeededContext();

        const sharedBlock = Array.from(
          { length: 10 },
          (_, i) =>
            `shared-${String(i + 1).padStart(2, '0')}: common content alpha beta gamma delta epsilon zeta\n`,
        ).join('');
        // Two extra lines that appear in both dst-secondary and src-eee (but NOT in dst-primary or src-aaa..ddd)
        const extraLines =
          'extra-line-A: kappa lambda mu nu xi omicron pi rho sigma tau\nextra-line-B: upsilon phi chi psi omega alpha beta gamma delta epsilon\n';

        const dstPrimaryId = await writeBlob(
          ctx,
          `${sharedBlock}UNIQUE-PRIMARY: marker for primary destination\n`,
        );
        const dstSecondaryId = await writeBlob(
          ctx,
          `${sharedBlock}${extraLines}UNIQUE-SECONDARY: marker for secondary destination\n`,
        );
        // src-E: scores HIGH with dst-secondary (shares shared-block + extraLines),
        // scores LOWER with dst-primary (lacks extraLines in dst-primary).
        const srcEId = await writeBlob(
          ctx,
          `${sharedBlock}${extraLines}UNIQUE-SRC-E: marker only in src-E\n`,
        );
        const srcAId = await writeBlob(ctx, `${sharedBlock}UNIQUE-SRC-A: marker only in src-A\n`);
        const srcBId = await writeBlob(ctx, `${sharedBlock}UNIQUE-SRC-B: marker only in src-B\n`);
        const srcCId = await writeBlob(ctx, `${sharedBlock}UNIQUE-SRC-C: marker only in src-C\n`);
        const srcDId = await writeBlob(ctx, `${sharedBlock}UNIQUE-SRC-D: marker only in src-D\n`);

        const diff: TreeDiff = {
          changes: [
            // Filenames alphabetically ordered: src-aaa < src-bbb < src-ccc < src-ddd < src-eee
            {
              type: 'delete',
              oldPath: 'src-aaa.txt' as FilePath,
              oldId: srcAId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'src-bbb.txt' as FilePath,
              oldId: srcBId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'src-ccc.txt' as FilePath,
              oldId: srcCId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'src-ddd.txt' as FilePath,
              oldId: srcDId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'src-eee.txt' as FilePath,
              oldId: srcEId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst-primary.txt' as FilePath,
              newId: dstPrimaryId,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst-secondary.txt' as FilePath,
              newId: dstSecondaryId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act
        const sut = detectSimilarityRenames(ctx, diff);
        const result = await sut;
        const renames = result.changes.filter((c) => c.type === 'rename');
        const deletes = result.changes.filter((c) => c.type === 'delete');
        // Assert — exactly 2 renames: one src→dst-primary, and src-eee→dst-secondary.
        // The cap at 4 per destination ensures src-eee is dropped from dst-primary's
        // candidate list (it scores lower than src-aaa..ddd there) and is free for dst-secondary.
        expect(renames).toHaveLength(2);
        const secondaryRename = renames.find(
          (r) => r.type === 'rename' && r.newPath === 'dst-secondary.txt',
        );
        expect(secondaryRename).toBeDefined();
        if (secondaryRename?.type === 'rename') {
          expect(secondaryRename.oldPath).toBe('src-eee.txt');
        }
        // 3 orphan deletes (src-aaa/bbb/ccc/ddd minus the one that paired with dst-primary)
        expect(deletes).toHaveLength(3);
      });
    });
  });

  describe('Given copies:"on" where copy sources alone push num_create*num_src over the limit', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the inexact pass is skipped and no copy is detected (Fix 2: copy sources count in gate)', async () => {
        // Arrange — 1 add (num_create=1), 0 deletes, 5 modifies (copy sources under copies:'on').
        // limit=2 → limit²=4.
        // Before fix: isOverLimit used adds * deletes = 1 * 0 = 0 ≤ 4 → pass RUNS → copy found.
        // After fix:  numSrc = deletes + copySources = 0 + 5 = 5;
        //             isOverLimit = 1 * 5 = 5 > 4 → pass SKIPPED → no copy.
        const ctx = await buildSeededContext();
        const sharedContent = Array.from(
          { length: 10 },
          (_, i) => `common line ${String(i + 1).padStart(2, '0')}: shared text alpha beta gamma\n`,
        ).join('');
        const dstId = await writeBlob(ctx, `${sharedContent}UNIQUE-DST: destination file\n`);
        const modOldIds: ObjectId[] = [];
        const modNewIds: ObjectId[] = [];
        for (let i = 0; i < 5; i++) {
          const oldId = await writeBlob(
            ctx,
            `${sharedContent}UNIQUE-SRC-${i}: source ${i} original\n`,
          );
          const newId = await writeBlob(
            ctx,
            `${sharedContent}UNIQUE-SRC-${i}: source ${i} modified\n`,
          );
          modOldIds.push(oldId);
          modNewIds.push(newId);
        }
        const diff: TreeDiff = {
          changes: [
            ...Array.from({ length: 5 }, (_, i) => ({
              type: 'modify' as const,
              path: `src-${i}.txt` as FilePath,
              oldId: modOldIds[i] as ObjectId,
              newId: modNewIds[i] as ObjectId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            })),
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        // Act
        const sut = detectSimilarityRenames(ctx, diff, { copies: 'on', limit: 2 });
        const result = await sut;
        const copies = result.changes.filter((c) => c.type === 'copy');
        const adds = result.changes.filter((c) => c.type === 'add');
        // Assert — inexact pass skipped: no copies, dst remains as add
        expect(copies).toHaveLength(0);
        expect(adds).toHaveLength(1);
        if (adds[0]?.type === 'add') {
          expect(adds[0].newPath).toBe('dst.txt');
        }
        // All modifies survive unchanged
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(5);
      });
    });
  });
});

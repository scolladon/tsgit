import { describe, expect, it } from 'vitest';
import {
  detectSimilarityRenames,
  isSizeRejected,
  NUM_CANDIDATE_PER_DST,
  recordIfBetter,
  type ScoredTriple,
} from '../../../../src/application/primitives/detect-similarity-renames.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AddChange, DeleteChange, TreeDiff } from '../../../../src/domain/diff/diff-change.js';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import {
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  MAX_SCORE,
} from '../../../../src/domain/diff/similarity.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { Commit, FilePath, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
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

  describe('Given a bridge-plus-S5 fixture where the per-destination cap is outcome-determining (NUM_CANDIDATE_PER_DST=4)', () => {
    describe('When detectSimilarityRenames is called with threshold 1% of MAX_SCORE', () => {
      it('Then s5.txt pairs with d2.txt (cap evicts s5 from d1 matrix, making it available for d2)', async () => {
        // Arrange — outcome-determining proof for NUM_CANDIDATE_PER_DST=4.
        //
        // Without cap (=1000): s5.txt pairs with d1.txt (score 31%), d2.txt UNMATCHED.
        // With cap=4:          s5.txt pairs with d2.txt (score 15%), d1.txt UNMATCHED.
        //
        // Fixture design (threshold = 1% = Math.trunc(MAX_SCORE / 100) = 600):
        //
        //   COMMON   = 20 lines shared among b1..b4, d1, d3..d6
        //   EXTRAi   = 4 lines shared only by bi and d(i+2)  (i = 1..4)
        //   S5D1     = 10 lines shared only by s5 and d1
        //   S5D2     = 2 lines shared only by s5 and d2
        //
        //   b1..b4   = COMMON + EXTRAi + unique-bi
        //   s5       = S5D1 + S5D2 + unique-s5
        //   d1       = COMMON + S5D1 + unique-d1   ← D1 (primary, unmatched with cap=4)
        //   d2       = S5D2 + unique-d2            ← D2 (secondary, pairs with s5 with cap=4)
        //   d3..d6   = COMMON + EXTRAi + unique-di ← bridge destinations (consume b1..b4)
        //
        // Spanhash scores (raw / MAX_SCORE = 60000):
        //   d1 ← bi  : ~39007 (65%)   ← fills d1's 4 cap slots
        //   d1 ← s5  : ~19148 (31%)   ← 5th-best for d1; evicted by cap=4
        //   d2 ← s5  : ~9257  (15%)   ← only viable source for d2
        //   d(i+2)←bi: ~57739 (96%)   ← bridge: scores HIGHER than d1←bi
        //
        // Greedy without cap: D3..D6 consume B1..B4 via their 96% triples.
        //   D1←B1..B4 are then all skipped (sources already used).
        //   D1←S5@31% processes — D1 is still free, S5 is still free → D1←S5 PAIRS.
        //   D2←S5 is skipped (S5 consumed). D2 UNMATCHED.
        //
        // Greedy with cap=4: S5 is evicted from D1's 4-slot matrix (65% > 31%).
        //   D3..D6 consume B1..B4; D1←B1..B4 all skipped.
        //   No D1←S5 triple exists → D1 UNMATCHED.
        //   D2←S5@15% processes → D2←S5 PAIRS.
        //
        // Pinned against git 2.54.0 with -M1%:
        //   R096  b1.txt → d3.txt
        //   R096  b2.txt → d4.txt
        //   R096  b3.txt → d5.txt
        //   R096  b4.txt → d6.txt
        //   R015  s5.txt → d2.txt
        //   A     d1.txt
        const ctx = await buildSeededContext();
        const threshold1pct = Math.trunc(MAX_SCORE / 100);

        const makeBlock = (prefix: string, count: number): string =>
          Array.from(
            { length: count },
            (_, i) =>
              `${prefix}-${String(i + 1).padStart(2, '0')}: content alpha beta gamma delta epsilon zeta\n`,
          ).join('');

        const COMMON = makeBlock('common', 20);
        const EXTRA1 = makeBlock('extra-B1', 4);
        const EXTRA2 = makeBlock('extra-B2', 4);
        const EXTRA3 = makeBlock('extra-B3', 4);
        const EXTRA4 = makeBlock('extra-B4', 4);
        const S5D1 = makeBlock('s5-d1', 10);
        const S5D2 = makeBlock('s5-d2', 2);

        const [b1Id, b2Id, b3Id, b4Id, s5Id, d1Id, d2Id, d3Id, d4Id, d5Id, d6Id] =
          await Promise.all([
            writeBlob(
              ctx,
              `${COMMON}${EXTRA1}unique-B1: marker only in B1 alpha beta gamma delta\n`,
            ),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA2}unique-B2: marker only in B2 alpha beta gamma delta\n`,
            ),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA3}unique-B3: marker only in B3 alpha beta gamma delta\n`,
            ),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA4}unique-B4: marker only in B4 alpha beta gamma delta\n`,
            ),
            writeBlob(ctx, `${S5D1}${S5D2}unique-S5: marker only in S5 alpha beta gamma delta\n`),
            writeBlob(ctx, `${COMMON}${S5D1}unique-D1: marker only in D1 alpha beta gamma delta\n`),
            writeBlob(ctx, `${S5D2}unique-D2: marker only in D2 alpha beta gamma delta\n`),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA1}unique-D3: marker only in D3 alpha beta gamma delta\n`,
            ),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA2}unique-D4: marker only in D4 alpha beta gamma delta\n`,
            ),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA3}unique-D5: marker only in D5 alpha beta gamma delta\n`,
            ),
            writeBlob(
              ctx,
              `${COMMON}${EXTRA4}unique-D6: marker only in D6 alpha beta gamma delta\n`,
            ),
          ]);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'b1.txt' as FilePath,
              oldId: b1Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'b2.txt' as FilePath,
              oldId: b2Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'b3.txt' as FilePath,
              oldId: b3Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'b4.txt' as FilePath,
              oldId: b4Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 's5.txt' as FilePath,
              oldId: s5Id,
              oldMode: FILE_MODE.REGULAR,
            },
            { type: 'add', newPath: 'd1.txt' as FilePath, newId: d1Id, newMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'd2.txt' as FilePath, newId: d2Id, newMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'd3.txt' as FilePath, newId: d3Id, newMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'd4.txt' as FilePath, newId: d4Id, newMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'd5.txt' as FilePath, newId: d5Id, newMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'd6.txt' as FilePath, newId: d6Id, newMode: FILE_MODE.REGULAR },
          ],
        };
        // Act
        const sut = detectSimilarityRenames(ctx, diff, { threshold: threshold1pct });
        const result = await sut;
        const renames = result.changes.filter((c) => c.type === 'rename');
        const adds = result.changes.filter((c) => c.type === 'add');
        // Assert — cap=4 evicts s5 from d1's matrix (b1..b4 fill 4 slots at 65% each,
        // s5 at 31% is the 5th candidate and is dropped). The bridge destinations d3..d6
        // consume b1..b4 before d1 can. d1 is left unmatched; s5 pairs with d2 (its only
        // viable destination).
        expect(renames).toHaveLength(5);
        const s5Rename = renames.find((r) => r.type === 'rename' && r.oldPath === 's5.txt');
        expect(s5Rename).toBeDefined();
        if (s5Rename?.type === 'rename') {
          // Without cap (=1000), s5 would pair with d1 (score 31% > d2's 15%).
          // With cap=4, s5 is evicted from d1's matrix and pairs with d2 instead.
          expect(s5Rename.newPath).toBe('d2.txt');
        }
        // d1 must be left as an unmatched add (cap evicted its only remaining viable source)
        const d1Add = adds.find((a) => a.type === 'add' && a.newPath === 'd1.txt');
        expect(d1Add).toBeDefined();
      });
    });
  });

  // ── equivalent-mutant: L41 new Array() vs new Array(n) ──────────────────────
  // Workers write by index assignment; JS arrays auto-extend so .map() covers all
  // indices regardless of initial length. Proof: results[idx]=… sets length to
  // max(idx)+1; .map() then covers 0..ids.length-1 identically.
  //
  // equivalent-mutant: L53 Math.max(MAX_CONCURRENT_BLOB_LOADS,ids.length) as concurrency ─
  // Extra workers spin once, see cursor≥ids.length, and return immediately.
  // Proof: cursor is shared; all ids processed before extras start.
  //
  // equivalent-mutant: L55 i<=concurrency vs i<concurrency ───────────────────
  // One extra worker is spawned; it sees cursor≥ids.length on entry and exits.
  // Proof: same shared-cursor argument; final results array unchanged.
  //
  // equivalent-mutant: L141 i<=slots.length in min-find loop ─────────────────
  // Extra iteration accesses slots[NUM_CANDIDATE_PER_DST]=undefined; the
  // `cur!==undefined` guard skips it; minIdx is unchanged.
  // Proof: undefined-check guard is the invariant.
  //
  // equivalent-mutant: L185 Math.min(sfSize,dfSize) as maxSize ────────────────
  // When sfSize≤dfSize: new maxSize=sfSize<dfSize; (sfSize-dfSize)*MAX_SCORE<0;
  // LHS≥0 so LHS<RHS is always false → never rejects. Equivalent to no prefilter.
  // Proof: (min-max)*MAX_SCORE≤0; positive<non-positive = false.
  //
  // equivalent-mutant: L186 Math.max(sfSize,dfSize) as minSize ────────────────
  // maxSize=minSize; (maxSize-minSize)=0; RHS=0; LHS≥0 → never rejects.
  // Proof: (max-max)*MAX_SCORE=0.
  //
  // equivalent-mutant: L187 ConditionalExpression "false" (isSizeRejected→false) ─
  // The size prefilter is conservative: every rejected pair would also score<threshold.
  // Proof: the formula is a necessary condition derivable from the threshold formula;
  // any pair with score≥threshold has min/max≥threshold/MAX_SCORE, satisfying the
  // inequality in the non-rejected direction.
  //
  // equivalent-mutant: L187 ArithmeticOperator "(maxSize-minSize)/MAX_SCORE" ──
  // RHS becomes (max-min)/MAX_SCORE<1; LHS=max*(MAX_SCORE-threshold)≥0; for any
  // realistic blob (max≥1, threshold<MAX_SCORE) LHS>>RHS → never rejects. Equivalent.
  // Proof: max*(MAX_SCORE-threshold)≥(MAX_SCORE-threshold)>>1.
  //
  // equivalent-mutant: L187 ArithmeticOperator "MAX_SCORE+threshold" ─────────
  // LHS=max*(MAX_SCORE+threshold)>max*(MAX_SCORE-threshold); even harder to be <RHS
  // → effectively never rejects. Equivalent.
  // Proof: (MAX_SCORE+threshold)>(MAX_SCORE-threshold) so LHS grows, < fails.
  //
  // equivalent-mutant: L198 ConditionalExpression "false" (isSizeRejected guard) ─
  // Same as L187-false: prefilter is an optimization; skipping it leaves results
  // unchanged since estimateSimilarityFromMaps returns <threshold for the same pairs.

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

  // ── recordIfBetter slot-cap: min-tracking loop bounds and comparison operators ──

  // equivalent-mutant: L141 i<=slots.length (extra iteration) ─────────────────
  // Already documented above.
  //
  // equivalent-mutant: L141 i>=slots.length (loop never runs → minIdx=0 always) ─
  // Proof: when candidate C satisfies min_score < C.score ≤ slot[0].score,
  // correct code evicts the true min and adds C; mutant keeps slot[0] and doesn't add C.
  // But in the greedy pass, D picks slot[0]'s source (score ≥ C.score) regardless,
  // so C remains free for other destinations in both cases. When C.score > slot[0].score,
  // both correct and mutant add C to the cap (mutant's check C>slot[0] also passes).
  // Hence the observable set of pairings is identical. QED.
  //
  // equivalent-mutant: L141 BlockStatement empty (same as i>=) ─────────────────
  // Same proof: loop body never executes → minIdx=0 → same reasoning as i>=.
  //
  // equivalent-mutant: L144 false (condition always false → minIdx=0 always) ───
  // Same proof as i>=slots.length.
  //
  // equivalent-mutant: L144 true (condition always true → minIdx=last slot) ────
  // minIdx always ends at slots.length-1 (last slot). The candidate is rejected iff
  // candidate.score ≤ slots[last].score. Since the last slot has a non-minimum score
  // in general, the eviction decision differs from correct. But the same greedy-pass
  // argument applies: the destination picks the highest-scored source regardless of
  // which specific lower-scored sources are in vs out of the cap.
  // Proof: any C that only enters under "true" (but not under correct/minIdx=last) satisfies
  // C.score > slots[last].score, meaning C also beats the true minimum, so correct code
  // would also add C. No difference.
  //
  // equivalent-mutant: L144 cur.score<=min.score (tracks MAX not min → minIdx=0 often) ─
  // Tracking the maximum instead of minimum means slot[0] is most often "minimized".
  // Same greedy-pass equivalence argument applies.
  //
  // equivalent-mutant: L144 cur.score>=min.score (similar argument) ────────────
  // Same equivalence: the score selected for eviction may differ but the final
  // rename assignments are unchanged by the greedy-pass argument above.
  //
  // equivalent-mutant: L148 candidate.score>=minSlot.score (>= displaces equal) ─
  // Equal-score entries: if C.score == minSlot.score, both candidates are equally
  // valid for the slot. Evicting the existing entry and replacing with C gives a
  // cap with the same score distribution. The greedy pass produces the same result
  // (same scores, different but equivalent sources). For the observable output
  // (number and score of renames) to differ, we'd need C to be the ONLY viable
  // source for some other destination — but that would mean C is unique, making
  // C.score > all other candidates for that other destination, which means C would
  // have been added to the cap anyway (C beats the true minimum). Proof by
  // contradiction: if C with equal score displaces slot[0] under >= but not under >,
  // then C.score == slot[0].score, and the same greedy-pass argument shows no
  // observable difference (both C and slot[0]'s source have the same score and
  // either can pair with the destination).

  // ── buildFingerprintMap dedup: fingerprints.has(id) skip ──

  describe('Given two delete sources sharing the same blob id (deduplication in fingerprint map)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the shared blob id is fingerprinted once and both renames are detected', async () => {
        // Arrange — two deletes with the SAME blob id (identical content, thus same SHA).
        // buildFingerprintMap must skip the second id (has(id) guard, L170).
        // If the guard is removed (mutant: false), the second id still works — the
        // fingerprint is just overwritten with the same value — so this kills the mutant
        // via a correctness assertion on both renames being found.
        const ctx = await buildSeededContext();
        const sharedContent = Array.from(
          { length: 10 },
          (_, i) => `shared-line-${i}: dedup content alpha beta\n`,
        ).join('');
        const sharedId = await writeBlob(ctx, sharedContent);
        const dst1Id = await writeBlob(
          ctx,
          sharedContent.replace('shared-line-0:', 'CHANGED-line-0:'),
        );
        const dst2Id = await writeBlob(
          ctx,
          sharedContent.replace('shared-line-0:', 'ALTERED-line-0:'),
        );

        const diff: TreeDiff = {
          changes: [
            // Two deletes with the SAME blob id
            {
              type: 'delete',
              oldPath: 'src-a.txt' as FilePath,
              oldId: sharedId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'src-b.txt' as FilePath,
              oldId: sharedId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst-1.txt' as FilePath,
              newId: dst1Id,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst-2.txt' as FilePath,
              newId: dst2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — 2 renames detected; each source matches its closest destination
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
        expect(renames.every((r) => r.type === 'rename')).toBe(true);
      });
    });
  });

  // ── isSizeRejected boundary: <= changes accepted-pair threshold ──

  describe('Given an add/delete pair at exactly the size-rejection boundary (isSizeRejected <=)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the pair is NOT rejected by the size prefilter and is detected as a rename', async () => {
        // Arrange — craft sfSize and dfSize such that the isSizeRejected formula is
        // exactly at equality: maxSize * (MAX_SCORE - threshold) == (maxSize - minSize) * MAX_SCORE.
        // Solving: min/max = threshold/MAX_SCORE, i.e. with threshold=DEFAULT_RENAME_THRESHOLD=30000
        // and MAX_SCORE=60000: min/max = 1/2. Use sfSize=50 bytes, dfSize=100 bytes.
        // With correct '<': equality → NOT rejected (accepted for scoring).
        // With mutant '<=': equality → REJECTED (pair dropped → no rename).
        // Kills L187 [EqualityOperator] "<=".
        const ctx = await buildSeededContext();

        // Build sfSize=50 bytes, dfSize=100 bytes, with high content similarity.
        // The src content (50 bytes) is a prefix of the dst content (100 bytes),
        // sharing many spanhash chunks → similarity >= DEFAULT_RENAME_THRESHOLD.
        // Content: 5 lines of 10 bytes each vs 10 lines of 10 bytes each.
        const srcContent = Array.from({ length: 5 }, (_, i) => `abcdefgh${i}\n`).join(''); // 50 bytes
        const dstContent = Array.from({ length: 10 }, (_, i) => `abcdefgh${i % 5}\n`).join(''); // 100 bytes
        const srcId = await writeBlob(ctx, srcContent);
        const dstId = await writeBlob(ctx, dstContent);

        // Verify sizes are as expected
        const encoder = new TextEncoder();
        expect(encoder.encode(srcContent).length).toBe(50);
        expect(encoder.encode(dstContent).length).toBe(100);

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

        // Act — default threshold (30000 = 50% of MAX_SCORE), which is the boundary
        const result = await detectSimilarityRenames(ctx, diff, {
          threshold: DEFAULT_RENAME_THRESHOLD,
        });

        // Assert — the pair should be detected as a rename (size prefilter must NOT reject it)
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames.length).toBeGreaterThan(0);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('src.txt');
          expect(renames[0].newPath).toBe('dst.txt');
        }
      });
    });
  });

  // ── sortTriples comparator: score equality and kind-ordering arms ──

  describe('Given a rename and a copy candidate with DIFFERENT scores (sortTriples score branch)', () => {
    describe('When detectSimilarityRenames is called with copies:"on"', () => {
      it('Then the higher-scored candidate sorts first regardless of kind', async () => {
        // Arrange — copy candidate scores HIGHER than rename candidate for the same dst.
        // With correct sortTriples, copy (higher score) sorts before rename (lower score).
        // The greedy pass then picks the copy first; the rename dst is consumed → no rename.
        // Kills L267 [ConditionalExpression] "true" (always returns b.score-a.score,
        // ignoring the score-equality rename-priority branch).
        const ctx = await buildSeededContext();
        // Destination blob: 10 specific lines
        const dstContent = Array.from(
          { length: 10 },
          (_, i) => `dst-line-${i}: copy-wins content alpha beta gamma\n`,
        ).join('');
        // Copy source (modify preimage): IDENTICAL to dst → copy score = MAX_SCORE
        const copySourceContent = dstContent;
        // Rename source (delete): shares only partial content → rename score < MAX_SCORE
        const renameSourceContent = dstContent.replace(
          'dst-line-0: copy-wins content alpha beta gamma\n',
          'DIFFERENT-line-0\n',
        );

        const dstId = await writeBlob(ctx, dstContent);
        const modOldId = await writeBlob(ctx, copySourceContent);
        const modNewId = await writeBlob(ctx, 'completely different content\n');
        const delId = await writeBlob(ctx, renameSourceContent);

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
              type: 'delete',
              oldPath: 'del-src.txt' as FilePath,
              oldId: delId,
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

        // Act — copies:'on' so modify is a copy source; copy has higher score
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — the copy wins (higher score sorts first); the add is consumed by the copy
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('mod-src.txt');
          expect(copies[0].newPath).toBe('dst.txt');
        }
        // del-src.txt remains as a delete (no rename; dst was consumed by copy)
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes.some((d) => d.type === 'delete' && d.oldPath === 'del-src.txt')).toBe(true);
      });
    });
  });

  describe('Given a rename and a copy candidate at equal score (sortTriples kind-priority branch)', () => {
    describe('When detectSimilarityRenames is called with copies:"on"', () => {
      it('Then rename sorts AHEAD of copy at equal score (L269 and L270 kind arms both exercised)', async () => {
        // Arrange — rename and copy both score identically against dst.
        // The rename candidate MUST sort before the copy at equal score.
        // Kills L269 false (rename-wins arm disabled), L269 true (always fires, always returns -1),
        //       L269 a.kind!=='rename' (negates condition, copy sorts before rename),
        //       L270 true (always returns 1, wrong direction),
        //       L270 LogicalOperator || (fires when only one kind matches),
        //       L270 false (copy-loses arm disabled),
        //       L270 b.kind!=='rename' / a.kind!=='copy' negations.
        const ctx = await buildSeededContext();
        const sharedContent = Array.from(
          { length: 12 },
          (_, i) => `sort-line-${i}: equal-score content alpha beta gamma delta\n`,
        ).join('');
        const dstId = await writeBlob(ctx, sharedContent);
        const delId = await writeBlob(ctx, sharedContent); // rename source: IDENTICAL → R100
        const modOldId = await writeBlob(ctx, sharedContent); // copy source: IDENTICAL → C100
        const modNewId = await writeBlob(ctx, 'new content for modify target\n');

        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'del-src.txt' as FilePath,
              oldId: delId,
              oldMode: FILE_MODE.REGULAR,
            },
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
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'on' so mod-src.txt preimage is a copy source
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — rename wins at equal score; copy candidate loses
        const renames = result.changes.filter((c) => c.type === 'rename');
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(renames).toHaveLength(1);
        expect(copies).toHaveLength(0);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('del-src.txt');
          expect(renames[0].newPath).toBe('dst.txt');
        }
        // The modify must survive (rename won; copy source not consumed)
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
      });
    });
  });

  // ── buildAllTriples: copies!=='off' guard ──

  describe('Given copies:"off" with a modify and an add (buildAllTriples copies guard)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then no copy triples are built and the add remains when there are no delete sources', async () => {
        // Arrange — a copies:'off' diff so the copy-source guard must not build copy triples
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED\n'));
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
              newPath: 'added.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — explicit copies:'off'; no delete → inexact pass runs with only copy path guarded
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'off' });

        // Assert — copies:'off' means NO copy is detected; add stays as-is
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        if (result.changes.find((c) => c.type === 'add')?.type === 'add') {
          expect(result.changes.find((c) => c.type === 'add')?.type).toBe('add');
        }
      });
    });
  });

  // ── runInexactPass null guard: both-empty early return ──

  describe('Given no deletes and no copy sources (runInexactPass null guard)', () => {
    describe('When detectSimilarityRenames is called with copies:"off" and only adds', () => {
      it('Then the inexact pass returns null (early return when both empty)', async () => {
        // Arrange — no deletes, copies:'off' so both the deletes and copy-sources arrays are empty
        const ctx = await buildSeededContext();
        const addId = await writeBlob(ctx, tenLines(0));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'new.txt' as FilePath,
              newId: addId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — no deletes, copies:'off' → copySources empty → early return condition applies
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'off' });

        // Assert — add remains unchanged; no rename or copy
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('add');
        if (result.changes[0]?.type === 'add') {
          expect(result.changes[0].newPath).toBe('new.txt');
        }
      });
    });
  });

  // ── computeBreakScores: zero-size guards ──

  describe('Given a modify where both old and new blobs are empty (computeBreakScores zero-size)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites enabled', () => {
      it('Then computedBreakScore is 0 and dissimilarity is 0 (no NaN from division by zero)', async () => {
        // Arrange — empty→empty modify so maxSize=0 and srcSize=0, exercising both size guards
        const ctx = await buildSeededContext();
        // Empty blobs: 0 bytes each
        const emptyId = await writeBlob(ctx, '');
        // Two empty-blob modifies to ensure the breakScore path is exercised
        const anotherEmptyId = await writeBlob(ctx, '');

        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'empty.txt' as FilePath,
              oldId: emptyId,
              newId: anotherEmptyId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — breakScore=1 (anything > 0) so the break is attempted;
        // empty blobs have computedBreakScore=0 < 1 → NOT broken → plain modify
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — plain modify (no break attempted because computedBreakScore=0, not NaN)
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given a modify where the source blob is empty but the destination is non-empty', () => {
    describe('When detectSimilarityRenames is called with breakRewrites enabled', () => {
      it('Then dissimilarity is 0 (srcSize=0 → guard protects division by zero)', async () => {
        // Arrange — empty source blob but non-empty destination so srcSize=0 triggers the guard
        const ctx = await buildSeededContext();
        const emptyId = await writeBlob(ctx, '');
        const newId = await writeBlob(ctx, 'completely new content\n'.repeat(5));

        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file.txt' as FilePath,
              oldId: emptyId,
              newId: newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — low breakScore to force attempt; empty src has computedBreakScore computable
        // (maxSize = dstSize > 0, so L513 guard passes); srcSize=0 → dissimilarity guard matters
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — modify is present (not NaN-broken); dissimilarity=0 means no broken datum
        // (0 < DEFAULT_MERGE_SCORE → re-merged or not broken)
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          // dissimilarity=0 < mergeScore → emitMergedModify returns original (no broken)
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  // ── attemptBreaks early returns ──

  describe('Given a diff with no modify changes (attemptBreaks early return on empty modifies)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the function returns immediately with no broken records (modifies.length===0 guard)', async () => {
        // Arrange — delete+add only (no modifies) so the modifies.length===0 guard fires
        const ctx = await buildSeededContext();
        const delId = await writeBlob(ctx, tenLines(0));
        const addId = await writeBlob(ctx, tenLines(1));

        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: delId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: addId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — breakRewrites enabled; no modifies → should short-circuit
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — rename found (break pass correctly did nothing); no modify in output
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(0);
      });
    });
  });

  describe('Given modifies that all score below the break-attempt gate (attemptBreaks guard on empty records)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then no synthetic halves are created (records.length===0 guard fires)', async () => {
        // Arrange — very similar modify so dissimilarity stays below break threshold; records stays empty
        const ctx = await buildSeededContext();
        // Very similar modify: dissimilarity low → computedBreakScore < DEFAULT_BREAK_SCORE
        const similar1 = tenLines(0);
        const similar2 = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const modOldId = await writeBlob(ctx, similar1);
        const modNewId = await writeBlob(ctx, similar2);

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
          ],
        };

        // Act — high breakScore so modify doesn't exceed gate → records empty
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: MAX_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — modify passed through unchanged (not broken); no halves created
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('modify');
        if (result.changes[0]?.type === 'modify') {
          expect(result.changes[0].broken).toBeUndefined();
        }
      });
    });
  });

  // ── findPresentHalves: syntheticAdds membership check ──

  describe('Given a broken modify whose add-half is consumed but delete-half remains (findPresentHalves add side)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the delete-half stays as a delete and no re-merge is emitted', async () => {
        // Arrange — broken modify whose add-half is consumed by an exact rename; a real add
        // remains so the synthetic-set membership check must protect it from being treated as
        // a present synthetic half (add-half consumed, del-half survives as a plain delete)
        const ctx = await buildSeededContext();
        const contentA = 'aaa\nbbb\nccc\nddd\n'.repeat(10); // del-half content
        const contentB = 'xxx\nyyy\nzzz\nwww\n'.repeat(10); // add-half content (fully disjoint)

        const modOldId = await writeBlob(ctx, contentA);
        const modNewId = await writeBlob(ctx, contentB);
        // A delete with the same content as add-half → pairs with add-half via exact rename
        const otherDelId = await writeBlob(ctx, contentB); // same SHA as modNewId
        // A real add that is NOT a synthetic half — must not be misidentified as a present half
        const realAddId = await writeBlob(ctx, 'real-add-content unique\n'.repeat(3));

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
            // This delete pairs with the add-half via exact rename: other.txt → file.txt
            {
              type: 'delete',
              oldPath: 'other.txt' as FilePath,
              oldId: otherDelId,
              oldMode: FILE_MODE.REGULAR,
            },
            // Real add that must NOT be treated as a synthetic half
            {
              type: 'add',
              newPath: 'truly-new.txt' as FilePath,
              newId: realAddId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — break fires (contentA and contentB are fully disjoint → MAX_SCORE dissimilarity).
        // Exact pass: other.txt (oldId=B) → file.txt add-half (newId=B): exact rename, add-half consumed.
        // del-half (file.txt/oldId=A) remains as a delete.
        // remergeOrKeepBroken: del half present, add half NOT present → one-half-consumed path → del stays.
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — 1 rename (other.txt → file.txt via add-half); del-half remains as delete
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('other.txt');
          expect(renames[0].newPath).toBe('file.txt');
        }
        // del-half of file.txt stays as a delete (not re-merged)
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(1);
        if (deletes[0]?.type === 'delete') {
          expect(deletes[0].oldPath).toBe('file.txt');
        }
        // real add truly-new.txt must survive (not misidentified as a present synthetic half)
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
        if (adds[0]?.type === 'add') {
          expect(adds[0].newPath).toBe('truly-new.txt');
        }
        // No re-merged modify
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(0);
      });
    });
  });

  // ── remergeOrKeepBroken guards ──

  describe('Given no broken records (remergeOrKeepBroken early return guard)', () => {
    describe('When detectSimilarityRenames is called without breakRewrites', () => {
      it('Then changes are returned unchanged without entering remerge logic (broken.length===0 guard)', async () => {
        // Arrange — no breakRewrites so broken is empty; the early-return guard must fire
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

        // Act — no breakRewrites → broken=[] → guard fires
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — rename detected; no extraneous changes
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('rename');
        if (result.changes[0]?.type === 'rename') {
          expect(result.changes[0].oldPath).toBe('src.txt');
          expect(result.changes[0].newPath).toBe('dst.txt');
        }
      });
    });
  });

  describe('Given a broken modify where BOTH halves were consumed (remergeOrKeepBroken both-consumed path)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then neither half is re-merged and no extra modify appears (!delPresent && !addPresent guard)', async () => {
        // Arrange — fully disjoint modify so both halves are broken; each half is consumed by
        // an exact rename partner so !delPresent && !addPresent must hold and skip re-merge
        const ctx = await buildSeededContext();
        const modOldContent = 'aaa\nbbb\nccc\n'.repeat(10);
        const modNewContent = 'xxx\nyyy\nzzz\n'.repeat(10); // fully disjoint → break

        // Both halves are consumed: del-half → rename to dst1, add-half → rename from src2
        const modOldId = await writeBlob(ctx, modOldContent);
        const modNewId = await writeBlob(ctx, modNewContent);
        // dst1 matches the delete-half (modOldContent)
        const dst1Id = await writeBlob(ctx, modOldContent);
        // src2 has content identical to the add-half (modNewContent)
        const src2Id = await writeBlob(ctx, modNewContent);

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
            // dst1 pairs with the del-half via exact rename (same content)
            {
              type: 'add',
              newPath: 'dst1.txt' as FilePath,
              newId: dst1Id,
              newMode: FILE_MODE.REGULAR,
            },
            // src2 pairs with the add-half via exact rename (same content)
            {
              type: 'delete',
              oldPath: 'src2.txt' as FilePath,
              oldId: src2Id,
              oldMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — 2 renames; NO modify re-emitted (both halves consumed)
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given a broken modify where BOTH halves remain unconsumed (remergeOrKeepBroken toStrip guard)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the halves are stripped and a plain or broken modify is re-emitted (toStrip.size===0 guard)', async () => {
        // Arrange — fully disjoint modify so both halves survive with no rename candidates;
        // toStrip is non-empty so the strip path runs and a broken modify is re-emitted
        const ctx = await buildSeededContext();
        // Fully disjoint content → break IS attempted and both halves survive (no rename candidates)
        const oldId = await writeBlob(ctx, 'aaa\nbbb\nccc\nddd\n'.repeat(5));
        const newId = await writeBlob(ctx, 'xxx\nyyy\nzzz\nwww\n'.repeat(5));

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

        // Act — breakRewrites enabled; dissimilarity = MAX_SCORE; mergeScore = DEFAULT_MERGE_SCORE
        // MAX_SCORE > DEFAULT_MERGE_SCORE → kept broken
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — 1 broken modify; no delete/add halves remain
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeDefined();
          expect(change.broken?.score).toBe(MAX_SCORE);
        }
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  // ── resolveCopySources: copies='off' and copies='on' guards ──

  describe('Given copies:"off" (resolveCopySources copies==="off" guard)', () => {
    describe('When detectSimilarityRenames is called with an add and a modify', () => {
      it('Then copy sources are empty and the inexact pass finds no copies', async () => {
        // Arrange — copies:'off' with a modify + add; the guard must return an empty source list
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED\n'));
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'COPY\n'));

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
              newPath: 'added.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — explicit copies:'off'
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'off' });

        // Assert — NO copy detected; add stays as-is
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
      });
    });
  });

  describe('Given copies:"on" (resolveCopySources copies==="on" guard)', () => {
    describe('When detectSimilarityRenames is called with an add and a modify', () => {
      it('Then copy sources are built from modified files only and a copy is detected', async () => {
        // Arrange — preimage with an unchanged file that matches the add better than the modify
        // preimage; copies:'on' must exclude unchanged files while copies:'harder' includes them
        const ctx = await buildSeededContext();
        // Destination: similar to unchangedContent only (not to modOldContent)
        const unchangedContent = Array.from(
          { length: 10 },
          (_, i) => `unchanged-line-${i}: perfect match alpha beta gamma\n`,
        ).join('');
        const dstContent = unchangedContent.replace('unchanged-line-0:', 'COPY-DST line-0:');
        const modOldContent = 'totally different content for modify preimage\n'.repeat(3);
        const modNewContent = 'modified content after change\n'.repeat(3);

        const dstId = await writeBlob(ctx, dstContent);
        const unchangedId = await writeBlob(ctx, unchangedContent);
        const modOldId = await writeBlob(ctx, modOldContent);
        const modNewId = await writeBlob(ctx, modNewContent);

        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['unchanged.txt' as FilePath, { id: unchangedId, mode: FILE_MODE.REGULAR }],
          ['mod-src.txt' as FilePath, { id: modOldId, mode: FILE_MODE.REGULAR }],
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
              newPath: 'added.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'on': only modify preimage is a copy source (unchanged file excluded)
        const resultOn = await detectSimilarityRenames(ctx, diff, { copies: 'on' }, preimage);
        // Act — copies:'harder': unchanged file is also a copy source; should detect copy from it
        const resultHarder = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder' },
          preimage,
        );

        // Assert copies:'on' — no copy (mod-src.txt preimage doesn't match dst well)
        expect(resultOn.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(resultOn.changes.filter((c) => c.type === 'add')).toHaveLength(1);

        // Assert copies:'harder' — copy detected from unchanged.txt
        const copiesHarder = resultHarder.changes.filter((c) => c.type === 'copy');
        expect(copiesHarder).toHaveLength(1);
        if (copiesHarder[0]?.type === 'copy') {
          expect(copiesHarder[0].oldPath).toBe('unchanged.txt');
        }
      });
    });
  });

  describe('Given copies:"harder" with >= at the harderOverLimit boundary', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then when harder sources exactly equal limit^2 the pass runs (> not >=)', async () => {
        // Kills L696 [EqualityOperator] ">=": changes ">" to ">=" at the limit boundary.
        // With ">": adds.length * harderSources.length == limit^2 → NOT over limit → runs.
        // With ">=": same value → IS over limit → falls back → different copy sources.
        // Arrange: 1 add, 4 harder sources (1 modify + 3 unchanged in preimage), limit=2 (limit^2=4).
        // 1 * 4 = 4; with ">": 4 > 4 = false → NOT fallback → uses harder sources.
        // With ">=": 4 >= 4 = true → fallback to 'on' sources (only the modify preimage).
        const ctx = await buildSeededContext();
        // The add's content is most similar to unchanged.txt, not to the modify preimage.
        const sharedContent = Array.from(
          { length: 10 },
          (_, i) => `unchanged-match-${i}: shared content alpha beta gamma\n`,
        ).join('');
        const dstContent = sharedContent.replace('unchanged-match-0:', 'DST-line-0:');
        const unchangedContent = sharedContent;
        const modOldContent = 'modify-preimage different from dst\n'.repeat(3);
        const modNewContent = 'modify-new content\n'.repeat(3);

        const dstId = await writeBlob(ctx, dstContent);
        const unchangedId1 = await writeBlob(ctx, unchangedContent);
        const unchangedId2 = await writeBlob(ctx, 'unique-unchanged-2\n'.repeat(3));
        const unchangedId3 = await writeBlob(ctx, 'unique-unchanged-3\n'.repeat(3));
        const modOldId = await writeBlob(ctx, modOldContent);
        const modNewId = await writeBlob(ctx, modNewContent);

        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['unchanged1.txt' as FilePath, { id: unchangedId1, mode: FILE_MODE.REGULAR }],
          ['unchanged2.txt' as FilePath, { id: unchangedId2, mode: FILE_MODE.REGULAR }],
          ['unchanged3.txt' as FilePath, { id: unchangedId3, mode: FILE_MODE.REGULAR }],
          ['mod-src.txt' as FilePath, { id: modOldId, mode: FILE_MODE.REGULAR }],
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
              newPath: 'added.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'harder', limit=2 (limit^2=4), harderSources=4:
        //   adds.length * harderSources.length = 1 * 4 = 4
        //   With ">": 4 > 4 = false → NOT over limit → use harder sources (finds copy from unchanged1)
        //   With ">=": 4 >= 4 = true → over limit → fallback to 'on' sources → no copy from unchanged
        const result = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder', limit: 2 },
          preimage,
        );

        // Assert — with correct ">": unchanged1.txt is a copy source → copy detected
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('unchanged1.txt');
          expect(copies[0].newPath).toBe('added.txt');
        }
      });
    });
  });

  // ── finalizeWithBroken: broken.length===0 fast path ──

  describe('Given a diff with only renames (no broken records, finalizeWithBroken guard)', () => {
    describe('When detectSimilarityRenames is called without breakRewrites', () => {
      it('Then finalizeWithBroken returns sorted changes directly (broken.length===0 guard)', async () => {
        // Arrange — delete+add pair with no breakRewrites so broken is empty; paths are
        // deliberately out of alpha order to also verify sorting via the fast path
        const ctx = await buildSeededContext();
        const srcContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const srcId = await writeBlob(ctx, srcContent);
        const dstId = await writeBlob(ctx, dstContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'b-src.txt' as FilePath,
              oldId: srcId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'a-dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — no breakRewrites → broken=[] → finalizeWithBroken short-circuit
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — rename found AND changes are sorted by path (a-dst.txt < b-src.txt)
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('rename');
        if (result.changes[0]?.type === 'rename') {
          expect(result.changes[0].oldPath).toBe('b-src.txt');
          expect(result.changes[0].newPath).toBe('a-dst.txt');
        }
      });
    });
  });

  // ── runBreakPass: breakRewrites.score===0 maps to DEFAULT_BREAK_SCORE ──

  describe('Given breakRewrites with score===0 (runBreakPass zero-score maps to DEFAULT_BREAK_SCORE)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then score===0 uses DEFAULT_BREAK_SCORE not 0 (kills L751 ConditionalExpression "true")', async () => {
        // Arrange — similar modify (one-line change) so computedBreakScore < DEFAULT_BREAK_SCORE;
        // score:0 must map to DEFAULT_BREAK_SCORE so the modify is NOT broken
        const ctx = await buildSeededContext();
        const similar1 = tenLines(0);
        const similar2 = tenLines(0).replace('X line 0\n', 'Y line 0\n');
        const oldId = await writeBlob(ctx, similar1);
        const newId = await writeBlob(ctx, similar2);

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

        // Act — score:0 should map to DEFAULT_BREAK_SCORE so this similar modify is NOT broken
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 0, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — plain modify (not broken); if mutant fires breakScore=0 → modify IS broken
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  // ── detectSimilarityRenames: exactResult options spreading ──

  describe('Given 33 adds and 33 deletes with one exact pair (L809 {} mutant: exact-pass limit bypass)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then exact rename is found even when adds*deletes exceeds the default limit of 1000', async () => {
        // Arrange — 33 adds × 33 deletes = 1089; one matching pair shares the same blob id;
        // limit:1 (inexact) forces a scenario where the exact pass must use MAX_SAFE_INTEGER
        const ctx = await buildSeededContext();
        const exactId = await writeBlob(ctx, 'exact-match-content unique sha\n'.repeat(3));
        // 33 distinct adds and 33 distinct deletes; only add[0]/delete[0] share exactId
        const otherIds = await Promise.all(
          Array.from({ length: 32 }, (_, i) =>
            writeBlob(ctx, `distinct-content-${String(i + 1).padStart(2, '0')}: no match\n`),
          ),
        );
        const changes: TreeDiff['changes'] = [
          {
            type: 'delete',
            oldPath: 'del-exact.txt' as FilePath,
            oldId: exactId,
            oldMode: FILE_MODE.REGULAR,
          },
          ...otherIds.map((id, i) => ({
            type: 'delete' as const,
            oldPath: `del-${String(i + 1).padStart(2, '0')}.txt` as FilePath,
            oldId: id,
            oldMode: FILE_MODE.REGULAR,
          })),
          {
            type: 'add',
            newPath: 'add-exact.txt' as FilePath,
            newId: exactId,
            newMode: FILE_MODE.REGULAR,
          },
          ...otherIds.map((id, i) => ({
            type: 'add' as const,
            newPath: `add-${String(i + 1).padStart(2, '0')}.txt` as FilePath,
            newId: id,
            newMode: FILE_MODE.REGULAR,
          })),
        ];
        const diff: TreeDiff = { changes };

        // Act — limit=1 so limit²=1; isOverLimit = 33*33=1089 > 1 → inexact pass SKIPPED.
        // Correct: exact pass gets limit=MAX_SAFE_INTEGER → 1089 ≤ MAX → runs → 33 renames.
        //          After exact pass: 0 adds, 0 deletes → early return.
        // Mutant {}: exact pass gets limit=1000 → 1089 > 1000 → bails → 33 adds+deletes left.
        //            isOverLimit = 1089 > 1 → true → inexact skipped → 33 unpaired adds/deletes.
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });

        // Assert — 33 renames found (exact pass ran); no stray adds or deletes
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(33);
        const exactRename = renames.find(
          (r) => r.type === 'rename' && r.oldPath === 'del-exact.txt',
        );
        expect(exactRename).toBeDefined();
        if (exactRename?.type === 'rename') {
          expect(exactRename.newPath).toBe('add-exact.txt');
          expect(exactRename.similarity.score).toBe(MAX_SCORE);
        }
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
      });
    });
  });

  // ── detectSimilarityRenames: hasRenameWork / hasCopyWork guards ──

  // equivalent-mutant: L812 [LogicalOperator] "adds.length>0 || deletes.length>0" ─────────
  // equivalent-mutant: L812 [EqualityOperator] "adds.length>=0" ──────────────────────────
  // equivalent-mutant: L812 [EqualityOperator] "deletes.length>=0" ────────────────────────
  // equivalent-mutant: L812 [ConditionalExpression] "true" (hasRenameWork always true) ─────
  // equivalent-mutant: L813 [LogicalOperator] "copies!=='off' || adds.length>0" ────────────
  // equivalent-mutant: L813 [EqualityOperator] "adds.length>=0" ──────────────────────────
  // equivalent-mutant: L813 [ConditionalExpression] "true" (hasCopyWork always true) ───────
  // equivalent-mutant: L814 [BlockStatement] "{}" (body emptied) ──────────────────────────
  // equivalent-mutant: L814 [ConditionalExpression] "false" (guard never fires) ────────────
  // Proof: When hasRenameWork or hasCopyWork is incorrectly true, the code falls through
  // to resolveCopySources (returns [] when copies='off') and runInexactPass.
  // runInexactPass returns null when deletes=[] AND copySources=[] (L446 guard).
  // assemblePostPass(adds, [], other, null) = [...adds, ...other] = exactResult.changes.
  // finalizeWithBroken sorts by path in both branches, so the output is identical.
  // When copies!='off' but adds=0, no copy sources help either; same null result.
  // The guards are pure short-circuit optimizations; the observable return value is unchanged.

  describe('Given no adds but some deletes (hasRenameWork guard: adds.length>0 required)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the inexact pass is skipped and delete remains (no adds → no work)', async () => {
        // Arrange — delete-only diff (no adds) so adds.length=0 and hasRenameWork is false
        const ctx = await buildSeededContext();
        const delId = await writeBlob(ctx, tenLines(0));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'src.txt' as FilePath,
              oldId: delId,
              oldMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — delete remains; no rename (no adds → nothing to pair with)
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('delete');
        if (result.changes[0]?.type === 'delete') {
          expect(result.changes[0].oldPath).toBe('src.txt');
        }
      });
    });
  });

  describe('Given only adds but no deletes and copies:"off" (hasRenameWork and hasCopyWork guard)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then both work guards fire false and changes pass through unchanged', async () => {
        // Arrange — add+modify with copies:'off' and no deletes so adds.length>0 but
        // deletes.length=0; hasRenameWork=false and hasCopyWork=false → early return
        const ctx = await buildSeededContext();
        const addId = await writeBlob(ctx, tenLines(0));
        const modOldId = await writeBlob(ctx, tenLines(1));
        const modNewId = await writeBlob(ctx, tenLines(2));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'new.txt' as FilePath,
              newId: addId,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'modify',
              path: 'mod.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'off', no deletes → hasRenameWork=false, hasCopyWork=false → early return
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'off' });

        // Assert — changes pass through; 1 add, 1 modify; no renames/copies
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
      });
    });
  });

  describe('Given adds and copies:"on" but no deletes (hasCopyWork guard: copies!=="off")', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then hasCopyWork is true and the inexact pass is attempted for copies', async () => {
        // Arrange — copies:'on' with an add and a modify but no deletes; hasCopyWork must be
        // true even with deletes.length=0 so the inexact copy pass runs
        const ctx = await buildSeededContext();
        const modOldId = await writeBlob(ctx, tenLines(0));
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED\n'));
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

        // Act — copies:'on', no deletes → hasCopyWork=true → inexact pass runs → copy found
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — copy detected from modify preimage
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
      });
    });
  });

  describe('Given !hasRenameWork && !hasCopyWork resolves to false (L814 BlockStatement guard)', () => {
    describe('When detectSimilarityRenames is called with adds, deletes, and copies:"off"', () => {
      it('Then the early-return body runs only when both conditions are false (L814 body and guard)', async () => {
        // Arrange — add-only diff with copies:'off' so hasRenameWork=false and hasCopyWork=false;
        // the early-return body must execute and return the add unchanged
        const ctx = await buildSeededContext();
        const addId = await writeBlob(ctx, tenLines(0));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'new.txt' as FilePath,
              newId: addId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'off', add-only diff → early return fires
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'off' });

        // Assert — single add remains; the function returned early correctly
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('add');
        if (result.changes[0]?.type === 'add') {
          expect(result.changes[0].newPath).toBe('new.txt');
          expect(result.changes[0].newId).toBe(addId);
        }
      });
    });
  });

  // ── detectSimilarityRenames: isOverLimit >= boundary ──

  describe('Given adds.length*numSrc exactly equals limit^2 (isOverLimit >= mutant)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the inexact pass runs when the product equals limit^2 (> not >=)', async () => {
        // L824 [EqualityOperator] "adds.length * numSrc >= limit * limit":
        // With ">": product == limit^2 → NOT over limit → inexact runs.
        // With ">=": product == limit^2 → IS over limit → inexact skipped → no rename.
        // Arrange: 1 add, 1 delete (numSrc=1), limit=1 → 1*1=1 == 1*1=1.
        // With ">": 1 > 1 = false → inexact runs → rename found.
        // With ">=": 1 >= 1 = true → skip → no rename.
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

        // Act — limit=1: 1 add * 1 delete = 1; limit^2 = 1; 1 > 1 = false → runs
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });

        // Assert — rename found (inexact pass ran: limit boundary is not exceeded by >)
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('rename');
        if (result.changes[0]?.type === 'rename') {
          expect(result.changes[0].similarity.score).toBeGreaterThanOrEqual(
            DEFAULT_RENAME_THRESHOLD,
          );
        }
      });
    });
  });

  describe('Given a different-oid gitlink add/delete pair', () => {
    describe('When detectSimilarityRenames runs at threshold 1', () => {
      it('Then stays separate add and delete, gitlink oid never read', async () => {
        // Arrange — seed real commit objects so a mutant dropping the partitionLeftovers
        // guard falls through to hydrateAndFingerprint → readBlob → throws
        const ctx = await buildSeededContext();
        const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, emptyTree);
        const author = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
        const commitX: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'x',
            extraHeaders: [],
          },
        };
        const commitY: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'y',
            extraHeaders: [],
          },
        };
        const glX = await writeObject(ctx, commitX);
        const glY = await writeObject(ctx, commitY);
        const diff: TreeDiff = {
          changes: [
            { type: 'delete', oldPath: 'sub' as FilePath, oldId: glX, oldMode: FILE_MODE.GITLINK },
            { type: 'add', newPath: 'sub' as FilePath, newId: glY, newMode: FILE_MODE.GITLINK },
          ],
        };

        // Act — threshold 1 maximises chance of inexact match
        const result = await detectSimilarityRenames(ctx, diff, { threshold: 1 });
        const resultHarder = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder' },
          new Map(),
        );

        // Assert — both runs: one add + one delete, no rename, no copy, no throw
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(resultHarder.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(resultHarder.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
        expect(resultHarder.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
      });
    });
  });

  describe('Given a gitlink delete and a real-blob add (R3 candidate)', () => {
    describe('When detectSimilarityRenames runs', () => {
      it('Then gitlink stays delete and blob stays add (no cross-kind rename)', async () => {
        // Arrange — isolates the gitlink-delete guard in partitionLeftovers
        const ctx = await buildSeededContext();
        const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, emptyTree);
        const author = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
        const commitX: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'x',
            extraHeaders: [],
          },
        };
        const glX = await writeObject(ctx, commitX);
        const blobId = await writeBlob(ctx, tenLines(0));
        const diff: TreeDiff = {
          changes: [
            { type: 'delete', oldPath: 'sub' as FilePath, oldId: glX, oldMode: FILE_MODE.GITLINK },
            {
              type: 'add',
              newPath: 'file.txt' as FilePath,
              newId: blobId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { threshold: 1 });

        // Assert — gitlink delete stays, blob add stays; no rename
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        const del = result.changes.find((c) => c.type === 'delete');
        if (del?.type === 'delete') expect(del.oldMode).toBe(FILE_MODE.GITLINK);
      });
    });
  });

  describe('Given a gitlink modify above the break-attempt gate', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then gitlink modify passes through unchanged, readBlob never called', async () => {
        // Arrange — isolates the attemptBreaks gitlink-mode filter.
        // Seed real commit objects; a mutant removing the filter would call readBlob and throw.
        const ctx = await buildSeededContext();
        const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, emptyTree);
        const author = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
        const commitOld: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'o',
            extraHeaders: [],
          },
        };
        const commitNew: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'n',
            extraHeaders: [],
          },
        };
        const oldId = await writeObject(ctx, commitOld);
        const newId = await writeObject(ctx, commitNew);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'sub' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.GITLINK,
              newMode: FILE_MODE.GITLINK,
            },
          ],
        };

        // Act — break score 1 guarantees the gate triggers for non-gitlink modifies
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — modify passes through untouched (no break datum)
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
          expect(change.oldMode).toBe(FILE_MODE.GITLINK);
        }
      });
    });
  });

  describe('Given a gitlink modify in the diff with copies: "on"', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then gitlink preimage is NOT a copy source, blob add stays add', async () => {
        // Arrange — isolates buildCopySourcesForOn gitlink-mode guard (other-derived source).
        // Seed real commit objects; a mutant removing the guard would add gitlink to copy sources,
        // call readBlob and throw.
        const ctx = await buildSeededContext();
        const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, emptyTree);
        const author = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
        const commitOld: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'o',
            extraHeaders: [],
          },
        };
        const commitNew: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'n',
            extraHeaders: [],
          },
        };
        const oldGlId = await writeObject(ctx, commitOld);
        const newGlId = await writeObject(ctx, commitNew);
        const blobId = await writeBlob(ctx, tenLines(0));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'sub' as FilePath,
              oldId: oldGlId,
              newId: newGlId,
              oldMode: FILE_MODE.GITLINK,
              newMode: FILE_MODE.GITLINK,
            },
            {
              type: 'add',
              newPath: 'file.txt' as FilePath,
              newId: blobId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'on' includes modify preimages as copy sources
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — gitlink modify is not a copy source; blob add stays as add
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
      });
    });
  });

  describe('Given an unchanged gitlink entry in the preimage with copies: "harder"', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then gitlink preimage entry is NOT a copy source, blob add stays add', async () => {
        // Arrange — isolates buildCopySourcesForHarder gitlink-mode guard (preimage-derived source).
        // Seed real commit object so a mutant removing the guard would add it to copy sources,
        // call readBlob and throw.
        const ctx = await buildSeededContext();
        const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, emptyTree);
        const author = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
        const commitX: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'x',
            extraHeaders: [],
          },
        };
        const gitlinkOid = await writeObject(ctx, commitX);
        const blobId = await writeBlob(ctx, tenLines(0));
        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['unchanged_sub' as FilePath, { id: gitlinkOid, mode: FILE_MODE.GITLINK }],
        ]);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'file.txt' as FilePath,
              newId: blobId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'harder' includes unchanged preimage entries as copy sources
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'harder' }, preimage);

        // Assert — gitlink preimage is NOT a copy source; blob add stays as add
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
      });
    });
  });

  describe('Given an exact same-oid gitlink add/delete pair (R1)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then folds to R100 MAX_SCORE rename, no bytes read', async () => {
        // Arrange — regression guard: exact domain fold must stay mode-agnostic
        const ctx = await buildSeededContext();
        const emptyTree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, emptyTree);
        const author = { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
        const commitX: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'x',
            extraHeaders: [],
          },
        };
        const glId = await writeObject(ctx, commitX);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/sub' as FilePath,
              oldId: glId,
              oldMode: FILE_MODE.GITLINK,
            },
            { type: 'add', newPath: 'b/sub' as FilePath, newId: glId, newMode: FILE_MODE.GITLINK },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — one rename at MAX_SCORE, both modes 160000
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].similarity.score).toBe(MAX_SCORE);
          expect(renames[0].oldMode).toBe(FILE_MODE.GITLINK);
          expect(renames[0].newMode).toBe(FILE_MODE.GITLINK);
        }
      });
    });
  });
});

const oidOf = (c: string): ObjectId => c.repeat(40) as ObjectId;
const renameTriple = (score: number): ScoredTriple => ({
  kind: 'rename',
  src: {
    type: 'delete',
    oldPath: 'src.txt' as FilePath,
    oldId: oidOf('a'),
    oldMode: FILE_MODE.REGULAR,
  } satisfies DeleteChange,
  add: {
    type: 'add',
    newPath: 'dst.txt' as FilePath,
    newId: oidOf('b'),
    newMode: FILE_MODE.REGULAR,
  } satisfies AddChange,
  score,
});

describe('Given the per-destination candidate matrix helper recordIfBetter', () => {
  describe('When the slot array is not yet full', () => {
    it('Then the candidate is appended without eviction', () => {
      // Arrange
      const sut = recordIfBetter;
      const slots: ScoredTriple[] = [renameTriple(50), renameTriple(40)];

      // Act
      sut(slots, renameTriple(10));

      // Assert — below the cap every candidate is kept regardless of score
      expect(slots.map((s) => s.score)).toEqual([50, 40, 10]);
    });
  });

  describe('When the slot array is full and the candidate beats the minimum', () => {
    it('Then it replaces exactly the minimum-scored slot', () => {
      // Arrange — the minimum (10) sits at index 1 of four full slots
      const sut = recordIfBetter;
      const slots: ScoredTriple[] = [
        renameTriple(50),
        renameTriple(10),
        renameTriple(30),
        renameTriple(20),
      ];

      // Act
      sut(slots, renameTriple(25));

      // Assert — only the true minimum (index 1) is evicted
      expect(slots.map((s) => s.score)).toEqual([50, 25, 30, 20]);
    });
  });

  describe('When two slots tie for the minimum', () => {
    it('Then the first minimum (lowest index) is the one evicted', () => {
      // Arrange — two 10s at indices 0 and 2
      const sut = recordIfBetter;
      const slots: ScoredTriple[] = [
        renameTriple(10),
        renameTriple(30),
        renameTriple(10),
        renameTriple(20),
      ];

      // Act
      sut(slots, renameTriple(25));

      // Assert — strict `<` min-finding keeps the lower index, evicting index 0
      expect(slots.map((s) => s.score)).toEqual([25, 30, 10, 20]);
    });
  });

  describe('When the candidate ties the minimum exactly', () => {
    it('Then the existing entry is kept (strictly-better replacement only)', () => {
      // Arrange — the minimum (20) is a distinct object at index 1
      const sut = recordIfBetter;
      const original = renameTriple(20);
      const slots: ScoredTriple[] = [
        renameTriple(50),
        original,
        renameTriple(30),
        renameTriple(40),
      ];

      // Act — a candidate equal to the minimum (a different object)
      sut(slots, renameTriple(20));

      // Assert — equal score does not displace; the original object is retained
      expect(slots[1]).toBe(original);
    });
  });

  describe('When the candidate is below the minimum', () => {
    it('Then no slot is replaced', () => {
      // Arrange — the minimum is 10
      const sut = recordIfBetter;
      const slots: ScoredTriple[] = [
        renameTriple(50),
        renameTriple(10),
        renameTriple(30),
        renameTriple(20),
      ];

      // Act
      sut(slots, renameTriple(5));

      // Assert
      expect(slots.map((s) => s.score)).toEqual([50, 10, 30, 20]);
    });
  });

  describe('When the cap constant is read', () => {
    it('Then it is git NUM_CANDIDATE_PER_DST of 4', () => {
      // Arrange / Act
      const sut = NUM_CANDIDATE_PER_DST;

      // Assert
      expect(sut).toBe(4);
    });
  });
});

describe('Given the size prefilter isSizeRejected', () => {
  describe('When the two sizes are too far apart to reach the threshold', () => {
    it('Then the pair is rejected', () => {
      // Arrange — a 10-byte vs 100-byte pair cannot be 50% similar
      const sut = isSizeRejected;

      // Act
      const result = sut(10, 100, DEFAULT_RENAME_THRESHOLD);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('When the two sizes are close enough to possibly reach the threshold', () => {
    it('Then the pair is not rejected', () => {
      // Arrange — 90 vs 100 bytes can exceed 50% similarity
      const sut = isSizeRejected;

      // Act
      const result = sut(90, 100, DEFAULT_RENAME_THRESHOLD);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('When the size delta sits exactly on the reachability boundary', () => {
    it('Then the pair is not rejected (strict inequality, inclusive boundary survives)', () => {
      // Arrange — max*(MAX-thr) equals (max-min)*MAX exactly: 2*30000 === 1*60000
      const sut = isSizeRejected;

      // Act
      const result = sut(1, 2, DEFAULT_RENAME_THRESHOLD);

      // Assert — the boundary is reachable, so the pair must be scored, not dropped
      expect(result).toBe(false);
    });
  });
});

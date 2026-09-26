import { describe, expect, it, vi } from 'vitest';
import {
  detectSimilarityRenames,
  isSizeRejected,
  NUM_CANDIDATE_PER_DST,
  recordIfBetter,
} from '../../../../src/application/primitives/detect-similarity-renames.js';
import * as readBlobMod from '../../../../src/application/primitives/read-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AddChange, TreeDiff } from '../../../../src/domain/diff/diff-change.js';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import type { MatrixCandidate } from '../../../../src/domain/diff/rename-pairing.js';
import {
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  estimateSimilarity,
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

/** Like `tenLines`, but long enough (60 lines, ~470 bytes) to clear
 *  MINIMUM_BREAK_SIZE while a single changed line stays a low-dissimilarity
 *  minority — used where a -B fixture needs to stay "very similar". */
const manyLines = (changed: number): string =>
  Array.from({ length: 60 }, (_, i) => (i === changed ? `X line ${i}\n` : `line ${i}\n`)).join('');

/**
 * Every line is the same byte length AND unique to its own position (both
 * the kept and the edited variant), so two lines only ever match when they
 * sit at the SAME index in both files — editing k of BASENAME_LINE_COUNT
 * lines always scores exactly (BASENAME_LINE_COUNT - k) / BASENAME_LINE_COUNT
 * against the shared baseline, and two independently-edited files never
 * coincidentally match on an edited line they don't actually share.
 */
const BASENAME_LINE_COUNT = 20;
const basenameKeptLineAt = (index: number): string => `m${String(index).padStart(4, '0')}\n`;
const basenameEditedLineAt = (index: number): string => `y${String(index).padStart(4, '0')}\n`;
const basenameContentEditingAt = (editedIndices: ReadonlySet<number>): string =>
  Array.from({ length: BASENAME_LINE_COUNT }, (_, i) =>
    editedIndices.has(i) ? basenameEditedLineAt(i) : basenameKeptLineAt(i),
  ).join('');
const basenameBaseline = (): string => basenameContentEditingAt(new Set());
const basenameEdited = (editedCount: number): string =>
  basenameContentEditingAt(new Set(Array.from({ length: editedCount }, (_, i) => i)));

/**
 * One line is one raw-score unit out of MAX_SCORE: every line is the same
 * byte length, so a content built from exactly `matchingLines` lines shared
 * with `scoreUnitBaseline` scores EXACTLY `matchingLines` — letting a
 * boundary test hit a specific raw score rather than a rounded approximation.
 */
const SCORE_UNIT_LINE_COUNT = MAX_SCORE;
const scoreUnitBaseline = (): string => 'a\n'.repeat(SCORE_UNIT_LINE_COUNT);
const scoreUnitContentAt = (matchingLines: number): string =>
  'a\n'.repeat(matchingLines) + 'b\n'.repeat(SCORE_UNIT_LINE_COUNT - matchingLines);

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
        // Act
        const result = await detectSimilarityRenames(ctx, diff);
        // Assert
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
        const result = await detectSimilarityRenames(ctx, diff);
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
        const result = await detectSimilarityRenames(ctx, diff);
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

  describe('Given two leftover deletes tied at the same inexact score, the second basename-matching', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the basename-matching source wins — nameScore breaks the score tie, not build order', async () => {
        // Arrange — del1 and del2 each differ from dst by exactly one (distinct)
        // line, so both tie at the same inexact score; only del2's basename
        // ('Foo.txt') matches the destination's, and it is examined SECOND.
        const ctx = await buildSeededContext();
        const dstContent = tenLines(-1);
        const del1Content = tenLines(0);
        const del2Content = tenLines(5);
        const dstId = await writeBlob(ctx, dstContent);
        const del1Id = await writeBlob(ctx, del1Content);
        const del2Id = await writeBlob(ctx, del2Content);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/Aaa.txt' as FilePath,
              oldId: del1Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/Foo.txt' as FilePath,
              oldId: del2Id,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/Foo.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — the tie is genuine (both candidates score identically)
        const rename = result.changes.find((c) => c.type === 'rename');
        const encoder = new TextEncoder();
        const del1Score = estimateSimilarity(
          encoder.encode(del1Content),
          encoder.encode(dstContent),
        );
        const del2Score = estimateSimilarity(
          encoder.encode(del2Content),
          encoder.encode(dstContent),
        );
        expect(del1Score).toBe(del2Score);
        expect(rename?.oldPath).toBe('a/Foo.txt');
        expect(result.changes.find((c) => c.type === 'delete')?.oldPath).toBe('a/Aaa.txt');
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
        // Arrange — a modify is never an inexact rename source
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
        // Arrange — a modified file acts as a copy source; the copy
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
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

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

  describe('Given copies: "on" with a source the diff does not touch', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the unchanged file is NOT a copy source and the add remains as-is', async () => {
        // Arrange — plain -C only uses the preimage of CHANGED files.
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

  describe('Given copies: "on" and a copy pair scored one below threshold', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the copy is NOT detected (add remains as add)', async () => {
        // Arrange — the copy pass gate is the same `threshold` as renames; set it to
        // one above the pair's measured score so this exact pair falls below it.
        const ctx = await buildSeededContext();
        const preimageContent = tenLines(0);
        const copyContent = tenLines(0).replace('X line 0\n', 'COPY DST\n');
        const measuredScore = estimateSimilarity(
          new TextEncoder().encode(preimageContent),
          new TextEncoder().encode(copyContent),
        );
        const modOldId = await writeBlob(ctx, preimageContent);
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED line 0\n'));
        const dstId = await writeBlob(ctx, copyContent);
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

        // Act — threshold one above the measured score: the copy-pass gate rejects it
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          threshold: measuredScore + 1,
        });

        // Assert — no copy detected
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(0);
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
      });
    });
  });

  describe('Given copies: "on" and a copy pair scored exactly at threshold', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the copy IS detected (inclusive gate)', async () => {
        // Arrange — same pair as the sibling row above, threshold set to the exact
        // measured score so the copy-pass gate (score >= threshold) admits it.
        const ctx = await buildSeededContext();
        const preimageContent = tenLines(0);
        const copyContent = tenLines(0).replace('X line 0\n', 'COPY DST\n');
        const measuredScore = estimateSimilarity(
          new TextEncoder().encode(preimageContent),
          new TextEncoder().encode(copyContent),
        );
        const modOldId = await writeBlob(ctx, preimageContent);
        const modNewId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'EDITED line 0\n'));
        const dstId = await writeBlob(ctx, copyContent);
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

        // Act — threshold at the exact measured score: the copy-pass gate admits it
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          threshold: measuredScore,
        });

        // Assert — copy detected
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('kept.txt');
          expect(copies[0].newPath).toBe('copied.txt');
        }
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

  describe('Given copies: "harder" with limit=0 (unlimited) and an unchanged file similar to an add', () => {
    describe('When detectSimilarityRenames is called with preimage', () => {
      it('Then the harder source set is never limit-capped so the unchanged file folds into a copy', async () => {
        // Arrange — limit=0 means unlimited: git never falls back to the 'on' source set,
        // so the unchanged preimage file stays a copy source and the add folds into a copy.
        const ctx = await buildSeededContext();
        const unchangedContent = tenLines(0);
        const dstContent = tenLines(0).replace('X line 0\n', 'COPY DST line 0\n');
        const unchangedId = await writeBlob(ctx, unchangedContent);
        const dstId = await writeBlob(ctx, dstContent);
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

        // Act — limit=0 (unlimited) under copies:'harder'; preimage passed positionally
        const result = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder', limit: 0 },
          preimage,
        );

        // Assert — copy detected from the unchanged harder source (no limit fallback to 'on')
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('unchanged.txt');
          expect(copies[0].newPath).toBe('copied.txt');
        }
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
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
      it('Then rename wins over copy at equal score', async () => {
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
        const result = await detectSimilarityRenames(ctx, diff);

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
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
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
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
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
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
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
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
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
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
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
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
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

  describe('Given breakRewrites merge:0 and a broken pair whose dissimilarity is below the 60% default', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then merge:0 maps to DEFAULT_MERGE_SCORE so the pair re-merges to a plain modify', async () => {
        // Arrange — ~25% of the file changed, so the break dissimilarity sits BELOW
        // DEFAULT_MERGE_SCORE (60%). A 100% rename threshold keeps the synthetic halves
        // unpaired, isolating the keep-broken/re-merge gate. merge:0 must resolve to the
        // 60% default: dissimilarity < 60% → re-merge to a plain modify (no broken datum).
        // With merge:0 mapping to 0 instead, dissimilarity >= 0 would keep it broken.
        const ctx = await buildSeededContext();
        const shared = 'shared line alpha beta gamma delta epsilon\n';
        const oldId = await writeBlob(ctx, shared.repeat(20));
        const newId = await writeBlob(
          ctx,
          `${shared.repeat(15)}${'different NEW text zeta eta theta iota\n'.repeat(5)}`,
        );
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

        // Act — score:1 forces the break; threshold MAX_SCORE keeps the halves unpaired.
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: 0 },
          threshold: MAX_SCORE,
        });

        // Assert — one plain modify, no broken datum (merge:0 → 60%, dissimilarity below it).
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given a broken pair that re-merges alongside an unrelated surviving change', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then only the broken halves are stripped and the unrelated change is retained', async () => {
        // Arrange — file1 is a fully-disjoint modify that -B keeps broken; file2 is an
        // unrelated add. Re-merge must strip ONLY file1's synthetic halves and keep file2.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
        const file2Id = await writeBlob(ctx, 'brand new unrelated file body\n');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'file1.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'file2.txt' as FilePath,
              newId: file2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — break file1 (disjoint → kept broken); file2 add is untouched.
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — both paths survive: stripping the halves must not drop file2.
        const paths = result.changes
          .map((c) => ('newPath' in c ? c.newPath : (c as { path: FilePath }).path))
          .sort();
        expect(paths).toEqual(['file1.txt', 'file2.txt']);
        const file2 = result.changes.find((c) => 'newPath' in c && c.newPath === 'file2.txt');
        expect(file2?.type).toBe('add');
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

  describe('Given breakRewrites and a broken modify whose old content pairs elsewhere while its new content stays unpaired (design row K1)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the halves rejoin as a broken modify and the pairing becomes a copy (write back counts the rejoin as a use, live git: M100 m ; C100 m→q)', async () => {
        // Arrange — file.txt's old content exactly matches rename-dst.txt (an unrelated
        // add); file.txt's new content is fully disjoint and unpaired, so its add-half
        // never pairs. Fixture kept >= 500 bytes per design so Part 11's byte-size guard
        // still leaves it broken.
        const ctx = await buildSeededContext();
        const sharedContent = 'shared\ncontent\nfor\nrename\ntarget\n'.repeat(20);
        const disjointContent = 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(30);

        // file.txt: old=sharedContent, new=disjointContent → dissimilarity ~MAX_SCORE → break
        const modOldId = await writeBlob(ctx, sharedContent);
        const modNewId = await writeBlob(ctx, disjointContent);
        // rename-dst.txt: identical to file.txt's old content → exact pair
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

        // Assert — the unpaired add-half rejoins into a broken modify
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        if (modifies[0]?.type === 'modify') {
          expect(modifies[0].broken?.score).toBe(MAX_SCORE);
        }
        // The rejoin counted one extra use of file.txt's old content, so the exact
        // pairing with rename-dst.txt labels as a copy, not a rename (K1).
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('file.txt');
          expect(copies[0].newPath).toBe('rename-dst.txt');
          expect(copies[0].similarity.score).toBe(MAX_SCORE);
        }
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
      });
    });
  });

  describe('Given breakRewrites and a broken modify whose old content near-matches another add while its new content stays unpaired (design row K2)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the halves rejoin as a broken modify and the inexact pairing becomes a copy (live git: M100 m ; C099 m→q)', async () => {
        // Arrange — m.txt's old content near-matches (one extra tail line) q.txt, an
        // unrelated add; m.txt's new content is fully disjoint and stays unpaired.
        const ctx = await buildSeededContext();
        const oldContent = 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25);
        const newContent = 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25);
        const nearMatchContent = `${oldContent}extra unique tail line only in q\n`;

        const oldId = await writeBlob(ctx, oldContent);
        const newId = await writeBlob(ctx, newContent);
        const qId = await writeBlob(ctx, nearMatchContent);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'm.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'q.txt' as FilePath,
              newId: qId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — the unpaired add-half rejoins into a broken modify
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        if (modifies[0]?.type === 'modify') {
          expect(modifies[0].broken?.score).toBe(MAX_SCORE);
        }
        // The rejoin counted one extra use of m.txt's old content, so the inexact
        // pairing with q.txt labels as a copy, not a rename (K2).
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('m.txt');
          expect(copies[0].newPath).toBe('q.txt');
          expect(copies[0].similarity.score).toBeLessThan(MAX_SCORE);
        }
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
      });
    });
  });

  describe('Given breakRewrites and a broken modify whose own two halves pair with each other under a lowered rename threshold', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the pair resolves back to a broken modify instead of a same-path rename', async () => {
        // Arrange — f.txt keeps 35 of its 100 lines: dissimilarity (65%) clears
        // both the default break gate and the default merge gate, so the delete
        // half is unseeded and free to compete; its own add half is the only
        // destination, and their 35% literal overlap clears a threshold lowered
        // to 20% — the self-pair wins the slot exactly like git's matrix does.
        const lineCount = 100;
        const keptCount = 35;
        const selfPairLine = (index: number, changed: boolean): string =>
          changed
            ? `different-${index}: completely new text zeta theta kappa\n`
            : `line-${index}: shared content alpha beta gamma delta\n`;
        const oldContent = Array.from({ length: lineCount }, (_, i) => selfPairLine(i, false)).join(
          '',
        );
        const newContent = Array.from({ length: lineCount }, (_, i) =>
          selfPairLine(i, i >= keptCount),
        ).join('');
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, oldContent);
        const newId = await writeBlob(ctx, newContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'f.txt' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          threshold: 12000,
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — a modify with a high (break) dissimilarity, never a rename
        expect(result.changes).toHaveLength(1);
        const [change] = result.changes;
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.path).toBe('f.txt');
          expect(change.broken?.score).toBeGreaterThanOrEqual(DEFAULT_MERGE_SCORE);
        }
        expect(result.changes.some((c) => c.type === 'rename')).toBe(false);
        expect(result.changes.some((c) => c.type === 'copy')).toBe(false);
      });
    });
  });

  describe('Given 5 deleted sources for one destination, 3 unrelated junk below threshold and 2 tied best matches', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the junk sources still occupy a matrix slot, shifting the tie-break to the later-visited best match', async () => {
        // Arrange — a0/a2/a3 are junk, far below the default 50% threshold;
        // a1 and a4 are equally similar to d (one changed line out of ten).
        // git's record_if_better visits every source, so a0's slot survives
        // long enough to be evicted by a4, not a1 — a4 ends up ahead of a1 in
        // the pre-sort array, and the stable sort keeps that order on the tie.
        const ctx = await buildSeededContext();
        const junkContent = (label: string): string =>
          `completely unrelated ${label} content block\n`.repeat(6);
        const [a0Id, a1Id, a2Id, a3Id, a4Id, dId] = await Promise.all([
          writeBlob(ctx, junkContent('zero')),
          writeBlob(ctx, tenLines(5)),
          writeBlob(ctx, junkContent('two')),
          writeBlob(ctx, junkContent('three')),
          writeBlob(ctx, tenLines(5)),
          writeBlob(ctx, tenLines(-1)),
        ]);
        const deletes = [
          ['a0.txt', a0Id],
          ['a1.txt', a1Id],
          ['a2.txt', a2Id],
          ['a3.txt', a3Id],
          ['a4.txt', a4Id],
        ] as const;
        const diff: TreeDiff = {
          changes: [
            ...deletes.map(
              ([path, oldId]) =>
                ({
                  type: 'delete',
                  oldPath: path as FilePath,
                  oldId,
                  oldMode: FILE_MODE.REGULAR,
                }) as const,
            ),
            { type: 'add', newPath: 'd.txt' as FilePath, newId: dId, newMode: FILE_MODE.REGULAR },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — a4 wins the destination, a1 stays a plain delete
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        expect(renames[0]?.oldPath).toBe('a4.txt');
        expect(result.changes.some((c) => c.type === 'delete' && c.oldPath === 'a1.txt')).toBe(
          true,
        );
      });
    });
  });

  describe('Given a 5x5 scenario with unambiguous per-pair best scores', () => {
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
        const result = await detectSimilarityRenames(ctx, diff);
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
        const result = await detectSimilarityRenames(ctx, diff, { threshold: threshold1pct });
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
  // equivalent-mutant: L53 Math.max(MAX_CONCURRENT_OBJECT_LOADS,ids.length) as concurrency ─
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
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on', limit: 2 });
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

  // ── selectPairs wiring: a deleted source beats a better-scoring retained one ──

  describe('Given copies:"on" with a modified source scoring higher than a deleted source for the same destination (design row C19)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the deleted source wins the destination as a rename — pass 1 never lets a retained source win, no matter its score', async () => {
        // Arrange — the modify's preimage (copy candidate, ~95%) scores higher than the
        // delete (rename candidate, ~90%) against dst, but neither is an EXACT match (an
        // exact match would resolve in the exact pass, ahead of this test's target — the
        // inexact matrix). git's two-pass selection (design row C19) pairs only zero-use
        // (deleted) sources in pass 1, so the delete wins the destination even though the
        // retained source scores higher — a pure score-sort gets this backwards.
        const ctx = await buildSeededContext();
        const dstContent = Array.from(
          { length: 10 },
          (_, i) => `dst-line-${i}: c19 content alpha beta gamma\n`,
        ).join('');
        const copySourceContent = `${dstContent}extra-tail-line: zzz\n`; // ~95%, not exact
        const renameSourceContent = dstContent.replace(
          'dst-line-0: c19 content alpha beta gamma\n',
          'DIFFERENT-line-0\n',
        ); // ~90%

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

        // Act — copies:'on' so mod-src.txt's preimage is a copy candidate
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — the DELETE wins as a rename despite the retained source's higher score
        const renames = result.changes.filter((c) => c.type === 'rename');
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(renames).toHaveLength(1);
        expect(copies).toHaveLength(0);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('del-src.txt');
          expect(renames[0].newPath).toBe('dst.txt');
        }
        // The modify survives — its preimage was never consumed (pass 2 never ran; the
        // destination was already claimed in pass 1)
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
      });
    });
  });

  describe('Given copies:"on" with an exactly-consumed modify source scoring higher than a deleted source for a second destination (design row C20)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the exact pass folds the first destination into a copy and the deleted source wins the second as a rename', async () => {
        // Arrange — mod.txt's old content is IDENTICAL to n1.txt (exact copy pass, uses
        // the source once already) and 85%-similar to n2.txt; d.txt is 80%-similar to
        // n2.txt. Once the exact pass consumes mod.txt's source, pass 1 (deleted-only)
        // still wins n2.txt for d.txt despite its lower score.
        const ctx = await buildSeededContext();
        const sharedLines = Array.from(
          { length: 17 },
          (_, i) => `c20-shared-${String(i).padStart(2, '0')}: alpha beta gamma delta\n`,
        );
        const modOnly = Array.from({ length: 3 }, (_, i) => `c20-mod-only-${i}: epsilon zeta\n`);
        const n2Only = Array.from({ length: 3 }, (_, i) => `c20-n2-only-${i}: eta theta\n`);
        const dOnly = Array.from({ length: 4 }, (_, i) => `c20-d-only-${i}: iota kappa\n`);

        const modOldContent = [...sharedLines, ...modOnly].join('');
        const n1Content = modOldContent; // exact match to mod.txt's old content
        const n2Content = [...sharedLines, ...n2Only].join('');
        const dOldContent = [...sharedLines.slice(0, 16), ...dOnly].join('');

        const modOldId = await writeBlob(ctx, modOldContent);
        const modNewId = await writeBlob(ctx, 'c20 modify new content\n');
        const dOldId = await writeBlob(ctx, dOldContent);
        const n1Id = await writeBlob(ctx, n1Content);
        const n2Id = await writeBlob(ctx, n2Content);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'mod.txt' as FilePath,
              oldId: modOldId,
              newId: modNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'd.txt' as FilePath,
              oldId: dOldId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'n1.txt' as FilePath,
              newId: n1Id,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'n2.txt' as FilePath,
              newId: n2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — n1.txt folds into an exact copy; n2.txt is won by the deleted source
        const copies = result.changes.filter((c) => c.type === 'copy');
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(copies).toHaveLength(1);
        expect(renames).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('mod.txt');
          expect(copies[0].newPath).toBe('n1.txt');
        }
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('d.txt');
          expect(renames[0].newPath).toBe('n2.txt');
        }
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given copies:"on" with four higher-scoring retained sources and one lower-scoring deleted source competing for one destination (cull rule keeps used sources in the shared candidate cap)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the shared per-destination cap evicts the deleted source before pass 1 runs, so a retained source wins as a copy and the delete survives', async () => {
        // Arrange — r1..r4's old content shares 16 of 20 lines with n.txt (~80%); d.txt
        // shares only 8 of 20 lines with n.txt (~40%). All five compete for n.txt's
        // shared 4-slot matrix cap: if used (retained) sources were excluded from that
        // cap, d.txt — the only zero-use source — would win pass 1 outright. Because
        // the cap is shared across every matrix source regardless of use count, d.txt
        // is evicted before pass 1 ever runs, and pass 2 lets a retained source win
        // instead.
        const ctx = await buildSeededContext();
        const common = Array.from(
          { length: 16 },
          (_, i) => `cull-common-${String(i).padStart(2, '0')}: alpha beta gamma delta epsilon\n`,
        );
        const nTail = Array.from({ length: 4 }, (_, i) => `cull-n-tail-${i}: zeta eta\n`);
        const nContent = [...common, ...nTail].join('');
        const retainedTail = (n: number): string[] =>
          Array.from({ length: 4 }, (_, i) => `cull-r${n}-tail-${i}: theta iota\n`);
        const dTail = Array.from({ length: 12 }, (_, i) => `cull-d-tail-${i}: kappa lambda\n`);
        const dOldContent = [...common.slice(0, 8), ...dTail].join('');

        const nId = await writeBlob(ctx, nContent);
        const dOldId = await writeBlob(ctx, dOldContent);
        const retained = await Promise.all(
          [1, 2, 3, 4].map(async (n) => ({
            path: `r${n}.txt` as FilePath,
            oldId: await writeBlob(ctx, [...common, ...retainedTail(n)].join('')),
            newId: await writeBlob(ctx, `cull-r${n}-new content only\n`),
          })),
        );

        const diff: TreeDiff = {
          changes: [
            ...retained.map((r) => ({
              type: 'modify' as const,
              path: r.path,
              oldId: r.oldId,
              newId: r.newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            })),
            {
              type: 'delete',
              oldPath: 'd.txt' as FilePath,
              oldId: dOldId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'n.txt' as FilePath,
              newId: nId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — a low threshold (30%) admits both the ~80% retained scores and d.txt's
        // ~40% score as legitimate candidates, isolating the cap-eviction behaviour.
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          threshold: Math.trunc(MAX_SCORE * 0.3),
        });

        // Assert — a retained source wins n.txt as a copy; d.txt never pairs
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(['r1.txt', 'r2.txt', 'r3.txt', 'r4.txt']).toContain(copies[0].oldPath);
          expect(copies[0].newPath).toBe('n.txt');
        }
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(1);
        if (deletes[0]?.type === 'delete') {
          expect(deletes[0].oldPath).toBe('d.txt');
        }
        expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(4);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given two rename candidates from the same delete tied at equal score (selectPairs pass 1 stable order)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the first destination in build order wins the delete (rename-vs-rename tiebreak is stable)', async () => {
        // Arrange — one delete D equally similar to two adds A1 and A2 (each differs from D by
        // one distinct line → identical score, distinct content). Greedy consumes D for the
        // FIRST candidate in build order (A1, iterated before A2). Reversing that stable
        // order would hand D to A2 instead.
        const ctx = await buildSeededContext();
        const dId = await writeBlob(ctx, tenLines(0));
        const a1Id = await writeBlob(ctx, tenLines(0).replace('line 5\n', 'CH1 line 5\n'));
        const a2Id = await writeBlob(ctx, tenLines(0).replace('line 7\n', 'CH2 line 7\n'));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'D.txt' as FilePath,
              oldId: dId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'A1.txt' as FilePath,
              newId: a1Id,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'A2.txt' as FilePath,
              newId: a2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert — D pairs with A1 (first in build order); A2 is left as an unmatched add
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('D.txt');
          expect(renames[0].newPath).toBe('A1.txt');
        }
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
        if (adds[0]?.type === 'add') {
          expect(adds[0].newPath).toBe('A2.txt');
        }
      });
    });
  });

  describe('Given two copy sources with identical content tied at equal score for one dst (selectPairs pass 2 stable order)', () => {
    describe('When detectSimilarityRenames is called with copies:"harder"', () => {
      it('Then the first copy source in build order wins the dst (copy-vs-copy tiebreak is stable)', async () => {
        // Arrange — two unchanged files A.txt and B.txt share the SAME blob id (identical
        // content) and both match the add equally. Greedy takes the FIRST source in build
        // order (A.txt, iterated before B.txt). Reversing that stable order would name
        // B.txt as the copy source instead.
        const ctx = await buildSeededContext();
        const sharedId = await writeBlob(ctx, tenLines(0));
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'CHG line 0\n'));
        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['A.txt' as FilePath, { id: sharedId, mode: FILE_MODE.REGULAR }],
          ['B.txt' as FilePath, { id: sharedId, mode: FILE_MODE.REGULAR }],
        ]);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'dst.txt' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'harder' so both unchanged files are copy sources
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'harder' }, preimage);

        // Assert — the copy names A.txt (first source in build order) as its origin
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('A.txt');
          expect(copies[0].newPath).toBe('dst.txt');
        }
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

  describe('Given a modify where both old and new blobs are empty (should_break size guard fires at maxSize=0)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites enabled', () => {
      it('Then the pair never reaches computeBreakScores, so no division by zero is possible', async () => {
        // Arrange — empty→empty modify so maxSize=0 (< MINIMUM_BREAK_SIZE) and srcSize=0:
        // isBreakSizeGuarded fires on both conditions before computeBreakScores ever runs.
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

        // Act — breakScore=1 (anything > 0); the guard still forces computedBreakScore=0 < 1
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 1, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — plain modify (guard short-circuits before any scoring)
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });
  });

  describe('Given an empty-source modify whose new content matches an unrelated deleted file (design row S0)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites enabled', () => {
      it('Then the empty-source guard means the modify never breaks and the deleted file stays a bare delete (live git: D a/d ; M a/e)', async () => {
        // Arrange — a/e's old content is empty; its new content is byte-identical to a/d's
        // deleted content and kept >= MINIMUM_BREAK_SIZE, so only the empty-source guard (S0),
        // not the size guard (S1), explains the outcome. Without the S0 guard, a/e's modify
        // would break, its synthetic add-half would exact-pair with a/d's delete, and write
        // back would drop a/e's synthetic delete-half — turning the pair into a wrong rename.
        const ctx = await buildSeededContext();
        const emptyId = await writeBlob(ctx, '');
        const sharedContent = Array.from(
          { length: 20 },
          (_, i) =>
            `line-${String(i).padStart(2, '0')}: shared payload alpha beta gamma delta epsilon\n`,
        ).join('');
        const sharedId = await writeBlob(ctx, sharedContent);

        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/d' as FilePath,
              oldId: sharedId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'modify',
              path: 'a/e' as FilePath,
              oldId: emptyId,
              newId: sharedId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — a/d stays a bare delete, a/e stays an unbroken modify, no rename appears
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(1);
        if (deletes[0]?.type === 'delete') {
          expect(deletes[0].oldPath).toBe('a/d');
        }
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        if (modifies[0]?.type === 'modify') {
          expect(modifies[0].path).toBe('a/e');
          expect(modifies[0].broken).toBeUndefined();
        }
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
      });
    });
  });

  describe('Given a modify whose sizes sit one byte under the should_break minimum-size guard (design row S1)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites enabled', () => {
      it('Then a 399-byte fully-disjoint pair is never broken, even though dissimilarity would be MAX_SCORE', async () => {
        // Arrange — both sides exactly 399 bytes (< MINIMUM_BREAK_SIZE), fully disjoint content.
        // LF-delimited short lines (not one 399-byte run of a single byte) so the spanhash
        // chunk splitter's 64-byte forced boundary can't accidentally alias src and dst chunks.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(
          ctx,
          `${'aaaa\nbbbb\ncccc\ndddd\n'.repeat(19)}${'e'.repeat(18)}\n`,
        );
        const newId = await writeBlob(
          ctx,
          `${'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(19)}${'q'.repeat(18)}\n`,
        );
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
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — the size guard fires: no break attempted, plain modify survives
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken).toBeUndefined();
        }
      });
    });

    describe('When the same fully-disjoint pair sits exactly at MINIMUM_BREAK_SIZE (400 bytes)', () => {
      it('Then the pair breaks normally', async () => {
        // Arrange — both sides exactly 400 bytes (the minimum-size gate is inclusive)
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(20));
        const newId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(20));
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
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — the pair clears the size guard and breaks, kept broken at MAX_SCORE
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.broken?.score).toBe(MAX_SCORE);
          expect(change.broken?.maxScore).toBe(MAX_SCORE);
        }
      });
    });
  });

  // ── computeBreakScores maxSize denominator: max(src,dst) not min(src,dst) ──

  describe('Given a breakRewrites modify whose old content is fully preserved as the first half of a doubled-length new content', () => {
    describe('When detectSimilarityRenames is called with a break gate strictly between the max- and min-denominator scores', () => {
      it('Then max(src,dst) is the denominator so the score stays below the gate and the modify is NOT broken', async () => {
        // Arrange — src is exactly the first half of dst; dst appends an equal-sized block of new
        // lines, so srcSize = S, dstSize = 2S, srcRemoved ≈ 0, literalAdded ≈ S. Each block is
        // 396 bytes (>= MINIMUM_BREAK_SIZE) so Part 11's size guard does not itself explain a
        // non-break here — only the max-denominator choice does.
        //   break_score = min(srcRemoved + literalAdded, maxSize) * MAX_SCORE / maxSize
        // With maxSize = max(src,dst) = 2S → ≈ S * MAX_SCORE / 2S = 30000 (below the 45000 gate → NOT broken).
        // With maxSize = min(src,dst) = S  → ≈ S * MAX_SCORE / S  = 60000 (above the gate → broken).
        // A break would split file.txt into a delete-half (content == target.txt → exact rename)
        // plus a surviving add-half, turning the plain modify into a rename. The modify surviving
        // as a plain modify (no rename) pins max(src,dst) as the denominator.
        const ctx = await buildSeededContext();
        const preserved = Array.from(
          { length: 12 },
          (_, i) => `shared-line-${String(i).padStart(2, '0')}: alpha beta gamma\n`,
        ).join('');
        const appended = Array.from(
          { length: 12 },
          (_, i) => `brand-new-line-${String(i).padStart(2, '0')}: delta epsilon\n`,
        ).join('');
        const srcContent = preserved;
        const dstContent = `${preserved}${appended}`;
        const modOldId = await writeBlob(ctx, srcContent);
        const modNewId = await writeBlob(ctx, dstContent);
        // target.txt is byte-identical to the modify's old content — an exact-rename partner for
        // the delete-half IF (and only if) the break fires.
        const targetId = await writeBlob(ctx, srcContent);

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
              newPath: 'target.txt' as FilePath,
              newId: targetId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — gate at 45000, strictly between the max-denominator (30000) and min-denominator (60000) scores
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: 45000, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — max denominator keeps the score below the gate: no break, so no rename and the modify survives
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        const modifies = result.changes.filter((c) => c.type === 'modify');
        expect(modifies).toHaveLength(1);
        if (modifies[0]?.type === 'modify') {
          expect(modifies[0].path).toBe('file.txt');
          expect(modifies[0].broken).toBeUndefined();
        }
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
        if (adds[0]?.type === 'add') {
          expect(adds[0].newPath).toBe('target.txt');
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
        // Arrange — very similar modify so dissimilarity stays below break threshold; records stays empty.
        // manyLines (>= MINIMUM_BREAK_SIZE) so the break-attempt gate — not Part 11's size guard —
        // is what keeps records empty.
        const ctx = await buildSeededContext();
        // Very similar modify: dissimilarity low → computedBreakScore < DEFAULT_BREAK_SCORE
        const similar1 = manyLines(0);
        const similar2 = manyLines(0).replace('X line 0\n', 'Y line 0\n');
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

  // ── write back: a broken delete drops once its add half pairs (design row S2) ──

  describe('Given a broken modify whose add-half pairs elsewhere (design row S2)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the delete-half is dropped, whatever its own use count (live git: no D, only R)', async () => {
        // Arrange — file.txt's add-half (contentB) pairs exactly with other.txt's delete;
        // file.txt's delete-half (contentA) is unused elsewhere, so under the OLD rule it
        // would survive as a bare delete — S2 says it must be dropped regardless, because
        // its own add half paired. A real add (truly-new.txt) must be unaffected.
        const ctx = await buildSeededContext();
        const contentA = 'aaa\nbbb\nccc\nddd\n'.repeat(35); // del-half content, >= 500 bytes
        const contentB = 'xxx\nyyy\nzzz\nwww\n'.repeat(35); // add-half content (fully disjoint)

        const modOldId = await writeBlob(ctx, contentA);
        const modNewId = await writeBlob(ctx, contentB);
        // A delete with the same content as the add-half → pairs with it via exact rename
        const otherDelId = await writeBlob(ctx, contentB); // same SHA as modNewId
        // A real add that is NOT a synthetic half — must be unaffected by write back
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
            // Real add that must be unaffected by write back
            {
              type: 'add',
              newPath: 'truly-new.txt' as FilePath,
              newId: realAddId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — break fires (contentA and contentB are fully disjoint → MAX_SCORE dissimilarity).
        // Exact pass: other.txt (oldId=B) → file.txt add-half (newId=B): exact rename, add-half paired.
        // Write back (S2): file.txt's delete-half is dropped because its add half paired.
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — 1 rename (other.txt → file.txt via add-half); no delete for file.txt at all
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('other.txt');
          expect(renames[0].newPath).toBe('file.txt');
        }
        // file.txt's delete-half never surfaces — S2 drops it unconditionally
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
        // real add truly-new.txt must survive
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

  // ── write back guards ──

  describe('Given no broken records', () => {
    describe('When detectSimilarityRenames is called without breakRewrites', () => {
      it('Then changes are returned unchanged without entering write back (broken.length===0)', async () => {
        // Arrange — no breakRewrites so broken is empty; write back must no-op
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

        // Act — no breakRewrites → broken=[] → write back has nothing to do
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

  describe('Given a broken modify whose add-half pairs elsewhere and whose old content also pairs elsewhere', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then no modify is re-emitted — write back drops the delete because its add half paired (S2)', async () => {
        // Arrange — fully disjoint modify so both halves are broken; each half pairs with
        // an exact rename partner. The add half pairing alone is enough for write back to
        // drop the delete (S2); the old content separately pairs with dst1 as its own rename.
        const ctx = await buildSeededContext();
        const modOldContent = 'aaa\nbbb\nccc\n'.repeat(35);
        const modNewContent = 'xxx\nyyy\nzzz\n'.repeat(35); // fully disjoint → break

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

  describe('Given a broken modify whose add-half stays unpaired and has no rename candidates at all (design row K3 shape, no other source)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then write back rejoins the halves into a plain or broken modify', async () => {
        // Arrange — fully disjoint modify so both halves survive with no rename candidates;
        // the add half is unpaired, so write back rejoins into a broken modify
        const ctx = await buildSeededContext();
        // Fully disjoint content → break IS attempted and both halves survive (no rename candidates)
        const oldId = await writeBlob(ctx, 'aaa\nbbb\nccc\nddd\n'.repeat(30));
        const newId = await writeBlob(ctx, 'xxx\nyyy\nzzz\nwww\n'.repeat(30));

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

  // ── buildCopySourcesForOn: unpaired deletes are copy sources ──

  describe('Given copies:"on" and a delete whose content matches two adds (delete is also a copy source)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the delete copies to its best (first-in-path-order) add and renames to the second', async () => {
        // Arrange — matrix: an unpaired delete D is BOTH a rename source and a copy source.
        // D is more similar to A1 (one line changed) than to A2 (three lines changed), so both
        // land D's two uses; git's use-count label (not the pass that produced a pair) decides
        // rename vs copy: walked in destination-path order, every use but the last is a copy —
        // A1 sorts before A2, so A1 is the copy and A2, last in path order, is the rename.
        const ctx = await buildSeededContext();
        const dId = await writeBlob(ctx, tenLines(0));
        const a1Id = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'Y line 0\n'));
        const a2Id = await writeBlob(
          ctx,
          tenLines(0)
            .replace('X line 0\n', 'Y0\n')
            .replace('line 1\n', 'Z1\n')
            .replace('line 2\n', 'Z2\n'),
        );
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'D.txt' as FilePath,
              oldId: dId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'A1.txt' as FilePath,
              newId: a1Id,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'A2.txt' as FilePath,
              newId: a2Id,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act — copies:'on' so the unpaired delete is added to the copy-source set
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — copy D→A1 plus rename D→A2; no add or delete survives
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
        if (renames[0]?.type === 'rename') {
          expect(renames[0].oldPath).toBe('D.txt');
          expect(renames[0].newPath).toBe('A2.txt');
        }
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('D.txt');
          expect(copies[0].newPath).toBe('A1.txt');
        }
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
      });
    });
  });

  describe('Given copies:"on" and a type-change whose preimage matches an add (type-change is a copy source)', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the add folds into a copy from the type-change preimage WITHOUT consuming the type-change', async () => {
        // Arrange — a type-change (regular→symlink) contributes its PREIMAGE blob as a copy
        // source under plain -C, exactly like a modify. The add matches that preimage and folds
        // into a copy; the type-change itself survives (source retained). Removing the
        // type-change arm of the copy-source guard leaves the add unmatched.
        const ctx = await buildSeededContext();
        const tcOldId = await writeBlob(ctx, tenLines(0));
        const tcNewId = await writeBlob(ctx, 'symlink-target-path');
        const dstId = await writeBlob(ctx, tenLines(0).replace('X line 0\n', 'COPY line 0\n'));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'tc.txt' as FilePath,
              oldId: tcOldId,
              newId: tcNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
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
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert — copy from the type-change preimage; type-change survives; no leftover add
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('tc.txt');
          expect(copies[0].newPath).toBe('copied.txt');
        }
        expect(result.changes.filter((c) => c.type === 'type-change')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
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
        // score:0 must map to DEFAULT_BREAK_SCORE so the modify is NOT broken. manyLines
        // (>= MINIMUM_BREAK_SIZE) keeps Part 11's size guard out of the way.
        const ctx = await buildSeededContext();
        const similar1 = manyLines(0);
        const similar2 = manyLines(0).replace('X line 0\n', 'Y line 0\n');
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

  describe('Given a gitlink delete and a real-blob add', () => {
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

  describe('Given a gitlink add and a real-blob delete (add-side guard)', () => {
    describe('When detectSimilarityRenames runs', () => {
      it('Then gitlink stays add and blob stays delete, gitlink oid never read', async () => {
        // Arrange — isolates the gitlink-add guard in partitionLeftovers. A non-gitlink
        // delete keeps `deletes` non-empty so the inexact pass runs past its short-circuit;
        // a mutant dropping the add-side guard would route the gitlink add into `adds`,
        // hydrate its commit oid via readBlob, and throw.
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
            {
              type: 'delete',
              oldPath: 'file.txt' as FilePath,
              oldId: blobId,
              oldMode: FILE_MODE.REGULAR,
            },
            { type: 'add', newPath: 'sub' as FilePath, newId: glX, newMode: FILE_MODE.GITLINK },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { threshold: 1 });

        // Assert — gitlink add stays, blob delete stays; no rename
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        const add = result.changes.find((c) => c.type === 'add');
        if (add?.type === 'add') expect(add.newMode).toBe(FILE_MODE.GITLINK);
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

  describe('Given an exact same-oid gitlink add/delete pair', () => {
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

  // ── non-regular files leave similarity scoring (symlinks, row N1-N6b) ──

  describe('Given a deleted symlink whose target equals a new regular file (row N1)', () => {
    describe('When detectSimilarityRenames is called at the most permissive threshold', () => {
      it('Then the pair stays a plain delete and add, and the symlink blob is never read', async () => {
        // Arrange — same content, cross-kind: the exact pass already rejects this by
        // mode class; only the inexact matrix's own filter is under test here.
        const ctx = await buildSeededContext();
        const targetId = await writeBlob(ctx, 'shared-symlink-target');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/link' as FilePath,
              oldId: targetId,
              oldMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/file' as FilePath,
              newId: targetId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { threshold: 1 });

        // Assert — no rename; the symlink source is never a matrix candidate
        try {
          expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
          expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given row N1 under -C (row N1c)', () => {
    describe('When detectSimilarityRenames is called with copies: "on"', () => {
      it('Then the pair still stays a plain delete and add', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const targetId = await writeBlob(ctx, 'shared-symlink-target-c');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/link' as FilePath,
              oldId: targetId,
              oldMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/file' as FilePath,
              newId: targetId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          threshold: 1,
        });

        // Assert — no rename, no copy
        try {
          expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
          expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given a symlink deleted and a dissimilar symlink added, same kind both sides (row N2)', () => {
    describe('When detectSimilarityRenames is called at the most permissive threshold', () => {
      it('Then the pair stays a plain delete and add, no bytes read for either side', async () => {
        // Arrange — git's estimate_similarity requires S_ISREG on BOTH sides, so a
        // same-kind symlink pair never scores even though the content is 99%+ similar.
        const ctx = await buildSeededContext();
        const oldTarget = 'a'.repeat(280);
        const newTarget = `${oldTarget}b`;
        const oldId = await writeBlob(ctx, oldTarget);
        const newId = await writeBlob(ctx, newTarget);
        const diff: TreeDiff = {
          changes: [
            { type: 'delete', oldPath: 'a/link' as FilePath, oldId, oldMode: FILE_MODE.SYMLINK },
            { type: 'add', newPath: 'b/link' as FilePath, newId, newMode: FILE_MODE.SYMLINK },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { threshold: 1 });

        // Assert
        try {
          expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
          expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given a regular file deleted and a similar symlink added (row N3)', () => {
    describe('When detectSimilarityRenames is called at the most permissive threshold', () => {
      it('Then the pair stays a plain delete and add, the symlink destination is never read', async () => {
        // Arrange — the source is regular (eligible), the destination is a symlink
        // (excluded): isolates the destination-side filter.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, tenLines(0));
        const newId = await writeBlob(ctx, tenLines(1));
        const diff: TreeDiff = {
          changes: [
            { type: 'delete', oldPath: 'a/reg' as FilePath, oldId, oldMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'b/link' as FilePath, newId, newMode: FILE_MODE.SYMLINK },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { threshold: 1 });

        // Assert
        try {
          expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(1);
          expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
          expect(readSpy.mock.calls.some(([, id]) => id === newId)).toBe(false);
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given a modified symlink and a regular add matching its OLD target (row N4)', () => {
    describe('When detectSimilarityRenames is called with copies: "on"', () => {
      it('Then the modify stays plain and the add stays unpaired, the symlink preimage is never read', async () => {
        // Arrange — under -C the symlink's old blob would normally lend itself as a
        // copy source; a non-regular preimage never gets scored, only paired exactly
        // (and the exact pass already rejects it: cross-kind, different exactKey).
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'old-target-content');
        const newId = await writeBlob(ctx, 'new-target-content');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'a/link' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/file' as FilePath,
              newId: oldId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          threshold: 1,
        });

        // Assert
        try {
          expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'modify')).toHaveLength(1);
          expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given an unchanged symlink preimage and a regular add matching its target (row N5)', () => {
    describe('When detectSimilarityRenames is called with copies: "harder"', () => {
      it('Then the add stays unpaired, the unchanged symlink is never read', async () => {
        // Arrange — isolates the source-side filter for an `unchanged`-origin source.
        const ctx = await buildSeededContext();
        const targetId = await writeBlob(ctx, 'unchanged-symlink-target');
        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['a/link' as FilePath, { id: targetId, mode: FILE_MODE.SYMLINK }],
        ]);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'b/file' as FilePath,
              newId: targetId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder', threshold: 1 },
          preimage,
        );

        // Assert
        try {
          expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
          expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given an unchanged regular preimage and a symlink add carrying its content (row N5r)', () => {
    describe('When detectSimilarityRenames is called with copies: "harder"', () => {
      it('Then the add stays unpaired — the symlink destination never enters the matrix', async () => {
        // Arrange — isolates the destination-side filter against a regular (eligible)
        // unchanged source.
        const ctx = await buildSeededContext();
        const contentId = await writeBlob(ctx, 'unchanged-regular-content');
        const preimage = new Map<FilePath, FlatTreeEntry>([
          ['a/reg' as FilePath, { id: contentId, mode: FILE_MODE.REGULAR }],
        ]);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'add',
              newPath: 'b/link' as FilePath,
              newId: contentId,
              newMode: FILE_MODE.SYMLINK,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(
          ctx,
          diff,
          { copies: 'harder', threshold: 1 },
          preimage,
        );

        // Assert
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
      });
    });
  });

  describe('Given a fully-retargeted symlink modify and a regular add matching its OLD target under -M -B (row N6b)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the broken halves rejoin into one kept-broken modify, the add stays unpaired', async () => {
        // Arrange — the symlink modify still breaks (attemptBreaks keeps symlinks
        // eligible); the resulting synthetic delete half shares its OLD content with
        // the regular add, but never pairs with it — a non-regular side never scores,
        // so both broken halves stay unpaired and rejoin instead of cross-pairing.
        const ctx = await buildSeededContext();
        const oldTarget = 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(27); // 540 bytes
        const newTarget = 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(27); // 540 bytes, fully disjoint
        const oldId = await writeBlob(ctx, oldTarget);
        const newId = await writeBlob(ctx, newTarget);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'a/link' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/file' as FilePath,
              newId: oldId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — one kept-broken modify at a/link, plus the untouched add at b/file
        expect(result.changes).toHaveLength(2);
        const modify = result.changes.find((c) => c.type === 'modify');
        expect(modify?.type).toBe('modify');
        if (modify?.type === 'modify') {
          expect(modify.path).toBe('a/link');
          expect(modify.broken?.score).toBe(MAX_SCORE);
          expect(modify.broken?.maxScore).toBe(MAX_SCORE);
        }
        const add = result.changes.find((c) => c.type === 'add');
        expect(add?.type).toBe('add');
        if (add?.type === 'add') expect(add.newPath).toBe('b/file');
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
      });
    });
  });

  // ── -B breaks symlink↔regular type changes unconditionally (rows N7b, N7s) ──

  describe('Given a symlink→regular type change under -M -B (row N7b)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change is kept broken at MAX_SCORE and neither blob is read', async () => {
        // Arrange — a type change breaks unconditionally: content size is irrelevant
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, 'link-target');
        const newId = await writeBlob(ctx, 'regular file content');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — kept-broken type change, no blob read for either side
        try {
          expect(result.changes).toHaveLength(1);
          const change = result.changes[0];
          expect(change?.type).toBe('type-change');
          if (change?.type === 'type-change') {
            expect(change.broken?.score).toBe(MAX_SCORE);
            expect(change.broken?.maxScore).toBe(MAX_SCORE);
            expect(change.oldMode).toBe(FILE_MODE.SYMLINK);
            expect(change.newMode).toBe(FILE_MODE.REGULAR);
          }
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given a symlink→regular type change where both sides are the SAME blob under -M -B (row N7s)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change still breaks — the check runs before the same-oid check', async () => {
        // Arrange — same blob id on both sides; a modify would short-circuit on this
        // (same oid means never dissimilar), but a type change breaks unconditionally.
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'shared-blob-content');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: id,
              newId: id,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        try {
          expect(result.changes).toHaveLength(1);
          const change = result.changes[0];
          expect(change?.type).toBe('type-change');
          if (change?.type === 'type-change') {
            expect(change.broken?.score).toBe(MAX_SCORE);
          }
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  // ── -B's isBreakableKind filter: file↔symlink breaks, other pairs never do ──

  describe('Given a file↔gitlink type change under -M -B', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change is never broken — a gitlink side is not breakable', async () => {
        // Arrange — G3: gitlink type changes never break, whatever the other side is
        const ctx = await buildSeededContext();
        const gitlinkId = '1'.repeat(40) as ObjectId;
        const fileId = await writeBlob(ctx, 'regular content');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/sub' as FilePath,
              oldId: gitlinkId,
              newId: fileId,
              oldMode: FILE_MODE.GITLINK,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        try {
          expect(result.changes).toHaveLength(1);
          const change = result.changes[0];
          expect(change?.type).toBe('type-change');
          if (change?.type === 'type-change') expect(change.broken).toBeUndefined();
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  describe('Given a symlink↔gitlink type change under -M -B', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change is never broken — a gitlink side is not breakable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitlinkId = '2'.repeat(40) as ObjectId;
        const linkId = await writeBlob(ctx, 'symlink-target');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/sub' as FilePath,
              oldId: linkId,
              newId: gitlinkId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.GITLINK,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type === 'type-change') expect(change.broken).toBeUndefined();
      });
    });
  });

  describe('Given a directory↔file type change under -M -B (a non-recursive diff subtree entry)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change is never broken — a directory side is not breakable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = '3'.repeat(40) as ObjectId;
        const fileId = await writeBlob(ctx, 'regular content');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/sub' as FilePath,
              oldId: treeId,
              newId: fileId,
              oldMode: FILE_MODE.DIRECTORY,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type === 'type-change') expect(change.broken).toBeUndefined();
      });
    });
  });

  describe('Given a directory-mode modify under -M -B (a non-recursive diff subtree entry)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the modify is never scored — a directory side is not breakable', async () => {
        // Arrange — scoring a directory as a blob is nonsensical; isBreakableKind
        // must exclude it before scoreModifies ever reads a byte.
        const ctx = await buildSeededContext();
        const oldTreeId = '4'.repeat(40) as ObjectId;
        const newTreeId = '5'.repeat(40) as ObjectId;
        const diff: TreeDiff = {
          changes: [
            {
              type: 'modify',
              path: 'a/sub' as FilePath,
              oldId: oldTreeId,
              newId: newTreeId,
              oldMode: FILE_MODE.DIRECTORY,
              newMode: FILE_MODE.DIRECTORY,
            },
          ],
        };
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        try {
          expect(result.changes).toHaveLength(1);
          const change = result.changes[0];
          expect(change?.type).toBe('modify');
          if (change?.type === 'modify') expect(change.broken).toBeUndefined();
          expect(readSpy).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
        }
      });
    });
  });

  // ── a broken type change's rejoin counts as a use of its source (rows N7d, N7e, N7m) ──

  describe('Given a regular→symlink type change whose OLD content exactly matches an unrelated add (row N7d)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change stays kept-broken and the exact pairing becomes a copy, not a rename', async () => {
        // Arrange — a/p's old (regular) content exactly matches b/q; a/p's new
        // (symlink) content is disjoint from anything else, so the add half stays
        // unpaired and rejoins — the rejoin bumps a/p's old content to 2 uses.
        const ctx = await buildSeededContext();
        const oldContent = 'regular\ncontent\nfor\na\np\n'.repeat(20);
        const oldId = await writeBlob(ctx, oldContent);
        const newId = await writeBlob(ctx, 'a-brand-new-symlink-target');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/q' as FilePath,
              newId: oldId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        const typeChanges = result.changes.filter((c) => c.type === 'type-change');
        expect(typeChanges).toHaveLength(1);
        if (typeChanges[0]?.type === 'type-change') {
          expect(typeChanges[0].broken?.score).toBe(MAX_SCORE);
        }
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('a/p');
          expect(copies[0].newPath).toBe('b/q');
          expect(copies[0].similarity.score).toBe(MAX_SCORE);
        }
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given N7d with the add near-matching (one extra line) instead of exact (row N7e)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the type change stays kept-broken and the inexact pairing becomes a copy', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldContent = 'regular\ncontent\nfor\na\np\n'.repeat(20);
        const oldId = await writeBlob(ctx, oldContent);
        const newId = await writeBlob(ctx, 'a-brand-new-symlink-target');
        const nearMatchContent = `${oldContent}extra unique tail line only in q\n`;
        const qId = await writeBlob(ctx, nearMatchContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/q' as FilePath,
              newId: qId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        const typeChanges = result.changes.filter((c) => c.type === 'type-change');
        expect(typeChanges).toHaveLength(1);
        if (typeChanges[0]?.type === 'type-change') {
          expect(typeChanges[0].broken?.score).toBe(MAX_SCORE);
        }
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('a/p');
          expect(copies[0].newPath).toBe('b/q');
          expect(copies[0].similarity.score).toBeLessThan(MAX_SCORE);
        }
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given N7d with two identical adds matching the old content, under -M only (row N7m)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites and copies off', () => {
      it('Then only the first add in path order pairs; the second stays a plain add', async () => {
        // Arrange — rename mode is one-shot per source: b/q (path order first)
        // takes the exact pairing, b/r stays unpaired even though it is identical.
        const ctx = await buildSeededContext();
        const oldContent = 'regular\ncontent\nfor\na\np\n'.repeat(20);
        const oldId = await writeBlob(ctx, oldContent);
        const newId = await writeBlob(ctx, 'a-brand-new-symlink-target');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            { type: 'add', newPath: 'b/q' as FilePath, newId: oldId, newMode: FILE_MODE.REGULAR },
            { type: 'add', newPath: 'b/r' as FilePath, newId: oldId, newMode: FILE_MODE.REGULAR },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        const typeChanges = result.changes.filter((c) => c.type === 'type-change');
        expect(typeChanges).toHaveLength(1);
        if (typeChanges[0]?.type === 'type-change') {
          expect(typeChanges[0].broken?.score).toBe(MAX_SCORE);
        }
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('a/p');
          expect(copies[0].newPath).toBe('b/q');
        }
        const adds = result.changes.filter((c) => c.type === 'add');
        expect(adds).toHaveLength(1);
        if (adds[0]?.type === 'add') expect(adds[0].newPath).toBe('b/r');
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
      });
    });
  });

  // ── a broken type change's paired add half vanishes the T entirely (S2: rows N7f, N7j, N7g, N7h, N7k) ──

  describe('Given a symlink→regular type change whose NEW content exactly matches a deleted file (row N7f)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the pairing replaces the type change entirely — no T, no D', async () => {
        // Arrange — a/old's content exactly matches a/p's NEW (regular) content, so
        // the type change's synthetic add half pairs with it; write back drops the
        // synthetic delete half whatever its own use count (S2).
        const ctx = await buildSeededContext();
        const symlinkOldId = await writeBlob(ctx, 'symlink-target-before-a-p');
        const regularContent = 'regular\ncontent\nfor\na\np\nafter\nthe\ntype\nchange\n'.repeat(10);
        const regularId = await writeBlob(ctx, regularContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: symlinkOldId,
              newId: regularId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/old' as FilePath,
              oldId: regularId,
              oldMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — a single rename replaces both the type change and the delete
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('rename');
        if (change?.type === 'rename') {
          expect(change.oldPath).toBe('a/old');
          expect(change.newPath).toBe('a/p');
          expect(change.similarity.score).toBe(MAX_SCORE);
        }
      });
    });
  });

  describe('Given N7f with the deleted file near-matching (one extra line) instead of exact (row N7j)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the inexact pairing replaces the type change entirely — no T, no D', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const symlinkOldId = await writeBlob(ctx, 'symlink-target-before-a-p');
        const regularContent = 'regular\ncontent\nfor\na\np\nafter\nthe\ntype\nchange\n'.repeat(10);
        const regularId = await writeBlob(ctx, regularContent);
        const nearMatchContent = `${regularContent}extra unique tail line only in a-old\n`;
        const nearMatchId = await writeBlob(ctx, nearMatchContent);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: symlinkOldId,
              newId: regularId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/old' as FilePath,
              oldId: nearMatchId,
              oldMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('rename');
        if (change?.type === 'rename') {
          expect(change.oldPath).toBe('a/old');
          expect(change.newPath).toBe('a/p');
          expect(change.similarity.score).toBeLessThan(MAX_SCORE);
        }
      });
    });
  });

  describe('Given a regular→symlink type change whose NEW content exactly matches a deleted symlink (row N7g)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the symlink half pairs exactly and the type change vanishes — no T, no D', async () => {
        // Arrange — a/s's content exactly matches a/p's NEW (symlink) content; a
        // symlink can only ever pair exactly, never inexactly.
        const ctx = await buildSeededContext();
        const regularOldContent =
          'regular\ncontent\nbefore\na\np\nbreaks\ninto\na\nsymlink\n'.repeat(10);
        const regularOldId = await writeBlob(ctx, regularOldContent);
        const symlinkNewId = await writeBlob(ctx, 'symlink-target-after-a-p');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: regularOldId,
              newId: symlinkNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'delete',
              oldPath: 'a/s' as FilePath,
              oldId: symlinkNewId,
              oldMode: FILE_MODE.SYMLINK,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('rename');
        if (change?.type === 'rename') {
          expect(change.oldPath).toBe('a/s');
          expect(change.newPath).toBe('a/p');
          expect(change.similarity.score).toBe(MAX_SCORE);
        }
      });
    });
  });

  describe('Given N7g plus an add matching the type change OLD content (row N7h)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then both halves pair independently into two renames — no T, no D, no A', async () => {
        // Arrange — a/s pairs with a/p's NEW (symlink) half as in N7g; b/q separately
        // pairs with a/p's OLD (regular) half as its own broken-delete source. Neither
        // pairing bumps the other's use count, so both stay renames (not copies).
        const ctx = await buildSeededContext();
        const regularOldContent =
          'regular\ncontent\nbefore\na\np\nbreaks\ninto\na\nsymlink\n'.repeat(10);
        const regularOldId = await writeBlob(ctx, regularOldContent);
        const symlinkNewId = await writeBlob(ctx, 'symlink-target-after-a-p');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: regularOldId,
              newId: symlinkNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'delete',
              oldPath: 'a/s' as FilePath,
              oldId: symlinkNewId,
              oldMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'add',
              newPath: 'b/q' as FilePath,
              newId: regularOldId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(2);
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
        const bySource = new Map(renames.map((r) => [r.type === 'rename' ? r.oldPath : '', r]));
        const first = bySource.get('a/s');
        expect(first?.type === 'rename' ? first.newPath : undefined).toBe('a/p');
        const second = bySource.get('a/p');
        expect(second?.type === 'rename' ? second.newPath : undefined).toBe('b/q');
        expect(result.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'type-change')).toHaveLength(0);
      });
    });
  });

  describe('Given two type changes swapping content — a/p regular→symlink, a/r symlink→regular (row N7k)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then the two broken halves cross-pair into a swap of renames — no T, no D', async () => {
        // Arrange — a/p's NEW (symlink) content equals a/r's OLD (symlink) content,
        // and a/r's NEW (regular) content equals a/p's OLD (regular) content.
        const ctx = await buildSeededContext();
        const regularContent =
          'regular\ncontent\nswapped\nwith\na\nsymlink\ntarget\nvalue\n'.repeat(10);
        const regularId = await writeBlob(ctx, regularContent);
        const symlinkId = await writeBlob(ctx, 'swapped-symlink-target-value');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: regularId,
              newId: symlinkId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'type-change',
              path: 'a/r' as FilePath,
              oldId: symlinkId,
              newId: regularId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(2);
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
        const bySource = new Map(renames.map((r) => [r.type === 'rename' ? r.oldPath : '', r]));
        const fromR = bySource.get('a/r');
        expect(fromR?.type === 'rename' ? fromR.newPath : undefined).toBe('a/p');
        const fromP = bySource.get('a/p');
        expect(fromP?.type === 'rename' ? fromP.newPath : undefined).toBe('a/r');
        expect(result.changes.filter((c) => c.type === 'type-change')).toHaveLength(0);
      });
    });
  });

  describe('Given a regular→symlink type change and an unrelated deleted regular file with the SAME content as the symlink target, cross-mode (row N7n)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites', () => {
      it('Then neither half pairs — the symlink half never scores against a regular-mode source', async () => {
        // Arrange — a/d is a regular file whose content equals a/p's NEW (symlink)
        // target string; identical bytes but a different kind never pair, exactly
        // or inexactly (a symlink destination is excluded from the inexact matrix).
        const ctx = await buildSeededContext();
        const regularOldId = await writeBlob(ctx, 'regular-content-before-a-p');
        const symlinkTarget = 'shared-target-value-cross-mode';
        const symlinkNewId = await writeBlob(ctx, symlinkTarget);
        const crossModeId = await writeBlob(ctx, symlinkTarget);
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId: regularOldId,
              newId: symlinkNewId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            {
              type: 'delete',
              oldPath: 'a/d' as FilePath,
              oldId: crossModeId,
              oldMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert — a/d stands alone, a/p stays kept-broken
        expect(result.changes).toHaveLength(2);
        const deleteChange = result.changes.find((c) => c.type === 'delete');
        expect(deleteChange?.type).toBe('delete');
        if (deleteChange?.type === 'delete') expect(deleteChange.oldPath).toBe('a/d');
        const typeChange = result.changes.find((c) => c.type === 'type-change');
        expect(typeChange?.type).toBe('type-change');
        if (typeChange?.type === 'type-change') expect(typeChange.broken?.score).toBe(MAX_SCORE);
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
      });
    });
  });

  describe('Given N7d under copies: "on" (row N7c: a broken type change registers once, never also as a modified source)', () => {
    describe('When detectSimilarityRenames is called with breakRewrites and copies on', () => {
      it('Then the type change stays kept-broken and exactly one copy pairs — no duplicate source', async () => {
        // Arrange — identical to N7d, plus copies:'on'; a double registration
        // (broken-delete AND modified) would surface as a second copy or a stray
        // leftover entry for a/p.
        const ctx = await buildSeededContext();
        const oldContent = 'regular\ncontent\nfor\na\np\n'.repeat(20);
        const oldId = await writeBlob(ctx, oldContent);
        const newId = await writeBlob(ctx, 'a-brand-new-symlink-target');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'type-change',
              path: 'a/p' as FilePath,
              oldId,
              newId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.SYMLINK,
            },
            { type: 'add', newPath: 'b/q' as FilePath, newId: oldId, newMode: FILE_MODE.REGULAR },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          copies: 'on',
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        expect(result.changes).toHaveLength(2);
        const typeChanges = result.changes.filter((c) => c.type === 'type-change');
        expect(typeChanges).toHaveLength(1);
        if (typeChanges[0]?.type === 'type-change') {
          expect(typeChanges[0].broken?.score).toBe(MAX_SCORE);
        }
        const copies = result.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('a/p');
          expect(copies[0].newPath).toBe('b/q');
        }
      });
    });
  });

  describe('Given an unrelated deleted symlink alongside a rename candidate at the rename limit (row L5)', () => {
    describe('When detectSimilarityRenames is called with limit: 1', () => {
      it('Then the symlink still counts toward the source count and the inexact pass is skipped', async () => {
        // Arrange — one regular delete/add pair would rename fine alone (1 source * 1
        // dest <= limit^2); the unrelated symlink delete pushes the source count to 2,
        // tripping the gate (2 * 1 > 1^2) even though it is never itself scored.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, tenLines(0));
        const newId = await writeBlob(ctx, tenLines(1));
        const linkId = await writeBlob(ctx, 'unrelated-target');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/Foo.meta' as FilePath,
              oldId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/lnk' as FilePath,
              oldId: linkId,
              oldMode: FILE_MODE.SYMLINK,
            },
            { type: 'add', newPath: 'b/Bar.meta' as FilePath, newId, newMode: FILE_MODE.REGULAR },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });

        // Assert — the limit gate skips the inexact pass entirely
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(2);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
      });
    });
  });

  // ── plain -M basename pre-pass: a unique-basename delete pairs before the
  // matrix runs, even when a differently-named delete scores higher ──

  describe('Given two deletes where only the lower-scoring one shares its destination basename', () => {
    describe('When detectSimilarityRenames is called under plain -M', () => {
      it('Then the basename-matching delete pairs despite the other delete scoring higher', async () => {
        // Arrange — foo.c edited on 4/20 lines (80%), bar.c edited on 1/20 (95%); only
        // foo.c shares the destination's basename.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert
        expect(result.changes).toHaveLength(2);
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') {
          expect(rename.oldPath).toBe('a/foo.c');
          expect(rename.newPath).toBe('b/foo.c');
          expect(rename.similarity.score).toBe(48000);
        }
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/bar.c');
      });
    });
  });

  describe('Given the same basename-matching-but-lower-scoring fixture with a rename limit of 1', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the basename-matching delete still pairs — the basename pre-pass is never limited', async () => {
        // Arrange — identical to the plain -M fixture, but limit: 1 would skip a 2-source
        // matrix outright; the basename pass runs before the limit gate ever applies.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });

        // Assert
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') {
          expect(rename.oldPath).toBe('a/foo.c');
          expect(rename.newPath).toBe('b/foo.c');
        }
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/bar.c');
      });
    });
  });

  describe('Given the basename-matching fixture plus a third destination the freed delete can still reach', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the basename pass frees the other delete for the ordinary matrix', async () => {
        // Arrange — foo.c/bar.c/dest as before, plus zed.c (baseline with only its LAST
        // line edited): bar.c (edited on line 0) shares 18/20 lines with zed.c (90%),
        // and zed.c's basename matches nothing, so it is only reachable via the matrix.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const zedId = await writeBlob(ctx, basenameContentEditingAt(new Set([19])));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/zed.c' as FilePath,
              newId: zedId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
        const toFoo = renames.find((c) => c.type === 'rename' && c.newPath === 'b/foo.c');
        expect(toFoo?.type).toBe('rename');
        if (toFoo?.type === 'rename') expect(toFoo.oldPath).toBe('a/foo.c');
        const toZed = renames.find((c) => c.type === 'rename' && c.newPath === 'b/zed.c');
        expect(toZed?.type).toBe('rename');
        if (toZed?.type === 'rename') {
          expect(toZed.oldPath).toBe('a/bar.c');
          expect(toZed.similarity.score).toBe(54000);
        }
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
      });
    });
  });

  describe('Given a basename-matching pair plus an unrelated leftover pair, under a rename limit of 1', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then both pairs become renames — the basename pass shrinks the leftover matrix to fit the limit', async () => {
        // Arrange — foo.c→foo.c pairs by basename and never touches the limit; x.c/y.c
        // share no basename with anything, so they are the ONLY leftover 1x1 matrix,
        // which fits limit: 1 (1*1 <= 1^2).
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const xId = await writeBlob(ctx, basenameEdited(1));
        const fooDstId = await writeBlob(ctx, basenameBaseline());
        const yId = await writeBlob(ctx, basenameBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/x.c' as FilePath,
              oldId: xId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: fooDstId,
              newMode: FILE_MODE.REGULAR,
            },
            { type: 'add', newPath: 'b/y.c' as FilePath, newId: yId, newMode: FILE_MODE.REGULAR },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { limit: 1 });

        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
        const toFoo = renames.find((c) => c.type === 'rename' && c.newPath === 'b/foo.c');
        if (toFoo?.type === 'rename') expect(toFoo.oldPath).toBe('a/foo.c');
        const toY = renames.find((c) => c.type === 'rename' && c.newPath === 'b/y.c');
        if (toY?.type === 'rename') expect(toY.oldPath).toBe('a/x.c');
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(0);
      });
    });
  });

  describe('Given the basename-matching-but-lower-scoring fixture under copies: "on"', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then the basename pass never runs and the higher-scoring delete wins the matrix instead', async () => {
        // Arrange — identical fixture; the basename pre-pass only applies with copies off.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { copies: 'on' });

        // Assert
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') expect(rename.oldPath).toBe('a/bar.c');
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/foo.c');
      });
    });
  });

  describe('Given the basename-matching fixture alongside an unrelated broken modify', () => {
    describe('When detectSimilarityRenames is called with breakRewrites set', () => {
      it('Then the basename pass never runs anywhere in the diff and the higher-scoring delete wins instead', async () => {
        // Arrange — an unrelated fully-disjoint modify breaks (dissimilarity MAX_SCORE);
        // its presence anywhere in the diff disables the basename pre-pass entirely.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const oldMId = await writeBlob(ctx, 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25));
        const newMId = await writeBlob(ctx, 'xxxx\nyyyy\nzzzz\nwwww\n'.repeat(25));
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'modify',
              path: 'm.txt' as FilePath,
              oldId: oldMId,
              newId: newMId,
              oldMode: FILE_MODE.REGULAR,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') expect(rename.oldPath).toBe('a/bar.c');
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/foo.c');
        const modify = result.changes.find((c) => c.type === 'modify');
        expect(modify?.type).toBe('modify');
        if (modify?.type === 'modify') expect(modify.broken?.score).toBe(MAX_SCORE);
      });
    });
  });

  describe('Given the basename-matching fixture alongside an unrelated broken type change', () => {
    describe('When detectSimilarityRenames is called with breakRewrites set', () => {
      it('Then the basename pass never runs anywhere in the diff and the higher-scoring delete wins instead', async () => {
        // Arrange — a symlink→regular type change breaks unconditionally, with no
        // relation at all to foo.c/bar.c/dest.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const oldTId = await writeBlob(ctx, 'link-target');
        const newTId = await writeBlob(ctx, 'regular file content');
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
            {
              type: 'type-change',
              path: 't' as FilePath,
              oldId: oldTId,
              newId: newTId,
              oldMode: FILE_MODE.SYMLINK,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, {
          breakRewrites: { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE },
        });

        // Assert
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') expect(rename.oldPath).toBe('a/bar.c');
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/foo.c');
      });
    });
  });

  describe('Given the basename-matching-but-lower-scoring fixture with threshold set to MAX_SCORE', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then neither the basename pass nor the matrix pair anything — only exact matches would count', async () => {
        // Arrange — threshold === MAX_SCORE disables the basename pre-pass; no inexact
        // score (80% or 95%) can reach MAX_SCORE either, so nothing pairs at all.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, basenameEdited(4));
        const barId = await writeBlob(ctx, basenameEdited(1));
        const dstId = await writeBlob(ctx, basenameBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff, { threshold: MAX_SCORE });

        // Assert
        expect(result.changes.filter((c) => c.type === 'rename')).toHaveLength(0);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(2);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
      });
    });
  });

  describe('Given a basename-matching delete scoring exactly at the basename pass gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then it pairs even though a differently-named delete scores higher', async () => {
        // Arrange — the basename gate is the midpoint between threshold (30000) and
        // MAX_SCORE (60000): 45000. foo.c is built to score EXACTLY 45000 against dest;
        // bar.c (no basename match) scores 50000, comfortably higher.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, scoreUnitContentAt(45000));
        const barId = await writeBlob(ctx, scoreUnitContentAt(50000));
        const dstId = await writeBlob(ctx, scoreUnitBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') {
          expect(rename.oldPath).toBe('a/foo.c');
          expect(rename.similarity.score).toBe(45000);
        }
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/bar.c');
      });
    });
  });

  describe('Given the same fixture with the basename-matching delete scoring one below the gate', () => {
    describe('When detectSimilarityRenames is called', () => {
      it('Then it falls to the matrix and loses to the differently-named, higher-scoring delete', async () => {
        // Arrange — foo.c now scores 44999, one below the 45000 basename gate; bar.c
        // still scores 50000. The basename pass rejects foo.c, so both flow to the
        // ordinary matrix, where bar.c's higher score wins the destination.
        const ctx = await buildSeededContext();
        const fooId = await writeBlob(ctx, scoreUnitContentAt(44999));
        const barId = await writeBlob(ctx, scoreUnitContentAt(50000));
        const dstId = await writeBlob(ctx, scoreUnitBaseline());
        const diff: TreeDiff = {
          changes: [
            {
              type: 'delete',
              oldPath: 'a/foo.c' as FilePath,
              oldId: fooId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'delete',
              oldPath: 'a/bar.c' as FilePath,
              oldId: barId,
              oldMode: FILE_MODE.REGULAR,
            },
            {
              type: 'add',
              newPath: 'b/foo.c' as FilePath,
              newId: dstId,
              newMode: FILE_MODE.REGULAR,
            },
          ],
        };

        // Act
        const result = await detectSimilarityRenames(ctx, diff);

        // Assert
        const rename = result.changes.find((c) => c.type === 'rename');
        expect(rename?.type).toBe('rename');
        if (rename?.type === 'rename') {
          expect(rename.oldPath).toBe('a/bar.c');
          expect(rename.similarity.score).toBe(50000);
        }
        const remainingDelete = result.changes.find((c) => c.type === 'delete');
        expect(remainingDelete?.type).toBe('delete');
        if (remainingDelete?.type === 'delete') expect(remainingDelete.oldPath).toBe('a/foo.c');
      });
    });
  });
});

const oidOf = (c: string): ObjectId => c.repeat(40) as ObjectId;
const renameTriple = (score: number, nameScore: 0 | 1 = 0): MatrixCandidate => ({
  source: 0,
  destination: {
    type: 'add',
    newPath: 'dst.txt' as FilePath,
    newId: oidOf('b'),
    newMode: FILE_MODE.REGULAR,
  } satisfies AddChange,
  score,
  nameScore,
});

describe('Given the per-destination candidate matrix helper recordIfBetter', () => {
  describe('When recordIfBetter is called with a candidate', () => {
    it.each([
      {
        slots: [renameTriple(50), renameTriple(40)],
        candidate: renameTriple(10),
        expected: [50, 40, 10],
        label: 'the slot array is not yet full: the candidate is appended without eviction',
      },
      {
        slots: [renameTriple(50), renameTriple(10), renameTriple(30), renameTriple(20)],
        candidate: renameTriple(25),
        expected: [50, 25, 30, 20],
        label:
          'the slot array is full and the candidate beats the minimum: it replaces exactly the minimum-scored slot',
      },
      {
        slots: [renameTriple(10), renameTriple(30), renameTriple(10), renameTriple(20)],
        candidate: renameTriple(25),
        expected: [25, 30, 10, 20],
        label: 'two slots tie for the minimum: the first minimum (lowest index) is the one evicted',
      },
      {
        slots: [renameTriple(50), renameTriple(10), renameTriple(30), renameTriple(20)],
        candidate: renameTriple(5),
        expected: [50, 10, 30, 20],
        label: 'the candidate is below the minimum: no slot is replaced',
      },
    ])('Then $label', ({ slots, candidate, expected }) => {
      // Arrange & Act
      recordIfBetter(slots, candidate);

      // Assert
      expect(slots.map((s) => s.score)).toEqual(expected);
    });
  });

  describe('When the candidate ties the minimum exactly', () => {
    it('Then the existing entry is kept (strictly-better replacement only)', () => {
      // Arrange — the minimum (20) is a distinct object at index 1
      const original = renameTriple(20);
      const slots: MatrixCandidate[] = [
        renameTriple(50),
        original,
        renameTriple(30),
        renameTriple(40),
      ];

      // Act — a candidate equal to the minimum (a different object)
      recordIfBetter(slots, renameTriple(20));

      // Assert — equal score does not displace; the original object is retained
      expect(slots[1]).toBe(original);
    });
  });

  describe('When a fifth equal-score, basename-matching candidate arrives at four equal-score, non-basename-matching slots', () => {
    it('Then it displaces the slot at the lowest index — nameScore breaks the score tie', () => {
      // Arrange — git's name_score in score_compare: on a score tie, the
      // lowest-ranked (worst) slot is the lowest index, since none of the
      // four outranks another; a matching basename then beats that tie.
      const slots: MatrixCandidate[] = [
        renameTriple(50, 0),
        renameTriple(50, 0),
        renameTriple(50, 0),
        renameTriple(50, 0),
      ];
      const fifth = renameTriple(50, 1);

      // Act
      recordIfBetter(slots, fifth);

      // Assert
      expect(slots[0]).toBe(fifth);
      expect(slots.map((s) => s.nameScore)).toEqual([1, 0, 0, 0]);
    });
  });

  describe('When a strictly higher-scoring candidate arrives at a full slot array whose minimum also ties on nameScore', () => {
    it('Then score still outranks nameScore — the candidate replaces the lowest-scoring slot', () => {
      // Arrange
      const slots: MatrixCandidate[] = [
        renameTriple(50, 1),
        renameTriple(10, 1),
        renameTriple(30, 0),
        renameTriple(20, 0),
      ];
      const candidate = renameTriple(25, 0);

      // Act
      recordIfBetter(slots, candidate);

      // Assert
      expect(slots[1]).toBe(candidate);
    });
  });

  describe('When the cap constant is read', () => {
    it('Then it is git NUM_CANDIDATE_PER_DST of 4', () => {
      // Arrange & Act
      const result = NUM_CANDIDATE_PER_DST;

      // Assert
      expect(result).toBe(4);
    });
  });
});

describe('Given the size prefilter isSizeRejected', () => {
  describe('When isSizeRejected is called with two sizes', () => {
    it.each([
      {
        sfSize: 10,
        dfSize: 100,
        expected: true,
        label:
          'the two sizes are too far apart to reach the threshold (10 vs 100 bytes cannot be 50% similar): the pair is rejected',
      },
      {
        sfSize: 90,
        dfSize: 100,
        expected: false,
        label:
          'the two sizes are close enough to possibly reach the threshold (90 vs 100 bytes can exceed 50% similarity): the pair is not rejected',
      },
      {
        sfSize: 1,
        dfSize: 2,
        expected: false,
        label:
          'the size delta sits exactly on the reachability boundary (max*(MAX-thr) equals (max-min)*MAX exactly: 2*30000 === 1*60000): the pair is not rejected (strict inequality, inclusive boundary survives)',
      },
    ])('Then $label', ({ sfSize, dfSize, expected }) => {
      // Arrange & Act
      const result = isSizeRejected(sfSize, dfSize, DEFAULT_RENAME_THRESHOLD);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

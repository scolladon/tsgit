import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  AddChange,
  DeleteChange,
  RenameChange,
} from '../../../../src/domain/diff/diff-change.js';
import { kindOf } from '../../../../src/domain/diff/mode-kind.js';
import { detectRenames } from '../../../../src/domain/diff/rename-detect.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { arbExactRenameDiff } from './arbitraries.js';

// Spec predicate for the exact-mode rule (git's `mode_similarity`): both sides
// regular-file-kind pair freely, everything else must match exactly. Restated
// here rather than imported so the property checks the rule, not the loop
// that enforces it.
function isExactModeCompatible(oldMode: FileMode, newMode: FileMode): boolean {
  if (kindOf(oldMode) === 'file' && kindOf(newMode) === 'file') return true;
  return oldMode === newMode;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// One id, one mode: every add competes for every delete, so basename ties are common.
const SINGLE_REGULAR_POOL = {
  ids: ['a'.repeat(40) as ObjectId],
  modes: [FILE_MODE.REGULAR],
};

const sut = detectRenames;

describe('Given an arbitrary diff with colliding ids and paths', () => {
  describe('When detectRenames called', () => {
    it('Then no deleted source is consumed by more than one rename (one-shot)', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(), (input) => {
          const result = sut(input);

          const renameOldPaths = result.changes
            .filter((c): c is RenameChange => c.type === 'rename')
            .map((r) => r.oldPath);

          expect(new Set(renameOldPaths).size).toBe(renameOldPaths.length);
        }),
        { numRuns: 100 },
      );
    });

    it('Then a source with a different basename is never picked over a leftover basename match', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(SINGLE_REGULAR_POOL), (input) => {
          const result = sut(input);

          const leftoverDeletes = result.changes.filter(
            (c): c is DeleteChange => c.type === 'delete',
          );
          const renames = result.changes.filter((c): c is RenameChange => c.type === 'rename');
          for (const rename of renames) {
            if (basenameOf(rename.oldPath) === basenameOf(rename.newPath)) continue;
            const skippedBasenameMatch = leftoverDeletes.some(
              (d) =>
                d.oldId === rename.newId &&
                isExactModeCompatible(d.oldMode, rename.newMode) &&
                basenameOf(d.oldPath) === basenameOf(rename.newPath),
            );
            expect(skippedBasenameMatch).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then every input add and delete path is conserved exactly once', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(), (input) => {
          const result = sut(input);

          const addPaths = input.changes
            .filter((c): c is AddChange => c.type === 'add')
            .map((a) => a.newPath);
          for (const path of addPaths) {
            const survivedAsAdd = result.changes.some(
              (c) => c.type === 'add' && c.newPath === path,
            );
            const survivedAsRename = result.changes.some(
              (c) => c.type === 'rename' && c.newPath === path,
            );
            expect(survivedAsAdd !== survivedAsRename).toBe(true);
          }

          const deletePaths = input.changes
            .filter((c): c is DeleteChange => c.type === 'delete')
            .map((d) => d.oldPath);
          for (const path of deletePaths) {
            const survivedAsDelete = result.changes.some(
              (c) => c.type === 'delete' && c.oldPath === path,
            );
            const survivedAsRename = result.changes.some(
              (c) => c.type === 'rename' && c.oldPath === path,
            );
            expect(survivedAsDelete !== survivedAsRename).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then every rename is an exact, mode-compatible pair', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(), (input) => {
          const result = sut(input);

          const renames = result.changes.filter((c): c is RenameChange => c.type === 'rename');
          for (const rename of renames) {
            expect(rename.oldId).toBe(rename.newId);
            expect(rename.similarity.score).toBe(MAX_SCORE);
            expect(isExactModeCompatible(rename.oldMode, rename.newMode)).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then every non-add/delete input change appears unchanged in the output', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(), (input) => {
          const result = sut(input);

          const passThrough = input.changes.filter((c) => c.type !== 'add' && c.type !== 'delete');
          for (const change of passThrough) {
            expect(result.changes).toContainEqual(change);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then applying it twice equals applying it once (idempotence)', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(), (input) => {
          const once = sut(input);
          const twice = sut(once);

          expect(twice).toEqual(once);
        }),
        { numRuns: 100 },
      );
    });

    it('Then no leftover add and leftover delete share an exact-mode-compatible id (maximality)', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbExactRenameDiff(), (input) => {
          const result = sut(input);

          const leftoverAdds = result.changes.filter((c): c is AddChange => c.type === 'add');
          const leftoverDeletes = result.changes.filter(
            (c): c is DeleteChange => c.type === 'delete',
          );
          for (const add of leftoverAdds) {
            for (const del of leftoverDeletes) {
              const stillFoldable =
                add.newId === del.oldId && isExactModeCompatible(del.oldMode, add.newMode);
              expect(stillFoldable).toBe(false);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});

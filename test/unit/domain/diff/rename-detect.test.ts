import { describe, expect, it } from 'vitest';
import type {
  AddChange,
  DeleteChange,
  DiffChange,
  TreeDiff,
} from '../../../../src/domain/diff/diff-change.js';
import { detectRenames } from '../../../../src/domain/diff/rename-detect.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

function extractPaths(changes: ReadonlyArray<DiffChange>): Set<string> {
  const paths = new Set<string>();
  for (const c of changes) {
    if (c.type === 'add') paths.add(c.newPath);
    else if (c.type === 'delete') paths.add(c.oldPath);
    else if (c.type === 'rename') {
      paths.add(c.oldPath);
      paths.add(c.newPath);
    } else paths.add(c.path);
  }
  return paths;
}

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ID_C = 'c'.repeat(40) as ObjectId;

function addChange(path: string, id: ObjectId, mode: FileMode = FILE_MODE.REGULAR): AddChange {
  return { type: 'add', newPath: path as FilePath, newId: id, newMode: mode };
}

function deleteChange(
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): DeleteChange {
  return { type: 'delete', oldPath: path as FilePath, oldId: id, oldMode: mode };
}

function diff(changes: ReadonlyArray<DiffChange>): TreeDiff {
  return { changes };
}

describe('detectRenames', () => {
  describe('Given diff with Add+Delete matching ObjectId on distinct paths', () => {
    describe('When detectRenames called', () => {
      it('Then single RenameChange replaces the pair', () => {
        // Arrange
        const sut = diff([deleteChange('old.txt', ID_A), addChange('new.txt', ID_A)]);

        // Act
        const result = detectRenames(sut);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'old.txt',
            newPath: 'new.txt',
            id: ID_A,
            mode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given diff with Add+Delete matching id but multiple deletion candidates', () => {
    describe('When detectRenames called', () => {
      it('Then no fold — kept as add+delete', () => {
        // Arrange — both deletes share the same id; add cannot pick one unambiguously
        const sut = diff([
          deleteChange('a.txt', ID_A),
          deleteChange('b.txt', ID_A),
          addChange('c.txt', ID_A),
        ]);

        // Act
        const result = detectRenames(sut);

        // Assert — no rename emitted; order preserved by byte-order on primary path
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a.txt', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'b.txt', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'c.txt', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given diff with no matching add/delete pairs', () => {
    describe('When detectRenames called', () => {
      it('Then same diff returned', () => {
        // Arrange — add and delete carry different ids
        const sut = diff([deleteChange('a.txt', ID_A), addChange('b.txt', ID_B)]);

        // Act
        const result = detectRenames(sut);

        // Assert
        expect(result.changes).toEqual(sut.changes);
      });
    });
  });

  describe('Given adds × deletes at limit exactly', () => {
    describe('When detectRenames called', () => {
      it('Then rename detected', () => {
        // Arrange — 2 × 2 = 4 ≤ limit 4
        const sut = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_B),
          addChange('c', ID_A),
          addChange('d', ID_B),
        ]);

        // Act
        const result = detectRenames(sut, { limit: 4 });

        // Assert — two renames
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(2);
      });
    });
  });

  describe('Given adds x deletes product (3) just under limit (4)', () => {
    describe('When detectRenames called', () => {
      it('Then renames still detected', () => {
        // Arrange — 1 add x 3 deletes = 3 <= 4
        const sut = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_B),
          deleteChange('c', ID_C),
          addChange('d', ID_A),
        ]);

        // Act
        const result = detectRenames(sut, { limit: 4 });

        // Assert — product 3 < limit 4, rename detection proceeds
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toHaveLength(1);
      });
    });
  });

  describe('Given adds × deletes at limit + 1', () => {
    describe('When detectRenames called', () => {
      it('Then diff returned unchanged', () => {
        // Arrange — 2 × 2 = 4 > limit 3
        const sut = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_B),
          addChange('c', ID_A),
          addChange('d', ID_B),
        ]);

        // Act
        const result = detectRenames(sut, { limit: 3 });

        // Assert — unchanged
        expect(result).toBe(sut);
      });
    });
  });

  describe('Given exactly maxSameIdDeletes deletes sharing one ObjectId with matching add', () => {
    describe('When detectRenames called', () => {
      it('Then that id is skipped (ambiguity)', () => {
        // Arrange — cap at 2: two deletes of ID_A are accepted, but an add pointing to ID_A has two candidates
        const sut = diff([deleteChange('a', ID_A), deleteChange('b', ID_A), addChange('c', ID_A)]);

        // Act
        const result = detectRenames(sut, { maxSameIdDeletes: 2 });

        // Assert — no renames (add has 2 candidates)
        expect(result.changes.some((c) => c.type === 'rename')).toBe(false);
      });
    });
  });

  describe('Given maxSameIdDeletes + 1 deletes sharing one ObjectId', () => {
    describe('When detectRenames called', () => {
      it('Then that id is pruned and adds remain as add+delete', () => {
        // Arrange — cap at 2: three deletes of ID_A exceed the cap and get pruned from the map
        const sut = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_A),
          deleteChange('c', ID_A),
          addChange('d', ID_A),
        ]);

        // Act
        const result = detectRenames(sut, { maxSameIdDeletes: 2, limit: 1000 });

        // Assert — add is NOT folded (pruned key)
        expect(result.changes.some((c) => c.type === 'rename')).toBe(false);
        expect(result.changes.filter((c) => c.type === 'delete')).toHaveLength(3);
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
      });
    });
  });

  describe('Given output after fold with mixed change types', () => {
    describe('When compared to byte-order invariant', () => {
      it('Then sorted by primary path key per variant', () => {
        // Arrange — add 'z' at end, rename will take primary key = newPath = 'y'; other change 'x' sorts before.
        const sut = diff([
          {
            type: 'modify',
            path: 'x' as FilePath,
            oldId: ID_B,
            newId: ID_C,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          deleteChange('a', ID_A),
          addChange('y', ID_A),
          addChange('z', ID_C),
        ]);

        // Act
        const result = detectRenames(sut);

        // Assert — primary-key sort: 'x' (modify) < 'y' (rename newPath) < 'z' (add newPath)
        const keys = result.changes.map((c) => {
          if (c.type === 'add') return c.newPath;
          if (c.type === 'delete') return c.oldPath;
          if (c.type === 'rename') return c.newPath;
          return c.path;
        });
        expect(keys).toEqual(['x', 'y', 'z']);
      });
    });
  });

  describe('Given exactly 1 delete with matching add and maxSameIdDeletes=1', () => {
    describe('When detectRenames called', () => {
      it('Then rename found (at boundary)', () => {
        // Arrange — list.length (1) <= maxSameIdDeletes (1) so the key is kept in the map.
        // With the mutation > → >=, list.length (1) >= maxSameIdDeletes (1) would prune → no rename.
        const sut = diff([deleteChange('old.txt', ID_A), addChange('new.txt', ID_A)]);

        // Act
        const result = detectRenames(sut, { maxSameIdDeletes: 1 });

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'old.txt',
            newPath: 'new.txt',
            id: ID_A,
            mode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given maxSameIdDeletes=0 and a single delete with a matching add', () => {
    describe('When detectRenames called', () => {
      it('Then the id is pruned and no rename is folded', () => {
        // Kills the `list.length <= maxSameIdDeletes` ConditionalExpression `true`
        // mutant: under `true` every key is kept, so the lone delete survives the
        // prune and folds with the add into a rename. The real predicate
        // `1 <= 0 === false` prunes the key, leaving add+delete unfolded.
        // Arrange
        const sut = diff([deleteChange('old.txt', ID_A), addChange('new.txt', ID_A)]);

        // Act
        const result = detectRenames(sut, { maxSameIdDeletes: 0 });

        // Assert — no rename; the pair stays as separate add + delete.
        expect(result.changes.some((c) => c.type === 'rename')).toBe(false);
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'new.txt', newId: ID_A, newMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'old.txt', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given the property "detectRenames(detectRenames(d)) deep-equals detectRenames(d) (idempotence)"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange
        const sut = diff([
          deleteChange('a.txt', ID_A),
          deleteChange('other.txt', ID_B),
          addChange('b.txt', ID_A),
          addChange('another.txt', ID_C),
        ]);

        // Act
        const once = detectRenames(sut);
        const twice = detectRenames(once);

        // Assert
        expect(twice).toEqual(once);
      });
    });
  });

  describe('Given the property "detectRenames output paths are a subset of input paths"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange
        const sut = diff([
          deleteChange('a.txt', ID_A),
          deleteChange('b.txt', ID_B),
          addChange('c.txt', ID_A),
          addChange('d.txt', ID_C),
        ]);

        // Act
        const result = detectRenames(sut);

        // Assert — all paths in the output must come from input paths
        const inputPaths = extractPaths(sut.changes);
        const outputPaths = extractPaths(result.changes);
        for (const p of outputPaths) {
          expect(inputPaths.has(p)).toBe(true);
        }
      });
    });
  });
});

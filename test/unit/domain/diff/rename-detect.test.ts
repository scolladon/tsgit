import { describe, expect, it } from 'vitest';
import type {
  AddChange,
  DeleteChange,
  DiffChange,
  TreeDiff,
} from '../../../../src/domain/diff/diff-change.js';
import { detectRenames } from '../../../../src/domain/diff/rename-detect.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

function extractPaths(changes: ReadonlyArray<DiffChange>): Set<string> {
  const paths = new Set<string>();
  for (const c of changes) {
    if (c.type === 'add') paths.add(c.newPath);
    else if (c.type === 'delete') paths.add(c.oldPath);
    else if (c.type === 'rename' || c.type === 'copy') {
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

// Zero-padded so path-byte order matches numeric order: a/F001.meta .. a/F101.meta.
function manyDeletes(count: number, id: ObjectId = ID_A): DeleteChange[] {
  return Array.from({ length: count }, (_, i) =>
    deleteChange(`a/F${String(i + 1).padStart(3, '0')}.meta`, id),
  );
}

const sut = detectRenames;

describe('detectRenames', () => {
  describe('Given diff with Add+Delete matching ObjectId on distinct paths', () => {
    describe('When detectRenames called', () => {
      it('Then single RenameChange replaces the pair', () => {
        // Arrange
        const input = diff([deleteChange('old.txt', ID_A), addChange('new.txt', ID_A)]);

        // Act
        const result = detectRenames(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'old.txt',
            newPath: 'new.txt',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
        // Exact pair: oldId === newId, similarity.score === MAX_SCORE
        const rename = result.changes[0];
        if (rename?.type === 'rename') {
          expect(rename.oldId).toBe(rename.newId);
          expect(rename.similarity.score).toBe(MAX_SCORE);
        }
      });
    });
  });

  describe('Given one delete and two adds sharing its id', () => {
    describe('When detectRenames called', () => {
      it('Then only the first add in path order is folded, the other stays an add', () => {
        // Arrange
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          addChange('b/Bar.meta', ID_A),
          addChange('b/Baz.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert — the deleted source is consumed once; Baz never sees it
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Foo.meta',
            newPath: 'b/Bar.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          { type: 'add', newPath: 'b/Baz.meta', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given one delete and two adds sharing its id, the basename match processed second', () => {
    describe('When detectRenames called', () => {
      it('Then path order still wins — the earlier add claims the only source', () => {
        // Arrange — b/Foo.meta shares a basename with the delete, but b/Bar.meta sorts first
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          addChange('b/Bar.meta', ID_A),
          addChange('b/Foo.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Foo.meta',
            newPath: 'b/Bar.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          { type: 'add', newPath: 'b/Foo.meta', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given one delete and three adds sharing its id', () => {
    describe('When detectRenames called', () => {
      it('Then the first in path order is folded, the other two stay adds', () => {
        // Arrange
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          addChange('b/A.meta', ID_A),
          addChange('b/B.meta', ID_A),
          addChange('b/C.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Foo.meta',
            newPath: 'b/A.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          { type: 'add', newPath: 'b/B.meta', newId: ID_A, newMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'b/C.meta', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given two deletes sharing one id and one add with no basename match', () => {
    describe('When detectRenames called', () => {
      it('Then the first delete in path order is folded, the other stays a delete', () => {
        // Arrange
        const input = diff([
          deleteChange('a.txt', ID_A),
          deleteChange('b.txt', ID_A),
          addChange('c.txt', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'b.txt', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          {
            type: 'rename',
            oldPath: 'a.txt',
            newPath: 'c.txt',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given two deletes sharing one id where the second delete basename-matches the add', () => {
    describe('When detectRenames called', () => {
      it('Then the basename match is folded, not the first in path order', () => {
        // Arrange
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          deleteChange('a/Qux.meta', ID_A),
          addChange('b/Qux.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a/Foo.meta', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          {
            type: 'rename',
            oldPath: 'a/Qux.meta',
            newPath: 'b/Qux.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given three deletes sharing one id where the third delete basename-matches the add', () => {
    describe('When detectRenames called', () => {
      it('Then the basename match wins over both earlier deletes', () => {
        // Arrange
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          deleteChange('a/Qux.meta', ID_A),
          deleteChange('a/Zed.meta', ID_A),
          addChange('b/Zed.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a/Foo.meta', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'a/Qux.meta', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          {
            type: 'rename',
            oldPath: 'a/Zed.meta',
            newPath: 'b/Zed.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given two deletes and two adds sharing one id, basename preference per add', () => {
    describe('When detectRenames called', () => {
      it('Then the basename match folds first, the leftover pairs by path order', () => {
        // Arrange — add path order: b/Qux.meta then b/Zed.meta
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          deleteChange('a/Qux.meta', ID_A),
          addChange('b/Qux.meta', ID_A),
          addChange('b/Zed.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert — Qux keeps its basename match; Foo is the only source left for Zed
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Qux.meta',
            newPath: 'b/Qux.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          {
            type: 'rename',
            oldPath: 'a/Foo.meta',
            newPath: 'b/Zed.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given two deletes and two adds sharing one id with no basename overlap', () => {
    describe('When detectRenames called', () => {
      it('Then adds pair with the deletes in path order', () => {
        // Arrange
        const input = diff([
          deleteChange('a/Foo.meta', ID_A),
          deleteChange('a/Qux.meta', ID_A),
          addChange('b/Bar.meta', ID_A),
          addChange('b/Baz.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Foo.meta',
            newPath: 'b/Bar.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          {
            type: 'rename',
            oldPath: 'a/Qux.meta',
            newPath: 'b/Baz.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given a candidate whose basename contains the add basename as a suffix, not a full segment', () => {
    describe('When detectRenames called', () => {
      it('Then the suffix does not count as a basename match', () => {
        // Arrange — a/xFoo.meta ends with "Foo.meta" but its basename is "xFoo.meta"
        const input = diff([
          deleteChange('a/Bar.meta', ID_A),
          deleteChange('a/xFoo.meta', ID_A),
          addChange('b/Foo.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert — first in path order wins, since neither basename matches
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a/xFoo.meta', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          {
            type: 'rename',
            oldPath: 'a/Bar.meta',
            newPath: 'b/Foo.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given a top-level add whose basename matches a nested delete, over an unrelated top-level delete', () => {
    describe('When detectRenames called', () => {
      it('Then the nested delete wins by basename', () => {
        // Arrange
        const input = diff([
          deleteChange('a/Bar.meta', ID_A),
          deleteChange('b/Foo.meta', ID_A),
          addChange('Foo.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'b/Foo.meta',
            newPath: 'Foo.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          { type: 'delete', oldPath: 'a/Bar.meta', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given a symlink delete and a regular add sharing an id', () => {
    describe('When detectRenames called', () => {
      it('Then no rename is folded — the mode kinds are incompatible', () => {
        // Arrange
        const input = diff([
          deleteChange('a/link', ID_A, FILE_MODE.SYMLINK),
          addChange('b/link', ID_A, FILE_MODE.REGULAR),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a/link', oldId: ID_A, oldMode: FILE_MODE.SYMLINK },
          { type: 'add', newPath: 'b/link', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given a regular delete and a symlink add sharing an id', () => {
    describe('When detectRenames called', () => {
      it('Then no rename is folded — the mode kinds are incompatible', () => {
        // Arrange
        const input = diff([
          deleteChange('a/file', ID_A, FILE_MODE.REGULAR),
          addChange('b/file', ID_A, FILE_MODE.SYMLINK),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a/file', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'b/file', newId: ID_A, newMode: FILE_MODE.SYMLINK },
        ]);
      });
    });
  });

  describe('Given a symlink delete, a regular add and a symlink add all sharing an id', () => {
    describe('When detectRenames called', () => {
      it('Then only the mode-compatible symlink add is folded', () => {
        // Arrange — add path order: b/file then b/link2
        const input = diff([
          deleteChange('a/link', ID_A, FILE_MODE.SYMLINK),
          addChange('b/file', ID_A, FILE_MODE.REGULAR),
          addChange('b/link2', ID_A, FILE_MODE.SYMLINK),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'b/file', newId: ID_A, newMode: FILE_MODE.REGULAR },
          {
            type: 'rename',
            oldPath: 'a/link',
            newPath: 'b/link2',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.SYMLINK,
            newMode: FILE_MODE.SYMLINK,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given a regular delete and adds of both regular modes sharing an id', () => {
    describe('When detectRenames called', () => {
      it('Then the first in path order folds regardless of the executable bit', () => {
        // Arrange — add path order: b/Bar.sh then b/Baz.sh
        const input = diff([
          deleteChange('a/Foo.sh', ID_A, FILE_MODE.REGULAR),
          addChange('b/Bar.sh', ID_A, FILE_MODE.EXECUTABLE),
          addChange('b/Baz.sh', ID_A, FILE_MODE.REGULAR),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Foo.sh',
            newPath: 'b/Bar.sh',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          { type: 'add', newPath: 'b/Baz.sh', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given two gitlinks sharing an id', () => {
    describe('When detectRenames called', () => {
      it('Then they fold exactly — gitlink modes pair with themselves', () => {
        // Arrange
        const input = diff([
          deleteChange('a/sub', ID_A, FILE_MODE.GITLINK),
          addChange('b/sub2', ID_A, FILE_MODE.GITLINK),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/sub',
            newPath: 'b/sub2',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.GITLINK,
            newMode: FILE_MODE.GITLINK,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given a gitlink delete and a regular add sharing an id', () => {
    describe('When detectRenames called', () => {
      it('Then no rename is folded — gitlinks pair only with an identical mode', () => {
        // Arrange
        const input = diff([
          deleteChange('a/sub', ID_A, FILE_MODE.GITLINK),
          addChange('b/sub', ID_A, FILE_MODE.REGULAR),
        ]);

        // Act
        const result = sut(input);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a/sub', oldId: ID_A, oldMode: FILE_MODE.GITLINK },
          { type: 'add', newPath: 'b/sub', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given 99 mode-compatible deletes sharing an id plus a basename match as the 100th eligible', () => {
    describe('When detectRenames called', () => {
      it('Then the basename match still folds — the cap is not yet reached', () => {
        // Arrange
        const input = diff([
          ...manyDeletes(99),
          deleteChange('a/Zzz.meta', ID_A),
          addChange('b/Zzz.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Zzz.meta',
            newPath: 'b/Zzz.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(99);
        expect(deletes.some((d) => d.type === 'delete' && d.oldPath === 'a/F001.meta')).toBe(true);
      });
    });
  });

  describe('Given 100 mode-compatible deletes sharing an id plus a basename match as the 101st eligible', () => {
    describe('When detectRenames called', () => {
      it('Then the basename match is never examined — the first delete folds instead', () => {
        // Arrange
        const input = diff([
          ...manyDeletes(100),
          deleteChange('a/Zzz.meta', ID_A),
          addChange('b/Zzz.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toEqual([
          {
            type: 'rename',
            oldPath: 'a/F001.meta',
            newPath: 'b/Zzz.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(100);
        expect(deletes.some((d) => d.type === 'delete' && d.oldPath === 'a/Zzz.meta')).toBe(true);
      });
    });
  });

  describe('Given a mode-incompatible delete among 99 eligible deletes plus a basename match', () => {
    describe('When detectRenames called', () => {
      it('Then the incompatible delete does not count toward the cap', () => {
        // Arrange — 1 symlink (skipped, uncounted) + 99 regular + the basename match, 101 total
        const input = diff([
          deleteChange('a/Aaa.meta', ID_A, FILE_MODE.SYMLINK),
          ...manyDeletes(99),
          deleteChange('a/Zzz.meta', ID_A),
          addChange('b/Zzz.meta', ID_A),
        ]);

        // Act
        const result = sut(input);

        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toEqual([
          {
            type: 'rename',
            oldPath: 'a/Zzz.meta',
            newPath: 'b/Zzz.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(100);
        expect(deletes.some((d) => d.type === 'delete' && d.oldPath === 'a/Aaa.meta')).toBe(true);
      });
    });
  });

  describe('Given 101 mode-compatible deletes sharing an id with no basename match', () => {
    describe('When detectRenames called', () => {
      it('Then only the first delete, within the cap, folds', () => {
        // Arrange
        const input = diff([...manyDeletes(101), addChange('b/Bar.meta', ID_A)]);

        // Act
        const result = sut(input);

        // Assert
        const renames = result.changes.filter((c) => c.type === 'rename');
        expect(renames).toEqual([
          {
            type: 'rename',
            oldPath: 'a/F001.meta',
            newPath: 'b/Bar.meta',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
        const deletes = result.changes.filter((c) => c.type === 'delete');
        expect(deletes).toHaveLength(100);
      });
    });
  });

  describe('Given diff with no matching add/delete pairs', () => {
    describe('When detectRenames called', () => {
      it('Then same diff returned', () => {
        // Arrange — add and delete carry different ids
        const input = diff([deleteChange('a.txt', ID_A), addChange('b.txt', ID_B)]);

        // Act
        const result = detectRenames(input);

        // Assert
        expect(result.changes).toEqual(input.changes);
      });
    });
  });

  describe('Given adds × deletes at limit exactly', () => {
    describe('When detectRenames called', () => {
      it('Then rename detected', () => {
        // Arrange — 2 × 2 = 4 ≤ limit 4
        const input = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_B),
          addChange('c', ID_A),
          addChange('d', ID_B),
        ]);

        // Act
        const result = detectRenames(input, { limit: 4 });

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
        const input = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_B),
          deleteChange('c', ID_C),
          addChange('d', ID_A),
        ]);

        // Act
        const result = detectRenames(input, { limit: 4 });

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
        const input = diff([
          deleteChange('a', ID_A),
          deleteChange('b', ID_B),
          addChange('c', ID_A),
          addChange('d', ID_B),
        ]);

        // Act
        const result = detectRenames(input, { limit: 3 });

        // Assert — unchanged
        expect(result).toBe(input);
      });
    });
  });

  describe('Given output after fold with mixed change types', () => {
    describe('When compared to byte-order invariant', () => {
      it('Then sorted by primary path key per variant', () => {
        // Arrange — add 'z' at end, rename will take primary key = newPath = 'y'; other change 'x' sorts before.
        const input = diff([
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
        const result = detectRenames(input);

        // Assert — primary-key sort: 'x' (modify) < 'y' (rename newPath) < 'z' (add newPath)
        const keys = result.changes.map((c) => {
          if (c.type === 'add') return c.newPath;
          if (c.type === 'delete') return c.oldPath;
          if (c.type === 'rename' || c.type === 'copy') return c.newPath;
          return c.path;
        });
        expect(keys).toEqual(['x', 'y', 'z']);
      });
    });
  });

  describe('Given the property "detectRenames(detectRenames(d)) deep-equals detectRenames(d) (idempotence)"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange
        const input = diff([
          deleteChange('a.txt', ID_A),
          deleteChange('other.txt', ID_B),
          addChange('b.txt', ID_A),
          addChange('another.txt', ID_C),
        ]);

        // Act
        const once = detectRenames(input);
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
        const input = diff([
          deleteChange('a.txt', ID_A),
          deleteChange('b.txt', ID_B),
          addChange('c.txt', ID_A),
          addChange('d.txt', ID_C),
        ]);

        // Act
        const result = detectRenames(input);

        // Assert — all paths in the output must come from input paths
        const inputPaths = extractPaths(input.changes);
        const outputPaths = extractPaths(result.changes);
        for (const p of outputPaths) {
          expect(inputPaths.has(p)).toBe(true);
        }
      });
    });
  });
});

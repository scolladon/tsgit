import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeContent } from '../../../../src/domain/merge/three-way-content.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const enc = (s: string): Uint8Array => encoder.encode(s);

function assertClean(result: ReturnType<typeof mergeContent>, expected: string): void {
  expect(result.status).toBe('clean');
  if (result.status === 'clean') {
    expect(decoder.decode(result.bytes)).toBe(expected);
  }
}

function assertConflict(
  result: ReturnType<typeof mergeContent>,
  conflictType: 'content' | 'binary',
): void {
  expect(result.status).toBe('conflict');
  if (result.status === 'conflict') {
    expect(result.conflictType).toBe(conflictType);
    expect(result.markedBytes).toBeDefined();
    expect(result.markedBytes.length).toBeGreaterThan(0);
  }
}

describe('mergeContent', () => {
  describe('Given at most two distinct byte sequences among base, ours, and theirs', () => {
    describe('When mergeContent called', () => {
      it.each([
        {
          base: 'a\nb\n',
          ours: 'a\nb\n',
          theirs: 'a\nb\n',
          expected: 'a\nb\n',
          label: 'clean with base bytes (all three sides identical)',
        },
        {
          base: 'a\nb\n',
          ours: 'a\nX\n',
          theirs: 'a\nb\n',
          expected: 'a\nX\n',
          label: 'clean with ours (theirs unchanged from base)',
        },
        {
          base: 'a\nb\n',
          ours: 'a\nb\n',
          theirs: 'a\nY\n',
          expected: 'a\nY\n',
          label: 'clean with theirs (ours unchanged from base)',
        },
        {
          base: 'a\nb\n',
          ours: 'a\nZ\n',
          theirs: 'a\nZ\n',
          expected: 'a\nZ\n',
          label: 'clean with ours (both sides made the identical modification)',
        },
      ])('Then $label', ({ base, ours, theirs, expected }) => {
        // Arrange
        const baseBytes = enc(base);
        const oursBytes = enc(ours);
        const theirsBytes = enc(theirs);

        // Act
        const result = mergeContent(baseBytes, oursBytes, theirsBytes);

        // Assert
        assertClean(result, expected);
      });
    });
  });

  describe('Given non-overlapping modifications on both sides', () => {
    describe('When mergeContent called', () => {
      it('Then clean merged (both changes applied)', () => {
        // Arrange
        const base = enc('a\nb\nc\nd\ne\n');
        const ours = enc('A\nb\nc\nd\ne\n'); // change line 0
        const theirs = enc('a\nb\nc\nd\nE\n'); // change line 4

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertClean(result, 'A\nb\nc\nd\nE\n');
      });
    });
  });

  describe('Given overlapping modifications on both sides (different content)', () => {
    describe('When mergeContent called', () => {
      it('Then content conflict with markers', () => {
        // Arrange
        const base = enc('a\nb\nc\n');
        const ours = enc('a\nX\nc\n');
        const theirs = enc('a\nY\nc\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
        if (result.status === 'conflict') {
          expect(decoder.decode(result.markedBytes)).toContain('<<<<<<<');
          expect(decoder.decode(result.markedBytes)).toContain('=======');
          expect(decoder.decode(result.markedBytes)).toContain('>>>>>>>');
        }
      });
    });
  });

  describe('Given any side binary (NUL in first 8000 bytes)', () => {
    describe('When mergeContent called', () => {
      it('Then binary conflict with ours bytes', () => {
        // Arrange — ours has NUL
        const base = enc('a\nb\n');
        const ours = new Uint8Array([0x00, 0x61, 0x62]);
        const theirs = enc('a\nY\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'binary');
        if (result.status === 'conflict') {
          expect(result.markedBytes).toEqual(ours);
        }
      });
    });
  });

  describe('Given undefined base (add-add) with identical bytes', () => {
    describe('When mergeContent called', () => {
      it('Then clean with ours', () => {
        // Arrange
        const bytes = enc('a\nb\n');

        // Act
        const result = mergeContent(undefined, bytes, bytes);

        // Assert
        assertClean(result, 'a\nb\n');
      });
    });
  });

  describe('Given undefined base (add-add) with different bytes', () => {
    describe('When mergeContent called', () => {
      it('Then content conflict with whole-file markers', () => {
        // Arrange
        const ours = enc('hello\n');
        const theirs = enc('world\n');

        // Act
        const result = mergeContent(undefined, ours, theirs);

        // Assert
        assertConflict(result, 'content');
        if (result.status === 'conflict') {
          const text = decoder.decode(result.markedBytes);
          expect(text).toContain('hello');
          expect(text).toContain('world');
        }
      });
    });
  });

  describe('Given mergeContent called with custom labels', () => {
    describe('When output emitted', () => {
      it('Then labels appear in markedBytes', () => {
        // Arrange
        const base = enc('a\nb\nc\n');
        const ours = enc('a\nX\nc\n');
        const theirs = enc('a\nY\nc\n');

        // Act
        const result = mergeContent(base, ours, theirs, {
          labels: { ours: 'HEAD', theirs: 'feature' },
        });

        // Assert
        expect(result.status).toBe('conflict');
        if (result.status === 'conflict') {
          const text = decoder.decode(result.markedBytes);
          expect(text).toContain('<<<<<<< HEAD');
          expect(text).toContain('>>>>>>> feature');
        }
      });
    });
  });

  describe('Given theirs binary (NUL at offset 2)', () => {
    describe('When mergeContent called', () => {
      it('Then binary conflict', () => {
        // Arrange — theirs has NUL
        const base = enc('a\n');
        const ours = enc('a\n');
        const theirs = new Uint8Array([0x61, 0x62, 0x00]);

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'binary');
      });
    });
  });

  describe('Given changes on the first two lines that touch at line 1 (git: xdl_do_merge)', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (ours [0,1) touches theirs [1,2))', () => {
        // Arrange — ours' change ends exactly where theirs' change starts: git's
        // `xscr1->i1 + xscr1->chg1 < xscr2->i1` separateness test is false, so the
        // two hunks fall through to the conflict check instead of merging clean.
        const base = enc('a\nb\nc\nd\ne\n');
        const ours = enc('X\nb\nc\nd\ne\n');
        const theirs = enc('a\nY\nc\nd\ne\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given both sides insert different content at the same base position', () => {
    describe('When mergeContent called', () => {
      it('Then content conflict (zero-length overlap)', () => {
        // Arrange — both sides insert at base position 1 (between 'a' and 'b'), with different content.
        const base = enc('a\nb\n');
        const ours = enc('a\nX\nb\n');
        const theirs = enc('a\nY\nb\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — the zero-length overlap detection catches the collision
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given replacements have different lengths at same base range', () => {
    describe('When mergeContent called', () => {
      it('Then whole-file fallback (lineArraysEqual length-guard)', () => {
        // Arrange — both sides replace base[1] but with a differing number of lines.
        const base = enc('a\nb\nc\n');
        const ours = enc('a\nX\nc\n');
        const theirs = enc('a\nX\nY\nc\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given twin at first change + non-overlapping extra on theirs side', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge with twin deduped and extra applied', () => {
        // Arrange — both sides change line 0 identically (twin); theirs additionally changes line 4.
        // If consumed.has guard were deleted, the twin would be applied twice → wrong result.
        const base = enc('a\nb\nc\nd\ne\n');
        const ours = enc('X\nb\nc\nd\ne\n');
        const theirs = enc('X\nb\nc\nd\nY\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — twin applied once + theirs' extra change
        assertClean(result, 'X\nb\nc\nd\nY\n');
      });
    });
  });

  describe('Given two twins on both sides plus extra theirs change', () => {
    describe('When mergeContent called', () => {
      it('Then consumed-set lookup skips first twin for second oc and clean merge applies all', () => {
        // Arrange — ours changes lines 0 and 2 identically to theirs; theirs also changes line 6.
        // findIdenticalTwin's consumed.has TRUE fires when oc2=(2,3,[Z]) skips consumed theirs[0].
        const base = enc('a\nb\nc\nd\ne\nf\ng\n');
        const ours = enc('X\nb\nZ\nd\ne\nf\ng\n');
        const theirs = enc('X\nb\nZ\nd\ne\nf\nY\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — both twins deduped + theirs extra applied
        assertClean(result, 'X\nb\nZ\nd\ne\nf\nY\n');
      });
    });
  });

  describe('Given twin consumed + second ours collides with unconsumed theirs', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (collidesWithUnconsumed consumed-skip exercised)', () => {
        // Arrange — twin at (0,1,[X]) consumed; ours (3,4,[W]) differs from theirs (3,4,[Z]).
        // In collidesWithUnconsumed, consumed theirs[0] is skipped, unconsumed theirs[1] overlaps → conflict.
        const base = enc('a\nb\nc\nd\ne\nf\ng\n');
        const ours = enc('X\nb\nc\nW\ne\nf\ng\n');
        const theirs = enc('X\nb\nc\nZ\ne\nf\ng\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — twin at (0,1,[X]) ok but (3,4,[W]) vs (3,4,[Z]) conflicts
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given both sides share one identical change plus one side has extra non-overlapping change', () => {
    describe('When mergeContent called', () => {
      it('Then clean merged with identical twin applied once + extra change', () => {
        // Arrange — (0,1,[X]) in both; theirs additionally has (2,3,[Y]).
        const base = enc('a\nb\nc\n');
        const ours = enc('X\nb\nc\n');
        const theirs = enc('X\nb\nY\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertClean(result, 'X\nb\nY\n');
      });
    });
  });

  describe('Given base and ours are completely disjoint, large sides', () => {
    describe('When mergeContent called', () => {
      it('Then the whole-file rewrite conflicts with theirs’ small edit to the same region', () => {
        // Arrange — base and ours share no line at all, so ours' diff against base
        // is itself a full-region rewrite [0, N). theirs differs slightly from base
        // (bypassing the fast-path equality shortcut) inside that same region, so the
        // two sides' changes overlap and conflict.
        const N = 1500;
        const base = enc(Array.from({ length: N }, (_, i) => `b${i}\n`).join(''));
        const ours = enc(Array.from({ length: N }, (_, i) => `o${i}\n`).join(''));
        const theirsLines = Array.from({ length: N }, (_, i) => `b${i}\n`);
        theirsLines[0] = 'X\n';
        const theirs = enc(theirsLines.join(''));

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — ours' whole-region rewrite overlaps theirs' edit
        assertConflict(result, 'content');
      }, 60_000);
    });
  });

  describe('Given base binary', () => {
    describe('When mergeContent called', () => {
      it('Then binary conflict', () => {
        // Arrange
        const base = new Uint8Array([0x00, 0x61]);
        const ours = enc('a\n');
        const theirs = enc('b\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'binary');
      });
    });
  });

  describe('Given zero-length insertion at position 5 and deletion [5,7)', () => {
    describe('When mergeContent called', () => {
      it('Then conflict detected (not silently merged)', () => {
        // Arrange — ours inserts a line after base line 4 (zero-length range [5,5));
        // theirs deletes base lines 5-6 (range [5,7)). Git's closed touching rule treats
        // two ranges as separate only when one side's base end is strictly before the
        // other's base start: [5,5) ends at 5, which is not before [5,7)'s start (5), so
        // they conflict.
        const base = enc('a\nb\nc\nd\ne\nf\ng\n');
        const ours = enc('a\nb\nc\nd\ne\nINSERTED\nf\ng\n');
        const theirs = enc('a\nb\nc\nd\ne\ng\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given adjacent ranges [0,1) vs [1,2) that touch at line 1', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (git conflicts on touching hunks)', () => {
        // Arrange — ours changes line 0, theirs changes line 1. Ranges [0,1) and [1,2) touch at
        // line 1 (a.baseEnd === b.baseStart): git's xdl_do_merge only calls two hunks separate
        // when one ends strictly before the other starts, so this falls through to conflict.
        const base = enc('a\nb\nc\n');
        const ours = enc('X\nb\nc\n');
        const theirs = enc('a\nY\nc\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given overlapping ranges [0,2) vs [1,3)', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (ranges overlap)', () => {
        // Arrange — ours changes lines 0-1, theirs changes lines 1-2. Ranges [0,2) and [1,3) overlap at line 1.
        const base = enc('a\nb\nc\nd\n');
        const ours = enc('X\nY\nc\nd\n');
        const theirs = enc('a\nP\nQ\nd\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given theirs inserts inside a range ours deletes', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (an insertion touching a deletion is not separate)', () => {
        // Arrange — ours deletes lines 1-2 (range [1,3)); theirs inserts at line 1
        // (zero-length range [1,1)). Neither side's base end is strictly before the
        // other's base start (3 is not before 1, and 1 is not before 1), so git's
        // closed touching rule conflicts.
        const base = enc('a\nb\nc\nd\n');
        const ours = enc('a\nd\n');
        const theirs = enc('a\nX\nb\nc\nd\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given base and theirs are completely disjoint (not ours)', () => {
    describe('When mergeContent called', () => {
      it('Then theirs’ whole-file rewrite conflicts with ours’ small edit to the same region', () => {
        // Arrange — base vs theirs share no line at all (a full-region rewrite);
        // base vs ours is a tiny one-line edit inside that same region.
        const N = 1500;
        const base = enc(Array.from({ length: N }, (_, i) => `b${i}\n`).join(''));
        const theirs = enc(Array.from({ length: N }, (_, i) => `t${i}\n`).join(''));
        // ours differs from base minimally to bypass the fast-path bytesEqual shortcut
        const oursLines = Array.from({ length: N }, (_, i) => `b${i}\n`);
        oursLines[0] = 'X\n';
        const ours = enc(oursLines.join(''));

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      }, 60_000);
    });
  });

  describe('Given ours is a strict byte-prefix of base + theirs differs', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (length-guard short-circuits bytesEqual)', () => {
        // Arrange — ours ("a\nb\n") is the exact 4-byte prefix of base ("a\nb\nc\n", 6 bytes).
        // If the `a.length !== b.length` guard were forced false, bytesEqual(ours, base) would
        // loop only i<4, find every byte equal, and wrongly report ours === base → clean theirs.
        const base = enc('a\nb\nc\n');
        const ours = enc('a\nb\n');
        const theirs = enc('a\nb\nZ\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — ours (delete line 2) vs theirs (replace line 2) overlap → conflict
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given ours inserts strictly inside a theirs replacement range', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (an insertion strictly inside a range is not separate)', () => {
        // Arrange — ours inserts at base pos 2 (zero-length range [2,2)); theirs replaces
        // base[1,3). Neither side's base end is strictly before the other's base start
        // (2 is not before 1, and 3 is not before 2), so git's closed touching rule
        // conflicts.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nINS\nc\nd\ne\nf\ng\nh\n');
        const theirs = enc('a\nP\nQ\nd\ne\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given two zero-length insertions at different base positions', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (two disjoint zero-length insertions are separate)', () => {
        // Arrange — ours inserts at base pos 1 (range [1,1)), theirs inserts at base pos 5
        // (range [5,5)). Ours' base end (1) is strictly before theirs' base start (5), so
        // git's closed touching rule treats them as separate and merges clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nIO\nb\nc\nd\ne\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nd\ne\nIT\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertClean(result, 'a\nIO\nb\nc\nd\ne\nIT\nf\ng\nh\n');
      });
    });
  });

  describe('Given a zero-length insertion before a disjoint non-zero theirs range', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (an insertion strictly before a range is separate)', () => {
        // Arrange — ours inserts at base pos 1 (range [1,1)); theirs replaces base[3,5).
        // Ours' base end (1) is strictly before theirs' base start (3), so git's closed
        // touching rule treats them as separate and merges clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nIO\nb\nc\nd\ne\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nP\nQ\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertClean(result, 'a\nIO\nb\nc\nP\nQ\nf\ng\nh\n');
      });
    });
  });

  describe('Given a zero-length insertion exactly at the end of a non-zero theirs range', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (an insertion touching a range is not separate)', () => {
        // Arrange — ours inserts at base pos 5; theirs replaces base[3,5). The insertion's
        // baseStart (5) equals theirs' baseEnd (5): git's `i1 + chg1 < other.i1` separateness
        // test is false for a touching pair, so the two hunks conflict.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nd\ne\nIO\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nP\nQ\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given two overlapping non-zero ranges', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (overlapping non-zero ranges are not separate)', () => {
        // Arrange — ours replaces base[3,5), theirs replaces base[1,4). Neither side's base
        // end is strictly before the other's base start (5 is not before 1, and 4 is not
        // before 3), so git's closed touching rule conflicts.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nT1\nT2\ne\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — ranges [3,5) and [1,4) overlap at line 3
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given a zero-length theirs insertion before a non-zero ours range', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (an insertion strictly before a range is separate)', () => {
        // Arrange — ours replaces base[3,5); theirs inserts at base pos 1 (range [1,1)).
        // Theirs' base end (1) is strictly before ours' base start (3), so git's closed
        // touching rule treats them as separate and merges clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nIT\nb\nc\nd\ne\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertClean(result, 'a\nIT\nb\nc\nOO\nf\ng\nh\n');
      });
    });
  });

  describe('Given a zero-length theirs insertion exactly at the end of a non-zero ours range', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (an insertion touching a range is not separate)', () => {
        // Arrange — ours replaces base[3,5); theirs inserts at base pos 5. The insertion's
        // baseStart (5) equals ours' baseEnd (5): git's `i1 + chg1 < other.i1` separateness
        // test is false for a touching pair, so the two hunks conflict.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nd\ne\nIT\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given two touching non-zero ranges [3,5) and [1,3)', () => {
    describe('When mergeContent called', () => {
      it('Then conflict, matching `git merge-file` (touching ranges are not separate)', () => {
        // Arrange — ours replaces base[3,5); theirs replaces base[1,3). They touch at boundary 3:
        // git's `i1 + chg1 < other.i1` separateness test is false (3 < 3), so the two hunks
        // conflict instead of merging clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nT1\nd\ne\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given identical replacement content at ranges with different baseStart', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (twin requires equal baseStart)', () => {
        // Arrange — ours replaces base[2,4) with [Z]; theirs replaces base[1,4) with [Z]. Same
        // baseEnd and content but different baseStart, so they are NOT identical twins. Forcing the
        // baseStart-equality check true would dedupe them and wrongly merge clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nZ\ne\nf\ng\nh\n');
        const theirs = enc('a\nZ\ne\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — ranges [2,4) and [1,4) overlap → conflict
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given changes sharing baseStart but differing in baseEnd and content', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (twin needs ALL three conditions AND-ed)', () => {
        // Arrange — ours replaces base[2,4) with [Z]; theirs replaces base[2,5) with [W]. They share
        // baseStart only. Replacing the twin guard's && with || would treat equal baseStart alone as
        // a twin and wrongly merge clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nZ\ne\nf\ng\nh\n');
        const theirs = enc('a\nb\nW\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — ranges [2,4) and [2,5) overlap → conflict
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given identical content and baseStart but different baseEnd', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (twin requires equal baseEnd)', () => {
        // Arrange — ours replaces base[2,4) with [Z]; theirs replaces base[2,5) with [Z]. Same
        // baseStart and content but different baseEnd, so they are NOT twins. Forcing the
        // baseEnd-equality check true would dedupe them and wrongly merge clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nZ\ne\nf\ng\nh\n');
        const theirs = enc('a\nb\nZ\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — ranges [2,4) and [2,5) overlap → conflict
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given an ours change after a theirs change in base order', () => {
    describe('When mergeContent called', () => {
      it('Then plan is sorted by baseStart before applying', () => {
        // Arrange — ours changes lines 1 and 5, theirs changes line 3. The merged plan is built as
        // [ours[1,2), ours[5,6), theirs[3,4)] — out of base order. Without the final sort (or with a
        // `+` comparator) applyPlan would walk ranges out of order and corrupt the output.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nB\nc\nd\ne\nF\ng\nh\n');
        const theirs = enc('a\nb\nc\nD\ne\nf\ng\nh\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — only an ascending sort produces this exact interleaving
        assertClean(result, 'a\nB\nc\nD\ne\nF\ng\nh\n');
      });
    });
  });

  describe('Given ours is a completely disjoint rewrite while theirs only appends one line at the base end', () => {
    describe('When mergeContent called', () => {
      it('Then whole-file conflict — the rewrite touches theirs’ end-append', () => {
        // Arrange — base and ours share no line at all, so ours' diff against base
        // is a full-region rewrite [0, baseLen) that reaches the very end of base.
        // theirs is base plus a single appended line — a zero-length change at
        // baseLen. git's touching rule (xdl_do_merge) conflicts here: ours' change
        // ends exactly where theirs' begins, which is not "strictly before".
        const baseLen = 20_000;
        const baseText = Array.from({ length: baseLen }, (_, i) => `b${i}\n`).join('');
        const base = enc(baseText);
        const ours = enc(Array.from({ length: 31_000 }, (_, i) => `o${i}\n`).join(''));
        const theirs = enc(`${baseText}APPENDED\n`);

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(result, 'content');
      });
    });
  });

  describe('Given ours equal to base and a large theirs', () => {
    describe('When mergeContent called', () => {
      it('Then the ours-unchanged fast path returns clean theirs', () => {
        // Arrange — ours === base (empty); theirs has 50_001 lines, an add-only
        // change the `bytesEqual(ours, base)` fast path short-circuits to clean.
        const base = new Uint8Array(0);
        const ours = new Uint8Array(0);
        const theirsText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const theirs = enc(theirsText);

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — clean, byte-identical to theirs
        expect(result.status).toBe('clean');
        if (result.status === 'clean') {
          expect(decoder.decode(result.bytes)).toBe(theirsText);
        }
      });
    });
  });

  describe('Given theirs equal to base and a large ours', () => {
    describe('When mergeContent called', () => {
      it('Then the theirs-unchanged fast path returns clean ours', () => {
        // Arrange — theirs === base (empty); ours has 50_001 lines, an add-only
        // change the `bytesEqual(theirs, base)` fast path short-circuits to clean.
        const base = new Uint8Array(0);
        const theirs = new Uint8Array(0);
        const oursText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const ours = enc(oursText);

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — clean, byte-identical to ours
        expect(result.status).toBe('clean');
        if (result.status === 'clean') {
          expect(decoder.decode(result.bytes)).toBe(oursText);
        }
      });
    });
  });

  describe('Given ours equal to theirs, both large, base differs', () => {
    describe('When mergeContent called', () => {
      it('Then the ours-equals-theirs fast path returns clean ours', () => {
        // Arrange — ours === theirs, both 50_001 lines; base empty. The
        // `bytesEqual(ours, theirs)` fast path short-circuits to clean.
        const base = new Uint8Array(0);
        const sideText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const ours = enc(sideText);
        const theirs = enc(sideText);

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — clean, byte-identical to ours
        expect(result.status).toBe('clean');
        if (result.status === 'clean') {
          expect(decoder.decode(result.bytes)).toBe(sideText);
        }
      });
    });
  });

  describe('Given an undefined base with identical large ours and theirs', () => {
    describe('When mergeContent called', () => {
      it('Then the add-add identical fast path returns clean ours', () => {
        // Arrange — base undefined (add-add); ours === theirs, both 50_001
        // lines. The undefined-base `bytesEqual(ours, theirs)` fast path
        // short-circuits to clean.
        const sideText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const ours = enc(sideText);
        const theirs = enc(sideText);

        // Act
        const result = mergeContent(undefined, ours, theirs);

        // Assert — clean, byte-identical to ours
        expect(result.status).toBe('clean');
        if (result.status === 'clean') {
          expect(decoder.decode(result.bytes)).toBe(sideText);
        }
      });
    });
  });

  describe('Given the property "mergeContent(base, base, base) always clean for non-binary text"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange — generate text-only bytes (no NUL, bounded lines) to avoid binary detection
        const textByte = fc.integer({ min: 1, max: 127 });
        const textArray = fc.array(textByte, { maxLength: 200 }).map((arr) => new Uint8Array(arr));
        fc.assert(
          fc.property(textArray, (bytes) => {
            // Act
            const result = mergeContent(bytes, bytes, bytes);

            // Assert
            return result.status === 'clean';
          }),
          { numRuns: 40 },
        );
      });
    });
  });

  describe('Given an overlap and favor union', () => {
    describe('When mergeContent called', () => {
      it('Then clean with both sides concatenated, no markers', () => {
        // Arrange
        const base = enc('a\nb\nc\n');
        const ours = enc('a\nX\nc\n');
        const theirs = enc('a\nY\nc\n');

        // Act
        const result = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(result, 'a\nX\nY\nc\n');
      });
    });
  });

  describe('Given conflict sides sharing a trailing line and favor union', () => {
    describe('When mergeContent called', () => {
      it('Then the shared line appears once after both middles', () => {
        // Arrange
        const base = enc('p\nq\nr\ns\nt\n');
        const ours = enc('p\nX\nY\nZ\nt\n');
        const theirs = enc('p\nM\nN\nZ\nt\n');

        // Act
        const result = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(result, 'p\nX\nY\nM\nN\nZ\nt\n');
      });
    });
  });

  describe('Given two conflicts coalesced by a 3-line gap and favor union', () => {
    describe('When mergeContent called', () => {
      it('Then the gap lines appear on both sides', () => {
        // Arrange
        const base = enc('H\nX\nm1\nm2\nm3\nY\nT\n');
        const ours = enc('H\nXo\nm1\nm2\nm3\nYo\nT\n');
        const theirs = enc('H\nXt\nm1\nm2\nm3\nYt\nT\n');

        // Act
        const result = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(result, 'H\nXo\nm1\nm2\nm3\nYo\nXt\nm1\nm2\nm3\nYt\nT\n');
      });
    });
  });

  describe('Given a no-trailing-newline EOF conflict and favor union', () => {
    describe('When mergeContent called', () => {
      it('Then an interior newline is added but the final line keeps none', () => {
        // Arrange — base/ours/theirs all end without a trailing newline.
        const base = enc('a\nb\nc');
        const ours = enc('a\nXX');
        const theirs = enc('a\nYY');

        // Act
        const result = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(result, 'a\nXX\nYY');
      });
    });
  });

  describe('Given a union whose only newline-free line is the last, all interior lines LF-terminated', () => {
    describe('When mergeContent called', () => {
      it('Then the buffer is sized to interior lines only, with no trailing padding byte', () => {
        // Arrange — conflict on line 0 (LF-terminated on both sides); shared suffix ends
        // at 'c' with no trailing newline. Every interior union line already ends in LF, so
        // the measuring loop must add no phantom byte for the final newline-free line.
        // The interior guard `i < lines.length - 1` scopes the +1 to non-last lines; forcing
        // it to `i >= lines.length - 1` over-allocates one byte for 'c' → a trailing NUL.
        const base = enc('a\nb\nc');
        const ours = enc('X\nb\nc');
        const theirs = enc('Y\nb\nc');

        // Act
        const result = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(result, 'X\nY\nb\nc');
      });
    });
  });

  describe('Given an add/add (undefined base) overlap and favor union', () => {
    describe('When mergeContent called', () => {
      it('Then the differing middle is unioned and shared edges kept once', () => {
        // Arrange
        const ours = enc('hello\nx\n');
        const theirs = enc('world\nx\n');

        // Act
        const result = mergeContent(undefined, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(result, 'hello\nworld\nx\n');
      });
    });
  });

  describe('Given non-overlapping edits on each side of one overlap (default favor)', () => {
    describe('When mergeContent called', () => {
      it('Then only the overlap is marked, the outer edits apply cleanly', () => {
        // Arrange — ours changes line 0 + line 3; theirs changes line 3 + line 6. Only line 3 overlaps.
        const base = enc('a\nb\nc\nd\ne\nf\ng\n');
        const ours = enc('A\nb\nc\nD\ne\nf\ng\n');
        const theirs = enc('a\nb\nc\nD2\ne\nf\nG\n');

        // Act
        const result = mergeContent(base, ours, theirs);

        // Assert — per-region: A and G apply, only line 3 conflicts
        expect(result.status).toBe('conflict');
        if (result.status === 'conflict') {
          expect(decoder.decode(result.markedBytes)).toBe(
            'A\nb\nc\n<<<<<<< ours\nD\n=======\nD2\n>>>>>>> theirs\ne\nf\nG\n',
          );
        }
      });
    });
  });

  describe('Given an add/add (undefined base) overlap with shared edges (default favor)', () => {
    describe('When mergeContent called', () => {
      it('Then the conflict is trimmed to the differing middle', () => {
        // Arrange
        const ours = enc('a\nb\nc\n');
        const theirs = enc('a\nX\nc\n');

        // Act
        const result = mergeContent(undefined, ours, theirs);

        // Assert
        expect(result.status).toBe('conflict');
        if (result.status === 'conflict') {
          expect(decoder.decode(result.markedBytes)).toBe(
            'a\n<<<<<<< ours\nb\n=======\nX\n>>>>>>> theirs\nc\n',
          );
        }
      });
    });
  });
});

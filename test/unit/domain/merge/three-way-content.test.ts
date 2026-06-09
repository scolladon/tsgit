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
  describe('Given identical bytes on all three sides', () => {
    describe('When mergeContent called', () => {
      it('Then clean with base bytes', () => {
        // Arrange
        const bytes = enc('a\nb\n');

        // Act
        const sut = mergeContent(bytes, bytes, bytes);

        // Assert
        assertClean(sut, 'a\nb\n');
      });
    });
  });

  describe('Given base + ours modified + theirs unchanged from base', () => {
    describe('When mergeContent called', () => {
      it('Then clean with ours', () => {
        // Arrange
        const base = enc('a\nb\n');
        const ours = enc('a\nX\n');
        const theirs = base;

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nX\n');
      });
    });
  });

  describe('Given base + theirs modified + ours unchanged from base', () => {
    describe('When mergeContent called', () => {
      it('Then clean with theirs', () => {
        // Arrange
        const base = enc('a\nb\n');
        const theirs = enc('a\nY\n');

        // Act
        const sut = mergeContent(base, base, theirs);

        // Assert
        assertClean(sut, 'a\nY\n');
      });
    });
  });

  describe('Given base + both sides make identical modification', () => {
    describe('When mergeContent called', () => {
      it('Then clean with ours', () => {
        // Arrange
        const base = enc('a\nb\n');
        const same = enc('a\nZ\n');

        // Act
        const sut = mergeContent(base, same, same);

        // Assert
        assertClean(sut, 'a\nZ\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'A\nb\nc\nd\nE\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
        if (sut.status === 'conflict') {
          expect(decoder.decode(sut.markedBytes)).toContain('<<<<<<<');
          expect(decoder.decode(sut.markedBytes)).toContain('=======');
          expect(decoder.decode(sut.markedBytes)).toContain('>>>>>>>');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'binary');
        if (sut.status === 'conflict') {
          expect(sut.markedBytes).toEqual(ours);
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
        const sut = mergeContent(undefined, bytes, bytes);

        // Assert
        assertClean(sut, 'a\nb\n');
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
        const sut = mergeContent(undefined, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
        if (sut.status === 'conflict') {
          const text = decoder.decode(sut.markedBytes);
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
        const sut = mergeContent(base, ours, theirs, {
          labels: { ours: 'HEAD', theirs: 'feature' },
        });

        // Assert
        expect(sut.status).toBe('conflict');
        if (sut.status === 'conflict') {
          const text = decoder.decode(sut.markedBytes);
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'binary');
      });
    });
  });

  describe('Given non-overlapping changes at the start of base with unchanged suffix', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge retains the unchanged suffix', () => {
        // Arrange — both changes in the first two lines; lines 2-4 of base untouched.
        const base = enc('a\nb\nc\nd\ne\n');
        const ours = enc('X\nb\nc\nd\ne\n');
        const theirs = enc('a\nY\nc\nd\ne\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert — applyPlan must copy the base suffix after the last change
        assertClean(sut, 'X\nY\nc\nd\ne\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — the zero-length overlap detection catches the collision
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — twin applied once + theirs' extra change
        assertClean(sut, 'X\nb\nc\nd\nY\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — both twins deduped + theirs extra applied
        assertClean(sut, 'X\nb\nZ\nd\ne\nf\nY\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — twin at (0,1,[X]) ok but (3,4,[W]) vs (3,4,[Z]) conflicts
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'X\nb\nY\n');
      });
    });
  });

  describe('Given one side forces degraded diff (iteration cap)', () => {
    describe('When mergeContent called', () => {
      it('Then whole-file fallback conflict', () => {
        // Arrange — base and ours completely disjoint, large enough to trigger iteration cap.
        // theirs differs slightly from base to bypass the fast-path equality shortcuts.
        const N = 1500;
        const base = enc(Array.from({ length: N }, (_, i) => `b${i}\n`).join(''));
        const ours = enc(Array.from({ length: N }, (_, i) => `o${i}\n`).join(''));
        const theirsLines = Array.from({ length: N }, (_, i) => `b${i}\n`);
        theirsLines[0] = 'X\n';
        const theirs = enc(theirsLines.join(''));

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert — degraded path emits a whole-file content conflict
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'binary');
      });
    });
  });

  describe('Given zero-length insertion at position 5 and deletion [5,7)', () => {
    describe('When mergeContent called', () => {
      it('Then conflict detected (not silently merged)', () => {
        // Arrange — ours inserts a line after base line 4 (zero-length at base pos 5);
        // theirs deletes base lines 5-6 (range [5,7)).
        // With the old rangesOverlap, a zero-length insertion at the boundary of a deletion
        // would be missed (insertion 5..5 and range 5..7: the old code only handled both-zero-length
        // and both-non-zero-length cases).
        const base = enc('a\nb\nc\nd\ne\nf\ng\n');
        const ours = enc('a\nb\nc\nd\ne\nINSERTED\nf\ng\n');
        const theirs = enc('a\nb\nc\nd\ne\ng\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given adjacent non-overlapping ranges [0,1) vs [1,2)', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (no conflict)', () => {
        // Arrange — ours changes line 0, theirs changes line 1. Ranges [0,1) and [1,2) are adjacent
        // but do NOT overlap. a.baseStart (0) < b.baseEnd (2) is true, but b.baseStart (1) < a.baseEnd (1) is false.
        const base = enc('a\nb\nc\n');
        const ours = enc('X\nb\nc\n');
        const theirs = enc('a\nY\nc\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'X\nY\nc\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given theirs inserts inside a range ours deletes', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (zero-length b inside non-zero a)', () => {
        // Arrange — ours deletes lines 1-2 (replaces with nothing); theirs inserts at line 1 (zero-length).
        // rangesOverlap branch: b is zero-length, a is non-zero → b.baseStart >= a.baseStart && b.baseStart < a.baseEnd.
        const base = enc('a\nb\nc\nd\n');
        const ours = enc('a\nd\n');
        const theirs = enc('a\nX\nb\nc\nd\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given only theirs diff is degraded (not ours)', () => {
    describe('When mergeContent called', () => {
      it('Then whole-file fallback conflict', () => {
        // Arrange — base vs theirs is degenerate (completely disjoint, large), base vs ours is trivial (same).
        // This kills the || → && mutation: if only theirsDiff.degraded is true, the || path must still trigger.
        const N = 1500;
        const base = enc(Array.from({ length: N }, (_, i) => `b${i}\n`).join(''));
        const theirs = enc(Array.from({ length: N }, (_, i) => `t${i}\n`).join(''));
        // ours differs from base minimally to bypass the fast-path bytesEqual shortcut
        const oursLines = Array.from({ length: N }, (_, i) => `b${i}\n`);
        oursLines[0] = 'X\n';
        const ours = enc(oursLines.join(''));

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — ours (delete line 2) vs theirs (replace line 2) overlap → conflict
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given ours inserts strictly inside a theirs replacement range', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (zero-length a vs non-zero b)', () => {
        // Arrange — ours inserts at base pos 2; theirs replaces base[1,3). rangesOverlap takes the
        // ternary `:` branch. If the ternary condition were forced true it would compare
        // a.baseStart === b.baseStart (2 === 1 → false) and miss the real overlap.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nINS\nc\nd\ne\nf\ng\nh\n');
        const theirs = enc('a\nP\nQ\nd\ne\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given two zero-length insertions at different base positions', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (both-zero-length branch compares positions)', () => {
        // Arrange — ours inserts at base pos 1, theirs inserts at base pos 5. Both ranges are
        // zero-length but at distinct positions: a.baseStart === b.baseStart is false → no overlap.
        // Forcing that comparison to true would wrongly flag a conflict.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nIO\nb\nc\nd\ne\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nd\ne\nIT\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nIO\nb\nc\nd\ne\nIT\nf\ng\nh\n');
      });
    });
  });

  describe('Given a zero-length insertion before a disjoint non-zero theirs range', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (a.baseStart < b.baseStart short-circuits)', () => {
        // Arrange — ours inserts at base pos 1; theirs replaces base[3,5). The `:` branch evaluates
        // a.baseStart >= b.baseStart (1 >= 3 → false). Forcing the branch true, or flipping && to ||,
        // would wrongly report overlap.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nIO\nb\nc\nd\ne\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nP\nQ\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nIO\nb\nc\nP\nQ\nf\ng\nh\n');
      });
    });
  });

  describe('Given a zero-length insertion exactly at the end of a non-zero theirs range', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (a.baseStart < b.baseEnd is strict)', () => {
        // Arrange — ours inserts at base pos 5; theirs replaces base[3,5). The `:` branch evaluates
        // a.baseStart < b.baseEnd (5 < 5 → false). Relaxing `<` to `<=` (or forcing it true) would
        // wrongly flag an overlap at the touching boundary.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nd\ne\nIO\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nP\nQ\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nb\nc\nP\nQ\nIO\nf\ng\nh\n');
      });
    });
  });

  describe('Given two overlapping non-zero ranges where only the general branch detects it', () => {
    describe('When mergeContent called', () => {
      it('Then conflict (b-non-zero path falls through to general overlap)', () => {
        // Arrange — ours replaces base[3,5), theirs replaces base[1,4). Both ranges are non-zero,
        // so rangesOverlap must skip the b-zero-length branch and use the general test. Forcing the
        // `if (b.baseStart === b.baseEnd)` guard true would use the wrong (b-zero) formula → clean.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nT1\nT2\ne\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert — ranges [3,5) and [1,4) overlap at line 3
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given a zero-length theirs insertion before a non-zero ours range', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (b.baseStart >= a.baseStart short-circuits)', () => {
        // Arrange — ours replaces base[3,5); theirs inserts at base pos 1. The b-zero-length branch
        // evaluates b.baseStart >= a.baseStart (1 >= 3 → false). Forcing it true, or flipping && to
        // ||, would wrongly report overlap.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nIT\nb\nc\nd\ne\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nIT\nb\nc\nOO\nf\ng\nh\n');
      });
    });
  });

  describe('Given a zero-length theirs insertion exactly at the end of a non-zero ours range', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (b.baseStart < a.baseEnd is strict)', () => {
        // Arrange — ours replaces base[3,5); theirs inserts at base pos 5. The b-zero-length branch
        // evaluates b.baseStart < a.baseEnd (5 < 5 → false). Relaxing `<` to `<=` (or forcing it
        // true) would wrongly flag a boundary overlap.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nb\nc\nd\ne\nIT\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nb\nc\nOO\nIT\nf\ng\nh\n');
      });
    });
  });

  describe('Given two touching non-zero ranges [3,5) and [1,3)', () => {
    describe('When mergeContent called', () => {
      it('Then clean merge (general overlap test uses strict a.baseStart < b.baseEnd)', () => {
        // Arrange — ours replaces base[3,5); theirs replaces base[1,3). They touch at boundary 3 but
        // do not overlap: a.baseStart < b.baseEnd is 3 < 3 → false. Relaxing `<` to `<=` (or forcing
        // it true) would wrongly flag a conflict.
        const base = enc('a\nb\nc\nd\ne\nf\ng\nh\n');
        const ours = enc('a\nb\nc\nOO\nf\ng\nh\n');
        const theirs = enc('a\nT1\nd\ne\nf\ng\nh\n');

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertClean(sut, 'a\nT1\nOO\nf\ng\nh\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — ranges [2,4) and [1,4) overlap → conflict
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — ranges [2,4) and [2,5) overlap → conflict
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — ranges [2,4) and [2,5) overlap → conflict
        assertConflict(sut, 'content');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — only an ascending sort produces this exact interleaving
        assertClean(sut, 'a\nB\nc\nD\ne\nF\ng\nh\n');
      });
    });
  });

  describe('Given ours diff degrades while theirs only appends one line at the base end', () => {
    describe('When mergeContent called', () => {
      it('Then whole-file conflict (degraded guard fires)', () => {
        // Arrange — base/ours exceed the diff line cap (M+N > 50000) so ours' diff degrades, while
        // theirs is base plus a single appended line (a tiny, non-degraded diff). The degraded guard
        // must short-circuit to a whole-file conflict: without it, the degraded whole-file change
        // [0,baseLen) would NOT collide with theirs' zero-length end-append and wrongly merge clean.
        const baseLen = 20_000;
        const baseText = Array.from({ length: baseLen }, (_, i) => `b${i}\n`).join('');
        const base = enc(baseText);
        const ours = enc(Array.from({ length: 31_000 }, (_, i) => `o${i}\n`).join(''));
        const theirs = enc(`${baseText}APPENDED\n`);

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert
        assertConflict(sut, 'content');
      });
    });
  });

  describe('Given ours equal to base and a cap-exceeding theirs', () => {
    describe('When mergeContent called', () => {
      it('Then the ours-unchanged fast path returns clean theirs (not the degraded conflict)', () => {
        // Arrange — ours === base (empty); theirs has 50_001 lines so diffLines(base, theirs)
        // degrades (M+N > 50_000). The `bytesEqual(ours, base)` fast path must short-circuit
        // to clean; skipping it falls through to the degraded slow path → whole-file conflict.
        const base = new Uint8Array(0);
        const ours = new Uint8Array(0);
        const theirsText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const theirs = enc(theirsText);

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert — clean, byte-identical to theirs (slow path would yield status 'conflict')
        expect(sut.status).toBe('clean');
        if (sut.status === 'clean') {
          expect(decoder.decode(sut.bytes)).toBe(theirsText);
        }
      });
    });
  });

  describe('Given theirs equal to base and a cap-exceeding ours', () => {
    describe('When mergeContent called', () => {
      it('Then the theirs-unchanged fast path returns clean ours (not the degraded conflict)', () => {
        // Arrange — theirs === base (empty); ours has 50_001 lines so diffLines(base, ours)
        // degrades. The `bytesEqual(theirs, base)` fast path must short-circuit to clean;
        // skipping it falls through to the degraded slow path → whole-file conflict.
        const base = new Uint8Array(0);
        const theirs = new Uint8Array(0);
        const oursText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const ours = enc(oursText);

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert — clean, byte-identical to ours (slow path would yield status 'conflict')
        expect(sut.status).toBe('clean');
        if (sut.status === 'clean') {
          expect(decoder.decode(sut.bytes)).toBe(oursText);
        }
      });
    });
  });

  describe('Given ours equal to theirs (both cap-exceeding, base differs)', () => {
    describe('When mergeContent called', () => {
      it('Then the ours-equals-theirs fast path returns clean ours (not the degraded conflict)', () => {
        // Arrange — ours === theirs, both 50_001 lines; base empty so both side diffs degrade.
        // The `bytesEqual(ours, theirs)` fast path must short-circuit to clean; skipping it
        // falls through to the degraded slow path → whole-file conflict.
        const base = new Uint8Array(0);
        const sideText = Array.from({ length: 50_001 }, (_, i) => `line${i}\n`).join('');
        const ours = enc(sideText);
        const theirs = enc(sideText);

        // Act
        const sut = mergeContent(base, ours, theirs);

        // Assert — clean, byte-identical to ours (slow path would yield status 'conflict')
        expect(sut.status).toBe('clean');
        if (sut.status === 'clean') {
          expect(decoder.decode(sut.bytes)).toBe(sideText);
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
            const sut = mergeContent(bytes, bytes, bytes);

            // Assert
            return sut.status === 'clean';
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
        const sut = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(sut, 'a\nX\nY\nc\n');
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
        const sut = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(sut, 'p\nX\nY\nM\nN\nZ\nt\n');
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
        const sut = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(sut, 'H\nXo\nm1\nm2\nm3\nYo\nXt\nm1\nm2\nm3\nYt\nT\n');
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
        const sut = mergeContent(base, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(sut, 'a\nXX\nYY');
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
        const sut = mergeContent(undefined, ours, theirs, { favor: 'union' });

        // Assert
        assertClean(sut, 'hello\nworld\nx\n');
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
        const sut = mergeContent(base, ours, theirs);

        // Assert — per-region: A and G apply, only line 3 conflicts
        expect(sut.status).toBe('conflict');
        if (sut.status === 'conflict') {
          expect(decoder.decode(sut.markedBytes)).toBe(
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
        const sut = mergeContent(undefined, ours, theirs);

        // Assert
        expect(sut.status).toBe('conflict');
        if (sut.status === 'conflict') {
          expect(decoder.decode(sut.markedBytes)).toBe(
            'a\n<<<<<<< ours\nb\n=======\nX\n>>>>>>> theirs\nc\n',
          );
        }
      });
    });
  });
});

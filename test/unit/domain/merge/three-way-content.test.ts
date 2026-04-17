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
  it('Given identical bytes on all three sides, When mergeContent called, Then clean with base bytes', () => {
    // Arrange
    const bytes = enc('a\nb\n');

    // Act
    const sut = mergeContent(bytes, bytes, bytes);

    // Assert
    assertClean(sut, 'a\nb\n');
  });

  it('Given base + ours modified + theirs unchanged from base, When mergeContent called, Then clean with ours', () => {
    // Arrange
    const base = enc('a\nb\n');
    const ours = enc('a\nX\n');
    const theirs = base;

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertClean(sut, 'a\nX\n');
  });

  it('Given base + theirs modified + ours unchanged from base, When mergeContent called, Then clean with theirs', () => {
    // Arrange
    const base = enc('a\nb\n');
    const theirs = enc('a\nY\n');

    // Act
    const sut = mergeContent(base, base, theirs);

    // Assert
    assertClean(sut, 'a\nY\n');
  });

  it('Given base + both sides make identical modification, When mergeContent called, Then clean with ours', () => {
    // Arrange
    const base = enc('a\nb\n');
    const same = enc('a\nZ\n');

    // Act
    const sut = mergeContent(base, same, same);

    // Assert
    assertClean(sut, 'a\nZ\n');
  });

  it('Given non-overlapping modifications on both sides, When mergeContent called, Then clean merged (both changes applied)', () => {
    // Arrange
    const base = enc('a\nb\nc\nd\ne\n');
    const ours = enc('A\nb\nc\nd\ne\n'); // change line 0
    const theirs = enc('a\nb\nc\nd\nE\n'); // change line 4

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertClean(sut, 'A\nb\nc\nd\nE\n');
  });

  it('Given overlapping modifications on both sides (different content), When mergeContent called, Then content conflict with markers', () => {
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

  it('Given any side binary (NUL in first 8000 bytes), When mergeContent called, Then binary conflict with ours bytes', () => {
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

  it('Given undefined base (add-add) with identical bytes, When mergeContent called, Then clean with ours', () => {
    // Arrange
    const bytes = enc('a\nb\n');

    // Act
    const sut = mergeContent(undefined, bytes, bytes);

    // Assert
    assertClean(sut, 'a\nb\n');
  });

  it('Given undefined base (add-add) with different bytes, When mergeContent called, Then content conflict with whole-file markers', () => {
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

  it('Given mergeContent called with custom labels, When output emitted, Then labels appear in markedBytes', () => {
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

  it('Given theirs binary (NUL at offset 2), When mergeContent called, Then binary conflict', () => {
    // Arrange — theirs has NUL
    const base = enc('a\n');
    const ours = enc('a\n');
    const theirs = new Uint8Array([0x61, 0x62, 0x00]);

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertConflict(sut, 'binary');
  });

  it('Given non-overlapping changes at the start of base with unchanged suffix, When mergeContent called, Then clean merge retains the unchanged suffix', () => {
    // Arrange — both changes in the first two lines; lines 2-4 of base untouched.
    const base = enc('a\nb\nc\nd\ne\n');
    const ours = enc('X\nb\nc\nd\ne\n');
    const theirs = enc('a\nY\nc\nd\ne\n');

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert — applyPlan must copy the base suffix after the last change
    assertClean(sut, 'X\nY\nc\nd\ne\n');
  });

  it('Given both sides insert different content at the same base position, When mergeContent called, Then content conflict (zero-length overlap)', () => {
    // Arrange — both sides insert at base position 1 (between 'a' and 'b'), with different content.
    const base = enc('a\nb\n');
    const ours = enc('a\nX\nb\n');
    const theirs = enc('a\nY\nb\n');

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert — the zero-length overlap detection catches the collision
    assertConflict(sut, 'content');
  });

  it('Given replacements have different lengths at same base range, When mergeContent called, Then whole-file fallback (lineArraysEqual length-guard)', () => {
    // Arrange — both sides replace base[1] but with a differing number of lines.
    const base = enc('a\nb\nc\n');
    const ours = enc('a\nX\nc\n');
    const theirs = enc('a\nX\nY\nc\n');

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertConflict(sut, 'content');
  });

  it('Given twin at first change + non-overlapping extra on theirs side, When mergeContent called, Then clean merge with twin deduped and extra applied', () => {
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

  it('Given two twins on both sides plus extra theirs change, When mergeContent called, Then consumed-set lookup skips first twin for second oc and clean merge applies all', () => {
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

  it('Given twin consumed + second ours collides with unconsumed theirs, When mergeContent called, Then conflict (collidesWithUnconsumed consumed-skip exercised)', () => {
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

  it('Given both sides share one identical change plus one side has extra non-overlapping change, When mergeContent called, Then clean merged with identical twin applied once + extra change', () => {
    // Arrange — (0,1,[X]) in both; theirs additionally has (2,3,[Y]).
    const base = enc('a\nb\nc\n');
    const ours = enc('X\nb\nc\n');
    const theirs = enc('X\nb\nY\n');

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertClean(sut, 'X\nb\nY\n');
  });

  it('Given one side forces degraded diff (iteration cap), When mergeContent called, Then whole-file fallback conflict', () => {
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
  }, 20_000);

  it('Given base binary, When mergeContent called, Then binary conflict', () => {
    // Arrange
    const base = new Uint8Array([0x00, 0x61]);
    const ours = enc('a\n');
    const theirs = enc('b\n');

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertConflict(sut, 'binary');
  });

  it('Given zero-length insertion at position 5 and deletion [5,7), When mergeContent called, Then conflict detected (not silently merged)', () => {
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

  it('Given adjacent non-overlapping ranges [0,1) vs [1,2), When mergeContent called, Then clean merge (no conflict)', () => {
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

  it('Given overlapping ranges [0,2) vs [1,3), When mergeContent called, Then conflict (ranges overlap)', () => {
    // Arrange — ours changes lines 0-1, theirs changes lines 1-2. Ranges [0,2) and [1,3) overlap at line 1.
    const base = enc('a\nb\nc\nd\n');
    const ours = enc('X\nY\nc\nd\n');
    const theirs = enc('a\nP\nQ\nd\n');

    // Act
    const sut = mergeContent(base, ours, theirs);

    // Assert
    assertConflict(sut, 'content');
  });

  it('Given theirs inserts inside a range ours deletes, When mergeContent called, Then conflict (zero-length b inside non-zero a)', () => {
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

  it('Given only theirs diff is degraded (not ours), When mergeContent called, Then whole-file fallback conflict', () => {
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
  }, 20_000);

  it('Property: mergeContent(base, base, base) always clean for non-binary text', () => {
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

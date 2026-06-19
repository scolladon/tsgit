import { describe, expect, it } from 'vitest';
import { computeStatFields } from '../../../../src/domain/diff/stat-fields.js';
import type { LineKey } from '../../../../src/domain/diff/whitespace.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const withNul = (): Uint8Array => new Uint8Array([0x61, 0x00, 0x62]);

describe('computeStatFields', () => {
  describe('Given a pure addition (empty old, one new line)', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports one added line and zero deleted', () => {
        // Arrange
        const old = enc('');
        const next = enc('a\n');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 1, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a pure deletion (one old line, empty new)', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports zero added and one deleted line', () => {
        // Arrange
        const old = enc('a\n');
        const next = enc('');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 1, binary: false });
      });
    });
  });

  describe('Given a single-line replacement', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports one added and one deleted line', () => {
        // Arrange
        const old = enc('a\n');
        const next = enc('b\n');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 1, deleted: 1, binary: false });
      });
    });
  });

  describe('Given identical content', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports zero changes and binary false', () => {
        // Arrange
        const same = enc('a\nb\n');
        // Act
        const sut = computeStatFields(same, same);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a binary old side only', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports binary with zero counts', () => {
        // Arrange — old has a NUL byte; new is text. Isolates the first guard arm.
        const old = withNul();
        const next = enc('text\n');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  describe('Given a binary new side only', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports binary with zero counts', () => {
        // Arrange — new has a NUL byte; old is text. Isolates the second guard arm.
        const old = enc('text\n');
        const next = withNul();
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  describe('Given no options argument', () => {
    describe('When computeStatFields is called with options undefined', () => {
      it('Then it produces counts byte-identical to the no-options call', () => {
        // Arrange
        const old = enc('a  b\n');
        const next = enc('a    b\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next);
        const resultUndefined = sut(old, next, undefined);
        const resultEmpty = sut(old, next, {});
        // Assert — all three forms must produce the same counts (regression guard)
        expect(resultUndefined).toEqual(result);
        expect(resultEmpty).toEqual(result);
      });
    });
  });

  describe('Given a line-key mode all and a whitespace-only change', () => {
    describe('When computeStatFields is called with lineKey mode all', () => {
      it('Then it reports zero added and zero deleted (W1/D1 at count level)', () => {
        // Arrange — single line with only whitespace difference: "  ws\n" vs "    ws\n"
        const lineKey: LineKey = { mode: 'all', ignoreCrAtEol: false };
        const old = enc('  ws\n');
        const next = enc('    ws\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { lineKey });
        // Assert — whitespace-only line is treated as common; no change counted
        expect(result).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a line-key mode change and a whitespace-amount change', () => {
    describe('When computeStatFields is called with lineKey mode change', () => {
      it('Then it reports zero added and zero deleted (B-run: amount change hidden)', () => {
        // Arrange — "a b\n" vs "a    b\n": same presence, different amount → equal under change
        const lineKey: LineKey = { mode: 'change', ignoreCrAtEol: false };
        const old = enc('a b\n');
        const next = enc('a    b\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { lineKey });
        // Assert — amount-only change hidden under mode:change
        expect(result).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given ignoreBlankLines true and a blank-only insert', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports zero added and zero deleted (BL1: blank-only hunk suppressed)', () => {
        // Arrange — inserting a single blank line into otherwise identical content
        const old = enc('a\nb\n');
        const next = enc('a\n\nb\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { ignoreBlankLines: true });
        // Assert — blank-only theirs-only hunk does not count
        expect(result).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given ignoreBlankLines true, a blank insert, and a real change', () => {
    describe('When computeStatFields is called', () => {
      it('Then it counts the mixed hunk fully and suppresses the blank-only hunk (BL2: 2 1)', () => {
        // Arrange — old: "c\n", new: "\nC\n"
        // Myers produces: ours-only hunk ["c\n"] + theirs-only hunk ["\n","C\n"]
        // The theirs-only hunk is MIXED (blank "\n" + non-blank "C\n") → not blank-only → 2 added
        // The ours-only hunk ["c\n"] is non-blank → 1 deleted
        const old = enc('c\n');
        const next = enc('\nC\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { ignoreBlankLines: true });
        // Assert — mixed hunk counted fully; result is 2 added, 1 deleted (BL2)
        expect(result).toEqual({ added: 2, deleted: 1, binary: false });
      });
    });
  });

  describe('Given ignoreBlankLines true, a theirs-only hunk containing a blank and a non-blank line', () => {
    describe('When computeStatFields is called', () => {
      it('Then it counts all lines in that hunk because it is not blank-only', () => {
        // Arrange — old: "x\n", new: "\nY\n"
        // Myers produces: ours-only hunk ["x\n"] + theirs-only hunk ["\n","Y\n"]
        // The theirs-only hunk has ≥1 non-blank line ("Y\n") → not blank-only → all 2 lines counted
        const old = enc('x\n');
        const next = enc('\nY\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { ignoreBlankLines: true });
        // Assert — mixed theirs-only hunk counted fully: 2 added, 1 deleted
        expect(result).toEqual({ added: 2, deleted: 1, binary: false });
      });
    });
  });

  describe('Given ignoreBlankLines true and a spaces-only insert without line-key', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports one added (BL-spaces: spaces-only is NOT blank without line-key)', () => {
        // Arrange — inserting a spaces-only line "   \n"
        // Without a lineKey, normalization uses {mode:'none'}, so "   \n" is non-empty → not blank
        const old = enc('a\n');
        const next = enc('a\n   \n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { ignoreBlankLines: true });
        // Assert — spaces-only line is not blank under no-lineKey normalization
        expect(result).toEqual({ added: 1, deleted: 0, binary: false });
      });
    });
  });

  describe('Given ignoreBlankLines true, a spaces-only insert, and lineKey mode all', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports zero added (BL-combo: -w makes spaces-only line blank)', () => {
        // Arrange — inserting a spaces-only line "   \n"; with mode:all it normalizes to empty → blank
        const lineKey: LineKey = { mode: 'all', ignoreCrAtEol: false };
        const old = enc('a\n');
        const next = enc('a\n   \n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { lineKey, ignoreBlankLines: true });
        // Assert — mode:all strips spaces → empty content → blank line → suppressed
        expect(result).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a binary old side with lineKey option set', () => {
    describe('When computeStatFields is called', () => {
      it('Then it still reports binary with zero counts (binary guard unaffected by lineKey)', () => {
        // Arrange — binary short-circuit must ignore whitespace options
        const lineKey: LineKey = { mode: 'all', ignoreCrAtEol: false };
        const old = withNul();
        const next = enc('text\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { lineKey });
        // Assert
        expect(result).toEqual({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  describe('Given a binary new side with ignoreBlankLines set', () => {
    describe('When computeStatFields is called', () => {
      it('Then it still reports binary with zero counts (binary guard unaffected by ignoreBlankLines)', () => {
        // Arrange — binary short-circuit must ignore blank-line suppression options
        const old = enc('text\n');
        const next = withNul();
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { ignoreBlankLines: true });
        // Assert
        expect(result).toEqual({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  describe('Given a blank-only ours-only hunk with ignoreBlankLines true', () => {
    describe('When computeStatFields is called', () => {
      it('Then it suppresses the deletion count for that blank-only hunk', () => {
        // Arrange — deleting a blank line
        const old = enc('a\n\nb\n');
        const next = enc('a\nb\n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { ignoreBlankLines: true });
        // Assert — blank-only ours-only hunk is suppressed
        expect(result).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a lineKey mode none and a spaces-only insert with ignoreBlankLines false', () => {
    describe('When computeStatFields is called', () => {
      it('Then it counts the spaces-only line normally (no suppression when ignoreBlankLines absent)', () => {
        // Arrange — spaces-only insert, no blank suppression
        const lineKey: LineKey = { mode: 'none', ignoreCrAtEol: false };
        const old = enc('a\n');
        const next = enc('a\n   \n');
        // Act
        const sut = computeStatFields;
        const result = sut(old, next, { lineKey });
        // Assert — no suppression active
        expect(result).toEqual({ added: 1, deleted: 0, binary: false });
      });
    });
  });

  describe('Given lineKey mode all and a lineKey mode none for the same spaces-only insert', () => {
    describe('When checking blank definition reads the active lineKey', () => {
      it('Then mode:none treats spaces-only as non-blank and mode:all treats it as blank', () => {
        // Arrange — spaces-only insert
        const old = enc('a\n');
        const next = enc('a\n   \n');
        const keyNone: LineKey = { mode: 'none', ignoreCrAtEol: false };
        const keyAll: LineKey = { mode: 'all', ignoreCrAtEol: false };
        // Act
        const sut = computeStatFields;
        const resultNone = sut(old, next, { lineKey: keyNone, ignoreBlankLines: true });
        const resultAll = sut(old, next, { lineKey: keyAll, ignoreBlankLines: true });
        // Assert — active lineKey determines blank definition
        expect(resultNone).toEqual({ added: 1, deleted: 0, binary: false });
        expect(resultAll).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });
});

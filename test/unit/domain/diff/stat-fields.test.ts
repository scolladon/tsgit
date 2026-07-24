import { describe, expect, it } from 'vitest';
import { computeStatFields } from '../../../../src/domain/diff/stat-fields.js';
import type { LineKey } from '../../../../src/domain/diff/whitespace.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const withNul = (): Uint8Array => new Uint8Array([0x61, 0x00, 0x62]);

describe('computeStatFields', () => {
  describe('Given old/new byte content and diff-stat options', () => {
    describe('When computeStatFields is called', () => {
      it.each([
        {
          label:
            'a pure addition (empty old, one new line) reports one added line and zero deleted',
          old: enc(''),
          next: enc('a\n'),
          expected: { added: 1, deleted: 0, binary: false },
        },
        {
          label:
            'a pure deletion (one old line, empty new) reports zero added and one deleted line',
          old: enc('a\n'),
          next: enc(''),
          expected: { added: 0, deleted: 1, binary: false },
        },
        {
          label: 'a single-line replacement reports one added and one deleted line',
          old: enc('a\n'),
          next: enc('b\n'),
          expected: { added: 1, deleted: 1, binary: false },
        },
        {
          label: 'identical content reports zero changes and binary false',
          old: enc('a\nb\n'),
          next: enc('a\nb\n'),
          expected: { added: 0, deleted: 0, binary: false },
        },
        {
          // isolates the first guard arm
          label: 'a binary old side only reports binary with zero counts',
          old: withNul(),
          next: enc('text\n'),
          expected: { added: 0, deleted: 0, binary: true },
        },
        {
          // isolates the second guard arm
          label: 'a binary new side only reports binary with zero counts',
          old: enc('text\n'),
          next: withNul(),
          expected: { added: 0, deleted: 0, binary: true },
        },
        {
          label:
            'a line-key mode all and a whitespace-only change reports zero added and zero deleted (W1/D1 at count level)',
          old: enc('  ws\n'),
          next: enc('    ws\n'),
          options: { lineKey: { mode: 'all', ignoreCrAtEol: false } as LineKey },
          expected: { added: 0, deleted: 0, binary: false },
        },
        {
          label:
            'a line-key mode change and a whitespace-amount change reports zero added and zero deleted (B-run: amount change hidden)',
          old: enc('a b\n'),
          next: enc('a    b\n'),
          options: { lineKey: { mode: 'change', ignoreCrAtEol: false } as LineKey },
          expected: { added: 0, deleted: 0, binary: false },
        },
        {
          label:
            'ignoreBlankLines true and a blank-only insert reports zero added and zero deleted (BL1: blank-only hunk suppressed)',
          old: enc('a\nb\n'),
          next: enc('a\n\nb\n'),
          options: { ignoreBlankLines: true },
          expected: { added: 0, deleted: 0, binary: false },
        },
        {
          // Myers produces: ours-only hunk ["c\n"] + theirs-only hunk ["\n","C\n"].
          // The theirs-only hunk is MIXED (blank "\n" + non-blank "C\n") → not blank-only → 2 added.
          label:
            'ignoreBlankLines true, a blank insert, and a real change counts the mixed hunk fully and suppresses the blank-only hunk (BL2: 2 1)',
          old: enc('c\n'),
          next: enc('\nC\n'),
          options: { ignoreBlankLines: true },
          expected: { added: 2, deleted: 1, binary: false },
        },
        {
          // Myers produces: ours-only hunk ["x\n"] + theirs-only hunk ["\n","Y\n"], which has
          // ≥1 non-blank line ("Y\n") → not blank-only → all 2 lines counted.
          label:
            'ignoreBlankLines true, a theirs-only hunk containing a blank and a non-blank line counts all lines in that hunk because it is not blank-only',
          old: enc('x\n'),
          next: enc('\nY\n'),
          options: { ignoreBlankLines: true },
          expected: { added: 2, deleted: 1, binary: false },
        },
        {
          // Without a lineKey, normalization uses {mode:'none'}, so "   \n" is non-empty → not blank.
          label:
            'ignoreBlankLines true and a spaces-only insert without line-key reports one added (BL-spaces: spaces-only is NOT blank without line-key)',
          old: enc('a\n'),
          next: enc('a\n   \n'),
          options: { ignoreBlankLines: true },
          expected: { added: 1, deleted: 0, binary: false },
        },
        {
          // With mode:all it normalizes "   \n" to empty → blank → suppressed.
          label:
            'ignoreBlankLines true, a spaces-only insert, and lineKey mode all reports zero added (BL-combo: -w makes spaces-only line blank)',
          old: enc('a\n'),
          next: enc('a\n   \n'),
          options: {
            lineKey: { mode: 'all', ignoreCrAtEol: false } as LineKey,
            ignoreBlankLines: true,
          },
          expected: { added: 0, deleted: 0, binary: false },
        },
        {
          // The binary short-circuit must ignore whitespace options.
          label:
            'a binary old side with lineKey option set still reports binary with zero counts (binary guard unaffected by lineKey)',
          old: withNul(),
          next: enc('text\n'),
          options: { lineKey: { mode: 'all', ignoreCrAtEol: false } as LineKey },
          expected: { added: 0, deleted: 0, binary: true },
        },
        {
          // The binary short-circuit must ignore blank-line suppression options.
          label:
            'a binary new side with ignoreBlankLines set still reports binary with zero counts (binary guard unaffected by ignoreBlankLines)',
          old: enc('text\n'),
          next: withNul(),
          options: { ignoreBlankLines: true },
          expected: { added: 0, deleted: 0, binary: true },
        },
        {
          label:
            'a blank-only ours-only hunk with ignoreBlankLines true suppresses the deletion count for that blank-only hunk',
          old: enc('a\n\nb\n'),
          next: enc('a\nb\n'),
          options: { ignoreBlankLines: true },
          expected: { added: 0, deleted: 0, binary: false },
        },
        {
          label:
            'a lineKey mode none and a spaces-only insert with ignoreBlankLines false counts the spaces-only line normally (no suppression when ignoreBlankLines absent)',
          old: enc('a\n'),
          next: enc('a\n   \n'),
          options: { lineKey: { mode: 'none', ignoreCrAtEol: false } as LineKey },
          expected: { added: 1, deleted: 0, binary: false },
        },
        {
          label:
            'an inserted unterminated last line with ignoreBlankLines true counts the non-blank unterminated line (blank check handles missing LF)',
          old: enc('a\n'),
          next: enc('a\nb'),
          options: { ignoreBlankLines: true },
          expected: { added: 1, deleted: 0, binary: false },
        },
        {
          label:
            "numstatBinaryOverride 'binary' over purely textual content short-circuits to binary shape without sniffing content",
          old: enc('a\n'),
          next: enc('b\n'),
          options: { numstatBinaryOverride: 'binary' as const },
          expected: { added: 0, deleted: 0, binary: true },
        },
        {
          label:
            "numstatBinaryOverride 'text' over NUL-bearing content skips the isBinary guard and counts lines even over NUL bytes",
          old: new Uint8Array([0x61, 0x00, 0x0a]), // "a\0\n"
          next: new Uint8Array([0x62, 0x00, 0x0a]), // "b\0\n"
          options: { numstatBinaryOverride: 'text' as const },
          expected: { added: 1, deleted: 1, binary: false },
        },
        {
          label:
            'numstatBinaryOverride absent over NUL-bearing content (regression) uses the isBinary sniff and returns binary shape',
          old: new Uint8Array([0x61, 0x00, 0x0a]),
          next: new Uint8Array([0x62, 0x00, 0x0a]),
          options: {},
          expected: { added: 0, deleted: 0, binary: true },
        },
        {
          label:
            'numstatBinaryOverride absent over purely textual content (regression) uses the isBinary sniff and returns real line counts',
          old: enc('a\n'),
          next: enc('b\n'),
          options: {},
          expected: { added: 1, deleted: 1, binary: false },
        },
        {
          // NUL-bearing sides + blank insert; text override skips binary guard, and the blank
          // line insert is still suppressed by ignoreBlankLines.
          label:
            "numstatBinaryOverride 'text' combined with lineKey and ignoreBlankLines applies normalization options after the isBinary guard is skipped",
          old: new Uint8Array([0x61, 0x00, 0x0a]), // "a\0\n"
          next: new Uint8Array([0x61, 0x00, 0x0a, 0x0a]), // "a\0\n\n" (blank appended)
          options: { numstatBinaryOverride: 'text' as const, ignoreBlankLines: true },
          expected: { added: 0, deleted: 0, binary: false },
        },
      ])('Then $label', ({ old, next, options, expected }) => {
        // Arrange + Act
        const result = computeStatFields(old, next, options);

        // Assert
        expect(result).toEqual(expected);
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

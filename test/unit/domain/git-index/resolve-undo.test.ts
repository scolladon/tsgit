import { describe, expect, it } from 'vitest';
import { parseResolveUndo } from '../../../../src/domain/git-index/resolve-undo.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const sut = parseResolveUndo;

const BASE = '1111111111111111111111111111111111111111' as ObjectId;
const OURS = '2222222222222222222222222222222222222222' as ObjectId;
const THEIRS = '3333333333333333333333333333333333333333' as ObjectId;
const DIGEST = 20;

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** git's `resolve_undo_write` record: path, three octal modes, then one id per non-zero mode. */
const record = (
  path: string,
  modes: readonly [string, string, string],
  ids: ReadonlyArray<ObjectId>,
) => concat(text(`${path}\0${modes.join('\0')}\0`), ...ids.map((id) => hexToBytes(id)));

describe('Given a resolve-undo record with all three stages', () => {
  describe('When it is parsed', () => {
    it('Then every stage carries its mode and id, in stage order', () => {
      // Arrange
      const data = record('f', ['100644', '100755', '120000'], [BASE, OURS, THEIRS]);

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        {
          path: 'f',
          stages: [
            { stage: 1, mode: 0o100644, id: BASE },
            { stage: 2, mode: 0o100755, id: OURS },
            { stage: 3, mode: 0o120000, id: THEIRS },
          ],
        },
      ]);
    });
  });
});

describe('Given two records, the first without a base stage', () => {
  describe('When they are parsed', () => {
    it('Then a zero mode carries no id and the next record follows', () => {
      // Arrange
      const data = concat(
        record('a', ['0', '100644', '100644'], [OURS, THEIRS]),
        record('b', ['100644', '0', '0'], [BASE]),
      );

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        {
          path: 'a',
          stages: [
            { stage: 2, mode: 0o100644, id: OURS },
            { stage: 3, mode: 0o100644, id: THEIRS },
          ],
        },
        { path: 'b', stages: [{ stage: 1, mode: 0o100644, id: BASE }] },
      ]);
    });
  });
});

describe('Given an empty extension', () => {
  describe('When it is parsed', () => {
    it('Then it holds no record', () => {
      // Arrange
      const data = new Uint8Array(0);

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([]);
    });
  });
});

describe.each([
  { label: 'a path with no NUL', data: text('f') },
  { label: 'a path that ends the data', data: text('f\0') },
  {
    label: 'an empty mode',
    data: concat(text('f\0\u0000100644\u0000100644\0'), hexToBytes(OURS), hexToBytes(THEIRS)),
  },
  {
    label: 'a non-octal mode',
    data: concat(
      text('f\u0000100648\u0000100644\u0000100644\0'),
      hexToBytes(BASE),
      hexToBytes(OURS),
      hexToBytes(THEIRS),
    ),
  },
  { label: 'a mode with no NUL', data: text('f\u0000100644') },
  { label: 'a last mode that ends the data', data: text('f\u0000000\u0000000\u0000000\0') },
  {
    label: 'an id cut short',
    data: concat(
      text('f\u0000100644\u0000000\u0000000\0'),
      hexToBytes(BASE).subarray(0, DIGEST - 1),
    ),
  },
])('Given $label', ({ data }) => {
  describe('When it is parsed', () => {
    it('Then the whole extension is refused, as git drops it', () => {
      // Arrange
      const input = data;

      // Act
      const result = sut(input, DIGEST);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a malformed record after a valid one', () => {
  describe('When they are parsed', () => {
    it('Then the valid one is dropped too', () => {
      // Arrange
      const data = concat(record('a', ['100644', '0', '0'], [BASE]), text('b'));

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given mode fields git reads through strtoul', () => {
  describe.each([
    { field: ' 100644', mode: 0o100644 },
    { field: '\t\n+100644', mode: 0o100644 },
    { field: '0100644', mode: 0o100644 },
    { field: '-100644', mode: 2 ** 32 - 0o100644 },
    { field: '-0', mode: 0 },
    { field: '7'.repeat(23), mode: 2 ** 32 - 1 },
    { field: `2${'0'.repeat(21)}`, mode: 2 ** 32 - 1 },
    { field: `-1${'7'.repeat(21)}`, mode: 1 },
  ])('When the stage-1 mode is "$field"', ({ field, mode }) => {
    it('Then it decodes to the unsigned int git stores', () => {
      // Arrange
      const ids = mode === 0 ? [OURS] : [BASE, OURS];
      const data = record('f', [field, '100644', '0'], ids);
      const ours = { stage: 2, mode: 0o100644, id: OURS };

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        { path: 'f', stages: mode === 0 ? [ours] : [{ stage: 1, mode, id: BASE }, ours] },
      ]);
    });
  });

  describe.each([' ', '+', '-', ' +', '+-1', '1 '])('When the stage-1 mode is "%s"', (field) => {
    it('Then the extension is refused as git refuses it', () => {
      // Arrange
      const data = concat(
        record('f', [field, '0', '0'], []),
        record('g', ['100644', '0', '0'], [BASE]),
      );

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

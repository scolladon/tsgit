import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitIdentLine } from '../../../../src/domain/pretty/ident.js';

const NUM_RUNS = 200;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const nameArb = fc.stringMatching(/^[A-Za-z \t]{0,12}$/);
const mailArb = fc.stringMatching(/^[a-z@.]{0,12}$/);
const dateArb = fc.stringMatching(/^[0-9]{1,12}$/);
const tzArb = fc.stringMatching(/^[+-][0-9]{1,4}$/);
const gapArb = fc.stringMatching(/^[ \t]{0,3}$/);

const isWithin = (part: Uint8Array | undefined, line: Uint8Array): boolean =>
  part === undefined ||
  (part.buffer === line.buffer &&
    part.byteOffset >= line.byteOffset &&
    part.byteOffset + part.length <= line.byteOffset + line.length);

describe('Given arbitrary bytes, When splitting an ident line', () => {
  it('Then it never throws and every part is a slice of the input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (line) => {
        // Arrange
        const sut = splitIdentLine;

        // Act
        const result = sut(line);

        // Assert
        expect(Object.values(result).every((part) => isWithin(part, line))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Given a well-formed ident built from generated fields, When splitting it', () => {
  it('Then the fields come back, with the name right-trimmed', () => {
    fc.assert(
      fc.property(
        nameArb,
        mailArb,
        gapArb,
        dateArb,
        gapArb,
        tzArb,
        (name, mail, g1, date, g2, tz) => {
          // Arrange
          const sut = splitIdentLine;
          const line = encode(`${name} <${mail}>${g1}${date}${g2}${tz}`);

          // Act
          const result = sut(line);

          // Assert
          expect({
            name: decode(result.name),
            mail: decode(result.mail),
            date: decode(result.date),
            tz: decode(result.tz),
          }).toEqual({ name: name.trimEnd(), mail, date, tz });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

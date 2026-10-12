import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { identToGit, identToWorkingTree } from '../../../../src/domain/eol/ident.js';
import { createIdentTransform } from '../../../../src/domain/eol/ident-transform.js';

const OID = '08a4620a27060eb3dbee93734f82d9146bfd1b4d';
const ROUND_TRIP_RUNS = 200;
const CHUNKING_RUNS = 100;

const encode = (value: string): Uint8Array =>
  Uint8Array.from([...value].map((c) => c.charCodeAt(0)));

const identArbitrary = fc
  .array(fc.constantFrom('$', 'I', 'd', ':', ' ', '\t', '\n', 'a', 'Id', '$Id$', '$Id:'), {
    maxLength: 40,
  })
  .map((parts) => encode(parts.join('')));

const streamed = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const sut = createIdentTransform(OID);
  const parts = [...chunks.flatMap((chunk) => sut.push(chunk)), ...sut.flush()];
  return Uint8Array.from(parts.flatMap((part) => [...part]));
};

const splitAt = (bytes: Uint8Array, cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
  const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
  return [0, ...points].map((start, index, all) => bytes.subarray(start, all[index + 1]));
};

describe('ident properties', () => {
  describe('Given any content', () => {
    describe('When expanded then collapsed', () => {
      it('Then it equals the collapse of the original', () => {
        fc.assert(
          fc.property(identArbitrary, (bytes) => {
            // Arrange
            const expected = identToGit(bytes);

            // Act
            const result = identToGit(identToWorkingTree(bytes, OID));

            // Assert
            expect(result).toEqual(expected);
          }),
          { numRuns: ROUND_TRIP_RUNS },
        );
      });
    });
  });

  describe('Given any content and any chunking', () => {
    describe('When streamed', () => {
      it('Then the output equals the unchunked output', () => {
        fc.assert(
          fc.property(identArbitrary, fc.array(fc.nat(), { maxLength: 6 }), (bytes, cuts) => {
            // Arrange
            const expected = streamed([bytes]);

            // Act
            const result = streamed(splitAt(bytes, cuts));

            // Assert
            expect(result).toEqual(expected);
          }),
          { numRuns: CHUNKING_RUNS },
        );
      });
    });
  });
});

/**
 * Differential property: ObjectId.from must agree, on every input, with the
 * pair of regex literals it validated against before this file's sibling
 * rewrite. Lens 3 (total function over an algebraic grammar) — the oracle
 * below is deliberately NOT imported from production (object-id.ts deletes
 * these constants as part of the rewrite this file pins against), so it
 * stays an independent oracle rather than a copy of the production loop.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/objects/error.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  arbCodeUnitString,
  arbObjectId,
  arbObjectIdWithOneCharReplaced,
  arbObjectIdWithPadding,
} from './arbitraries.js';

const NUM_RUNS = 200;

const SHA1_HEX_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function oracleAccepts(hex: string): boolean {
  return SHA1_HEX_RE.test(hex) || SHA256_HEX_RE.test(hex);
}

function assertAgreesWithOracle(hex: string): void {
  if (oracleAccepts(hex)) {
    expect(ObjectId.from(hex)).toBe(hex);
    return;
  }
  try {
    ObjectId.from(hex);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(TsgitError);
    expect((error as TsgitError).data).toEqual({ code: 'INVALID_OBJECT_ID', value: hex });
  }
}

describe('object-id validator properties', () => {
  describe('Given an arbitrary valid 40- or 64-char hex ObjectId', () => {
    describe('When passed to ObjectId.from', () => {
      it('Then it agrees with the pair of original regex literals', () => {
        // Arrange + Act + Assert
        fc.assert(fc.property(fc.oneof(arbObjectId(40), arbObjectId(64)), assertAgreesWithOracle), {
          numRuns: NUM_RUNS,
        });
      });
    });
  });

  describe('Given a valid ObjectId hex string with one character replaced by an arbitrary code point', () => {
    describe('When passed to ObjectId.from', () => {
      it('Then it agrees with the pair of original regex literals', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.oneof(arbObjectIdWithOneCharReplaced(40), arbObjectIdWithOneCharReplaced(64)),
            assertAgreesWithOracle,
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given a valid ObjectId hex string with arbitrary text prepended or appended', () => {
    describe('When passed to ObjectId.from', () => {
      it('Then it agrees with the pair of original regex literals', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.oneof(arbObjectIdWithPadding(40), arbObjectIdWithPadding(64)),
            assertAgreesWithOracle,
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary unconstrained string', () => {
    describe('When passed to ObjectId.from', () => {
      it('Then it agrees with the pair of original regex literals', () => {
        // Arrange + Act + Assert
        fc.assert(fc.property(fc.string(), assertAgreesWithOracle), { numRuns: NUM_RUNS });
      });
    });
  });

  describe('Given an arbitrary code-unit string that may contain lone surrogates', () => {
    describe('When passed to ObjectId.from', () => {
      it('Then it agrees with the pair of original regex literals', () => {
        // Arrange + Act + Assert
        fc.assert(fc.property(arbCodeUnitString(), assertAgreesWithOracle), {
          numRuns: NUM_RUNS,
        });
      });
    });
  });
});

/**
 * Total-function property (CLAUDE.md lens 3): `isOid` is a total function
 * over the ASCII-hex safe subset — for ANY string of ANY length it must
 * agree with a plain length comparison against the config's declared width,
 * and it must never throw.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bytesToHex } from '../../../../src/domain/objects/encoding.js';
import { isOid, leadingOid } from '../../../../src/domain/objects/oid-pattern.js';
import { arbAsciiNoNulString, arbHashConfig, arbHexString, arbRawBytes } from './arbitraries.js';

const NUM_RUNS = 100;

describe('isOid properties', () => {
  describe('Given an arbitrary lower-case hex string of arbitrary length and a hash config', () => {
    describe('When isOid checks it', () => {
      it('Then it agrees with a plain length comparison to hexLength', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbHexString(), arbHashConfig(), (value, config) => {
            expect(isOid(value, config)).toBe(value.length === config.hexLength);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given arbitrary bytes hex-encoded and a hash config', () => {
    describe('When isOid checks the hex encoding', () => {
      it('Then it agrees with a byte-length comparison to digestLength', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRawBytes(), arbHashConfig(), (bytes, config) => {
            expect(isOid(bytesToHex(bytes), config)).toBe(bytes.length === config.digestLength);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary printable-ASCII, NUL-free string and a hash config', () => {
    describe('When isOid checks it', () => {
      it('Then it never throws', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAsciiNoNulString(), arbHashConfig(), (value, config) => {
            expect(() => isOid(value, config)).not.toThrow();
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

describe('leadingOid properties', () => {
  describe('Given an arbitrary oid and an arbitrary tail', () => {
    describe('When the leading oid of their concatenation is read', () => {
      it('Then it is the oid itself, whatever the tail', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbHashConfig(),
            arbAsciiNoNulString(),
            fc.boolean(),
            (config, tail, upper) => {
              const oid = 'a1'.repeat(config.hexLength / 2);
              const written = upper ? oid.toUpperCase() : oid;
              expect(leadingOid(`${written}${tail}`, config)).toBe(oid);
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary lower-case hex string and a hash config', () => {
    describe('When the leading oid is read', () => {
      it('Then it is defined exactly when the string reaches the width, and agrees with isOid on it', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbHexString(), arbHashConfig(), (value, config) => {
            const result = leadingOid(value, config);
            expect(result !== undefined).toBe(value.length >= config.hexLength);
            if (result !== undefined) expect(isOid(result, config)).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

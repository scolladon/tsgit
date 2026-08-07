import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { parsePackHeader, serializePackHeader } from '../../../../src/domain/storage/pack-entry.js';
import { arbSupportedPackVersion, arbUnsupportedPackVersion } from './arbitraries.js';

describe('pack-entry properties', () => {
  describe('Given an arbitrary supported pack header version and object count', () => {
    describe('When serializing then parsing', () => {
      it('Then the header round-trips verbatim', () => {
        // Arrange + Act + Assert
        const sut = parsePackHeader;

        fc.assert(
          fc.property(
            arbSupportedPackVersion(),
            fc.integer({ min: 0, max: 0xffffffff }),
            (version, objectCount) => {
              const result = sut(serializePackHeader(version, objectCount));

              expect(result).toEqual({ version, objectCount });
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary unsupported pack header version', () => {
    describe('When parsing', () => {
      it('Then it refuses and names the observed version', () => {
        // Arrange + Act + Assert
        const sut = parsePackHeader;

        fc.assert(
          fc.property(arbUnsupportedPackVersion(), fc.nat(), (version, objectCount) => {
            const bytes = serializePackHeader(version, objectCount);

            let caught: unknown;
            try {
              sut(bytes);
            } catch (e) {
              caught = e;
            }

            expect((caught as TsgitError).data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_HEADER',
                reason: expect.stringContaining(String(version)),
              }),
            );
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});

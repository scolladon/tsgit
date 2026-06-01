import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAuthorScript, serializeAuthorScript } from '../../../../src/domain/rebase/index.js';
import { arbAuthorIdentity } from './arbitraries.js';

describe('rebase author-script properties', () => {
  describe('Given an arbitrary author identity, When serialized then parsed', () => {
    it('Then the round-trip preserves the identity (sq-quoting is reversible)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbAuthorIdentity(), (identity) => {
          expect(parseAuthorScript(serializeAuthorScript(identity))).toEqual(identity);
        }),
        { numRuns: 200 },
      );
    });
  });
});

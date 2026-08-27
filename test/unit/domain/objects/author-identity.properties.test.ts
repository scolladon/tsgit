import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  parseIdentity,
  serializeIdentity,
} from '../../../../src/domain/objects/author-identity.js';
import { arbAuthorIdentity } from './arbitraries.js';

describe('author-identity properties', () => {
  describe('Given an arbitrary identity', () => {
    describe('When serialized then parsed', () => {
      it('Then serializeIdentity ∘ parseIdentity is the identity', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAuthorIdentity(), (identity) => {
            const line = serializeIdentity(identity);
            const result = parseIdentity(line);
            expect(result).toEqual(identity);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});

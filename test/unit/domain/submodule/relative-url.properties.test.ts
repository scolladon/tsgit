import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import { relativeUrl } from '../../../../src/domain/submodule/relative-url.js';
import { arbNonRelativeBase, arbRelativeUrl, arbVerbatimUrl } from './arbitraries.js';

describe('relativeUrl properties', () => {
  describe('Given an arbitrary non-relative base and a relative url', () => {
    describe('When resolving', () => {
      it('Then it returns a non-empty string, or refuses only via RELATIVE_URL_UNRESOLVABLE', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbNonRelativeBase(), arbRelativeUrl(), (base, url) => {
            try {
              const result = relativeUrl(base, url);
              return typeof result === 'string' && result.length > 0;
            } catch (err) {
              // git's relative_url `die`s when an over-popped base is exhausted;
              // the only permitted failure is that specific refusal.
              return err instanceof TsgitError && err.data.code === 'RELATIVE_URL_UNRESOLVABLE';
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary base and an absolute/remote url', () => {
    describe('When resolving', () => {
      it('Then the url is returned verbatim', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbNonRelativeBase(), arbVerbatimUrl(), (base, url) => {
            expect(relativeUrl(base, url)).toBe(url);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});

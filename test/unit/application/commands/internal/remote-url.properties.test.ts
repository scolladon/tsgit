import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  formatRemoteUrl,
  parseRemoteUrl,
} from '../../../../../src/application/commands/internal/remote-url.js';
import { remoteUrlArb } from './arbitraries.js';

describe('parseRemoteUrl / formatRemoteUrl properties', () => {
  describe('Given an arbitrary http(s), ssh://, or scp-like remote URL', () => {
    describe('When parsed, formatted, and re-parsed', () => {
      it('Then the canonicalising round-trip is stable', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(remoteUrlArb(), (raw) => {
            const once = parseRemoteUrl(raw);
            const twice = parseRemoteUrl(formatRemoteUrl(once));
            expect(twice).toEqual(once);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});

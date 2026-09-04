import { describe, expect, it } from 'vitest';

import {
  DELTA_CHAIN_FIXTURE,
  LARGE_FIXTURE,
  MANY_PACK_FIXTURE,
  MEDIUM_FIXTURE,
} from '../../../test/bench/support/fixture-generator.ts';
import { selectFixtureAction } from '../../gen-bench-fixture.ts';

describe('Given an argv token naming one of the four fixture labels', () => {
  describe('When selectFixtureAction routes it', () => {
    it.each([
      ['medium', MEDIUM_FIXTURE],
      ['large', LARGE_FIXTURE],
      ['delta-chain', DELTA_CHAIN_FIXTURE],
      ['many-pack', MANY_PACK_FIXTURE],
    ] as const)('Then %s routes to a generate action for that spec', (label, spec) => {
      // Arrange
      const sut = selectFixtureAction;

      // Act
      const result = sut(label);

      // Assert
      expect(result).toEqual({ kind: 'generate', spec });
    });
  });
});

describe('Given a prune flag, an unknown token, or no token at all', () => {
  describe('When selectFixtureAction routes it', () => {
    it.each([
      ['--prune', 'prune'],
      ['bogus-token', 'usage'],
      [undefined, 'usage'],
    ] as const)('Then %s routes to kind %s', (label, kind) => {
      // Arrange
      const sut = selectFixtureAction;

      // Act
      const result = sut(label);

      // Assert
      expect(result.kind).toBe(kind);
    });
  });
});

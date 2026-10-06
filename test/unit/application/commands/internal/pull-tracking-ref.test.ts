import { describe, expect, it } from 'vitest';
import {
  refspecTrackingRef,
  upstreamTrackingRef,
} from '../../../../../src/application/commands/internal/pull-tracking-ref.js';

describe('refspecTrackingRef', () => {
  describe.each([
    ['a bare branch name', 'origin', 'main', 'refs/remotes/origin/main'],
    [
      'a forced full branch refspec',
      'origin',
      '+refs/heads/main:refs/x/main',
      'refs/remotes/origin/main',
    ],
    ['a heads/ shorthand', 'origin', 'heads/topic', 'refs/remotes/origin/topic'],
    ['an empty source', 'origin', ':dst', 'refs/remotes/origin/HEAD'],
    ['a branch of the local repository', '.', 'refs/heads/topic', 'refs/heads/topic'],
    ['a tag ref', 'origin', 'refs/tags/v1', undefined],
    ['a tags/ shorthand', 'origin', 'tags/v1', undefined],
    ['a remotes/ shorthand', 'origin', 'remotes/o/x', undefined],
  ])('Given %s, When its tracking ref is derived', (_, remote, refspec, expected) => {
    it('Then it is the default remote-tracking mapping of the source branch', () => {
      // Arrange
      const sut = refspecTrackingRef;

      // Act
      const result = sut(remote, refspec);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('upstreamTrackingRef', () => {
  describe.each([
    ['the local remote', '.', [], 'refs/heads/main'],
    [
      'a remote mapping the branch',
      'origin',
      ['+refs/heads/*:refs/remotes/o/*'],
      'refs/remotes/o/main',
    ],
    ['a remote with no fetch refspec', 'origin', undefined, undefined],
  ])('Given %s, When the upstream tracking ref is derived', (_, remote, specs, expected) => {
    it('Then it is where the fetch stores the merged branch', () => {
      // Arrange
      const sut = upstreamTrackingRef;

      // Act
      const result = sut(remote, 'refs/heads/main', specs);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

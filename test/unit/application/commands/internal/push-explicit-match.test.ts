import { describe, expect, it } from 'vitest';
import {
  type LocalPushRefs,
  matchExplicitPush,
} from '../../../../../src/application/commands/internal/push-explicit-match.js';
import { parseRefspec } from '../../../../../src/application/commands/internal/refspec.js';

const LOCAL: LocalPushRefs = {
  names: [
    'refs/heads/main',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
    'refs/tags/lt',
  ],
  symrefs: new Map([
    ['HEAD', 'refs/heads/main'],
    ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'],
  ]),
};
const REMOTE = ['refs/heads/main', 'refs/tags/t0', 'refs/heads/both', 'refs/tags/both'];

describe('matchExplicitPush', () => {
  describe.each([
    { raw: 'main:t0', expected: { src: 'refs/heads/main', dst: 'refs/tags/t0' } },
    { raw: 'lt:newname', expected: { src: 'refs/tags/lt', dst: 'refs/tags/newname' } },
    { raw: 'lt', expected: { src: 'refs/tags/lt', dst: 'refs/tags/lt' } },
    { raw: 'main:fresh', expected: { src: 'refs/heads/main', dst: 'refs/heads/fresh' } },
    { raw: 'main:foo/bar', expected: { src: 'refs/heads/main', dst: 'refs/heads/foo/bar' } },
    { raw: 'main:refs/custom/x', expected: { src: 'refs/heads/main', dst: 'refs/custom/x' } },
    { raw: 'HEAD:fresh', expected: { src: 'HEAD', dst: 'refs/heads/fresh' } },
    { raw: 'HEAD', expected: { src: 'HEAD', dst: 'refs/heads/main' } },
    {
      raw: '+origin/main:refs/heads/x',
      expected: { src: 'refs/remotes/origin/main', dst: 'refs/heads/x' },
    },
  ])('Given the refspec $raw', ({ raw, expected }) => {
    describe('When it is matched against the local and remote refs', () => {
      it("Then its sides resolve as git's match_explicit resolves them", () => {
        // Arrange
        const sut = matchExplicitPush;

        // Act
        const result = sut(raw, parseRefspec(raw), LOCAL, REMOTE);

        // Assert
        expect(result).toEqual({ kind: 'matched', ...expected });
      });
    });
  });

  describe.each([
    { raw: 'absent:fresh', expected: { src: 'refs/heads/absent', dst: 'refs/heads/fresh' } },
    {
      raw: 'origin/main:fresh',
      expected: { src: 'refs/remotes/origin/main', dst: 'refs/heads/fresh' },
    },
    { raw: 'origin/HEAD', expected: { src: 'refs/remotes/origin/HEAD', dst: 'origin/HEAD' } },
  ])('Given the refspec $raw, whose side git cannot resolve', ({ raw, expected }) => {
    describe('When it is matched against the local and remote refs', () => {
      it('Then the side git cannot resolve keeps its parsed spelling', () => {
        // Arrange
        const sut = matchExplicitPush;

        // Act
        const result = sut(raw, parseRefspec(raw), LOCAL, REMOTE);

        // Assert
        expect(result).toEqual({ kind: 'matched', ...expected });
      });
    });
  });

  describe('Given a destination naming both a remote branch and a remote tag', () => {
    describe('When it is matched against the remote refs', () => {
      it('Then it is unmatched as ambiguous', () => {
        // Arrange
        const sut = matchExplicitPush;

        // Act
        const result = sut('main:both', parseRefspec('main:both'), LOCAL, REMOTE);

        // Assert
        expect(result).toEqual({ kind: 'unmatched', dst: 'both', reason: 'ambiguous' });
      });
    });
  });
});

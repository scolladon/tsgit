import { describe, expect, it } from 'vitest';
import { matchDeleteTarget } from '../../../../../src/application/commands/internal/push-delete-target.js';

describe('matchDeleteTarget', () => {
  describe.each([
    {
      rule: 'a branch outranks a weak remote-tracking match',
      dst: 'x',
      remote: ['refs/remotes/x', 'refs/heads/x'],
      expected: 'refs/heads/x',
    },
    {
      rule: 'a name spelled from below refs/ outranks a weak match',
      dst: 'x',
      remote: ['refs/x', 'refs/remotes/x'],
      expected: 'refs/x',
    },
    {
      rule: 'a name spelled in full outranks a weak match',
      dst: 'refs/remotes/x',
      remote: ['refs/remotes/x', 'refs/remotes/refs/remotes/x'],
      expected: 'refs/remotes/x',
    },
  ])('Given a remote where $rule', ({ dst, remote, expected }) => {
    describe('When the delete target is matched', () => {
      it('Then only the strong match is the target', () => {
        // Arrange
        const sut = matchDeleteTarget;

        // Act
        const result = sut(dst, remote);

        // Assert
        expect(result).toEqual({ kind: 'matched', name: expected });
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  indexMessage,
  onMessage,
  stashBranchLabel,
  untrackedMessage,
  wipMessage,
} from '../../../../../src/application/commands/internal/stash-message.js';

describe('stash-message builders', () => {
  describe('Given a branch label, abbrev, and subject', () => {
    describe('When wipMessage is built', () => {
      it('Then it reads "WIP on <branch>: <abbrev> <subject>"', () => {
        // Arrange + Act
        const sut = wipMessage('main', 'abc1234', 'initial commit');

        // Assert
        expect(sut).toBe('WIP on main: abc1234 initial commit');
      });
    });

    describe('When indexMessage is built', () => {
      it('Then it reads "index on <branch>: <abbrev> <subject>"', () => {
        // Arrange + Act
        const sut = indexMessage('main', 'abc1234', 'initial commit');

        // Assert
        expect(sut).toBe('index on main: abc1234 initial commit');
      });
    });

    describe('When untrackedMessage is built', () => {
      it('Then it reads "untracked files on <branch>: <abbrev> <subject>"', () => {
        // Arrange + Act
        const sut = untrackedMessage('main', 'abc1234', 'initial commit');

        // Assert
        expect(sut).toBe('untracked files on main: abc1234 initial commit');
      });
    });
  });

  describe('Given a custom message', () => {
    describe('When onMessage is built', () => {
      it('Then it reads "On <branch>: <message>"', () => {
        // Arrange + Act
        const sut = onMessage('main', 'wip before refactor');

        // Assert
        expect(sut).toBe('On main: wip before refactor');
      });
    });
  });

  describe('Given a HEAD ref state', () => {
    describe('When the stash branch label is derived', () => {
      it.each([
        {
          headRef: 'refs/heads/feature',
          expected: 'feature',
          label: 'a symbolic HEAD on refs/heads/feature uses the short branch name',
        },
        {
          headRef: undefined,
          expected: '(no branch)',
          label: 'a detached HEAD (no branch ref) uses the (no branch) literal',
        },
        {
          headRef: 'refs/something/weird',
          expected: '(no branch)',
          label: 'a symbolic HEAD on a non-heads ref uses the (no branch) literal',
        },
      ])('Then $label', ({ headRef, expected }) => {
        // Arrange + Act
        const sut = stashBranchLabel(headRef);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

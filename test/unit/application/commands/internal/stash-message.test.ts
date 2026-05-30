import { describe, expect, it } from 'vitest';
import {
  indexMessage,
  onMessage,
  stashBranchLabel,
  subjectOf,
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

  describe('Given a symbolic HEAD on refs/heads/feature', () => {
    describe('When the stash branch label is derived', () => {
      it('Then the short branch name is used', () => {
        // Arrange + Act
        const sut = stashBranchLabel('refs/heads/feature');

        // Assert
        expect(sut).toBe('feature');
      });
    });
  });

  describe('Given a detached HEAD (no branch ref)', () => {
    describe('When the stash branch label is derived', () => {
      it('Then the (no branch) literal is used', () => {
        // Arrange + Act
        const sut = stashBranchLabel(undefined);

        // Assert
        expect(sut).toBe('(no branch)');
      });
    });
  });

  describe('Given a symbolic HEAD on a non-heads ref', () => {
    describe('When the stash branch label is derived', () => {
      it('Then the (no branch) literal is used', () => {
        // Arrange + Act
        const sut = stashBranchLabel('refs/something/weird');

        // Assert
        expect(sut).toBe('(no branch)');
      });
    });
  });

  describe('Given a multi-line commit message', () => {
    describe('When the subject is extracted', () => {
      it('Then only the first line is returned', () => {
        // Arrange + Act
        const sut = subjectOf('first line\n\nbody paragraph\nmore body');

        // Assert
        expect(sut).toBe('first line');
      });
    });
  });

  describe('Given a single-line commit message', () => {
    describe('When the subject is extracted', () => {
      it('Then the whole message is returned verbatim', () => {
        // Arrange + Act
        const sut = subjectOf('just one line');

        // Assert
        expect(sut).toBe('just one line');
      });
    });
  });

  describe('Given an empty commit message', () => {
    describe('When the subject is extracted', () => {
      it('Then the empty string is returned', () => {
        // Arrange + Act
        const sut = subjectOf('');

        // Assert
        expect(sut).toBe('');
      });
    });
  });
});

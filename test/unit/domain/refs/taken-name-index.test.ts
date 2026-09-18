import { describe, expect, it } from 'vitest';

import type { RefName } from '../../../../src/domain/objects/index.js';
import { takenNameIndex } from '../../../../src/domain/refs/taken-name-index.js';

describe('takenNameIndex', () => {
  describe('Given no name taken yet, When any name is asked about', () => {
    it('Then it holds nothing under it', () => {
      // Arrange
      const sut = takenNameIndex;

      // Act
      const result = sut().holdsUnder('refs/heads/main' as RefName);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given a taken name nested two levels under the queried one', () => {
    describe('When the queried name is asked about', () => {
      it('Then it holds a name under it', () => {
        // Arrange
        const sut = takenNameIndex;

        // Act
        const index = sut();
        index.take('refs/heads/topic/sub/leaf' as RefName);
        const result = index.holdsUnder('refs/heads/topic' as RefName);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a taken name, When that very name is asked about', () => {
    it('Then it holds nothing under it — a name does not sit under itself', () => {
      // Arrange
      const sut = takenNameIndex;

      // Act
      const index = sut();
      index.take('refs/heads/main' as RefName);
      const result = index.holdsUnder('refs/heads/main' as RefName);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given a taken name sharing only a textual prefix with the queried one', () => {
    describe('When the queried name is asked about', () => {
      it('Then it holds nothing under it — the split is at a slash, not a character', () => {
        // Arrange
        const sut = takenNameIndex;

        // Act
        const index = sut();
        index.take('refs/heads/mainline' as RefName);
        const result = index.holdsUnder('refs/heads/main' as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a taken name ABOVE the queried one', () => {
    describe('When the queried name is asked about', () => {
      it('Then it holds nothing under it — the index answers one direction only', () => {
        // Arrange
        const sut = takenNameIndex;

        // Act
        const index = sut();
        index.take('refs/heads' as RefName);
        const result = index.holdsUnder('refs/heads/main' as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given several taken names, When a prefix only the last one shares is asked about', () => {
    it('Then it holds a name under it', () => {
      // Arrange
      const sut = takenNameIndex;
      const taken = ['refs/heads/a', 'refs/tags/v1', 'refs/remotes/origin/main'] as RefName[];

      // Act
      const index = sut();
      for (const name of taken) index.take(name);
      const result = index.holdsUnder('refs/remotes/origin' as RefName);

      // Assert
      expect(result).toBe(true);
    });
  });
});

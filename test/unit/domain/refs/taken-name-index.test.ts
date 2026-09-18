import { describe, expect, it } from 'vitest';

import type { RefName } from '../../../../src/domain/objects/index.js';
import { takenNameIndex } from '../../../../src/domain/refs/taken-name-index.js';

describe('takenNameIndex', () => {
  describe('Given nothing taken yet, When asked about any name', () => {
    it('Then it holds nothing under it', () => {
      // Arrange
      const sut = takenNameIndex();

      // Act
      const result = sut.holdsUnder('refs/heads/main' as RefName);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given a taken name nested two levels under the queried one', () => {
    describe('When asked about the queried name', () => {
      it('Then it holds a name under it', () => {
        // Arrange
        const sut = takenNameIndex();
        sut.take('refs/heads/topic/sub/leaf' as RefName);

        // Act
        const result = sut.holdsUnder('refs/heads/topic' as RefName);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a taken name, When asked about that very name', () => {
    it('Then it holds nothing under it — a name does not sit under itself', () => {
      // Arrange
      const sut = takenNameIndex();
      sut.take('refs/heads/main' as RefName);

      // Act
      const result = sut.holdsUnder('refs/heads/main' as RefName);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given a taken name sharing only a textual prefix with the queried one', () => {
    describe('When asked about the queried name', () => {
      it('Then it holds nothing under it — the split is at a slash, not a character', () => {
        // Arrange
        const sut = takenNameIndex();
        sut.take('refs/heads/mainline' as RefName);

        // Act
        const result = sut.holdsUnder('refs/heads/main' as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a taken name ABOVE the queried one', () => {
    describe('When asked about the queried name', () => {
      it('Then it holds nothing under it — the index answers one direction only', () => {
        // Arrange
        const sut = takenNameIndex();
        sut.take('refs/heads' as RefName);

        // Act
        const result = sut.holdsUnder('refs/heads/main' as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given several taken names, When asked about a prefix only the last one shares', () => {
    it('Then it holds a name under it', () => {
      // Arrange
      const sut = takenNameIndex();
      sut.take('refs/heads/a' as RefName);
      sut.take('refs/tags/v1' as RefName);
      sut.take('refs/remotes/origin/main' as RefName);

      // Act
      const result = sut.holdsUnder('refs/remotes/origin' as RefName);

      // Assert
      expect(result).toBe(true);
    });
  });
});

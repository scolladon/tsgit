import { describe, expect, it } from 'vitest';
import { describeName } from '../../../../src/domain/describe/ref-name.js';
import { RefName } from '../../../../src/domain/objects/object-id.js';

describe('describeName', () => {
  describe('Given a tag ref and all=false', () => {
    describe('When projecting the short name', () => {
      it('Then refs/tags/ is stripped', () => {
        // Arrange
        const ref = RefName.from('refs/tags/v2.0');

        // Act
        const sut = describeName(ref, false);

        // Assert
        expect(sut).toBe('v2.0');
      });
    });
  });

  describe('Given a branch ref and all=true', () => {
    describe('When projecting the short name', () => {
      it('Then only refs/ is stripped', () => {
        // Arrange
        const ref = RefName.from('refs/heads/main');

        // Act
        const sut = describeName(ref, true);

        // Assert
        expect(sut).toBe('heads/main');
      });
    });
  });

  describe('Given a remote-tracking ref and all=true', () => {
    describe('When projecting the short name', () => {
      it('Then it reads remotes/<remote>/<branch>', () => {
        // Arrange
        const ref = RefName.from('refs/remotes/origin/main');

        // Act
        const sut = describeName(ref, true);

        // Assert
        expect(sut).toBe('remotes/origin/main');
      });
    });
  });

  describe('Given a tag ref and all=true', () => {
    describe('When projecting the short name', () => {
      it('Then it reads tags/<name> (only refs/ stripped)', () => {
        // Arrange
        const ref = RefName.from('refs/tags/v2.0');

        // Act
        const sut = describeName(ref, true);

        // Assert
        expect(sut).toBe('tags/v2.0');
      });
    });
  });

  describe('Given a ref without a refs/ prefix and all=true', () => {
    describe('When projecting the short name', () => {
      it('Then it is returned verbatim', () => {
        // Arrange
        const ref = RefName.from('HEAD');

        // Act
        const sut = describeName(ref, true);

        // Assert
        expect(sut).toBe('HEAD');
      });
    });
  });

  describe('Given a ref outside refs/tags/ and all=false', () => {
    describe('When projecting the short name', () => {
      it('Then it is returned verbatim (no tags prefix to strip)', () => {
        // Arrange
        const ref = RefName.from('refs/heads/main');

        // Act
        const sut = describeName(ref, false);

        // Assert
        expect(sut).toBe('refs/heads/main');
      });
    });
  });
});

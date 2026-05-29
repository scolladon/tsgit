import { describe, expect, it } from 'vitest';
import { refCandidates } from '../../../../src/domain/refs/ref-candidates.js';

describe('refCandidates', () => {
  describe('Given a bare base name', () => {
    describe('When building the candidate ladder', () => {
      it('Then yields verbatim, heads, tags, remotes in order', () => {
        // Arrange
        const base = 'main';

        // Act
        const sut = refCandidates(base);

        // Assert
        expect(sut).toEqual(['main', 'refs/heads/main', 'refs/tags/main', 'refs/remotes/main']);
      });
    });
  });

  describe('Given a slash-qualified remote base', () => {
    describe('When building the candidate ladder', () => {
      it('Then the remotes candidate is refs/remotes/<base>', () => {
        // Arrange
        const base = 'origin/main';

        // Act
        const sut = refCandidates(base);

        // Assert
        expect(sut).toContain('refs/remotes/origin/main');
      });
    });
  });
});

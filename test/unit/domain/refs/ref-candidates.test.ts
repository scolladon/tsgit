import { describe, expect, it } from 'vitest';
import { refCandidates } from '../../../../src/domain/refs/ref-candidates.js';

describe('refCandidates', () => {
  describe('Given a bare base name', () => {
    describe('When building the candidate ladder', () => {
      it('Then yields the gitrevisions 6-rule order: verbatim, refs/, tags, heads, remotes, remotes/HEAD', () => {
        // Arrange
        const base = 'main';

        // Act
        const result = refCandidates(base);

        // Assert
        expect(result).toEqual([
          'main',
          'refs/main',
          'refs/tags/main',
          'refs/heads/main',
          'refs/remotes/main',
          'refs/remotes/main/HEAD',
        ]);
      });
    });
  });

  describe('Given a top-level ref name like stash', () => {
    describe('When building the candidate ladder', () => {
      it('Then refs/<base> is offered so refs/stash resolves (gitrevisions rule 2)', () => {
        // Arrange
        const base = 'stash';

        // Act
        const result = refCandidates(base);

        // Assert
        expect(result).toContain('refs/stash');
      });
    });
  });

  describe('Given a name that is both a tag and a branch', () => {
    describe('When building the candidate ladder', () => {
      it('Then the tag candidate precedes the branch candidate (git resolves the tag first)', () => {
        // Arrange
        const base = 'v1';

        // Act
        const result = refCandidates(base);

        // Assert
        const tagPos = result.findIndex((c) => c === 'refs/tags/v1');
        const headPos = result.findIndex((c) => c === 'refs/heads/v1');
        expect(tagPos).toBeLessThan(headPos);
      });
    });
  });

  describe('Given a slash-qualified remote base', () => {
    describe('When building the candidate ladder', () => {
      it('Then the remotes candidate is refs/remotes/<base>', () => {
        // Arrange
        const base = 'origin/main';

        // Act
        const result = refCandidates(base);

        // Assert
        expect(result).toContain('refs/remotes/origin/main');
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyRefspec,
  MAX_REFSPECS_PER_FETCH,
  parseRefspec,
} from '../../../../../src/application/commands/internal/ref-spec.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { RefName } from '../../../../../src/domain/objects/object-id.js';

describe('internal/ref-spec', () => {
  describe('parseRefspec', () => {
    it("Given 'refs/heads/main:refs/remotes/origin/main', When parseRefspec, Then non-force, src/dst set, no wildcard", () => {
      // Act
      const sut = parseRefspec('refs/heads/main:refs/remotes/origin/main');

      // Assert
      expect(sut).toEqual({
        force: false,
        src: 'refs/heads/main',
        dst: 'refs/remotes/origin/main',
        hasWildcard: false,
      });
    });

    it("Given '+refs/heads/main:refs/remotes/origin/main', When parseRefspec, Then force is true and '+' is stripped from src", () => {
      // Act
      const sut = parseRefspec('+refs/heads/main:refs/remotes/origin/main');

      // Assert
      expect(sut.force).toBe(true);
      expect(sut.src).toBe('refs/heads/main');
    });

    it('Given a non-force refspec with no NUL byte, When parseRefspec, Then does not throw the NUL-byte error', () => {
      // Act
      const sut = parseRefspec('refs/heads/main:refs/remotes/origin/main');

      // Assert
      expect(sut.force).toBe(false);
    });

    it("Given 'refs/heads/*:refs/remotes/origin/*', When parseRefspec, Then hasWildcard is true", () => {
      // Act
      const sut = parseRefspec('refs/heads/*:refs/remotes/origin/*');

      // Assert
      expect(sut.hasWildcard).toBe(true);
    });

    it('Given mismatched wildcards (src wild, dst not), When parseRefspec, Then throws REFSPEC_INVALID with wildcard-mismatch reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/*:refs/remotes/origin/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/heads/*:refs/remotes/origin/main',
        reason: 'wildcard mismatch between src and dst',
      });
    });

    it('Given a refspec with no colon, When parseRefspec, Then throws REFSPEC_INVALID with missing-separator reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/heads/main',
        reason: 'missing ":" separator',
      });
    });

    it('Given a refspec with NUL byte, When parseRefspec, Then throws REFSPEC_INVALID with NUL-byte reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/main:refs/remotes\0origin/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/heads/main:refs/remotes\0origin/main',
        reason: 'contains NUL byte',
      });
    });

    it('Given an empty src, When parseRefspec, Then throws REFSPEC_INVALID with non-empty reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec(':refs/heads/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: ':refs/heads/main',
        reason: 'src and dst must be non-empty',
      });
    });

    it('Given an empty dst, When parseRefspec, Then throws REFSPEC_INVALID with non-empty reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/main:');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/heads/main:',
        reason: 'src and dst must be non-empty',
      });
    });

    it('Given a refspec whose src has two "*", When parseRefspec, Then throws REFSPEC_INVALID with at-most-one-star reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/*/heads/*:refs/remotes/origin/*');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/*/heads/*:refs/remotes/origin/*',
        reason: 'each side may contain at most one "*"',
      });
    });

    it('Given a refspec whose dst has two "*", When parseRefspec, Then throws REFSPEC_INVALID with at-most-one-star reason', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/*:refs/*/origin/*');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'REFSPEC_INVALID',
        raw: 'refs/heads/*:refs/*/origin/*',
        reason: 'each side may contain at most one "*"',
      });
    });

    it('Given a single-wildcard refspec on both sides, When parseRefspec, Then accepts it without throwing the at-most-one-star error', () => {
      // Act
      const sut = parseRefspec('refs/heads/*:refs/remotes/origin/*');

      // Assert
      expect(sut.hasWildcard).toBe(true);
    });
  });

  describe('applyRefspec', () => {
    it("Given wildcard spec and 'refs/heads/main', When applyRefspec, Then returns mapped 'refs/remotes/origin/main'", () => {
      // Arrange
      const spec = parseRefspec('refs/heads/*:refs/remotes/origin/*');

      // Act
      const sut = applyRefspec(spec, 'refs/heads/main' as RefName);

      // Assert
      expect(sut).toBe('refs/remotes/origin/main');
    });

    it("Given wildcard spec and a non-matching ref ('refs/tags/v1'), When applyRefspec, Then returns undefined", () => {
      // Arrange
      const spec = parseRefspec('refs/heads/*:refs/remotes/origin/*');

      // Act
      const sut = applyRefspec(spec, 'refs/tags/v1' as RefName);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given an exact (non-wildcard) spec and the matching ref, When applyRefspec, Then returns dst', () => {
      // Arrange
      const spec = parseRefspec('refs/heads/main:refs/remotes/origin/main');

      // Act
      const sut = applyRefspec(spec, 'refs/heads/main' as RefName);

      // Assert
      expect(sut).toBe('refs/remotes/origin/main');
    });

    it('Given an exact spec and a non-matching ref, When applyRefspec, Then returns undefined', () => {
      // Arrange
      const spec = parseRefspec('refs/heads/main:refs/remotes/origin/main');

      // Act
      const sut = applyRefspec(spec, 'refs/heads/dev' as RefName);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a wildcard spec with a non-empty suffix and a ref matching prefix but not suffix, When applyRefspec, Then returns undefined', () => {
      // Arrange
      const spec = parseRefspec('refs/heads/*/head:refs/remotes/*/head');

      // Act
      const sut = applyRefspec(spec, 'refs/heads/main/tail' as RefName);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a wildcard spec with a non-empty suffix and a fully matching ref, When applyRefspec, Then captures only the segment between prefix and suffix', () => {
      // Arrange
      const spec = parseRefspec('refs/heads/*/head:refs/remotes/*/head');

      // Act
      const sut = applyRefspec(spec, 'refs/heads/main/head' as RefName);

      // Assert
      expect(sut).toBe('refs/remotes/main/head');
    });
  });

  describe('MAX_REFSPECS_PER_FETCH', () => {
    it('Equals 1024', () => {
      expect(MAX_REFSPECS_PER_FETCH).toBe(1024);
    });
  });
});

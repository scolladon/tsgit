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

    it("Given '+refs/heads/main:refs/remotes/origin/main', When parseRefspec, Then force is true", () => {
      // Act
      const sut = parseRefspec('+refs/heads/main:refs/remotes/origin/main');

      // Assert
      expect(sut.force).toBe(true);
    });

    it("Given 'refs/heads/*:refs/remotes/origin/*', When parseRefspec, Then hasWildcard is true", () => {
      // Act
      const sut = parseRefspec('refs/heads/*:refs/remotes/origin/*');

      // Assert
      expect(sut.hasWildcard).toBe(true);
    });

    it('Given mismatched wildcards (src wild, dst not), When parseRefspec, Then throws REFSPEC_INVALID', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/*:refs/remotes/origin/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REFSPEC_INVALID');
    });

    it('Given a refspec with no colon, When parseRefspec, Then throws REFSPEC_INVALID', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REFSPEC_INVALID');
    });

    it('Given a refspec with NUL byte, When parseRefspec, Then throws REFSPEC_INVALID', () => {
      // Act
      let caught: unknown;
      try {
        parseRefspec('refs/heads/main:refs/remotes\0origin/main');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REFSPEC_INVALID');
    });

    it('Given an empty src or dst, When parseRefspec, Then throws REFSPEC_INVALID', () => {
      let caught: unknown;
      try {
        parseRefspec(':refs/heads/main');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REFSPEC_INVALID');
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
  });

  describe('MAX_REFSPECS_PER_FETCH', () => {
    it('Equals 1024', () => {
      expect(MAX_REFSPECS_PER_FETCH).toBe(1024);
    });
  });
});

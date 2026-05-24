import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import { validateRefName } from '../../../../src/domain/refs/ref-validation.js';
import { arbRefName } from './arbitraries.js';

describe('validateRefName', () => {
  describe('valid ref names', () => {
    it("Given 'refs/heads/main', When validating, Then returns RefName", () => {
      // Arrange & Act
      const sut = validateRefName('refs/heads/main');

      // Assert
      expect(sut).toBe('refs/heads/main');
    });

    it("Given 'refs/tags/v1.0.0', When validating, Then returns RefName", () => {
      // Arrange & Act
      const sut = validateRefName('refs/tags/v1.0.0');

      // Assert
      expect(sut).toBe('refs/tags/v1.0.0');
    });

    it("Given 'HEAD', When validating, Then returns RefName (one-level accepted)", () => {
      // Arrange & Act
      const sut = validateRefName('HEAD');

      // Assert
      expect(sut).toBe('HEAD');
    });

    it("Given 'refs/remotes/origin/main', When validating, Then returns RefName", () => {
      // Arrange & Act
      const sut = validateRefName('refs/remotes/origin/main');

      // Assert
      expect(sut).toBe('refs/remotes/origin/main');
    });

    it("Given 'refs/heads/feature/my-branch', When validating, Then returns RefName", () => {
      // Arrange & Act
      const sut = validateRefName('refs/heads/feature/my-branch');

      // Assert
      expect(sut).toBe('refs/heads/feature/my-branch');
    });
  });

  describe('invalid ref names', () => {
    it("Given 'refs/heads/..main' (double dots), When validating, Then throws INVALID_REF", () => {
      // Arrange & Act & Assert
      try {
        validateRefName('refs/heads/..main');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty('reason', 'ref name must not contain ..');
      }
    });

    it("Given 'refs/heads/main.lock' (component ends with .lock), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/main.lock');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name component must not end with .lock',
        );
      }
    });

    it("Given 'refs/foo.lock/bar' (interior component ends with .lock), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/foo.lock/bar');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name component must not end with .lock',
        );
      }
    });

    it("Given 'refs//heads' (consecutive slashes), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs//heads');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name must not contain consecutive slashes',
        );
      }
    });

    it("Given 'refs/heads/' (trailing slash), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name must not start or end with /',
        );
      }
    });

    it("Given '/refs/heads/main' (leading slash), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('/refs/heads/main');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name must not start or end with /',
        );
      }
    });

    it("Given '-refs' (starts with dash), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('-refs');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty('reason', 'ref name must not start with -');
      }
    });

    it("Given '@' (single @), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('@');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty('reason', 'ref name must not be single @');
      }
    });

    it("Given 'refs/heads/@{main}' (contains @{), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/@{main}');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty('reason', 'ref name must not contain @{');
      }
    });

    it("Given 'refs/.hidden/main' (component starts with dot), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/.hidden/main');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name component must not start with .',
        );
      }
    });

    it("Given 'refs/heads/trail.' (ends with dot), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/trail.');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty('reason', 'ref name must not end with .');
      }
    });

    it("Given 'refs/heads/spa ce' (contains space), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/spa ce');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty(
          'reason',
          'ref name contains forbidden character',
        );
      }
    });

    it("Given 'refs/heads/til~de' (contains ~), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/til~de');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given 'refs/heads/car^et' (contains ^), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/car^et');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given 'refs/heads/col:on' (contains :), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/col:on');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given 'refs/heads/quest?' (contains ?), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/quest?');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given 'refs/heads/star*' (contains *), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/star*');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given 'refs/heads/bra[cket' (contains [), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/bra[cket');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given 'refs/heads/back\\slash' (contains \\), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('refs/heads/back\\slash');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it("Given '' (empty string), When validating, Then throws INVALID_REF", () => {
      // Arrange
      try {
        validateRefName('');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data.code).toBe('INVALID_REF');
        expect((e as TsgitError).data).toHaveProperty('reason', 'ref name must not be empty');
      }
    });

    it('Given string with NUL byte, When validating, Then throws INVALID_REF', () => {
      // Arrange
      try {
        validateRefName('refs/heads/ma\0in');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it('Given string with ASCII control char (0x01), When validating, Then throws INVALID_REF', () => {
      // Arrange
      try {
        validateRefName('refs/heads/ma\x01in');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it('Given string with DEL char (0x7F), When validating, Then throws INVALID_REF', () => {
      // Arrange
      try {
        validateRefName('refs/heads/ma\x7fin');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });

    it('Given string with char 0x1F (boundary), When validating, Then throws INVALID_REF', () => {
      // Arrange
      try {
        validateRefName('refs/heads/ma\x1fin');
        // Assert
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TsgitError);
        expect((e as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
      }
    });
  });

  describe('property-based tests', () => {
    it('Given any arbRefName, When validating, Then it is accepted', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(arbRefName(), (name) => {
          const sut = validateRefName(name);
          expect(sut).toBe(name);
        }),
      );
    });

    it('Given any string accepted by validateRefName, When inspecting, Then it contains no forbidden patterns', () => {
      // Arrange + Assert
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => {
            try {
              validateRefName(s);
              return true;
            } catch {
              return false;
            }
          }),
          (name) => {
            expect(name).not.toContain('..');
            expect(name).not.toContain('//');
            for (const ch of name) {
              const code = ch.charCodeAt(0);
              expect(code).toBeGreaterThan(0x1f);
              expect(code).not.toBe(0x7f);
              expect('~^:?*[\\ '.includes(ch)).toBe(false);
            }
          },
        ),
      );
    });
  });

  describe('Unicode RTL/LTR override rejection (Step 0(d))', () => {
    const overrides: ReadonlyArray<[string, number]> = [
      ['U+202A', 0x202a],
      ['U+202B', 0x202b],
      ['U+202C', 0x202c],
      ['U+202D', 0x202d],
      ['U+202E', 0x202e],
      ['U+2066', 0x2066],
      ['U+2067', 0x2067],
      ['U+2068', 0x2068],
      ['U+2069', 0x2069],
    ];

    for (const [label, code] of overrides) {
      it(`Given a ref name containing ${label}, When validating, Then throws INVALID_REF /forbidden Unicode override/`, () => {
        // Arrange
        try {
          validateRefName(`refs/heads/bad${String.fromCharCode(code)}name`);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_REF',
            reason: 'ref name contains forbidden Unicode override',
          });
        }
      });
    }

    it('Given a ref name with no overrides, When validating, Then succeeds (baseline accept)', () => {
      // Arrange
      const sut = validateRefName('refs/heads/main');
      // Assert
      expect(sut).toBe('refs/heads/main');
    });

    const negatives: ReadonlyArray<[string, number]> = [
      ['U+2029 just-below-first', 0x2029],
      ['U+202F just-above-upper-end', 0x202f],
      ['U+2065 just-below-second', 0x2065],
      ['U+206A just-above-second-end', 0x206a],
    ];

    for (const [label, code] of negatives) {
      it(`Given a ref name containing ${label}, When validating, Then succeeds (negative boundary)`, () => {
        // Arrange
        const sut = validateRefName(`refs/heads/ok${String.fromCharCode(code)}name`);
        // Assert
        expect(sut).toContain('refs/heads/');
      });
    }
  });
});

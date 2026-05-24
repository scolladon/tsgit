import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import { validateRefName } from '../../../../src/domain/refs/ref-validation.js';
import { arbRefName } from './arbitraries.js';

describe('validateRefName', () => {
  describe('valid ref names', () => {
    describe("Given 'refs/heads/main'", () => {
      describe('When validating', () => {
        it('Then returns RefName', () => {
          // Arrange & Act
          const sut = validateRefName('refs/heads/main');

          // Assert
          expect(sut).toBe('refs/heads/main');
        });
      });
    });

    describe("Given 'refs/tags/v1.0.0'", () => {
      describe('When validating', () => {
        it('Then returns RefName', () => {
          // Arrange & Act
          const sut = validateRefName('refs/tags/v1.0.0');

          // Assert
          expect(sut).toBe('refs/tags/v1.0.0');
        });
      });
    });

    describe("Given 'HEAD'", () => {
      describe('When validating', () => {
        it('Then returns RefName (one-level accepted)', () => {
          // Arrange & Act
          const sut = validateRefName('HEAD');

          // Assert
          expect(sut).toBe('HEAD');
        });
      });
    });

    describe("Given 'refs/remotes/origin/main'", () => {
      describe('When validating', () => {
        it('Then returns RefName', () => {
          // Arrange & Act
          const sut = validateRefName('refs/remotes/origin/main');

          // Assert
          expect(sut).toBe('refs/remotes/origin/main');
        });
      });
    });

    describe("Given 'refs/heads/feature/my-branch'", () => {
      describe('When validating', () => {
        it('Then returns RefName', () => {
          // Arrange & Act
          const sut = validateRefName('refs/heads/feature/my-branch');

          // Assert
          expect(sut).toBe('refs/heads/feature/my-branch');
        });
      });
    });
  });

  describe('invalid ref names', () => {
    describe("Given 'refs/heads/..main' (double dots)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/main.lock' (component ends with .lock)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/foo.lock/bar' (interior component ends with .lock)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs//heads' (consecutive slashes)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/' (trailing slash)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given '/refs/heads/main' (leading slash)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given '-refs' (starts with dash)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
          // Arrange
          try {
            validateRefName('-refs');
            // Assert
            expect.fail('should have thrown');
          } catch (e) {
            expect(e).toBeInstanceOf(TsgitError);
            expect((e as TsgitError).data.code).toBe('INVALID_REF');
            expect((e as TsgitError).data).toHaveProperty(
              'reason',
              'ref name must not start with -',
            );
          }
        });
      });
    });

    describe("Given '@' (single @)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
          // Arrange
          try {
            validateRefName('@');
            // Assert
            expect.fail('should have thrown');
          } catch (e) {
            expect(e).toBeInstanceOf(TsgitError);
            expect((e as TsgitError).data.code).toBe('INVALID_REF');
            expect((e as TsgitError).data).toHaveProperty(
              'reason',
              'ref name must not be single @',
            );
          }
        });
      });
    });

    describe("Given 'refs/heads/@{main}' (contains @{)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/.hidden/main' (component starts with dot)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/trail.' (ends with dot)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/spa ce' (contains space)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/til~de' (contains ~)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/car^et' (contains ^)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/col:on' (contains :)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/quest?' (contains ?)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/star*' (contains *)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/bra[cket' (contains [)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given 'refs/heads/back\\\\slash' (contains \\\\)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe("Given '' (empty string)", () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe('Given string with NUL byte', () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe('Given string with ASCII control char (0x01)', () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe('Given string with DEL char (0x7F)', () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
      });
    });

    describe('Given string with char 0x1F (boundary)', () => {
      describe('When validating', () => {
        it('Then throws INVALID_REF', () => {
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
    });
  });

  describe('property-based tests', () => {
    describe('Given any arbRefName', () => {
      describe('When validating', () => {
        it('Then it is accepted', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(arbRefName(), (name) => {
              const sut = validateRefName(name);
              expect(sut).toBe(name);
            }),
          );
        });
      });
    });

    describe('Given any string accepted by validateRefName', () => {
      describe('When inspecting', () => {
        it('Then it contains no forbidden patterns', () => {
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

    describe('Given a ref name containing a forbidden Unicode override', () => {
      describe('When validating', () => {
        for (const [label, code] of overrides) {
          it(`Then ${label} throws INVALID_REF /forbidden Unicode override/`, () => {
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
      });
    });

    describe('Given a ref name with no overrides', () => {
      describe('When validating', () => {
        it('Then succeeds (baseline accept)', () => {
          // Arrange
          const sut = validateRefName('refs/heads/main');
          // Assert
          expect(sut).toBe('refs/heads/main');
        });
      });
    });

    const negatives: ReadonlyArray<[string, number]> = [
      ['U+2029 just-below-first', 0x2029],
      ['U+202F just-above-upper-end', 0x202f],
      ['U+2065 just-below-second', 0x2065],
      ['U+206A just-above-second-end', 0x206a],
    ];

    describe('Given a ref name containing a negative-boundary Unicode code point', () => {
      describe('When validating', () => {
        for (const [label, code] of negatives) {
          it(`Then ${label} succeeds`, () => {
            // Arrange
            const sut = validateRefName(`refs/heads/ok${String.fromCharCode(code)}name`);
            // Assert
            expect(sut).toContain('refs/heads/');
          });
        }
      });
    });
  });
});

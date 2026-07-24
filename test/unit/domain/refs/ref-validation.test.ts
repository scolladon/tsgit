import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import { isSafeRefName, validateRefName } from '../../../../src/domain/refs/ref-validation.js';
import { arbRefName } from './arbitraries.js';

describe('validateRefName', () => {
  describe('valid ref names', () => {
    describe('Given a well-formed ref name', () => {
      describe('When validating', () => {
        it.each([
          { name: 'refs/heads/main', label: 'returns RefName' },
          { name: 'refs/tags/v1.0.0', label: 'returns RefName' },
          { name: 'HEAD', label: 'returns RefName (one-level accepted)' },
          { name: 'refs/remotes/origin/main', label: 'returns RefName' },
          { name: 'refs/heads/feature/my-branch', label: 'returns RefName' },
        ])('Then `$name` $label', ({ name }) => {
          // Arrange & Act
          const sut = validateRefName(name);

          // Assert
          expect(sut).toBe(name);
        });
      });
    });
  });

  describe('invalid ref names', () => {
    describe('Given an invalid ref name', () => {
      describe('When validating', () => {
        it.each([
          {
            name: 'refs/heads/..main',
            label: 'double dots',
            reason: 'ref name must not contain ..',
          },
          {
            name: 'refs/heads/main.lock',
            label: 'component ends with .lock',
            reason: 'ref name component must not end with .lock',
          },
          {
            name: 'refs/foo.lock/bar',
            label: 'interior component ends with .lock',
            reason: 'ref name component must not end with .lock',
          },
          {
            name: 'refs//heads',
            label: 'consecutive slashes',
            reason: 'ref name must not contain consecutive slashes',
          },
          {
            name: 'refs/heads/',
            label: 'trailing slash',
            reason: 'ref name must not start or end with /',
          },
          {
            name: '/refs/heads/main',
            label: 'leading slash',
            reason: 'ref name must not start or end with /',
          },
          {
            name: '-refs',
            label: 'starts with dash',
            reason: 'ref name must not start with -',
          },
          {
            name: '@',
            label: 'single @',
            reason: 'ref name must not be single @',
          },
          {
            name: 'refs/heads/@{main}',
            label: 'contains @{',
            reason: 'ref name must not contain @{',
          },
          {
            name: 'refs/.hidden/main',
            label: 'component starts with dot',
            reason: 'ref name component must not start with .',
          },
          {
            name: 'refs/heads/trail.',
            label: 'ends with dot',
            reason: 'ref name must not end with .',
          },
          {
            name: 'refs/heads/spa ce',
            label: 'contains space',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/til~de',
            label: 'contains ~',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/car^et',
            label: 'contains ^',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/col:on',
            label: 'contains :',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/quest?',
            label: 'contains ?',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/star*',
            label: 'contains *',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/bra[cket',
            label: 'contains [',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/back\\slash',
            label: 'contains \\',
            reason: 'ref name contains forbidden character',
          },
          {
            name: '',
            label: 'empty string',
            reason: 'ref name must not be empty',
          },
          {
            name: 'refs/heads/ma\0in',
            label: 'NUL byte',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/ma\x01in',
            label: 'ASCII control char (0x01)',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/ma\x7fin',
            label: 'DEL char (0x7F)',
            reason: 'ref name contains forbidden character',
          },
          {
            name: 'refs/heads/ma\x1fin',
            label: 'char 0x1F (boundary)',
            reason: 'ref name contains forbidden character',
          },
        ])('Then $label throws INVALID_REF', ({ name, reason }) => {
          // Arrange & Act & Assert
          try {
            validateRefName(name);
            // Assert
            expect.fail('should have thrown');
          } catch (e) {
            expect(e).toBeInstanceOf(TsgitError);
            expect((e as TsgitError).data).toEqual({ code: 'INVALID_REF', reason });
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

describe('isSafeRefName', () => {
  describe("Given 'refs/heads/main'", () => {
    describe('When checking safety', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isSafeRefName;

        // Act
        const result = sut('refs/heads/main');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe("Given 'refs/heads/../../../config'", () => {
    describe('When checking safety', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isSafeRefName;

        // Act
        const result = sut('refs/heads/../../../config');

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

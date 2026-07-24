import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../../../src/domain/objects/author-identity.js';
import {
  parseIdentity,
  serializeIdentity,
} from '../../../../src/domain/objects/author-identity.js';

describe('author-identity', () => {
  describe('parseIdentity', () => {
    describe("Given 'Alice <alice@example.com> 1234567890 +0200'", () => {
      describe('When parsing', () => {
        it("Then name='Alice', email='alice@example.com', timestamp=1234567890, tz='+0200'", () => {
          // Arrange
          const line = 'Alice <alice@example.com> 1234567890 +0200';

          // Act
          const sut = parseIdentity(line);

          // Assert
          expect(sut).toEqual({
            name: 'Alice',
            email: 'alice@example.com',
            timestamp: 1234567890,
            timezoneOffset: '+0200',
          });
        });
      });
    });

    describe('Given identity with negative timestamp', () => {
      describe('When parsing', () => {
        it('Then timestamp is negative number', () => {
          // Arrange
          const line = 'Bob <bob@test.com> -100 +0000';

          // Act
          const sut = parseIdentity(line);

          // Assert
          expect(sut.timestamp).toBe(-100);
        });
      });
    });

    describe('Given identity with a signed timezone', () => {
      describe('When parsing', () => {
        it.each([
          { line: 'Carol <carol@test.com> 0 -0500', expected: '-0500' },
          { line: 'Dave <dave@test.com> 0 +0000', expected: '+0000' },
          { line: 'Eve <eve@test.com> 0 -0000', expected: '-0000' },
        ])("Then timezoneOffset is '$expected'", ({ line, expected }) => {
          // Arrange & Act
          const sut = parseIdentity(line);

          // Assert
          expect(sut.timezoneOffset).toBe(expected);
        });
      });
    });

    describe('Given identity with a name that is empty or has no gap before <', () => {
      describe('When parsing', () => {
        it.each([
          { line: '<e@x.com> 0 +0000', expected: '', label: 'an empty name stays empty' },
          {
            line: 'Alice <alice@test.com> 0 +0000',
            expected: 'Alice',
            label: 'a trailing space before < is trimmed from the name',
          },
          {
            line: 'Alice!<alice@test.com> 0 +0000',
            expected: 'Alice!',
            label: 'a name with no gap before < preserves all characters',
          },
        ])('Then $label', ({ line, expected }) => {
          // Arrange & Act
          const sut = parseIdentity(line);

          // Assert
          expect(sut.name).toBe(expected);
        });
      });
    });

    describe("Given 'A <B> C <real@email.com> 123 +0000'", () => {
      describe('When parsing', () => {
        it("Then email is 'real@email.com' (last <> pair)", () => {
          // Arrange
          const line = 'A <B> C <real@email.com> 123 +0000';

          // Act
          const sut = parseIdentity(line);

          // Assert
          expect(sut.email).toBe('real@email.com');
        });
      });
    });

    // Each row isolates one distinct parseIdentity validation guard. The
    // timestamp trio (NaN / float / overflow) all fail the same single
    // `Number.isSafeInteger` check via different literal routes; the timezone
    // pair (malformed / angle-bracket) both fail the same `/^[+-]\d{4}$/` test.
    describe('Given a line that fails a parseIdentity validation guard', () => {
      describe('When parsing', () => {
        it.each([
          {
            line: 'no opening> 0 +0000',
            reason: 'missing opening angle bracket',
            label: 'a closing bracket but no opening bracket',
          },
          {
            line: 'no brackets here',
            reason: 'missing closing angle bracket',
            label: 'no angle brackets at all',
          },
          {
            line: 'Name <email>',
            reason: 'missing timestamp or timezone',
            label: 'no timestamp after >',
          },
          {
            line: 'Name <email> 123',
            reason: 'missing timestamp or timezone',
            label: 'no timezone',
          },
          {
            line: 'Name <email@test.com> NaN +0000',
            reason: 'invalid timestamp',
            label: 'a non-numeric timestamp',
          },
          {
            line: 'Alice <a@a.com> 100.5 +0000',
            reason: 'invalid timestamp',
            label: 'a float timestamp',
          },
          {
            line: 'Alice <a@a.com> 9007199254740993 +0000', // above Number.MAX_SAFE_INTEGER
            reason: 'invalid timestamp',
            label: 'an unsafe-integer timestamp',
          },
          {
            line: 'Alice <a@a.com> 100 abc',
            reason: 'invalid timezone offset',
            label: 'a malformed timezone',
          },
          {
            line: 'Alice <a@a.com> 100 <bad',
            reason: 'invalid timezone offset',
            label: 'a timezone containing an angle bracket',
          },
        ])('Then throws INVALID_IDENTITY for $label', ({ line, reason }) => {
          // Arrange & Act + Assert
          expect(() => parseIdentity(line)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_IDENTITY',
                reason,
              }),
            }),
          );
        });
      });
    });

    // Both rows probe the same `/^[+-]\d{4}$/` anchors from the opposite side
    // (unanchored suffix vs unanchored prefix match).
    describe('Given a timezone that only matches the offset pattern unanchored', () => {
      describe('When parsing', () => {
        it.each([
          {
            line: 'Alice <a@a.com> 100 X+0200', // 'X+0200' matches /[+-]\d{4}$/ but not /^[+-]\d{4}$/
            label: 'a leading non-offset char before +0200 (rejects unanchored suffix match)',
          },
          {
            line: 'Alice <a@a.com> 100 +0200X', // '+0200X' matches /^[+-]\d{4}/ but not /^[+-]\d{4}$/
            label: 'a trailing char after +0200 (rejects unanchored prefix match)',
          },
        ])(
          'Then throws INVALID_IDENTITY with invalid timezone offset reason for $label',
          ({ line }) => {
            // Arrange & Act / Assert
            try {
              parseIdentity(line);
              // Assert
              expect.unreachable();
            } catch (error) {
              expect((error as { data: { code: string; reason: string } }).data.code).toBe(
                'INVALID_IDENTITY',
              );
              expect((error as { data: { reason: string } }).data.reason).toBe(
                'invalid timezone offset',
              );
            }
          },
        );
      });
    });

    describe('Given identity with double space before timezone', () => {
      describe('When parsing', () => {
        it('Then parses correctly with tz=+0000', () => {
          // Arrange
          const line = 'Alice <a@a.com> 100  +0000';

          // Act
          const sut = parseIdentity(line);

          // Assert
          expect(sut.timestamp).toBe(100);
          expect(sut.timezoneOffset).toBe('+0000');
        });
      });
    });
  });

  describe('serializeIdentity', () => {
    describe('Given an AuthorIdentity', () => {
      describe('When serializing', () => {
        it("Then produces 'Name <email> timestamp tz'", () => {
          // Arrange
          const identity: AuthorIdentity = {
            name: 'Alice',
            email: 'alice@example.com',
            timestamp: 1234567890,
            timezoneOffset: '+0200',
          };

          // Act
          const sut = serializeIdentity(identity);

          // Assert
          expect(sut).toBe('Alice <alice@example.com> 1234567890 +0200');
        });
      });
    });

    describe('Given identity with empty name', () => {
      describe('When serializing', () => {
        it("Then produces ' <email> timestamp tz'", () => {
          // Arrange
          const identity: AuthorIdentity = {
            name: '',
            email: 'e@x.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          };

          // Act
          const sut = serializeIdentity(identity);

          // Assert
          expect(sut).toBe(' <e@x.com> 0 +0000');
        });
      });
    });

    // 3x3 matrix: each of the 3 fields has its own sequential control-char
    // guard (not one shared OR), so every (field × char) row is required to
    // prove the right field's own reason text fires, not another field's.
    describe('Given a control character in an identity field', () => {
      describe('When serializing', () => {
        it.each([
          {
            field: 'name',
            char: 'newline',
            identity: {
              name: 'Bad\nName',
              email: 'a@a.com',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
          },
          {
            field: 'name',
            char: 'CR',
            identity: {
              name: 'Bad\rName',
              email: 'a@a.com',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
          },
          {
            field: 'name',
            char: 'NUL',
            identity: {
              name: 'Bad\0Name',
              email: 'a@a.com',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
          },
          {
            field: 'email',
            char: 'newline',
            identity: { name: 'Name', email: 'bad\n@a.com', timestamp: 0, timezoneOffset: '+0000' },
          },
          {
            field: 'email',
            char: 'CR',
            identity: { name: 'Name', email: 'bad\r@a.com', timestamp: 0, timezoneOffset: '+0000' },
          },
          {
            field: 'email',
            char: 'NUL',
            identity: { name: 'Name', email: 'bad\0@a.com', timestamp: 0, timezoneOffset: '+0000' },
          },
          {
            field: 'timezoneOffset',
            char: 'newline',
            identity: { name: 'Name', email: 'a@a.com', timestamp: 0, timezoneOffset: '+00\n00' },
          },
          {
            field: 'timezoneOffset',
            char: 'CR',
            identity: { name: 'Name', email: 'a@a.com', timestamp: 0, timezoneOffset: '+00\r00' },
          },
          {
            field: 'timezoneOffset',
            char: 'NUL',
            identity: { name: 'Name', email: 'a@a.com', timestamp: 0, timezoneOffset: '+00\x0000' },
          },
        ] satisfies ReadonlyArray<{ field: string; char: string; identity: AuthorIdentity }>)(
          'Then throws INVALID_IDENTITY for a $char in $field',
          ({ field, identity }) => {
            // Arrange + Act / Assert
            try {
              serializeIdentity(identity);
              // Assert
              expect.unreachable();
            } catch (error) {
              expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
              expect((error as { data: { reason: string } }).data.reason).toMatch(
                new RegExp(`${field} contains forbidden control character`),
              );
            }
          },
        );
      });
    });

    describe('Given a field containing a character outside the reject set', () => {
      describe('When serializing', () => {
        it.each([
          {
            identity: {
              name: 'Name\twith\ttab',
              email: 'a@a.com',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
            expected: '\t',
            label: 'a tab in the name',
          },
          {
            identity: { name: 'café', email: 'a@a.com', timestamp: 0, timezoneOffset: '+0000' },
            expected: 'café',
            label: 'UTF-8 in the name',
          },
          {
            identity: {
              name: 'Alice',
              email: 'alice+tag@example.com',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
            expected: 'alice+tag@example.com',
            label: "a '+' (RFC5322 plus addressing) in the email",
          },
        ] satisfies ReadonlyArray<{ identity: AuthorIdentity; expected: string; label: string }>)(
          'Then $label succeeds',
          ({ identity, expected }) => {
            // Arrange + Act
            const sut = serializeIdentity(identity);

            // Assert
            expect(sut).toContain(expected);
          },
        );
      });
    });

    // Each row isolates one distinct serializeIdentity "invalid identity
    // fields" guard (name has <, email has >, timezoneOffset format).
    describe('Given identity fields that fail the shape guards', () => {
      describe('When serializing', () => {
        it.each([
          {
            identity: { name: 'Bad<Name', email: 'a@a.com', timestamp: 0, timezoneOffset: '+0000' },
            label: 'a < in the name',
          },
          {
            identity: { name: 'Name', email: 'bad>@a.com', timestamp: 0, timezoneOffset: '+0000' },
            label: 'a > in the email',
          },
          {
            identity: { name: 'Name', email: 'a@a.com', timestamp: 0, timezoneOffset: 'bad' },
            label: 'an invalid timezoneOffset format',
          },
        ] satisfies ReadonlyArray<{ identity: AuthorIdentity; label: string }>)(
          'Then throws INVALID_IDENTITY for $label',
          ({ identity }) => {
            // Arrange + Act + Assert
            expect(() => serializeIdentity(identity)).toThrow(
              expect.objectContaining({
                data: expect.objectContaining({
                  code: 'INVALID_IDENTITY',
                  reason: 'invalid identity fields',
                }),
              }),
            );
          },
        );
      });
    });

    // Both rows probe the same `/^[+-]\d{4}$/` anchors from the opposite side.
    describe('Given a timezoneOffset that only matches the offset pattern unanchored', () => {
      describe('When serializing', () => {
        it.each([
          {
            timezoneOffset: 'X+0200', // matches /[+-]\d{4}$/ but not /^[+-]\d{4}$/
            label: 'a leading non-offset char before +0200 (rejects unanchored suffix match)',
          },
          {
            timezoneOffset: '+0200X', // matches /^[+-]\d{4}/ but not /^[+-]\d{4}$/
            label: 'a trailing char after +0200 (rejects unanchored prefix match)',
          },
        ])(
          'Then throws INVALID_IDENTITY with invalid identity fields reason for $label',
          ({ timezoneOffset }) => {
            // Arrange
            const identity: AuthorIdentity = {
              name: 'Name',
              email: 'a@a.com',
              timestamp: 0,
              timezoneOffset,
            };

            // Act / Assert
            try {
              serializeIdentity(identity);
              // Assert
              expect.unreachable();
            } catch (error) {
              expect((error as { data: { code: string; reason: string } }).data.code).toBe(
                'INVALID_IDENTITY',
              );
              expect((error as { data: { reason: string } }).data.reason).toBe(
                'invalid identity fields',
              );
            }
          },
        );
      });
    });

    describe('Given identity with control char in name', () => {
      describe('When serializing', () => {
        it('Then error.data.line is the rendered "name <email>" string', () => {
          // Arrange — line template must carry name and email; empty-template mutant yields ''
          const identity: AuthorIdentity = {
            name: 'Bad\nName',
            email: 'a@a.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          };

          // Act / Assert
          try {
            serializeIdentity(identity);
            // Assert
            expect.unreachable();
          } catch (error) {
            expect((error as { data: { code: string } }).data.code).toBe('INVALID_IDENTITY');
            expect((error as { data: { line: string } }).data.line).toBe('Bad\nName <a@a.com>');
          }
        });
      });
    });
  });

  describe('roundtrip', () => {
    describe('Given an AuthorIdentity', () => {
      describe('When roundtripping parse(serialize(identity))', () => {
        it('Then equals original', () => {
          // Arrange
          const identity: AuthorIdentity = {
            name: 'Test User',
            email: 'test@example.com',
            timestamp: 9999999999,
            timezoneOffset: '-0800',
          };

          // Act
          const sut = parseIdentity(serializeIdentity(identity));

          // Assert
          expect(sut).toEqual(identity);
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given the roundtrip property "parseIdentity(serializeIdentity(identity)) equals original for valid identities"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange
          const arbIdentity = fc.record({
            name: fc
              .string()
              .filter((s) => !s.includes('<') && !s.includes('>') && !s.includes('\n')),
            email: fc
              .string()
              .filter(
                (s) =>
                  !s.includes('<') && !s.includes('>') && !s.includes(' ') && !s.includes('\n'),
              ),
            timestamp: fc.integer({ min: -1000000000, max: 9999999999 }),
            timezoneOffset: fc
              .tuple(
                fc.constantFrom('+', '-'),
                fc.integer({ min: 0, max: 23 }),
                fc.constantFrom(0, 15, 30, 45),
              )
              .map(
                ([sign, hours, minutes]) =>
                  `${sign}${hours.toString().padStart(2, '0')}${minutes.toString().padStart(2, '0')}`,
              ),
          });

          // Assert
          fc.assert(
            fc.property(arbIdentity, (identity) => {
              const serialized = serializeIdentity(identity);
              const sut = parseIdentity(serialized);
              expect(sut).toEqual(identity);
            }),
          );
        });
      });
    });
  });
});

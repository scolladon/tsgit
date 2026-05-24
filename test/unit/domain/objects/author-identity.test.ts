import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../../../src/domain/objects/author-identity.js';
import {
  parseIdentity,
  serializeIdentity,
} from '../../../../src/domain/objects/author-identity.js';

describe('author-identity', () => {
  describe('parseIdentity', () => {
    it("Given 'Alice <alice@example.com> 1234567890 +0200', When parsing, Then name='Alice', email='alice@example.com', timestamp=1234567890, tz='+0200'", () => {
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

    it('Given identity with negative timestamp, When parsing, Then timestamp is negative number', () => {
      // Arrange
      const line = 'Bob <bob@test.com> -100 +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.timestamp).toBe(-100);
    });

    it("Given identity with -0500 timezone, When parsing, Then timezoneOffset is '-0500'", () => {
      // Arrange
      const line = 'Carol <carol@test.com> 0 -0500';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.timezoneOffset).toBe('-0500');
    });

    it("Given identity with +0000 timezone, When parsing, Then timezoneOffset is '+0000'", () => {
      // Arrange
      const line = 'Dave <dave@test.com> 0 +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.timezoneOffset).toBe('+0000');
    });

    it("Given identity with -0000 timezone, When parsing, Then timezoneOffset is '-0000'", () => {
      // Arrange
      const line = 'Eve <eve@test.com> 0 -0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.timezoneOffset).toBe('-0000');
    });

    it("Given identity with empty name '<e@x.com> 0 +0000', When parsing, Then name is ''", () => {
      // Arrange
      const line = '<e@x.com> 0 +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.name).toBe('');
    });

    it("Given 'A <B> C <real@email.com> 123 +0000', When parsing, Then email is 'real@email.com' (last <> pair)", () => {
      // Arrange
      const line = 'A <B> C <real@email.com> 123 +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.email).toBe('real@email.com');
    });

    it('Given identity with closing bracket but no opening bracket, When parsing, Then throws INVALID_IDENTITY with reason about opening bracket', () => {
      // Arrange
      const line = 'no opening> 0 +0000';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'missing opening angle bracket',
          }),
        }),
      );
    });

    it('Given identity with non-numeric timestamp, When parsing, Then throws INVALID_IDENTITY with reason about invalid timestamp', () => {
      // Arrange
      const line = 'Name <email@test.com> NaN +0000';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid timestamp',
          }),
        }),
      );
    });

    it('Given identity with float timestamp, When parsing, Then throws INVALID_IDENTITY with reason about invalid timestamp', () => {
      // Arrange
      const line = 'Alice <a@a.com> 100.5 +0000';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid timestamp',
          }),
        }),
      );
    });

    it('Given identity with unsafe integer timestamp, When parsing, Then throws INVALID_IDENTITY', () => {
      // Arrange — above Number.MAX_SAFE_INTEGER
      const line = 'Alice <a@a.com> 9007199254740993 +0000';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid timestamp',
          }),
        }),
      );
    });

    it('Given identity with malformed timezone, When parsing, Then throws INVALID_IDENTITY', () => {
      // Arrange
      const line = 'Alice <a@a.com> 100 abc';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid timezone offset',
          }),
        }),
      );
    });

    it('Given identity with timezone containing angle bracket, When parsing, Then throws INVALID_IDENTITY', () => {
      // Arrange
      const line = 'Alice <a@a.com> 100 <bad';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid timezone offset',
          }),
        }),
      );
    });

    it('Given timezone with a leading non-offset char before +0200, When parsing, Then throws (anchored ^ rejects unanchored suffix match)', () => {
      // Arrange — 'X+0200' matches /[+-]\d{4}$/ but not /^[+-]\d{4}$/
      const line = 'Alice <a@a.com> 100 X+0200';

      // Act / Assert
      try {
        parseIdentity(line);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect((error as { data: { code: string; reason: string } }).data.code).toBe(
          'INVALID_IDENTITY',
        );
        expect((error as { data: { reason: string } }).data.reason).toBe('invalid timezone offset');
      }
    });

    it('Given timezone with a trailing char after +0200, When parsing, Then throws (anchored $ rejects unanchored prefix match)', () => {
      // Arrange — '+0200X' matches /^[+-]\d{4}/ but not /^[+-]\d{4}$/
      const line = 'Alice <a@a.com> 100 +0200X';

      // Act / Assert
      try {
        parseIdentity(line);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect((error as { data: { code: string; reason: string } }).data.code).toBe(
          'INVALID_IDENTITY',
        );
        expect((error as { data: { reason: string } }).data.reason).toBe('invalid timezone offset');
      }
    });

    it('Given identity with double space before timezone, When parsing, Then parses correctly with tz=+0000', () => {
      // Arrange
      const line = 'Alice <a@a.com> 100  +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.timestamp).toBe(100);
      expect(sut.timezoneOffset).toBe('+0000');
    });

    it('Given malformed identity (no angle brackets), When parsing, Then throws INVALID_IDENTITY with reason about closing bracket', () => {
      // Arrange
      const line = 'no brackets here';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'missing closing angle bracket',
          }),
        }),
      );
    });

    it('Given malformed identity (no timestamp after >), When parsing, Then throws INVALID_IDENTITY with reason about missing timestamp or timezone', () => {
      // Arrange
      const line = 'Name <email>';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'missing timestamp or timezone',
          }),
        }),
      );
    });

    it('Given malformed identity (no timezone), When parsing, Then throws INVALID_IDENTITY with reason about missing timestamp or timezone', () => {
      // Arrange
      const line = 'Name <email> 123';

      // Act + Assert
      expect(() => parseIdentity(line)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'missing timestamp or timezone',
          }),
        }),
      );
    });

    it('Given identity with name ending in space, When parsing, Then trailing space is trimmed from name', () => {
      // Arrange
      const line = 'Alice <alice@test.com> 0 +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.name).toBe('Alice');
    });

    it('Given identity with name not ending in space (no gap before <), When parsing, Then name preserves all characters', () => {
      // Arrange
      const line = 'Alice!<alice@test.com> 0 +0000';

      // Act
      const sut = parseIdentity(line);

      // Assert
      expect(sut.name).toBe('Alice!');
    });
  });

  describe('serializeIdentity', () => {
    it("Given an AuthorIdentity, When serializing, Then produces 'Name <email> timestamp tz'", () => {
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

    it("Given identity with empty name, When serializing, Then produces ' <email> timestamp tz'", () => {
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

    it('Given identity with newline in name, When serializing, Then throws INVALID_IDENTITY with forbidden-control-character reason', () => {
      // Arrange
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
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /name contains forbidden control character/,
        );
      }
    });

    it('Given identity with CR in name, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Bad\rName',
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
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /name contains forbidden control character/,
        );
      }
    });

    it('Given identity with NUL in name, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Bad\0Name',
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
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /name contains forbidden control character/,
        );
      }
    });

    it('Given identity with newline in email, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'bad\n@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act / Assert
      try {
        serializeIdentity(identity);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /email contains forbidden control character/,
        );
      }
    });

    it('Given identity with CR in email, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'bad\r@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act / Assert
      try {
        serializeIdentity(identity);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /email contains forbidden control character/,
        );
      }
    });

    it('Given identity with NUL in email, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'bad\0@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act / Assert
      try {
        serializeIdentity(identity);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /email contains forbidden control character/,
        );
      }
    });

    it('Given identity with newline in timezoneOffset, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+00\n00',
      };

      // Act / Assert
      try {
        serializeIdentity(identity);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /timezoneOffset contains forbidden control character/,
        );
      }
    });

    it('Given identity with CR in timezoneOffset, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+00\r00',
      };

      // Act / Assert
      try {
        serializeIdentity(identity);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /timezoneOffset contains forbidden control character/,
        );
      }
    });

    it('Given identity with NUL in timezoneOffset, When serializing, Then throws INVALID_IDENTITY /forbidden control character/', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+00\x0000',
      };

      // Act / Assert
      try {
        serializeIdentity(identity);
        // Assert
        expect.unreachable();
      } catch (error) {
        expect(error).toHaveProperty('data.code', 'INVALID_IDENTITY');
        expect((error as { data: { reason: string } }).data.reason).toMatch(
          /timezoneOffset contains forbidden control character/,
        );
      }
    });

    it('Given identity.name containing tab (not in reject set), When serializing, Then succeeds', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name\twith\ttab',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act
      const sut = serializeIdentity(identity);

      // Assert
      expect(sut).toContain('\t');
    });

    it('Given identity.name containing UTF-8 "café", When serializing, Then succeeds', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'café',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act
      const sut = serializeIdentity(identity);

      // Assert
      expect(sut).toContain('café');
    });

    it("Given identity.email containing '+' (RFC5322 plus addressing), When serializing, Then succeeds", () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Alice',
        email: 'alice+tag@example.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act
      const sut = serializeIdentity(identity);

      // Assert
      expect(sut).toContain('alice+tag@example.com');
    });

    it('Given identity with < in name, When serializing, Then throws INVALID_IDENTITY', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Bad<Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act + Assert
      expect(() => serializeIdentity(identity)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid identity fields',
          }),
        }),
      );
    });

    it('Given identity with > in email, When serializing, Then throws INVALID_IDENTITY', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'bad>@a.com',
        timestamp: 0,
        timezoneOffset: '+0000',
      };

      // Act + Assert
      expect(() => serializeIdentity(identity)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid identity fields',
          }),
        }),
      );
    });

    it('Given identity with invalid timezoneOffset format, When serializing, Then throws INVALID_IDENTITY', () => {
      // Arrange
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: 'bad',
      };

      // Act + Assert
      expect(() => serializeIdentity(identity)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_IDENTITY',
            reason: 'invalid identity fields',
          }),
        }),
      );
    });

    it('Given timezoneOffset with a leading non-offset char before +0200, When serializing, Then throws (anchored ^ rejects unanchored suffix match)', () => {
      // Arrange — 'X+0200' matches /[+-]\d{4}$/ but not /^[+-]\d{4}$/
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: 'X+0200',
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
        expect((error as { data: { reason: string } }).data.reason).toBe('invalid identity fields');
      }
    });

    it('Given timezoneOffset with a trailing char after +0200, When serializing, Then throws (anchored $ rejects unanchored prefix match)', () => {
      // Arrange — '+0200X' matches /^[+-]\d{4}/ but not /^[+-]\d{4}$/
      const identity: AuthorIdentity = {
        name: 'Name',
        email: 'a@a.com',
        timestamp: 0,
        timezoneOffset: '+0200X',
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
        expect((error as { data: { reason: string } }).data.reason).toBe('invalid identity fields');
      }
    });

    it('Given identity with control char in name, When serializing, Then error.data.line is the rendered "name <email>" string', () => {
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

  describe('roundtrip', () => {
    it('Given an AuthorIdentity, When roundtripping parse(serialize(identity)), Then equals original', () => {
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

  describe('property-based tests', () => {
    it('Given the roundtrip property "parseIdentity(serializeIdentity(identity)) equals original for valid identities", When sampled, Then it holds', () => {
      // Arrange
      const arbIdentity = fc.record({
        name: fc.string().filter((s) => !s.includes('<') && !s.includes('>') && !s.includes('\n')),
        email: fc
          .string()
          .filter(
            (s) => !s.includes('<') && !s.includes('>') && !s.includes(' ') && !s.includes('\n'),
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

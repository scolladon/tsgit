import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Tag } from '../../../../src/domain/objects/tag.js';
import { parseTagContent, serializeTagContent } from '../../../../src/domain/objects/tag.js';
import { arbObjectId } from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));
const OBJ_ID = ObjectId.from('b'.repeat(40));

function tagText(lines: string[]): Uint8Array {
  return encode(lines.join('\n'));
}

describe('tag', () => {
  describe('parseTagContent', () => {
    it('Given a complete tag, When parsing, Then object, objectType, tagName, tagger, message are correct and extraHeaders is empty array', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0.0',
        'tagger Alice <alice@test.com> 1000 +0000',
        '',
        'Release v1.0.0',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.object).toBe('b'.repeat(40));
      expect(sut.data.objectType).toBe('commit');
      expect(sut.data.tagName).toBe('v1.0.0');
      expect(sut.data.tagger?.name).toBe('Alice');
      expect(sut.data.message).toBe('Release v1.0.0');
      expect(sut.data.extraHeaders).toEqual([]);
    });

    it('Given a tag without tagger field, When parsing, Then tagger is undefined', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v0.1',
        '',
        'Old tag',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.tagger).toBeUndefined();
    });

    it('Given a tag with non-tagger header after tag line, When parsing, Then tagger is undefined and header is in extraHeaders', () => {
      // Arrange — 'custom-key value' should NOT be parsed as tagger
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'custom-key value',
        '',
        'msg',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.tagger).toBeUndefined();
      expect(sut.data.extraHeaders).toEqual([{ key: 'custom-key', value: 'value' }]);
    });

    it('Given a tag with gpgsig header, When parsing, Then gpgSignature extracted, excluded from extraHeaders', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' sig-data',
        ' -----END PGP SIGNATURE-----',
        '',
        'signed tag',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.gpgSignature).toContain('sig-data');
      expect(sut.data.extraHeaders.some((h) => h.key === 'gpgsig')).toBe(false);
    });

    it('Given a tag with extra headers (continuation lines), When parsing, Then extraHeaders preserves them', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
        'custom header-value',
        ' continuation',
        '',
        'msg',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.extraHeaders).toEqual([
        { key: 'custom', value: 'header-value\ncontinuation' },
      ]);
    });

    it("Given a tag pointing to another tag, When parsing, Then objectType is 'tag'", () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type tag',
        'tag nested',
        'tagger A <a@a.com> 0 +0000',
        '',
        'nested tag',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.objectType).toBe('tag');
    });

    it("Given a tag pointing to a blob, When parsing, Then objectType is 'blob'", () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type blob',
        'tag blob-tag',
        'tagger A <a@a.com> 0 +0000',
        '',
        'blob tag',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.objectType).toBe('blob');
    });

    it('Given a tag with no blank line (no message), When parsing, Then message is empty and headers are parsed', () => {
      // Arrange — no \n\n so the entire text is treated as headers
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.message).toBe('');
      expect(sut.data.tagName).toBe('v1.0');
    });

    it('Given a tag with extra header without value (no space), When parsing, Then key is extracted with empty value', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
        'keyonly',
        '',
        'msg',
      ]);

      // Act
      const sut = parseTagContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.extraHeaders).toEqual([{ key: 'keyonly', value: '' }]);
    });

    it('Given a tag with invalid objectType, When parsing, Then throws INVALID_TAG with invalid object type reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`, 'type invalid', 'tag v1.0', '', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'invalid object type: invalid',
          }),
        }),
      );
    });

    it('Given content missing object field, When parsing, Then throws INVALID_TAG with first line must be object reason', () => {
      // Arrange
      const content = tagText(['type commit', 'tag v1.0', '', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'first line must be object',
          }),
        }),
      );
    });

    it('Given content missing tag name field, When parsing, Then throws INVALID_TAG with third line must be tag name reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`, 'type commit', '', 'msg']);

      // Act
      let sut: unknown;
      try {
        parseTagContent(DUMMY_ID, content);
      } catch (e) {
        sut = e;
      }

      // Assert
      expect(sut).toBeInstanceOf(TsgitError);
      expect((sut as TsgitError).data).toEqual({
        code: 'INVALID_TAG',
        reason: 'third line must be tag name',
      });
    });

    it('Given content with third line not starting with "tag ", When parsing, Then throws INVALID_TAG', () => {
      // Arrange — 3 lines so length check passes, but third line is wrong
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'notatag v1.0',
        '',
        'msg',
      ]);

      // Act
      let sut: unknown;
      try {
        parseTagContent(DUMMY_ID, content);
      } catch (e) {
        sut = e;
      }

      // Assert
      expect(sut).toBeInstanceOf(TsgitError);
      expect((sut as TsgitError).data).toEqual({
        code: 'INVALID_TAG',
        reason: 'third line must be tag name',
      });
    });

    it('Given content missing type field, When parsing, Then throws INVALID_TAG with second line must be type reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`, 'tag v1.0', '', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'second line must be type',
          }),
        }),
      );
    });

    it('Given empty content, When parsing, Then throws INVALID_TAG with first line must be object reason', () => {
      // Arrange
      const content = tagText([]);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'first line must be object',
          }),
        }),
      );
    });

    it('Given content with only object line, When parsing, Then throws INVALID_TAG with second line must be type reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`]);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'second line must be type',
          }),
        }),
      );
    });

    it('Given content with object and type but no tag line, When parsing, Then throws INVALID_TAG with third line must be tag name reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`, 'type commit']);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'third line must be tag name',
          }),
        }),
      );
    });

    it('Given tag with empty tag name, When parsing, Then throws INVALID_TAG with invalid tag name reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`, 'type commit', 'tag ', '', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'invalid tag name: ',
          }),
        }),
      );
    });

    it('Given tag with null byte in tag name, When parsing, Then throws INVALID_TAG with invalid tag name reason', () => {
      // Arrange
      const content = tagText([`object ${'b'.repeat(40)}`, 'type commit', 'tag v1\0.0', '', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
          }),
        }),
      );
    });

    it('Given tag with duplicate gpgsig header, When parsing, Then throws INVALID_TAG with duplicate gpgsig header reason', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
        'gpgsig first-sig',
        'gpgsig second-sig',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'duplicate gpgsig header',
          }),
        }),
      );
    });

    it('Given tag with orphan continuation line (no preceding header), When parsing, Then throws INVALID_TAG with unexpected continuation line reason', () => {
      // Arrange
      const content = tagText([
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        ' orphan continuation',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseTagContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TAG',
            reason: 'unexpected continuation line without preceding header',
          }),
        }),
      );
    });
  });

  describe('serializeTagContent', () => {
    it('Given a tag, When serializing, Then produces correct format with fields in order', () => {
      // Arrange
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'v1.0',
          tagger: {
            name: 'Alice',
            email: 'alice@test.com',
            timestamp: 1000,
            timezoneOffset: '+0000',
          },
          message: 'Release',
          extraHeaders: [],
        },
      };

      // Act
      const sut = new TextDecoder().decode(serializeTagContent(tag));

      // Assert
      expect(sut).toContain(`object ${'b'.repeat(40)}\n`);
      expect(sut).toContain('type commit\n');
      expect(sut).toContain('tag v1.0\n');
      expect(sut).toContain('tagger Alice <alice@test.com> 1000 +0000\n');
    });

    it('Given a tag without tagger, When serializing, Then tagger line is omitted', () => {
      // Arrange
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'v1.0',
          message: 'msg',
          extraHeaders: [],
        },
      };

      // Act
      const sut = new TextDecoder().decode(serializeTagContent(tag));

      // Assert
      expect(sut).not.toContain('tagger');
    });

    it('Given a tag with newline in tagName, When serializing, Then throws INVALID_TAG with the exact invalid-tag-name reason', () => {
      // Arrange
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'v1.0\ninjected',
          message: 'msg',
          extraHeaders: [],
        },
      };

      // Act
      let thrown: unknown;
      try {
        serializeTagContent(tag);
      } catch (e) {
        thrown = e;
      }

      // Assert — exact reason kills the L125 empty-template StringLiteral mutant
      expect(thrown).toBeInstanceOf(TsgitError);
      expect((thrown as TsgitError).data).toEqual({
        code: 'INVALID_TAG',
        reason: 'invalid tag name: v1.0\ninjected',
      });
    });

    it('Given a tag with an empty tagName, When serializing, Then throws INVALID_TAG with invalid tag name reason', () => {
      // Arrange — kills the L124 `=== ''` StringLiteral mutant: under the mutant
      // an empty tagName no longer matches the guard and serialization succeeds.
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: '',
          message: 'msg',
          extraHeaders: [],
        },
      };

      // Act
      let thrown: unknown;
      try {
        serializeTagContent(tag);
      } catch (e) {
        thrown = e;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      expect((thrown as TsgitError).data).toEqual({
        code: 'INVALID_TAG',
        reason: 'invalid tag name: ',
      });
    });

    it('Given a tag with a NUL byte in tagName, When serializing, Then throws INVALID_TAG with invalid tag name reason', () => {
      // Arrange — isolates the `includes('\0')` operand of the L124 guard.
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'v1\0bad',
          message: 'msg',
          extraHeaders: [],
        },
      };

      // Act
      let thrown: unknown;
      try {
        serializeTagContent(tag);
      } catch (e) {
        thrown = e;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      expect((thrown as TsgitError).data).toEqual({
        code: 'INVALID_TAG',
        reason: 'invalid tag name: v1\0bad',
      });
    });

    it('Given a tag with a valid non-empty tagName, When serializing, Then it does NOT throw (guard does not over-trigger)', () => {
      // Arrange — kills the L124 ConditionalExpression `true` direction and pins
      // the `=== "Stryker was here!"` StringLiteral mutant: a normal name must pass.
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'release-1',
          message: 'msg',
          extraHeaders: [],
        },
      };

      // Act
      const sut = new TextDecoder().decode(serializeTagContent(tag));

      // Assert
      expect(sut).toContain('tag release-1\n');
    });

    it('Given a tag with extraHeaders, When serializing, Then extra headers appear with continuation lines', () => {
      // Arrange
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'v1.0',
          tagger: {
            name: 'A',
            email: 'a@a.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          },
          message: 'msg',
          extraHeaders: [{ key: 'custom', value: 'line1\nline2' }],
        },
      };

      // Act
      const sut = new TextDecoder().decode(serializeTagContent(tag));

      // Assert
      expect(sut).toContain('custom line1\n line2\n');
    });
  });

  describe('roundtrip', () => {
    it('Given a tag, When roundtripping parse(serialize(tag)), Then all fields match', () => {
      // Arrange
      const tag: Tag = {
        type: 'tag',
        id: DUMMY_ID,
        data: {
          object: OBJ_ID,
          objectType: 'commit',
          tagName: 'v2.0',
          tagger: {
            name: 'Tagger',
            email: 'tagger@test.com',
            timestamp: 5000,
            timezoneOffset: '-0800',
          },
          message: 'Release v2.0\n\nDetailed description',
          gpgSignature: '-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----',
          extraHeaders: [{ key: 'custom', value: 'val' }],
        },
      };

      // Act
      const bytes = serializeTagContent(tag);
      const sut = parseTagContent(DUMMY_ID, bytes);

      // Assert
      expect(sut.data).toEqual(tag.data);
    });
  });

  describe('property-based tests', () => {
    it('Roundtrip: parseTagContent(id, serializeTagContent(tag)) preserves all fields', () => {
      // Arrange
      const arbIdentity = fc.record({
        name: fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes('<') && !s.includes('>') && !s.includes('\n')),
        email: fc
          .string({ maxLength: 20 })
          .filter(
            (s) => !s.includes('<') && !s.includes('>') && !s.includes(' ') && !s.includes('\n'),
          ),
        timestamp: fc.integer({ min: 0, max: 9999999999 }),
        timezoneOffset: fc
          .tuple(fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 12 }), fc.constantFrom(0, 30))
          .map(
            ([sign, h, m]) =>
              `${sign}${h.toString().padStart(2, '0')}${m.toString().padStart(2, '0')}`,
          ),
      });

      const arbTagData = fc.record({
        object: arbObjectId(40),
        objectType: fc.constantFrom(
          'blob' as const,
          'tree' as const,
          'commit' as const,
          'tag' as const,
        ),
        tagName: fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((s) => !s.includes('\0') && !s.includes('\n') && !s.includes(' ')),
        tagger: fc.option(arbIdentity, { nil: undefined }),
        message: fc.string({ maxLength: 100 }).filter((s) => !s.includes('\0')),
        extraHeaders: fc.constant(
          [] as ReadonlyArray<{ readonly key: string; readonly value: string }>,
        ),
      });

      // Assert
      fc.assert(
        fc.property(arbTagData, (data) => {
          const tagData =
            data.tagger !== undefined
              ? {
                  object: data.object,
                  objectType: data.objectType,
                  tagName: data.tagName,
                  tagger: data.tagger,
                  message: data.message,
                  extraHeaders: data.extraHeaders,
                }
              : {
                  object: data.object,
                  objectType: data.objectType,
                  tagName: data.tagName,
                  message: data.message,
                  extraHeaders: data.extraHeaders,
                };
          const tag: Tag = {
            type: 'tag',
            id: DUMMY_ID,
            data: tagData,
          };
          const bytes = serializeTagContent(tag);
          const sut = parseTagContent(DUMMY_ID, bytes);
          expect(sut.data).toEqual(tag.data);
        }),
      );
    });
  });
});

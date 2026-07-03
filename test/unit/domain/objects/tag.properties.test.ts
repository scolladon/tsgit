import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Tag, TagData } from '../../../../src/domain/objects/tag.js';
import { parseTagContent, serializeTagContent } from '../../../../src/domain/objects/tag.js';
import {
  arbArmorBlock,
  arbAuthorIdentity,
  arbObjectId,
  arbObjectType,
  arbTagName,
} from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

const ARMOR_START_PATTERN = /-----BEGIN (?:PGP|SSH) SIGNATURE-----/g;

function arbSignedTagData(): fc.Arbitrary<TagData> {
  return fc.record({
    object: arbObjectId(40),
    objectType: arbObjectType(),
    tagName: arbTagName(),
    tagger: arbAuthorIdentity(),
    message: fc
      .string({ maxLength: 100 })
      .filter((s) => !s.includes('\0') && !s.includes('-----BEGIN')),
    gpgSignature: arbArmorBlock(),
    extraHeaders: fc.constant([]),
  });
}

const buildSignedTag = (data: TagData): Tag => ({ type: 'tag', id: DUMMY_ID, data });

describe('tag signature properties', () => {
  describe('Given an arbitrary signed tag', () => {
    describe('When parsing the serialized bytes', () => {
      it('Then it round-trips to the same TagData', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSignedTagData(), (data) => {
            const tag = buildSignedTag(data);
            const bytes = serializeTagContent(tag);
            const result = parseTagContent(DUMMY_ID, bytes);
            expect(result.data).toEqual(tag.data);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When serialized then parsed', () => {
      it('Then exactly one appended armor block yields exactly one peeled signature', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSignedTagData(), (data) => {
            const tag = buildSignedTag(data);
            const bytes = serializeTagContent(tag);
            const text = new TextDecoder().decode(bytes);
            const armorStarts = text.match(ARMOR_START_PATTERN) ?? [];
            const result = parseTagContent(DUMMY_ID, bytes);
            expect(armorStarts).toHaveLength(1);
            expect(result.data.gpgSignature).toBe(data.gpgSignature);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

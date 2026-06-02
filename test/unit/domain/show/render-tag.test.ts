import { describe, expect, it } from 'vitest';

import type { AuthorIdentity, ObjectId, TagData } from '../../../../src/domain/objects/index.js';
import { renderTagBlock } from '../../../../src/domain/show/render-tag.js';

const OID = '1377f4f38aca6c947ec77a2abfebb713f0fde8d4' as ObjectId;
const tagger: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

const baseTag = (overrides: Partial<TagData> = {}): TagData => ({
  object: OID,
  objectType: 'commit',
  tagName: 'v1.0',
  tagger,
  message: 'release one\n',
  extraHeaders: [],
  ...overrides,
});

const taggerlessTag = (): TagData => ({
  object: OID,
  objectType: 'commit',
  tagName: 'v1.0',
  message: 'release one\n',
  extraHeaders: [],
});

describe('renderTagBlock', () => {
  describe('Given an annotated tag with a tagger, When renderTagBlock runs', () => {
    it('Then the header, tagger, date, and verbatim message are emitted', () => {
      // Arrange
      const tag = baseTag();

      // Act
      const sut = renderTagBlock(tag);

      // Assert
      expect(sut).toBe(
        'tag v1.0\nTagger: A U Thor <author@example.com>\nDate:   Tue Nov 14 22:13:20 2023 +0000\n\nrelease one\n',
      );
    });
  });

  describe('Given a tag without a tagger, When renderTagBlock runs', () => {
    it('Then the Tagger and Date lines are omitted', () => {
      // Arrange
      const tag = taggerlessTag();

      // Act
      const sut = renderTagBlock(tag);

      // Assert
      expect(sut).toBe('tag v1.0\n\nrelease one\n');
    });
  });

  describe('Given a tag whose stored name differs from any input, When renderTagBlock runs', () => {
    it('Then the header uses the stored tag name', () => {
      // Arrange
      const tag = baseTag({ tagName: 'release-2' });

      // Act
      const sut = renderTagBlock(tag);

      // Assert
      expect(sut.startsWith('tag release-2\n')).toBe(true);
    });
  });
});

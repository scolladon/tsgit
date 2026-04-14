import { describe, expect, it } from 'vitest';
import type { Blob } from '../../../../src/domain/objects/blob.js';
import type { Commit } from '../../../../src/domain/objects/commit.js';
import { encode } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import { parseObject, serializeObject } from '../../../../src/domain/objects/git-object.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Tree } from '../../../../src/domain/objects/tree.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

function rawBlob(content: string): Uint8Array {
  const body = encode(content);
  const header = encode(`blob ${body.length}\0`);
  const result = new Uint8Array(header.length + body.length);
  result.set(header, 0);
  result.set(body, header.length);
  return result;
}

function rawTreeEntry(mode: string, name: string, sha: Uint8Array): Uint8Array {
  const modeBytes = encode(mode);
  const nameBytes = encode(name);
  const result = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + sha.length);
  result.set(modeBytes, 0);
  result[modeBytes.length] = 0x20;
  result.set(nameBytes, modeBytes.length + 1);
  result[modeBytes.length + 1 + nameBytes.length] = 0x00;
  result.set(sha, modeBytes.length + 1 + nameBytes.length + 1);
  return result;
}

function rawTree(entries: Uint8Array): Uint8Array {
  const header = encode(`tree ${entries.length}\0`);
  const result = new Uint8Array(header.length + entries.length);
  result.set(header, 0);
  result.set(entries, header.length);
  return result;
}

function rawCommit(text: string): Uint8Array {
  const body = encode(text);
  const header = encode(`commit ${body.length}\0`);
  const result = new Uint8Array(header.length + body.length);
  result.set(header, 0);
  result.set(body, header.length);
  return result;
}

function rawTag(text: string): Uint8Array {
  const body = encode(text);
  const header = encode(`tag ${body.length}\0`);
  const result = new Uint8Array(header.length + body.length);
  result.set(header, 0);
  result.set(body, header.length);
  return result;
}

describe('git-object', () => {
  describe('parseObject', () => {
    it('Given raw blob bytes (header + content), When calling parseObject, Then returns Blob with correct content', () => {
      // Arrange
      const raw = rawBlob('hello world');

      // Act
      const sut = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Assert
      expect(sut.type).toBe('blob');
      expect(new TextDecoder().decode((sut as Blob).content)).toBe('hello world');
    });

    it('Given raw tree bytes (header + content), When calling parseObject, Then returns Tree with correct entries', () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const entry = rawTreeEntry('100644', 'file.txt', sha);
      const raw = rawTree(entry);

      // Act
      const sut = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Assert
      expect(sut.type).toBe('tree');
      expect((sut as Tree).entries).toHaveLength(1);
      expect((sut as Tree).entries[0]!.name).toBe('file.txt');
    });

    it('Given raw commit bytes (header + content), When calling parseObject, Then returns Commit with correct fields', () => {
      // Arrange
      const commitText = [
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'msg',
      ].join('\n');
      const raw = rawCommit(commitText);

      // Act
      const sut = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Assert
      expect(sut.type).toBe('commit');
      expect((sut as Commit).data.message).toBe('msg');
    });

    it('Given raw tag bytes (header + content), When calling parseObject, Then returns Tag with correct fields', () => {
      // Arrange
      const tagText = [
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
        '',
        'tag msg',
      ].join('\n');
      const raw = rawTag(tagText);

      // Act
      const sut = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Assert
      expect(sut.type).toBe('tag');
    });

    it('Given raw bytes with invalid header type, When calling parseObject, Then throws INVALID_OBJECT_HEADER', () => {
      // Arrange
      const raw = encode('invalid 5\0hello');

      // Act & Assert
      expect(() => parseObject(DUMMY_ID, raw, SHA1_CONFIG)).toThrow(TsgitError);
    });

    it('Given header size != actual content length, When calling parseObject, Then throws INVALID_OBJECT_HEADER with size mismatch reason', () => {
      // Arrange
      const raw = encode('blob 999\0short');

      // Act & Assert
      expect(() => parseObject(DUMMY_ID, raw, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_OBJECT_HEADER',
            reason: 'size mismatch: header says 999, actual content is 5',
          }),
        }),
      );
    });
  });

  describe('serializeObject', () => {
    it('Given a Blob, When calling serializeObject, Then produces header + content bytes', () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        id: DUMMY_ID,
        content: encode('hello'),
      };

      // Act
      const sut = serializeObject(blob, SHA1_CONFIG);

      // Assert
      const expected = rawBlob('hello');
      expect(sut).toEqual(expected);
    });

    it('Given a Tree, When calling serializeObject, Then produces header + content bytes', () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const entry = rawTreeEntry('100644', 'file.txt', sha);
      const rawInput = rawTree(entry);
      const tree = parseObject(DUMMY_ID, rawInput, SHA1_CONFIG) as Tree;

      // Act
      const sut = serializeObject(tree, SHA1_CONFIG);

      // Assert
      expect(sut).toEqual(rawInput);
    });

    it('Given a Commit, When calling serializeObject, Then produces header + content bytes', () => {
      // Arrange
      const commitText = [
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'msg',
      ].join('\n');
      const raw = rawCommit(commitText);
      const commit = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Act
      const sut = serializeObject(commit, SHA1_CONFIG);

      // Assert
      expect(sut).toEqual(raw);
    });

    it('Given a Tag, When calling serializeObject, Then produces header + content bytes', () => {
      // Arrange
      const tagText = [
        `object ${'b'.repeat(40)}`,
        'type commit',
        'tag v1.0',
        'tagger A <a@a.com> 0 +0000',
        '',
        'tag msg',
      ].join('\n');
      const raw = rawTag(tagText);
      const tag = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Act
      const sut = serializeObject(tag, SHA1_CONFIG);

      // Assert
      expect(sut).toEqual(raw);
    });
  });

  describe('roundtrip', () => {
    it('Given any GitObject, When roundtripping parseObject(serializeObject(obj)), Then equals original', () => {
      // Arrange
      const commitText = [
        `tree ${'b'.repeat(40)}`,
        `parent ${'c'.repeat(40)}`,
        'author Alice <alice@test.com> 1000 +0200',
        'committer Bob <bob@test.com> 2000 -0500',
        '',
        'test commit',
      ].join('\n');
      const raw = rawCommit(commitText);
      const commit = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

      // Act
      const serialized = serializeObject(commit, SHA1_CONFIG);
      const sut = parseObject(DUMMY_ID, serialized, SHA1_CONFIG);

      // Assert
      expect(sut).toEqual(commit);
    });
  });
});

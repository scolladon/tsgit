import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob } from '../../../../src/domain/objects/blob.js';
import type { Commit } from '../../../../src/domain/objects/commit.js';
import { encode } from '../../../../src/domain/objects/encoding.js';
import {
  parseObject,
  serializeObject,
  splitObject,
} from '../../../../src/domain/objects/git-object.js';
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
    describe('Given raw blob bytes (header + content)', () => {
      describe('When calling parseObject', () => {
        it('Then returns Blob with correct content', () => {
          // Arrange
          const raw = rawBlob('hello world');

          // Act
          const result = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe('blob');
          expect(new TextDecoder().decode((result as Blob).content)).toBe('hello world');
        });
      });
    });

    describe('Given raw tree bytes (header + content)', () => {
      describe('When calling parseObject', () => {
        it('Then returns Tree with correct entries', () => {
          // Arrange
          const sha = new Uint8Array(20).fill(0xab);
          const entry = rawTreeEntry('100644', 'file.txt', sha);
          const raw = rawTree(entry);

          // Act
          const result = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe('tree');
          expect((result as Tree).entries).toHaveLength(1);
          expect((result as Tree).entries[0]!.name).toBe('file.txt');
        });
      });
    });

    describe('Given raw commit bytes (header + content)', () => {
      describe('When calling parseObject', () => {
        it('Then returns Commit with correct fields', () => {
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
          const result = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe('commit');
          expect((result as Commit).data.message).toBe('msg');
        });
      });
    });

    describe('Given raw tag bytes (header + content)', () => {
      describe('When calling parseObject', () => {
        it('Then returns Tag with correct fields', () => {
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
          const result = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe('tag');
        });
      });
    });

    describe('Given raw bytes that fail a parseObject validation guard', () => {
      describe('When calling parseObject', () => {
        it.each([
          {
            raw: 'invalid 5\0hello',
            reason: 'unknown object type: invalid',
            label: 'an invalid header type',
          },
          {
            raw: 'blob 999\0short',
            reason: 'size mismatch: header says 999, actual content is 5',
            label: 'a header size that does not match the actual content length',
          },
        ])(
          // Pin the exact reason string per guard so a StringLiteral mutant on
          // either template literal cannot survive.
          'Then throws INVALID_OBJECT_HEADER with $label',
          ({ raw, reason }) => {
            // Arrange
            const bytes = encode(raw);

            // Act + Assert
            expect(() => parseObject(DUMMY_ID, bytes, SHA1_CONFIG)).toThrow(
              expect.objectContaining({
                data: expect.objectContaining({
                  code: 'INVALID_OBJECT_HEADER',
                  reason,
                }),
              }),
            );
          },
        );
      });
    });
  });

  describe('splitObject', () => {
    describe('Given a loose-format buffer for each object type', () => {
      describe('When calling splitObject', () => {
        it.each([
          { label: 'a blob', raw: () => rawBlob('hello'), type: 'blob' },
          {
            label: 'a tree',
            raw: () => rawTree(rawTreeEntry('100644', 'file.txt', new Uint8Array(20).fill(0xab))),
            type: 'tree',
          },
          {
            label: 'a commit',
            raw: () =>
              rawCommit(
                [
                  `tree ${'b'.repeat(40)}`,
                  'author A <a@a.com> 0 +0000',
                  'committer A <a@a.com> 0 +0000',
                  '',
                  'msg',
                ].join('\n'),
              ),
            type: 'commit',
          },
          {
            label: 'a tag',
            raw: () =>
              rawTag(
                [
                  `object ${'b'.repeat(40)}`,
                  'type commit',
                  'tag v1.0',
                  'tagger A <a@a.com> 0 +0000',
                  '',
                  'tag msg',
                ].join('\n'),
              ),
            type: 'tag',
          },
        ])('Then returns { type: $type, content } for $label', ({ raw, type }) => {
          // Arrange
          const sut = splitObject;
          const bytes = raw();

          // Act
          const result = sut(bytes);

          // Assert
          expect(result.type).toBe(type);
          expect(result.content).toEqual(bytes.subarray(bytes.indexOf(0) + 1));
        });
      });
    });

    describe('Given a loose-format buffer whose header size does not match the actual content length', () => {
      describe('When calling splitObject', () => {
        it('Then throws INVALID_OBJECT_HEADER with the exact size-mismatch reason', () => {
          // Arrange
          const sut = splitObject;
          const bytes = encode('blob 999\0short');

          // Act
          try {
            sut(bytes);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_OBJECT_HEADER');
            if (data.code === 'INVALID_OBJECT_HEADER') {
              expect(data.reason).toBe('size mismatch: header says 999, actual content is 5');
            }
          }
        });
      });
    });

    describe('Given the same size-mismatched buffer routed through parseObject', () => {
      describe('When calling parseObject', () => {
        it('Then throws the identical INVALID_OBJECT_HEADER reason (proves the shared split)', () => {
          // Arrange
          const sut = parseObject;
          const bytes = encode('blob 999\0short');

          // Act
          try {
            sut(DUMMY_ID, bytes, SHA1_CONFIG);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_OBJECT_HEADER');
            if (data.code === 'INVALID_OBJECT_HEADER') {
              expect(data.reason).toBe('size mismatch: header says 999, actual content is 5');
            }
          }
        });
      });
    });
  });

  describe('serializeObject', () => {
    describe('Given a Blob', () => {
      describe('When calling serializeObject', () => {
        it('Then produces header + content bytes', () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            id: DUMMY_ID,
            content: encode('hello'),
          };

          // Act
          const result = serializeObject(blob, SHA1_CONFIG);

          // Assert
          const expected = rawBlob('hello');
          expect(result).toEqual(expected);
        });
      });
    });

    describe('Given a Tree, Commit, or Tag parsed from raw bytes', () => {
      describe('When calling serializeObject', () => {
        it.each([
          {
            label: 'a Tree',
            buildRaw: () => {
              const sha = new Uint8Array(20).fill(0xab);
              const entry = rawTreeEntry('100644', 'file.txt', sha);
              return rawTree(entry);
            },
          },
          {
            label: 'a Commit',
            buildRaw: () =>
              rawCommit(
                [
                  `tree ${'b'.repeat(40)}`,
                  'author A <a@a.com> 0 +0000',
                  'committer A <a@a.com> 0 +0000',
                  '',
                  'msg',
                ].join('\n'),
              ),
          },
          {
            label: 'a Tag',
            buildRaw: () =>
              rawTag(
                [
                  `object ${'b'.repeat(40)}`,
                  'type commit',
                  'tag v1.0',
                  'tagger A <a@a.com> 0 +0000',
                  '',
                  'tag msg',
                ].join('\n'),
              ),
          },
        ])('Then $label produces header + content bytes', ({ buildRaw }) => {
          // Arrange
          const raw = buildRaw();
          const object = parseObject(DUMMY_ID, raw, SHA1_CONFIG);

          // Act
          const result = serializeObject(object, SHA1_CONFIG);

          // Assert
          expect(result).toEqual(raw);
        });
      });
    });
  });

  describe('roundtrip', () => {
    describe('Given any GitObject', () => {
      describe('When roundtripping parseObject(serializeObject(obj))', () => {
        it('Then equals original', () => {
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
          const result = parseObject(DUMMY_ID, serialized, SHA1_CONFIG);

          // Assert
          expect(result).toEqual(commit);
        });
      });
    });
  });
});

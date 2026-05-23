import { describe, expect, it } from 'vitest';
import { parseBlobContent } from '../../../../src/domain/objects/blob.js';
import type { Commit } from '../../../../src/domain/objects/commit.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import { serializeObject } from '../../../../src/domain/objects/git-object.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { parseHeader } from '../../../../src/domain/objects/header.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { payloadByteLength } from '../../../../src/domain/objects/size.js';
import type { Tag } from '../../../../src/domain/objects/tag.js';
import type { Tree, TreeEntry } from '../../../../src/domain/objects/tree.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));
const OTHER_ID = ObjectId.from('b'.repeat(40));

const IDENTITY = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const buildTree = (): Tree => {
  const entries: ReadonlyArray<TreeEntry> = [
    { mode: FILE_MODE.REGULAR, name: 'README.md', id: OTHER_ID },
    { mode: FILE_MODE.REGULAR, name: 'package.json', id: OTHER_ID },
  ];
  return { type: 'tree', id: DUMMY_ID, entries };
};

const buildCommit = (): Commit => ({
  type: 'commit',
  id: DUMMY_ID,
  data: {
    tree: OTHER_ID,
    parents: [],
    author: IDENTITY,
    committer: IDENTITY,
    message: 'hello',
    extraHeaders: [],
  },
});

const buildTag = (): Tag => ({
  type: 'tag',
  id: DUMMY_ID,
  data: {
    object: OTHER_ID,
    objectType: 'commit',
    tagName: 'v1.0.0',
    tagger: IDENTITY,
    message: 'release',
    extraHeaders: [],
  },
});

describe('payloadByteLength', () => {
  it('Given a blob, When measured, Then size equals content.byteLength', () => {
    // Arrange
    const content = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = parseBlobContent(DUMMY_ID, content);

    // Act
    const sut = payloadByteLength(blob, SHA1_CONFIG);

    // Assert
    expect(sut).toBe(content.byteLength);
  });

  it('Given an empty blob, When measured, Then size is 0', () => {
    // Arrange
    const blob = parseBlobContent(DUMMY_ID, new Uint8Array(0));

    // Act
    const sut = payloadByteLength(blob, SHA1_CONFIG);

    // Assert
    expect(sut).toBe(0);
  });

  it('Given a tree, When measured, Then size equals the header size of its on-disk encoding', () => {
    // Arrange — cross-check via `serializeObject` + `parseHeader` so a
    // type-swap mutant inside `payloadByteLength` cannot pass by routing
    // through the same serializer.
    const tree = buildTree();
    const onDiskBytes = serializeObject(tree, SHA1_CONFIG);
    const expected = parseHeader(onDiskBytes).size;

    // Act
    const sut = payloadByteLength(tree, SHA1_CONFIG);

    // Assert
    expect(sut).toBe(expected);
  });

  it('Given a commit, When measured, Then size equals the header size of its on-disk encoding', () => {
    // Arrange
    const commit = buildCommit();
    const onDiskBytes = serializeObject(commit, SHA1_CONFIG);
    const expected = parseHeader(onDiskBytes).size;

    // Act
    const sut = payloadByteLength(commit, SHA1_CONFIG);

    // Assert
    expect(sut).toBe(expected);
  });

  it('Given a tag, When measured, Then size equals the header size of its on-disk encoding', () => {
    // Arrange
    const tag = buildTag();
    const onDiskBytes = serializeObject(tag, SHA1_CONFIG);
    const expected = parseHeader(onDiskBytes).size;

    // Act
    const sut = payloadByteLength(tag, SHA1_CONFIG);

    // Assert
    expect(sut).toBe(expected);
  });
});

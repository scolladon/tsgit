import type { Blob } from './blob.js';
import { parseBlobContent, serializeBlobContent } from './blob.js';
import type { Commit } from './commit.js';
import { parseCommitContent, serializeCommitContent } from './commit.js';
import { invalidObjectHeader } from './error.js';
import type { HashConfig } from './hash-config.js';
import { parseHeader, serializeHeader } from './header.js';
import type { ObjectId } from './object-id.js';
import type { Tag } from './tag.js';
import { parseTagContent, serializeTagContent } from './tag.js';
import type { Tree } from './tree.js';
import { parseTreeContent, serializeTreeContent } from './tree.js';

export type GitObject = Blob | Tree | Commit | Tag;

export function parseObject(id: ObjectId, rawBytes: Uint8Array, hash: HashConfig): GitObject {
  const { type, size, contentOffset } = parseHeader(rawBytes);
  const content = rawBytes.subarray(contentOffset);

  if (content.length !== size) {
    throw invalidObjectHeader(
      `size mismatch: header says ${size}, actual content is ${content.length}`,
    );
  }

  switch (type) {
    case 'blob':
      return parseBlobContent(id, content);
    case 'tree':
      return parseTreeContent(id, content, hash);
    case 'commit':
      return parseCommitContent(id, content);
    case 'tag':
      return parseTagContent(id, content);
  }
}

export function serializeObject(object: GitObject, hash: HashConfig): Uint8Array {
  let contentBytes: Uint8Array;

  switch (object.type) {
    case 'blob':
      contentBytes = serializeBlobContent(object);
      break;
    case 'tree':
      contentBytes = serializeTreeContent(object, hash);
      break;
    case 'commit':
      contentBytes = serializeCommitContent(object);
      break;
    case 'tag':
      contentBytes = serializeTagContent(object);
      break;
  }

  const header = serializeHeader(object.type, contentBytes.length);
  const result = new Uint8Array(header.length + contentBytes.length);
  result.set(header, 0);
  result.set(contentBytes, header.length);
  return result;
}

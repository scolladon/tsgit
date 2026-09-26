import type { Blob } from './blob.js';
import { parseBlobContent, serializeBlobContent } from './blob.js';
import type { Commit } from './commit.js';
import { parseCommitContent, serializeCommitContent } from './commit.js';
import { invalidObjectHeader } from './error.js';
import type { HashConfig } from './hash-config.js';
import { type ObjectType, parseHeader, serializeHeader } from './header.js';
import type { ObjectId } from './object-id.js';
import type { Tag } from './tag.js';
import { parseTagContent, serializeTagContent } from './tag.js';
import type { Tree } from './tree.js';
import { parseTreeContent, serializeTreeContent } from './tree.js';

export type GitObject = Blob | Tree | Commit | Tag;

export interface ObjectContent {
  readonly type: ObjectType;
  readonly content: Uint8Array;
}

export function sizeMismatch(declaredSize: number, actualSize: number) {
  return invalidObjectHeader(
    `size mismatch: header says ${declaredSize}, actual content is ${actualSize}`,
  );
}

export interface LooseObjectSplit extends ObjectContent {
  readonly declaredSize: number;
}

/** The loose-object split with the header's size claim kept as data, never enforced. */
export function splitLooseObject(rawBytes: Uint8Array): LooseObjectSplit {
  const { type, size, contentOffset } = parseHeader(rawBytes);
  return { type, content: rawBytes.subarray(contentOffset), declaredSize: size };
}

/** git's buffered tier refuses a size-lying commit, tree or tag; a blob takes the streaming contract. */
export function assertLooseSizeConsistent(split: LooseObjectSplit): void {
  if (split.type === 'blob' || split.declaredSize === split.content.byteLength) return;
  throw sizeMismatch(split.declaredSize, split.content.byteLength);
}

/**
 * How a loose object's ACTUAL content length compares to its header's size
 * claim — git's `unpack_loose_rest` verdict once the buffered tier's inflate
 * has already bounded the body to `header + claim` (object-resolver.ts's
 * `inflateLooseBuffered`), so `'truncate'` is only ever reachable for a body
 * that overran the claim while still fitting inside git's 32-byte header
 * window (a longer overrun is refused earlier, before this ever runs). A
 * commit, tree or tag disagreeing at all is `'refuse'`.
 */
export type LooseBodyVerdict = 'honest' | 'truncate' | 'underrun' | 'refuse';

/** Classifies a loose blob's body against its header claim for the buffered
 *  tier (object-resolver.ts's `applyLooseVerdict`) — never enforces
 *  anything itself, so the caller stays free to route each verdict as git's
 *  buffered read does. */
export function classifyLooseBody(split: LooseObjectSplit): LooseBodyVerdict {
  const { type, content, declaredSize } = split;
  if (content.byteLength === declaredSize) return 'honest';
  if (type !== 'blob') return 'refuse';
  return content.byteLength > declaredSize ? 'truncate' : 'underrun';
}

export function splitObject(rawBytes: Uint8Array): {
  readonly type: ObjectType;
  readonly content: Uint8Array;
  readonly bytes: Uint8Array;
} {
  const { type, content, declaredSize } = splitLooseObject(rawBytes);

  if (content.length !== declaredSize) {
    throw sizeMismatch(declaredSize, content.length);
  }

  return { type, content, bytes: rawBytes };
}

export function parseObject(id: ObjectId, rawBytes: Uint8Array, hash: HashConfig): GitObject {
  const { type, content } = splitObject(rawBytes);

  return parseObjectContent(id, type, content, hash);
}

export function parseObjectContent(
  id: ObjectId,
  type: ObjectType,
  content: Uint8Array,
  hash: HashConfig,
): GitObject {
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

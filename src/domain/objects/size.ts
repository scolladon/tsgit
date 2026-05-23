import { serializeCommitContent } from './commit.js';
import type { GitObject } from './git-object.js';
import type { HashConfig } from './hash-config.js';
import { serializeTagContent } from './tag.js';
import { serializeTreeContent } from './tree.js';

/**
 * Length in bytes of an object's canonical payload — the body that follows
 * `<type> <size>\0` on disk. Equal to the `size` field of git's
 * `cat-file --batch` header.
 *
 * Blobs are O(1) (a slice of an existing buffer). Trees / commits / tags
 * re-serialise the body to measure it; that matches the cost of
 * `serializeObject` and is the price of not threading the on-disk size
 * through the read pipeline. Acceptable for v1 — see
 * `docs/design/cat-file-batch.md` §4.1.
 */
export const payloadByteLength = (object: GitObject, hash: HashConfig): number => {
  switch (object.type) {
    case 'blob':
      return object.content.byteLength;
    case 'tree':
      return serializeTreeContent(object, hash).byteLength;
    case 'commit':
      return serializeCommitContent(object).byteLength;
    case 'tag':
      return serializeTagContent(object).byteLength;
  }
};

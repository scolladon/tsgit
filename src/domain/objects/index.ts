// Value objects — companion object pattern (type + value share a name)

export type { AuthorIdentity } from './author-identity.js';
export { parseIdentity, serializeIdentity } from './author-identity.js';
// Blob
export type { Blob } from './blob.js';
export { parseBlobContent, serializeBlobContent } from './blob.js';
// Commit
export type { Commit, CommitData, ExtraHeader } from './commit.js';
export { parseCommitContent, serializeCommitContent } from './commit.js';
// Commit message
export { stripspace } from './commit-message.js';
// Encoding (public subset)
export { bytesEqual, bytesToHex, compareBytes, hexToBytes } from './encoding.js';
// Errors
export type { DomainObjectError } from './error.js';
export {
  invalidCommit,
  invalidFileMode,
  invalidIdentity,
  invalidObjectHeader,
  invalidObjectId,
  invalidTag,
  invalidTreeEntry,
  TsgitError,
} from './error.js';
export type { FileMode } from './file-mode.js';
export {
  deriveWorkingMode,
  FILE_MODE,
  isDirectory,
  normalizeFileMode,
  validateFileMode,
} from './file-mode.js';
// GitObject
export type { GitObject } from './git-object.js';
export { parseObject, serializeObject } from './git-object.js';
export type { HashConfig } from './hash-config.js';
export { SHA1_CONFIG, SHA256_CONFIG } from './hash-config.js';
// Object header
export type { ObjectType } from './header.js';
export { parseHeader, serializeHeader } from './header.js';
export * from './object-id.js';
// Payload size
export { payloadByteLength } from './size.js';

// Tag
export type { Tag, TagData } from './tag.js';
export { parseTagContent, serializeTagContent } from './tag.js';
// Tree
export type { Tree, TreeEntry } from './tree.js';
export {
  parseTreeContent,
  serializeTreeContent,
  sortTreeEntries,
  treeEntryCompare,
} from './tree.js';

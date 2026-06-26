import type { FsckObjectType, FsckSeverity } from './types.js';
import { validateBlob } from './validate-blob.js';
import { validateCommit } from './validate-commit.js';
import { validateTag } from './validate-tag.js';
import { validateTree } from './validate-tree.js';

export interface ValidateObjectInput {
  /** The decompressed raw object body (without the git loose-object header). */
  readonly rawBody: Uint8Array;
  /** The declared object kind. */
  readonly kind: FsckObjectType;
  /** When true, WARN-class msg-ids are upgraded to ERROR. */
  readonly strict: boolean;
  /**
   * For blob objects: the file name this blob is stored as in its parent tree.
   * Required for special-file content checks (.gitmodules, .gitattributes).
   */
  readonly fileName?: string;
}

export interface ObjectFinding {
  readonly msgId: string;
  readonly severity: FsckSeverity;
}

/**
 * Validate a raw git object body against the fsck msg-id catalogue.
 *
 * This function operates on the raw decompressed object body (not the parsed
 * domain object) because tsgit's parsers normalise or reject exactly the faults
 * the catalogue classifies (e.g. zero-padded modes are discarded by
 * `normalizeFileMode`; bad entry names and duplicate names never reach a
 * parsed Tree). Parsing is done tolerantly here so every catalogue check
 * remains detectable.
 *
 * Returns an ordered list of `{ msgId, severity }` pairs for every check the
 * object fails. Severity is already adjusted for `strict`. The function NEVER
 * throws — it classifies faults and returns them.
 */
export function validateObject(input: ValidateObjectInput): ReadonlyArray<ObjectFinding> {
  const { rawBody, kind, strict, fileName } = input;
  switch (kind) {
    case 'tree':
      return validateTree(rawBody, strict);
    case 'commit':
      return validateCommit(rawBody, strict);
    case 'tag':
      return validateTag(rawBody, strict);
    case 'blob':
      return validateBlob(rawBody, strict, fileName);
  }
}

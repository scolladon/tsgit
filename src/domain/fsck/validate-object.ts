import type { HashConfig } from '../objects/hash-config.js';
import type { FsckSeverity } from './types.js';
import { validateBlob } from './validate-blob.js';
import { validateCommit } from './validate-commit.js';
import { validateTag } from './validate-tag.js';
import { validateTree } from './validate-tree.js';

interface ValidateObjectInputBase {
  /** The decompressed raw object body (without the git loose-object header). */
  readonly rawBody: Uint8Array;
  /** When true, WARN-class msg-ids are upgraded to ERROR. */
  readonly strict: boolean;
}

export type ValidateObjectInput =
  | (ValidateObjectInputBase & {
      readonly kind: 'tree';
      /** The repository's hash config — a raw tree's binary shas carry no width marker of their own. */
      readonly hashConfig: HashConfig;
    })
  | (ValidateObjectInputBase & {
      readonly kind: 'commit';
      /** The repository's hash config — fixes the width `tree`/`parent` oids must be. */
      readonly hashConfig: HashConfig;
    })
  | (ValidateObjectInputBase & {
      readonly kind: 'tag';
      /** The repository's hash config — fixes the width the `object` oid must be. */
      readonly hashConfig: HashConfig;
    })
  | (ValidateObjectInputBase & {
      readonly kind: 'blob';
      /**
       * The file name this blob is stored as in its parent tree. Required for
       * special-file content checks (.gitmodules, .gitattributes).
       */
      readonly fileName?: string;
    });

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
  switch (input.kind) {
    case 'tree':
      return validateTree(input.rawBody, input.strict, input.hashConfig.digestLength);
    case 'commit':
      return validateCommit(input.rawBody, input.strict, input.hashConfig);
    case 'tag':
      return validateTag(input.rawBody, input.strict, input.hashConfig);
    case 'blob':
      return validateBlob(input.rawBody, input.strict, input.fileName);
  }
}

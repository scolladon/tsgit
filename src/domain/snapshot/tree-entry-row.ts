import type { FileMode } from '../objects/file-mode.js';
import type { FilePath, ObjectId } from '../objects/object-id.js';

/**
 * Pure data shape for a tree-source row. Carried inside `TreeEntry`
 * (application tier) which adds I/O methods. Domain layering rule:
 * this file has zero outward imports beyond `domain/objects/`.
 */
export interface TreeEntryRow {
  readonly source: 'tree';
  readonly path: FilePath;
  readonly oid: ObjectId;
  readonly mode: FileMode;
  readonly kind: 'file' | 'symlink' | 'submodule';
}

import type { FileMode } from '../objects/file-mode.js';
import type { FilePath, ObjectId } from '../objects/object-id.js';

/** One entry in an archive export — path, raw git mode, object id, and optional content. */
export interface ArchiveEntry {
  /** Repo-relative path of this entry (slash-joined, pre-order). */
  readonly path: FilePath;
  /** Raw git mode exactly as stored in the tree object. */
  readonly mode: FileMode;
  /** Object id of this entry (blob, tree, or gitlink commit oid). */
  readonly oid: ObjectId;
  /**
   * Raw blob bytes. Present only for regular, exec, and symlink entries
   * (symlink: the link-target bytes). Absent for directory and gitlink
   * entries — serializer-side framing decides how those are encoded.
   */
  readonly content?: Uint8Array;
}

/** Structured result of `archive` — resolved tree metadata + lazy entry stream. */
export interface ArchiveResult {
  /** The resolved tree object id that was exported. */
  readonly tree: ObjectId;
  /**
   * Peeled commit oid. Present when the treeish resolved through a commit
   * (direct or via an annotated tag). Absent for a bare tree treeish.
   */
  readonly commit?: ObjectId;
  /**
   * Committer epoch seconds. Present when `commit` is present. Used by
   * serializers as the default mtime for archive entries.
   */
  readonly commitTime?: number;
  /** Lazy entry stream — blob bytes are hydrated per-entry, not upfront. */
  readonly entries: AsyncIterable<ArchiveEntry>;
}

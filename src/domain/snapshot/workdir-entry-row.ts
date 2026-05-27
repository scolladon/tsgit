import type { FileMode } from '../objects/file-mode.js';
import type { FilePath } from '../objects/object-id.js';

/**
 * Platform-abstracted stat shape for working-tree entries. Aligns with
 * `src/ports/file-system.ts:FileStat` — `mtimeNs` and `ino` are optional so
 * the browser adapter (which exposes neither) can satisfy the shape.
 *
 * `mode` is included so race detection covers chmod-only changes
 * (executable-bit flips, permission tweaks). Racy-stat detection prefers
 * `mtimeNs` when present, falls back to `mtimeMs`, and falls back further
 * to SHA-trailer comparison for the index file specifically.
 */
export interface WorkdirStat {
  readonly mode: FileMode;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs?: bigint;
  readonly ino?: bigint;
}

/**
 * Pure data shape for a working-tree row. `kind` discriminates the four
 * entry shapes the walker emits; the surfaced `mode` field mirrors
 * `stat.mode` for ergonomic access.
 */
export interface WorkdirEntryRow {
  readonly source: 'workdir';
  readonly path: FilePath;
  readonly mode: FileMode;
  readonly kind: 'file' | 'symlink' | 'directory' | 'submodule';
  readonly stat: WorkdirStat;
}

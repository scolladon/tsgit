import type { DiffChange } from './diff-change.js';

export interface PatchFile {
  readonly change: DiffChange;
  readonly oldContent?: Uint8Array;
  readonly newContent?: Uint8Array;
}

export interface PatchPathPrefix {
  readonly old: string;
  readonly new: string;
}

export interface PatchOptions {
  readonly contextLines?: number;
  readonly pathPrefix?: PatchPathPrefix;
}

export function renderPatch(files: ReadonlyArray<PatchFile>, _opts?: PatchOptions): string {
  if (files.length === 0) return '';
  return '';
}

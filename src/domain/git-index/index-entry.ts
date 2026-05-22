import type { FileMode, FilePath, ObjectId } from '../objects/index.js';

export interface IndexEntryFlags {
  readonly assumeValid: boolean;
  readonly stage: 0 | 1 | 2 | 3;
  /** Index v3 extended flag — the path is intentionally absent from the working tree. */
  readonly skipWorktree: boolean;
  /** Index v3 extended flag — `git add -N` placeholder. Modelled for faithful round-tripping. */
  readonly intentToAdd: boolean;
}

/** The common case — a freshly staged, materialised, stage-0 entry. */
export const STAGE0_FLAGS: IndexEntryFlags = {
  assumeValid: false,
  stage: 0,
  skipWorktree: false,
  intentToAdd: false,
};

export interface IndexEntry {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: FileMode;
  readonly uid: number;
  readonly gid: number;
  readonly fileSize: number;
  readonly id: ObjectId;
  readonly flags: IndexEntryFlags;
  readonly path: FilePath;
}

export interface IndexExtension {
  readonly signature: string;
  readonly data: Uint8Array;
}

export interface GitIndex {
  readonly version: 2 | 3;
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly extensions: ReadonlyArray<IndexExtension>;
}

export interface StatData {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: FileMode;
  readonly uid: number;
  readonly gid: number;
  readonly fileSize: number;
}

export function isStatClean(entry: IndexEntry, stat: StatData): boolean {
  return (
    entry.ctimeSeconds === stat.ctimeSeconds &&
    entry.ctimeNanoseconds === stat.ctimeNanoseconds &&
    entry.mtimeSeconds === stat.mtimeSeconds &&
    entry.mtimeNanoseconds === stat.mtimeNanoseconds &&
    entry.dev === stat.dev &&
    entry.ino === stat.ino &&
    entry.mode === stat.mode &&
    entry.uid === stat.uid &&
    entry.gid === stat.gid &&
    entry.fileSize === stat.fileSize
  );
}

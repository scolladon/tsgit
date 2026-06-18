// Shared public type surface — facade-reachable type closure re-exported by all
// runtime entries and by index.ts so both the `exports`-resolved surface and the
// `module`/`types`-resolved surface expose the identical type set.

// command result/option/namespace types (all *Options/*Result/*Input/*Info/*Entry/*Namespace);
// the diff change types also ride this barrel — see the diff barrel below.
export type * from './application/commands/index.js';
// primitive param/return types (*Options/*Input/*Entry from primitives/types.js).
// Values (readObject, writeObject, mergeBase, …) are dropped by export type *.
export type * from './application/primitives/index.js';
// snapshot family: no snapshot/index.ts barrel — enumerate the same files as index.ts.
// Explicit named re-exports WIN over the domain/objects and domain/git-index wildcards for the
// duplicate names TreeEntry and IndexEntry (explicit beats wildcard — semantics probed clean).
export type { IndexEntry } from './application/primitives/snapshot/index-entry.js';
export type {
  IndexSnapshot,
  Snapshot,
  SnapshotEntry,
  SnapshotOptions,
  TreeSnapshot,
  WorkdirSnapshot,
} from './application/primitives/snapshot/snapshot.js';
export type { SnapshotFactory } from './application/primitives/snapshot/snapshot-factory.js';
export type { StashSnapshot } from './application/primitives/snapshot/stash-snapshot.js';
export type { TreeEntry } from './application/primitives/snapshot/tree-entry.js';
export type { WorkdirEntry } from './application/primitives/snapshot/workdir-entry.js';
export type { WorkdirSnapshotOptions } from './application/primitives/snapshot/workdir-snapshot.js';
// diff types including ConflictKind, LineDiff, LineHunk, RenameDetectOptions,
// ModeKind, FlatTree, GroupedIndex, and patch-serializer types.
// Diff change types (TreeDiff etc.) appear in both commands and domain/diff barrels but trace
// to the SAME original declarations — benign dedupe, no TS2308.
export type * from './domain/diff/index.js';
// git index types (GitIndex, IndexEntry, IndexEntryFlags, IndexExtension, StatData)
export type * from './domain/git-index/index.js';
// git object union (GitObject, Blob, Commit, Tree, Tag, AuthorIdentity domain variant, …)
// export type * from a mixed barrel drops all value exports (parseCommitContent etc.).
// The object-id.ts re-export inside this barrel surfaces ObjectId/RefName/FilePath as types only
// via export type *; the value constructors are re-added explicitly below.
export type * from './domain/objects/index.js';
// Orphan: Pathspec declared in domain/pathspec but in no aggregating barrel.
// Its declaring-tier barrel (domain/pathspec/index.ts) already exports it.
export type { Pathspec } from './domain/pathspec/index.js';
// domain snapshot row types (SnapshotKind, TreeEntryRow, IndexEntryRow, …)
export type * from './domain/snapshot/index.js';
// port types (Context, FileSystem, RepositoryConfig, CommandRunner, Logger, …)
// Values (createContext, noopLogger, wrapLoggerSanitizer) are dropped by export type *.
export type * from './ports/index.js';

// Forced explicit winners — three names clash wildcard-vs-wildcard (probed: exactly these three
// TS2308s fire without the explicit lines; explicit named re-export beats wildcard, no error).
// Placed AFTER all wildcard lines so the explicit declaration wins.

// diffTrees: declared as a value in both application/primitives/diff-trees.ts and
// domain/diff/tree-diff.ts; export type * re-emits the name in type position from two different
// declarations → TS2308. Not a public value (facade exposes repo.primitives.diffTrees, not the
// raw fn). export type { diffTrees } collapses to one declaration without leaking the value.
export type { diffTrees } from './application/primitives/diff-trees.js';
// AuthorIdentity: ports/context.ts (port bag) vs domain/objects/author-identity.ts (commit/tag identity).
// Pick the domain one — rides commit/tag data results (primary data payload).
export type { AuthorIdentity } from './domain/objects/author-identity.js';
// Branded-id value carve-out — the ONE non-export-type line.
// Pulls both the value constructors (ObjectId.from/.fromRaw, RefName.from, FilePath.from) and
// the merged type. Sourced from object-id.ts directly (not the domain/objects barrel) to keep
// this surgical. No conflict with the domain/objects wildcard — both trace to the same declaration.
export { FilePath, ObjectId, RefName } from './domain/objects/object-id.js';
// The port-tier {name,email} identity (the OpenRepositoryOptions.config.user shape) is a distinct
// type from the domain authorship above; expose it under an unambiguous name so config.user is
// nameable without RepositoryConfig['user'] indexed-access.
export type { AuthorIdentity as ConfigUserIdentity } from './ports/context.js';
// WalkIgnorePredicate: ports/snapshot-resolvers.ts vs application/primitives/types.ts.
// Pick the ports one — it is the predicate carried by WorkdirEnumOptions and Context resolvers.
export type { WalkIgnorePredicate } from './ports/snapshot-resolvers.js';

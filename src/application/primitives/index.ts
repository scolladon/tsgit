export type { ApplyChangesetOpts, ApplyChangesetResult } from './apply-changeset.js';
export { applyChangeset, isWorkingTreeDirty } from './apply-changeset.js';
export type { BuildIndexFromTreeOpts } from './build-index-from-tree.js';
export { buildIndexFromTree } from './build-index-from-tree.js';
export type { BuildPackInput, BuildPackResult } from './build-pack.js';
export { buildPack } from './build-pack.js';
export { catFileBatch } from './cat-file-batch.js';
export type { WorkingTreeComparison, WorkingTreeDelta } from './compare-working-tree-entry.js';
export { compareWorkingTreeDelta, compareWorkingTreeEntry } from './compare-working-tree-entry.js';
export type { Changeset, ChangesetEntry, ChangesetStats } from './compute-changeset.js';
export { computeChangeset } from './compute-changeset.js';
export type { IniSection, ParsedConfig, ValuelessEntry } from './config-read.js';
export {
  findFirstValuelessEntry,
  findFirstValuelessInSection,
  invalidateConfigCache,
  parseIniSections,
  readConfig,
} from './config-read.js';
export {
  getAllConfigValues,
  getConfigValue,
  invalidateScopedConfigCache,
  readConfigSections,
} from './config-scoped-read.js';
export { createCommit } from './create-commit.js';
export { diffTrees } from './diff-trees.js';
export type { EnumeratePushObjectsInput } from './enumerate-push-objects.js';
export { enumeratePushObjects } from './enumerate-push-objects.js';
export { enumerateRefs } from './enumerate-refs.js';
export type { FetchPackInput, FetchPackResult } from './fetch-pack.js';
export { fetchPack } from './fetch-pack.js';
export { flattenTree } from './flatten-tree.js';
export type { HashBlobOptions } from './hash-blob.js';
export { hashBlob } from './hash-blob.js';
export type {
  IsIgnoredMatch,
  IsIgnoredMatchSource,
  IsIgnoredQuery,
} from './is-ignored.js';
export { isIgnored } from './is-ignored.js';
export type { MaterializeTreeOpts, MaterializeTreeResult } from './materialize-tree.js';
export { materializeTree } from './materialize-tree.js';
export { materializeWorktreeFromHead } from './materialize-worktree-from-head.js';
export { mergeBase } from './merge-base.js';
export { getRepoRoot, sparseCheckoutPath } from './path-layout.js';
export { readBlob } from './read-blob.js';
export { readHeadTree } from './read-head-tree.js';
export { readIndex } from './read-index.js';
export { readObject } from './read-object.js';
export {
  loadSparseMatcher,
  MAX_SPARSE_PATTERN_FILE_BYTES,
  readSparsePatternText,
} from './read-sparse-checkout.js';
export { readTree } from './read-tree.js';
export { resolveReflogIdentity } from './reflog-identity.js';
export {
  appendReflog,
  deleteReflog,
  listReflogs,
  readReflog,
  reflogExists,
  writeReflog,
} from './reflog-store.js';
export { resolveRef } from './resolve-ref.js';
export { type HookInput, runHook, runInformationalHook } from './run-hook.js';
export { readShallow, updateShallow } from './shallow-file.js';
export { synthesizeTreeFromIndex } from './synthesize-tree-from-index.js';
export type * from './types.js';
export type { ConfigEntry } from './update-config.js';
export {
  applyConfigOpInText,
  removeConfigSection,
  renameConfigSection,
  setConfigEntry,
  setConfigEntryInText,
  setCoreConfigEntryInText,
  unsetAllConfigEntries,
  unsetConfigEntry,
  updateConfigEntries,
  updateCoreConfig,
} from './update-config.js';
export { updateRef } from './update-ref.js';
export { walkCommits } from './walk-commits.js';
export { walkCommitsByDate } from './walk-commits-by-date.js';
export { walkSubmodules } from './walk-submodules.js';
export { walkTree } from './walk-tree.js';
export { walkWorkingTree } from './walk-working-tree.js';
export { writeObject } from './write-object.js';
export { writeSparsePatternText } from './write-sparse-checkout.js';
export { writeTree } from './write-tree.js';

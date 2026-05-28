export type { ApplyChangesetOpts, ApplyChangesetResult } from './apply-changeset.js';
export { applyChangeset, isWorkingTreeDirty } from './apply-changeset.js';
export type { BuildIndexFromTreeOpts } from './build-index-from-tree.js';
export { buildIndexFromTree } from './build-index-from-tree.js';
export type { BuildPackInput, BuildPackResult } from './build-pack.js';
export { buildPack } from './build-pack.js';
export { catFileBatch } from './cat-file-batch.js';
export type { Changeset, ChangesetEntry, ChangesetStats } from './compute-changeset.js';
export { computeChangeset } from './compute-changeset.js';
export type { IniSection, ParsedConfig } from './config-read.js';
export { invalidateConfigCache, parseIniSections, readConfig } from './config-read.js';
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
export { mergeBase } from './merge-base.js';
export { getRepoRoot, sparseCheckoutPath } from './path-layout.js';
export { readBlob } from './read-blob.js';
export { readIndex } from './read-index.js';
export { readObject } from './read-object.js';
export {
  loadSparseMatcher,
  MAX_SPARSE_PATTERN_FILE_BYTES,
  readSparsePatternText,
} from './read-sparse-checkout.js';
export { readTree } from './read-tree.js';
export { recordRefUpdate } from './record-ref-update.js';
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
export { type HookInput, runHook } from './run-hook.js';
export type { SetEntryFlagsOptions } from './set-entry-flags.js';
export { setEntryFlags } from './set-entry-flags.js';
export { readShallow, updateShallow } from './shallow-file.js';
export type { StageEntryOptions, StageEntrySource } from './stage-entry.js';
export { stageEntry } from './stage-entry.js';
export { synthesizeTreeFromIndex } from './synthesize-tree-from-index.js';
export type * from './types.js';
export type { UnstageEntryOptions } from './unstage-entry.js';
export { unstageEntry } from './unstage-entry.js';
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
export { walkSubmodules } from './walk-submodules.js';
export { walkTree } from './walk-tree.js';
export { walkWorkingTree } from './walk-working-tree.js';
export { writeObject } from './write-object.js';
export { writeSparsePatternText } from './write-sparse-checkout.js';
export { writeSymbolicRef } from './write-symbolic-ref.js';
export { writeTree } from './write-tree.js';

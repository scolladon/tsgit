export type {
  AddChange,
  CopyChange,
  DeleteChange,
  DiffChange,
  DiffChangeType,
  ModifyChange,
  RenameChange,
  StatDiffChange,
  StatFields,
  StatTreeDiff,
  TreeDiff,
  TypeChangeChange,
} from '../../domain/diff/index.js';
export { type MergeAbortResult, mergeAbort } from './abort-merge.js';
export { type AddOptions, type AddResult, add } from './add.js';
export {
  type BlameLine,
  type BlameLineBase,
  type BlameOptions,
  type BlameResult,
  blame,
  type CommittedBlameLine,
  type UncommittedBlameLine,
} from './blame.js';
export {
  type BranchCreateInput,
  type BranchCreateResult,
  type BranchDeleteInput,
  type BranchDeleteResult,
  type BranchInfo,
  type BranchListResult,
  type BranchRenameInput,
  type BranchRenameResult,
  branchCreate,
  branchDelete,
  branchList,
  branchRename,
} from './branch.js';
export {
  type CatFileBatchEntry,
  type CatFileInput,
  type CatFileResult,
  catFile,
} from './cat-file.js';
export { type CheckoutOptions, type CheckoutResult, checkout } from './checkout.js';
export {
  type CherryPickAbortResult,
  type CherryPickConflict,
  type CherryPickContinueInput,
  type CherryPickedCommit,
  type CherryPickResult,
  type CherryPickRunInput,
  cherryPickAbort,
  cherryPickContinue,
  cherryPickRun,
  cherryPickSkip,
} from './cherry-pick.js';
export { type CloneOptions, type CloneResult, clone } from './clone.js';
export { type CommitOptions, type CommitResult, commit } from './commit.js';
export {
  type ConfigEntryView,
  type ConfigGetAllInput,
  type ConfigGetAllResult,
  type ConfigGetInput,
  type ConfigGetRegexpInput,
  type ConfigGetRegexpResult,
  type ConfigGetResult,
  type ConfigListInput,
  type ConfigListResult,
  type ConfigRemoveSectionInput,
  type ConfigRemoveSectionResult,
  type ConfigRenameSectionInput,
  type ConfigRenameSectionResult,
  type ConfigSetInput,
  type ConfigSetResult,
  type ConfigUnsetAllInput,
  type ConfigUnsetAllResult,
  type ConfigUnsetInput,
  type ConfigUnsetResult,
  configGet,
  configGetAll,
  configGetRegexp,
  configList,
  configRemoveSection,
  configRenameSection,
  configSet,
  configUnset,
  configUnsetAll,
} from './config.js';
export {
  type MergeContinueInput,
  type MergeContinueResult,
  mergeContinue,
} from './continue-merge.js';
export { type DescribeOptions, type DescribeResult, describe } from './describe.js';
export { type DiffOptions, diff } from './diff.js';
export { type FetchOptions, type FetchResult, fetch } from './fetch.js';
export {
  createPromisorRemote,
  type FetchMissingOptions,
  type FetchMissingResult,
  fetchMissing,
} from './fetch-missing.js';
export {
  type GrepLineHit,
  type GrepOptions,
  type GrepPathResult,
  type GrepResult,
  grep,
} from './grep.js';
export { type InitOptions, type InitResult, init } from './init.js';
export { type BranchNamespace, bindBranchNamespace } from './internal/branch-namespace.js';
export {
  bindCherryPickNamespace,
  type CherryPickNamespace,
} from './internal/cherry-pick-namespace.js';
export { bindConfigNamespace, type ConfigNamespace } from './internal/config-namespace.js';
export { bindMergeNamespace, type MergeNamespace } from './internal/merge-namespace.js';
export {
  bindRebaseNamespace,
  type RebaseNamespace,
} from './internal/rebase-namespace.js';
export { bindRemoteNamespace, type RemoteNamespace } from './internal/remote-namespace.js';
export {
  bindRevertNamespace,
  type RevertNamespace,
} from './internal/revert-namespace.js';
export {
  bindSparseCheckoutNamespace,
  type SparseCheckoutNamespace,
} from './internal/sparse-checkout-namespace.js';
export { bindStashNamespace, type StashNamespace } from './internal/stash-namespace.js';
export {
  bindSubmoduleNamespace,
  type SubmoduleNamespace,
} from './internal/submodule-namespace.js';
export { bindTagNamespace, type TagNamespace } from './internal/tag-namespace.js';
export {
  bindWorktreeNamespace,
  type WorktreeNamespace,
} from './internal/worktree-namespace.js';
export { type LogEntry, type LogOptions, log } from './log.js';
export { type MergeResult, type MergeRunInput, mergeRun } from './merge.js';
export {
  type MvMove,
  type MvOptions,
  type MvResult,
  type MvSkipped,
  type MvSkipReason,
  mv,
} from './mv.js';
export {
  type NameRevOptions,
  type NameRevResult,
  type NameRevStep,
  nameRev,
} from './name-rev.js';
export { type PullOptions, type PullResult, pull } from './pull.js';
export { type PushOptions, type PushResult, push } from './push.js';
export {
  type RangeDiffCommit,
  type RangeDiffEntry,
  type RangeDiffOptions,
  type RangeDiffRange,
  type RangeDiffStatus,
  rangeDiff,
} from './range-diff.js';
export { type ReadFileAtResult, readFileAt } from './read-file-at.js';
export {
  type RebaseAbortResult,
  type RebaseConflict,
  type RebasedCommit,
  type RebaseInstruction,
  type RebaseInteractiveAction,
  type RebaseResult,
  type RebaseRunInput,
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from './rebase.js';
export {
  type ReflogAction,
  type ReflogResult,
  type ReflogShowEntry,
  reflog,
} from './reflog.js';
export {
  type RemoteAddInput,
  type RemoteAddResult,
  type RemoteInfo,
  type RemoteListResult,
  type RemoteRemoveInput,
  type RemoteRemoveResult,
  type RemoteRenameInput,
  type RemoteRenameResult,
  type RemoteSetUrlInput,
  type RemoteSetUrlResult,
  type RemoteShow,
  type RemoteShowInput,
  type RemoteShowResult,
  remoteAdd,
  remoteList,
  remoteRemove,
  remoteRename,
  remoteSetUrl,
  remoteShow,
} from './remote.js';
export { type ResetMode, type ResetOptions, type ResetResult, reset } from './reset.js';
export { revParse } from './rev-parse.js';
export {
  type RevertAbortResult,
  type RevertConflict,
  type RevertedCommit,
  type RevertResult,
  type RevertRunInput,
  revertAbort,
  revertContinue,
  revertRun,
  revertSkip,
} from './revert.js';
export { type RmOptions, type RmResult, rm } from './rm.js';
export {
  type ShortlogBy,
  type ShortlogCommit,
  type ShortlogGroup,
  type ShortlogOptions,
  shortlog,
} from './shortlog.js';
export {
  type ShowBlobResult,
  type ShowCommitResult,
  type ShowInput,
  type ShowOptions,
  type ShowResult,
  type ShowTagResult,
  type ShowTreeEntry,
  type ShowTreeResult,
  show,
} from './show.js';
export {
  type SparseCheckoutAddInput,
  type SparseCheckoutAppliedResult,
  type SparseCheckoutDisableInput,
  type SparseCheckoutListResult,
  type SparseCheckoutReapplyInput,
  type SparseCheckoutSetInput,
  sparseCheckoutAdd,
  sparseCheckoutDisable,
  sparseCheckoutList,
  sparseCheckoutReapply,
  sparseCheckoutSet,
} from './sparse-checkout.js';
export {
  type StashApplyInput,
  type StashApplyResult,
  type StashConflict,
  type StashDropInput,
  type StashDropResult,
  type StashListEntry,
  type StashListResult,
  type StashPopResult,
  type StashPushInput,
  type StashPushResult,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from './stash.js';
export {
  type BlobSide,
  type ChangedPath,
  type ChangeKind,
  type ConflictKind,
  type StatusResult,
  status,
  type UnmergedEntry,
  type WorktreeSide,
} from './status.js';
export {
  type SubmoduleAddEntry,
  type SubmoduleAddOptions,
  type SubmoduleAddResult,
  type SubmoduleDeinitEntry,
  type SubmoduleDeinitOptions,
  type SubmoduleDeinitResult,
  type SubmoduleEntry,
  type SubmoduleInitEntry,
  type SubmoduleInitOptions,
  type SubmoduleInitResult,
  type SubmoduleListOptions,
  type SubmoduleListResult,
  type SubmoduleSyncEntry,
  type SubmoduleSyncOptions,
  type SubmoduleSyncResult,
  type SubmoduleUpdateEntry,
  type SubmoduleUpdateOptions,
  type SubmoduleUpdateResult,
  submoduleAdd,
  submoduleDeinit,
  submoduleInit,
  submoduleList,
  submoduleSync,
  submoduleUpdate,
} from './submodule.js';
export {
  type TagCreateInput,
  type TagCreateResult,
  type TagDeleteInput,
  type TagDeleteResult,
  type TagInfo,
  type TagListResult,
  tagCreate,
  tagDelete,
  tagList,
} from './tag.js';
export {
  type WhatchangedEntry,
  type WhatchangedOptions,
  whatchanged,
} from './whatchanged.js';
export {
  type WorktreeAddOptions,
  type WorktreeAddResult,
  type WorktreeEntry,
  type WorktreeListResult,
  type WorktreeMoveOptions,
  type WorktreeMoveResult,
  type WorktreeRemoveOptions,
  type WorktreeRemoveResult,
  worktreeAdd,
  worktreeList,
  worktreeMove,
  worktreeRemove,
} from './worktree.js';

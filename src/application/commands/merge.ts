import {
  incompatibleOptions,
  mergeStrategyFailed,
  noMergeStrategyHandled,
  nonFastForward,
  unrelatedHistories,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { conflictsToIndexEntries, sortedRecordedPaths } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import {
  type IndexEntry,
  STAGE0_FLAGS,
  type StatData,
  skipWorktreeEntry,
} from '../../domain/git-index/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import { unsupportedOperation } from '../../domain/index.js';
import {
  type ConflictType,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeConflict,
  type MergeLabels,
  type MergeOutcome,
  mergeLabels,
  mergeTrees,
  type TreeMergeResult,
} from '../../domain/merge/index.js';
import type { MergeCommandLine } from '../../domain/merge/merge-command-line.js';
import { mergeTagHeader } from '../../domain/merge/merge-tag-header.js';
import {
  type OrtStrategyOptions,
  parseOrtStrategyOptions,
} from '../../domain/merge/strategy-options.js';
import { trivialMerge } from '../../domain/merge/trivial-merge.js';
import type { CommitData, ExtraHeader } from '../../domain/objects/commit.js';
import { treeDepthExceeded, unexpectedObjectType } from '../../domain/objects/error.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  type RefName,
  type TreeEntry,
} from '../../domain/objects/index.js';
import { treeEntry } from '../../domain/objects/tree.js';
import { refNotFound } from '../../domain/refs/error.js';
import { TAGS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import type { SparseMatcher } from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import { abbreviateObjectId } from '../primitives/abbreviate-object-id.js';
import {
  conflictResultTree,
  createMergeResultWriter,
} from '../primitives/apply-merge-to-worktree.js';
import {
  buildBlobUnchanged,
  buildContentMerger,
  type ContentMergeSettings,
  type RenormalizeSettings,
} from '../primitives/build-content-merger.js';
import { readConfig } from '../primitives/config-read.js';
import { createCommitWithStoredHeaders } from '../primitives/create-commit.js';
import { detectMergeRenames } from '../primitives/detect-merge-renames.js';
import { changedPaths, findWouldOverwrite } from '../primitives/find-would-overwrite.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { writeAutoMerge } from '../primitives/internal/auto-merge-ref.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import {
  readMergeRenormalize,
  readUiDiffAlgorithm,
} from '../primitives/internal/merge-rename-config.js';
import { mergedBlobEntries } from '../primitives/internal/merged-blob-entries.js';
import { peelChain, tagHop } from '../primitives/internal/peel-chain.js';
import { renormalizeAttributeLookup } from '../primitives/internal/renormalize-attributes.js';
import { resolveMaxTreeDepth } from '../primitives/internal/resolve-max-tree-depth.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from '../primitives/internal/symlinked-leading-path.js';
import { validateMergeWritePaths } from '../primitives/internal/validate-merge-write-paths.js';
import type { WorkingTreeWriter } from '../primitives/internal/write-converted-entry.js';
import { writeDistinctTypesSides } from '../primitives/internal/write-distinct-types-sides.js';
import { removeWorkingTreeFile } from '../primitives/internal/write-working-tree-file.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { mergeBasesOf, tryMergeBasesOf, tryReduceHeads } from '../primitives/merge-base.js';
import { mergeCollidingRenameSources } from '../primitives/merge-colliding-rename-sources.js';
import { assertEverySourceLoadable } from '../primitives/object-store.js';
import { readBlob } from '../primitives/read-blob.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject, readRawObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { resolveRef, resolveRefForReading } from '../primitives/resolve-ref.js';
import { runInformationalHook } from '../primitives/run-hook.js';
import { shiftMergeSide } from '../primitives/shift-merge-side.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeObject } from '../primitives/write-object.js';
import { writeTree } from '../primitives/write-tree.js';
import { configuredAutostash } from './internal/autostash-config.js';
import { branchMarkRef } from './internal/branch-mark.js';
import { branchMergeOptions } from './internal/branch-merge-options.js';
import { removeMergeBranchState } from './internal/branch-state.js';
import { conflictMergeMsg, conflictsHint } from './internal/cherry-pick-state.js';
import { resolveAuthor, resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { configuredMergeFastForward } from './internal/fast-forward-config.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeMergeAutostash } from './internal/merge-autostash.js';
import { mergeShortlog, settleMergeLog } from './internal/merge-log.js';
import {
  assertMergeMessageConfig,
  describeMergeHead,
  formatMergeMessage,
  type MergeHead,
} from './internal/merge-message.js';
import {
  writeMergeHeads,
  writeMergeMode,
  writeMergeMsg,
  writeOrigHead,
  writeSquashMsg,
} from './internal/merge-state.js';
import {
  allowsTrivialMerge,
  assertStrategyConfig,
  conflictWeight,
  explicitStrategies,
  forbidsFastForward,
  preferConflict,
  settleStrategies,
} from './internal/merge-strategies.js';
import {
  type OctopusRemote,
  type OctopusResult,
  octopusMerge,
  writeFlatTree,
} from './internal/octopus-merge.js';
import { expandPriorCheckout } from './internal/prior-checkout.js';
import {
  assertNoPendingOperation,
  assertOperationalRepositorySettingsFirst,
  branchRefFromHead,
  readHeadRaw,
  requireWorkTree,
} from './internal/repo-state.js';
import { resolveRevisionExpression } from './internal/revision-expression.js';
import { signCommitData } from './internal/sign-request.js';
import { buildSquashMessage } from './internal/squash-message.js';
import { applyMergeAutostash, createAutostash } from './stash.js';

const PREVIOUS_BRANCH_SHORTHAND = '-';
const PREVIOUS_BRANCH = '@{-1}';

export type { IndexEntry } from '../../domain/git-index/index.js';
export type { ConflictType, MergeConflict, MergeOutcome } from '../../domain/merge/index.js';
export type { SparseMatcher } from '../../domain/sparse/index.js';

const HEAD: RefName = 'HEAD' as RefName;

type FlatEntries = ReadonlyMap<FilePath, FlatTreeEntry>;

export interface MergeRunInput {
  /** The head merged — or several, which git merges with its `octopus` strategy. */
  readonly rev: string | ReadonlyArray<string>;
  readonly message?: string;
  /**
   * Fast-forward policy (git `--ff` / `--ff-only` / `--no-ff`); unset, it is
   * `merge.ff`'s, else `'allow'`:
   * - `'allow'` — fast-forward when possible, else a true merge.
   * - `'only'` — refuse with `NON_FAST_FORWARD` when a true merge is required.
   * - `'never'` — always create a merge commit, even when a fast-forward is possible.
   */
  readonly fastForward?: 'only' | 'never' | 'allow';
  /**
   * git's `--allow-unrelated-histories`: merge heads that share no commit with
   * `HEAD`, which otherwise refuse with `UNRELATED_HISTORIES`.
   */
  readonly allowUnrelatedHistories?: boolean;
  /**
   * git's `--autostash` / `--no-autostash`; unset, it is `merge.autostash`'s.
   * A dirty tree is stashed before the merge touches it (`MERGE_AUTOSTASH`)
   * and re-applied when the merge concludes — at once, or on the commit or
   * abort that ends a conflict stop; any other removal of the merge state
   * keeps it in the stash list instead.
   */
  readonly autostash?: boolean;
  /**
   * git's `--log[=<n>]` / `--no-log`: follow the message with a shortlog of
   * (at most `n`, `true` for 20) commits each head brings in. Unset — or a
   * negative count — it is `merge.log`'s (or `merge.summary`'s), else none.
   */
  readonly log?: boolean | number;
  /**
   * git's `--squash`: take the merge into the index and working tree and
   * write `SQUASH_MSG`, without `MERGE_HEAD` and without moving HEAD — even
   * when a fast-forward was possible. Refuses with `INCOMPATIBLE_OPTIONS`
   * under `fastForward: 'never'` (or `merge.ff = false`).
   */
  readonly squash?: boolean;
  /**
   * git's `--commit` / `--no-commit`. `false` stops a merge that would commit
   * with `MERGE_HEAD`, `MERGE_MSG` and `MERGE_MODE` kept for a later `commit`
   * and HEAD unmoved; a fast-forward still fast-forwards unless
   * `fastForward: 'never'`. `true` with `squash` refuses with
   * `INCOMPATIBLE_OPTIONS`.
   */
  readonly commit?: boolean;
  /**
   * git's `-s <strategy>`, once or several times: `ort` (one head's default),
   * `recursive` (run as `ort`), `resolve`, `octopus` (several heads' default),
   * `ours` (HEAD's tree, whatever the heads hold); unset, `pull.twohead` /
   * `pull.octopus` name them. Several are tried in turn: the first clean merge
   * commits, else the one leaving the fewest conflicts prepares the
   * resolution. `ours` never fast-forwards; git's trivial in-index merge is
   * tried first when every strategy is `resolve` or `octopus`. `subtree`
   * refuses with `UNSUPPORTED_OPERATION`. Any other name refuses with
   * `UNKNOWN_MERGE_STRATEGY`; a merge no strategy handles fails with
   * `MERGE_STRATEGY_FAILED` (one strategy) or `NO_MERGE_STRATEGY_HANDLED`.
   */
  readonly strategy?: string | ReadonlyArray<string>;
  /**
   * git's `-X <option>`, in order, read when a strategy runs (a fast-forward
   * never reads them). `ort` / `recursive` honour `no-renames`,
   * `find-renames[=<n>]` and `rename-threshold=<n>` over `merge.renames` /
   * `diff.renames`, and `ours` / `theirs` (that side wins every overlapping
   * hunk, every binary merge and every symlink both sides changed), and `ignore-space-change`,
   * `ignore-all-space`, `ignore-space-at-eol`, `ignore-cr-at-eol` (a line
   * whose change is whitespace-only yields to the other side's), and
   * `patience`, `histogram` and
   * `diff-algorithm=myers|default|minimal|patience|histogram` (the last
   * algorithm named wins; ort's own default is histogram), and
   * `renormalize` / `no-renormalize` (the last one named wins over
   * `merge.renormalize`: every merged blob is converted through the
   * attributes the sides carry before it is compared), and any other option
   * refuses with `UNKNOWN_STRATEGY_OPTION`.
   * `resolve` fails on any option, as git's `read-tree` refuses them;
   * `octopus` and `ours` ignore them.
   */
  readonly strategyOptions?: ReadonlyArray<string>;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  /**
   * Sign the merge commit (git's `-S`). Tri-state against `commit.gpgSign`:
   * an explicit `true`/`false` wins; `undefined` falls back to the config.
   */
  readonly sign?: boolean;
  /** Signing key override (git's `-S<keyid>`); falls back to `user.signingKey`. */
  readonly signKey?: string;
}

/**
 * Internal-only knobs for `merge`, set by composing porcelain (e.g. `pull`),
 * never by end users. Deliberately **not** re-exported from the commands barrel,
 * so it stays off the public API surface.
 */
export interface MergeInternalOptions {
  /**
   * Reflog action prefix, mirroring git's GIT_REFLOG_ACTION. Replaces the
   * default `merge <rev>` prefix in the fast-forward and merge-commit reflog
   * messages (e.g. `pull` → `pull: Fast-forward`). Defaults to `merge <rev>`.
   */
  readonly reflogAction?: string;
  /**
   * The heads merged, as FETCH_HEAD's for-merge lines describe them — what the
   * default message is formatted from. Defaults to `merge_name`'s description
   * of each head left once `reduce_heads` has run.
   */
  readonly heads?: ReadonlyArray<MergeHead>;
}

/** A merge whose message and autostash are settled — the caller's, or git's default. */
type SettledMerge = Omit<MergeRunInput, 'rev' | 'autostash' | 'strategy'> & {
  readonly rev: string;
  readonly message: string;
  readonly autostash: boolean;
  /** The strategies tried in turn: the caller's, `pull.twohead`'s / `pull.octopus`'s, or git's default. */
  readonly strategies: ReadonlyArray<string>;
};

export interface MergeConflictDescriptor {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type MergeResult =
  | { readonly kind: 'up-to-date'; readonly id: ObjectId }
  /** `branch` is the branch HEAD names; `undefined` when HEAD is detached. */
  | { readonly kind: 'fast-forward'; readonly id: ObjectId; readonly branch: RefName | undefined }
  | {
      readonly kind: 'merge';
      readonly id: ObjectId;
      readonly branch: RefName | undefined;
      readonly parents: ReadonlyArray<ObjectId>;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: ReadonlyArray<MergeConflictDescriptor>;
      /** What `MERGE_HEAD` resolves to: the first head merged. */
      readonly mergeHead: ObjectId;
      readonly origHead: ObjectId;
    }
  /**
   * `squash`: the merge is staged and `SQUASH_MSG` written; HEAD still names
   * `origHead`. `conflicts` is present when the merge left them to resolve.
   */
  | {
      readonly kind: 'squashed';
      readonly origHead: ObjectId;
      readonly conflicts?: ReadonlyArray<MergeConflictDescriptor>;
    }
  /** `commit: false`: the merge is staged with its state kept; HEAD still names `origHead`. */
  | { readonly kind: 'stopped'; readonly mergeHead: ObjectId; readonly origHead: ObjectId };

type SquashedResult = Extract<MergeResult, { readonly kind: 'squashed' }>;

/**
 * git's `finish` without a new head: a squash the strategies merged, clean or
 * not, which keeps the autostash and ends as a stop does.
 */
interface HeadlessSquash {
  readonly kind: 'headless-squash';
  readonly result: SquashedResult;
}

/** How the merge machinery ends: a result, or a squash that ends without a new head. */
type MergeEnding = MergeResult | HeadlessSquash;

const headless = async (squashed: Promise<SquashedResult>): Promise<HeadlessSquash> => ({
  kind: 'headless-squash',
  result: await squashed,
});

const resultOf = (ending: MergeEnding): MergeResult =>
  ending.kind === 'headless-squash' ? ending.result : ending;

/** A stop the caller concludes by hand: a conflict, a squash the strategies merged, or `commit: false`. */
const leftToResolve = (ending: MergeEnding): boolean =>
  ending.kind === 'conflict' || ending.kind === 'stopped' || ending.kind === 'headless-squash';

/** `post-merge`'s squash-flag argument: `1` after a `--squash` merge, else `0`. */
const squashFlag = (result: MergeResult): string => (result.kind === 'squashed' ? '1' : '0');

/**
 * Merge `rev` into HEAD: the branch it names, or HEAD itself when detached.
 *
 * - Up-to-date: rev is ancestor of HEAD → no-op.
 * - Fast-forward: HEAD is ancestor of rev → branch advances.
 * - True merge for diverged histories: the three-way tree merge (`mergeTrees`
 *   + `mergeContent`) commits the merged tree directly when it comes out
 *   CLEAN. A conflicted merge instead persists its state on disk (marker
 *   files, stage-1/2/3 index entries, MERGE_HEAD / MERGE_MSG / ORIG_HEAD) and
 *   returns `{ kind: 'conflict', ... }`. Resolution path: edit the marker
 *   files, `repo.add(paths)`, `repo.commit({ message })` — the resulting
 *   commit has two parents.
 */
export const mergeRun = async (
  ctx: Context,
  opts: MergeRunInput,
  internal: MergeInternalOptions = {},
): Promise<MergeResult> => {
  const ending = await computeMerge(ctx, opts, internal);
  const result = resultOf(ending);
  // post-merge is informational — git fires it after a merge that updates the
  // working tree (fast-forward or clean true-merge), never on up-to-date or a
  // conflict. It cannot abort the completed merge (its exit code is ignored).
  // git's `finish` then re-applies the autostash.
  if (result.kind === 'fast-forward' || result.kind === 'merge' || result.kind === 'squashed') {
    await runInformationalHook(ctx, 'post-merge', { args: [squashFlag(result)] });
  }
  if (leftToResolve(ending)) return result;
  if (result.kind !== 'up-to-date') await applyMergeAutostash(ctx);
  // git's `remove_merge_branch_state` on every concluded merge; a stop keeps its files.
  await removeMergeBranchState(ctx);
  return result;
};

/** The branch merged into (`undefined` when HEAD is detached) and the commit HEAD names. */
interface MergeTarget {
  readonly branch: RefName | undefined;
  readonly ourId: ObjectId;
}

/**
 * The message the merge records: the caller's, else git's `fmt_merge_msg`
 * over the heads — either followed by the shortlog `log` asks for.
 */
const settleMessage = async (
  ctx: Context,
  opts: MergeRunInput,
  internal: MergeInternalOptions,
  target: MergeTarget,
  remotes: ReadonlyArray<MergeRemote>,
): Promise<Omit<SettledMerge, 'strategies'>> => {
  const rev = remotes.map((remote) => remote.name).join(' ');
  const autostash = opts.autostash ?? (await configuredAutostash(ctx, 'merge')) ?? false;
  const log = await settleMergeLog(ctx, opts.log);
  if (opts.message !== undefined && log.length === 0) {
    return { ...opts, rev, autostash, message: opts.message };
  }
  const heads =
    internal.heads ??
    (await Promise.all(
      remotes.map((remote) => describeMergeHead(ctx, remote.spelt, remote.id, remote.object)),
    ));
  const into = shortBranchName(target.branch ?? HEAD);
  const formatted = await formatMergeMessage(ctx, heads, into, opts.message);
  if (log.length === 0) {
    return { ...opts, rev, autostash, message: withoutFinalNewline(formatted) };
  }
  const shortlog = await mergeShortlog(ctx, heads, target.ourId, log);
  const message = withoutFinalNewline(`${completeLine(formatted)}${shortlog}`);
  return { ...opts, rev, autostash, message };
};

/** git's `merge_msg`: `prepare_merge_message`'s output without its final newline, which the state file restores. */
const withoutFinalNewline = (text: string): string => text.slice(0, -1);

/** git's `strbuf_complete_line`: a non-empty text ends with a newline. */
const completeLine = (text: string): string =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`;

/**
 * What git settles before merging: the fast-forward policy (the caller's, else
 * `merge.ff`), the message, and `--no-ff` over a throwaway tag.
 */
const settleMerge = async (
  ctx: Context,
  input: MergeRunInput,
  internal: MergeInternalOptions,
  target: MergeTarget,
  remotes: ReadonlyArray<MergeRemote>,
): Promise<SettledMerge> => {
  const policy = await settleFastForward(ctx, input);
  const explicit = explicitStrategies(input.strategy);
  const strategies = await settleStrategies(ctx, explicit, remotes.length);
  const strategic: MergeRunInput = forbidsFastForward(strategies)
    ? { ...policy, fastForward: NO_FAST_FORWARD }
    : policy;
  const message = await settleMessage(ctx, strategic, internal, target, remotes);
  const settled = { ...message, strategies };
  const throwaway = await mergesThrowawayTag(ctx, settled, remotes);
  return throwaway ? { ...settled, fastForward: NO_FAST_FORWARD } : settled;
};

const NO_FAST_FORWARD = 'never';

const settleFastForward = async (ctx: Context, input: MergeRunInput): Promise<MergeRunInput> => {
  if (input.fastForward !== undefined) return input;
  const configured = await configuredMergeFastForward(ctx);
  return configured === undefined ? input : { ...input, fastForward: configured };
};

/** git's `merging_a_throwaway_tag` over every head, which only `--ff-only` overrides. */
const mergesThrowawayTag = async (
  ctx: Context,
  opts: SettledMerge,
  remotes: ReadonlyArray<MergeRemote>,
): Promise<boolean> => {
  if (opts.fastForward === 'only') return false;
  for (const remote of remotes) if (await isThrowawayTag(ctx, remote.object)) return true;
  return false;
};

/** An annotated tag its own `refs/tags/<name>` does not point at: a contributor's
 *  tag, whose merge git keeps as a commit so the tag is not lost. */
const isThrowawayTag = async (ctx: Context, object: ObjectId): Promise<boolean> => {
  const read = await readObject(ctx, object);
  if (read.type !== 'tag') return false;
  // A name no refname can carry resolves to nothing: a throwaway tag, as in git.
  const ownRef = `${TAGS_PREFIX}${read.data.tagName}` as RefName;
  return (await resolveRefForReading(ctx, ownRef)) !== object;
};

const computeMerge = async (
  ctx: Context,
  given: MergeRunInput,
  internal: MergeInternalOptions,
): Promise<MergeEnding> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  await assertStrategyConfig(ctx);
  await assertMergeMessageConfig(ctx);
  // git's merge reads `diff.algorithm` with its whole config, so a bad one refuses first.
  await readUiDiffAlgorithm(ctx);
  const head = await readHeadRaw(ctx);
  const branch = branchRefFromHead(head);
  const input = overBranchOptions(await branchMergeOptions(ctx, branch), given);
  await assertSquashCompatible(ctx, input);
  requireWorkTree(ctx, 'merge');
  await assertNoPendingOperation(ctx);
  const ourId = head.kind === 'symbolic' ? await resolveRef(ctx, head.target) : head.id;
  const named = await resolveRemotes(ctx, mergeArguments(input.rev));
  return named.length === 1
    ? twoHeadMerge(ctx, input, internal, branch, ourId, named[0]!)
    : manyHeadMerge(ctx, input, internal, branch, ourId, named);
};

/**
 * git parses `branch.<b>.mergeoptions` before the caller's options: a
 * caller's option wins, while `-s`, `-X` and `-m` add to the branch's.
 */
const overBranchOptions = (branch: MergeCommandLine, given: MergeRunInput): MergeRunInput => {
  const givenStrategies = given.strategy === undefined ? [] : [given.strategy].flat();
  const strategy = explicitStrategies([...(branch.strategy ?? []), ...givenStrategies])!;
  const strategyOptions = [...(branch.strategyOptions ?? []), ...(given.strategyOptions ?? [])];
  const { sign: _sign, signKey: _signKey, ...branchOptions } = branch;
  return {
    ...branchOptions,
    ...definedFields(given),
    ...signingOf(given.sign === undefined && given.signKey === undefined ? branch : given),
    ...(strategy.length === 0 ? {} : { strategy }),
    strategyOptions,
    ...joinedMessage(branch.message, given.message),
  };
};

/** git reads `-S` afresh on the command line: a caller's signing drops the branch's key. */
const signingOf = ({
  sign,
  signKey,
}: Pick<MergeRunInput, 'sign' | 'signKey'>): Pick<MergeRunInput, 'sign' | 'signKey'> => ({
  ...(sign === undefined ? {} : { sign }),
  ...(signKey === undefined ? {} : { signKey }),
});

/** A field set to `undefined` is one the caller did not give. */
const definedFields = (given: MergeRunInput): MergeRunInput =>
  Object.fromEntries(
    Object.entries(given).filter(([, value]) => value !== undefined),
  ) as MergeRunInput;

/** git's `option_parse_message`: each `-m` after the first opens a new paragraph. */
const joinedMessage = (
  branch: string | undefined,
  given: string | undefined,
): { readonly message?: string } => {
  if (given === undefined) return {};
  return { message: branch ? `${branch}\n\n${given}` : given };
};

/** Strategies git runs in-process as `ort`. */
const SUBTREE_STRATEGY = 'subtree';
const ORT_STRATEGIES: ReadonlySet<string> = new Set(['ort', 'recursive', SUBTREE_STRATEGY]);
const IN_INDEX_MERGE = 'In-index merge';

const mergeMadeBy = (strategy: string): string => `Merge made by the '${strategy}' strategy.`;

/** git refuses `--squash` with `--no-ff` (the caller's or `merge.ff`'s), then with `--commit`. */
const assertSquashCompatible = async (ctx: Context, input: MergeRunInput): Promise<void> => {
  if (input.squash !== true) return;
  const { fastForward } = await settleFastForward(ctx, input);
  if (fastForward === NO_FAST_FORWARD) throw incompatibleOptions('--squash', '--no-ff');
  if (input.commit === true) throw incompatibleOptions('--squash', '--commit');
};

/**
 * git's `create_autostash_ref(MERGE_AUTOSTASH)` before the merge touches the
 * tree: a failed merge re-applies it at once, a conflict stop keeps it, and so
 * does a refusal git `die`s on inside the strategy.
 */
const underAutostash = async (
  ctx: Context,
  opts: SettledMerge,
  run: () => Promise<MergeEnding>,
): Promise<MergeEnding> => {
  if (!opts.autostash) return run();
  await stashForMerge(ctx);
  try {
    const result = await run();
    if (leftToResolve(result)) ctx.logger?.info?.(STASH_POP_HINT);
    return result;
  } catch (error) {
    // Stryker disable next-line StringLiteral: equivalent — the fallback is only looked up in DIES_INSIDE_STRATEGY, which holds neither '' nor any other non-code string.
    if (!DIES_INSIDE_STRATEGY.has(errorDataCode(error) ?? '')) await applyMergeAutostash(ctx);
    throw error;
  }
};

/** Refusals git `die`s on past `create_autostash_ref`, which leave the stash in `MERGE_AUTOSTASH`. */
const DIES_INSIDE_STRATEGY: ReadonlySet<string> = new Set(['UNKNOWN_STRATEGY_OPTION']);

const STASH_POP_HINT = 'When finished, apply stashed changes with `git stash pop`';

const stashForMerge = async (ctx: Context): Promise<void> => {
  const stash = await createAutostash(ctx);
  if (stash === undefined) return;
  await writeMergeAutostash(ctx, stash);
  ctx.logger?.info?.(`Created autostash: ${await abbreviateObjectId(ctx, stash)}`);
};

/** git's `merge -`: a lone `-` names the previous branch, `@{-1}`. */
const mergeArguments = (rev: string | ReadonlyArray<string>): ReadonlyArray<string> => {
  const revs = typeof rev === 'string' ? [rev] : rev;
  return revs.length === 1 && revs[0] === PREVIOUS_BRANCH_SHORTHAND ? [PREVIOUS_BRANCH] : revs;
};

/** A head to merge: the commit, and the object its name resolved to before peeling. */
interface MergeRemote extends OctopusRemote {
  readonly object: ObjectId;
  /** The name with a leading `@{-<n>}` spelt out, as git's `merge_name` describes it. */
  readonly spelt: string;
}

/** git's `strbuf_branchname` over a merge argument: `@{-<n>}` and a branch mark spelt out. */
const interpretMergeName = async (ctx: Context, name: string): Promise<string> => {
  const expanded = await expandPriorCheckout(ctx, name);
  return (await branchMarkRef(ctx, expanded)) ?? expanded;
};

/** git's `get_merge_parent`: any revision, peeled to the commit it names. */
const resolveMergeParent = async (ctx: Context, name: string): Promise<MergeRemote> => {
  const spelt = await interpretMergeName(ctx, name);
  const object = await resolveRevisionExpression(ctx, spelt);
  if (object === undefined) throw refNotFound(name as RefName);
  const { id, result } = await peelChain(ctx, object, readObject, tagHop);
  if (result.type !== 'commit') throw refNotFound(name as RefName);
  return { id, name, object, spelt };
};

/** git's `get_merge_parent` over each name given, in order. */
const resolveRemotes = async (
  ctx: Context,
  revs: ReadonlyArray<string>,
): Promise<MergeRemote[]> => {
  const remotes: MergeRemote[] = [];
  for (const name of revs) remotes.push(await resolveMergeParent(ctx, name));
  return remotes;
};

/** A merge `reduce_heads` leaves with one remote head: git's two-head path. */
const twoHeadMerge = async (
  ctx: Context,
  input: MergeRunInput,
  internal: MergeInternalOptions,
  branch: RefName | undefined,
  ourId: ObjectId,
  remote: MergeRemote,
  named: ReadonlyArray<MergeRemote> = [remote],
): Promise<MergeEnding> => {
  const theirId = remote.id;
  const opts = await settleMerge(ctx, input, internal, { branch, ourId }, [remote]);
  await writeOrigHead(ctx, ourId);
  await assertEverySourceLoadable(ctx);
  // Stryker disable next-line ConditionalExpression: equivalent — when ourId===theirId, mergeBase returns that same commit, so the `base === theirId` check below yields the identical up-to-date result.
  if (ourId === theirId) return { kind: 'up-to-date', id: ourId };
  const bases = await tryMergeBasesOf(ctx, [ourId, theirId]);
  // git's `reduce_heads` leaves no remote head when its walk cannot parse a parent.
  if (bases === undefined) return { kind: 'up-to-date', id: ourId };
  assertRelated(opts, bases);
  const [base] = bases;
  if (base === theirId) return { kind: 'up-to-date', id: ourId };
  if (base === ourId && opts.fastForward !== 'never') {
    return fastForwardOrSquash(ctx, { opts, internal, branch }, { ourId, theirId });
  }
  if (opts.fastForward === 'only') throw nonFastForward(branch ?? HEAD, ourId, theirId);
  const commit = { opts, internal, branch, ourId, parents: [ourId, theirId], named };
  return underAutostash(ctx, opts, () => twoHeadStrategy(ctx, commit, remote, bases));
};

/** HEAD is an ancestor of the one remote head: fast-forward to it, or squash it in. */
const fastForwardOrSquash = (
  ctx: Context,
  { opts, internal, branch }: Pick<MergeCommitInput, 'opts' | 'internal' | 'branch'>,
  heads: { readonly ourId: ObjectId; readonly theirId: ObjectId },
): Promise<MergeEnding> =>
  underAutostash(ctx, opts, async () =>
    opts.squash === true
      ? squashInto(ctx, await getTree(ctx, heads.theirId), heads.ourId, [heads.theirId])
      : fastForward(ctx, opts, internal, branch, heads),
  );

/** git's trivial in-index merge where every strategy allows it, then its strategy loop for one head. */
const twoHeadStrategy = async (
  ctx: Context,
  commit: MergeCommitInput,
  remote: MergeRemote,
  bases: ReadonlyArray<ObjectId>,
): Promise<MergeEnding> => {
  if (allowsTrivialMerge(commit.opts.strategies)) {
    const trivial = await tryTrivialMerge(ctx, commit, remote.id, bases);
    if (trivial !== undefined) return trivial;
  }
  return tryStrategies(ctx, commit, (strategy) =>
    twoHeadAttempt(ctx, commit, { remote, bases, strategy }),
  );
};

/** What one strategy makes of the merge, before anything is written. */
type StrategyAttempt =
  | {
      readonly kind: 'clean';
      readonly tree: ObjectId;
      readonly note: string;
      /** The tree an ort merge records in `AUTO_MERGE` as it switches to its result. */
      readonly autoMerge?: ObjectId;
    }
  | ConflictAttempt
  | { readonly kind: 'failed' };

interface ConflictAttempt {
  readonly kind: 'conflict';
  /** git's `evaluate_result`: each unmerged path's diff-files record and its index stages. */
  readonly weight: number;
  readonly persist: () => Promise<MergeEnding>;
}

const FAILED: StrategyAttempt = { kind: 'failed' };

/**
 * git's strategy loop: the first strategy to merge cleanly commits; else the
 * last of those leaving the fewest conflicts writes them; else none handled it.
 */
const tryStrategies = async (
  ctx: Context,
  commit: MergeCommitInput,
  attempt: (strategy: string) => Promise<StrategyAttempt>,
): Promise<MergeEnding> => {
  const { strategies } = commit.opts;
  let best: ConflictAttempt | undefined;
  ctx.progress.start(MERGE_WRITE_FILES_OP);
  try {
    for (const strategy of strategies) {
      const tried = await attempt(strategy);
      if (tried.kind === 'clean') return await commitCleanAttempt(ctx, commit, tried);
      if (tried.kind === 'conflict') best = preferConflict(best, tried);
    }
    if (best !== undefined) return await best.persist();
  } finally {
    ctx.progress.end(MERGE_WRITE_FILES_OP);
  }
  throw strategies.length === 1
    ? mergeStrategyFailed(strategies[0]!)
    : noMergeStrategyHandled(strategies);
};

/** Commit a clean attempt; an ort result is recorded in `AUTO_MERGE` before anything else is written. */
const commitCleanAttempt = async (
  ctx: Context,
  commit: MergeCommitInput,
  tried: Extract<StrategyAttempt, { readonly kind: 'clean' }>,
): Promise<MergeEnding> => {
  if (tried.autoMerge !== undefined) await writeAutoMerge(ctx, tried.autoMerge);
  return commitCleanMerge(ctx, commit, tried.tree, tried.note);
};

interface TwoHeadTry {
  readonly remote: MergeRemote;
  readonly bases: ReadonlyArray<ObjectId>;
  readonly strategy: string;
}

/** git-merge-resolve hands `-X` values to `read-tree` as options, which refuses them. */
const hasStrategyOptions = (opts: SettledMerge): boolean => (opts.strategyOptions?.length ?? 0) > 0;

/** git's `try_merge_strategy` for one head: git-merge-resolve gives up on a baseless merge, octopus on one head. */
const twoHeadAttempt = (
  ctx: Context,
  commit: MergeCommitInput,
  { remote, bases, strategy }: TwoHeadTry,
): Promise<StrategyAttempt> => {
  if (strategy === 'ours') return oursAttempt(ctx, commit);
  if (ORT_STRATEGIES.has(strategy)) return ortAttempt(ctx, commit, remote.id, bases[0], strategy);
  if (strategy === 'octopus' || bases.length === 0) return Promise.resolve(FAILED);
  if (hasStrategyOptions(commit.opts)) return Promise.resolve(FAILED);
  return octopusAttempt(ctx, commit, [remote], strategy);
};

/** ort's settings for a porcelain merge: `diff.algorithm` first, then the `-X` options over it. */
const ortSettings = async (
  ctx: Context,
  strategy: string,
  opts: SettledMerge,
): Promise<OrtStrategyOptions> => {
  // builtin/merge.c sets `subtree_shift = ""` for `-s subtree` before reading `-X`.
  const implied = strategy === SUBTREE_STRATEGY ? [SUBTREE_STRATEGY] : [];
  const xOptions = parseOrtStrategyOptions([...implied, ...(opts.strategyOptions ?? [])]);
  const configured = await readUiDiffAlgorithm(ctx);
  // git reads the config at startup, so an unparsable value refuses even when `-X` decides.
  const configuredRenormalize = await readMergeRenormalize(ctx);
  const renormalize = xOptions.renormalize ?? configuredRenormalize ?? false;
  return {
    ...(configured === undefined ? {} : { diffAlgorithm: configured }),
    ...xOptions,
    renormalize,
  };
};

const ortAttempt = async (
  ctx: Context,
  commit: MergeCommitInput,
  theirId: ObjectId,
  baseId: ObjectId | undefined,
  strategy: string,
): Promise<StrategyAttempt> => {
  const { opts, ourId } = commit;
  const settings = await ortSettings(ctx, strategy, opts);
  const result = await computeMergeTreeResult(
    ctx,
    { ourId, theirId, baseId, strategy: settings },
    opts.rev,
  );
  if (result.kind === 'clean') return cleanOrtAttempt(result.tree, strategy);
  return {
    kind: 'conflict',
    weight: conflictWeight(result.conflicts),
    persist: () => persistConflictState(ctx, opts, result, ourId, theirId),
  };
};

/** A clean ort merge records its tree as the `AUTO_MERGE` too. */
const cleanOrtAttempt = (tree: ObjectId, strategy: string): StrategyAttempt => ({
  kind: 'clean',
  tree,
  note: mergeMadeBy(strategy),
  autoMerge: tree,
});

/**
 * git's `read_tree_trivial` for a merge about to commit over one base: the
 * index must match HEAD, and only a merge no path needs a file-level merge for
 * is committed, as an `In-index merge`.
 */
const tryTrivialMerge = async (
  ctx: Context,
  commit: MergeCommitInput,
  theirId: ObjectId,
  bases: ReadonlyArray<ObjectId>,
): Promise<MergeEnding | undefined> => {
  const { ourId } = commit;
  if (bases.length !== 1) return undefined;
  const [base, ours, theirs] = await Promise.all(
    [bases[0]!, ourId, theirId].map(async (id) => flattenTree(ctx, await getTree(ctx, id))),
  );
  await assertIndexMatches(ctx, ours!.entries);
  const merged = trivialMerge(base!.entries, ours!.entries, theirs!.entries);
  if (merged === undefined) return undefined;
  return commitCleanMerge(ctx, commit, await writeFlatTree(ctx, merged), IN_INDEX_MERGE);
};

/** git's `ours` strategy: HEAD's tree is the result, once the index matches it. */
const oursAttempt = async (ctx: Context, commit: MergeCommitInput): Promise<StrategyAttempt> => {
  const tree = await getTree(ctx, commit.ourId);
  await assertIndexMatches(ctx, (await flattenTree(ctx, tree)).entries);
  return { kind: 'clean', tree, note: mergeMadeBy('ours') };
};

/** git's `refusing to merge unrelated histories`, unless `--allow-unrelated-histories`. */
const assertRelated = (opts: SettledMerge, common: ReadonlyArray<ObjectId>): void => {
  if (common.length === 0 && opts.allowUnrelatedHistories !== true) throw unrelatedHistories();
};

/** git's `get_octopus_merge_bases` over `HEAD` and every head. */
const OCTOPUS = { octopus: true } as const;

/**
 * Several heads: git's `reduce_parents` drops repeats, heads `HEAD` reaches,
 * and `HEAD` itself when another head reaches it; one remote head left takes
 * the two-head path, several take the `octopus` strategy.
 */
const manyHeadMerge = async (
  ctx: Context,
  input: MergeRunInput,
  internal: MergeInternalOptions,
  branch: RefName | undefined,
  ourId: ObjectId,
  named: ReadonlyArray<MergeRemote>,
): Promise<MergeEnding> => {
  const { reduced, remotes } = await survivingRemotes(ctx, ourId, named);
  const described = describedSurvivors(internal, named, reduced);
  if (remotes.length === 1) {
    return twoHeadMerge(ctx, input, described, branch, ourId, remotes[0]!, named);
  }
  if (remotes.length === 0) {
    await writeOrigHead(ctx, ourId);
    return { kind: 'up-to-date', id: ourId };
  }
  const opts = await settleMerge(ctx, input, described, { branch, ourId }, remotes);
  await writeOrigHead(ctx, ourId);
  await assertEverySourceLoadable(ctx);
  assertRelated(opts, await mergeBasesOf(ctx, [ourId, ...remotes.map((r) => r.id)], OCTOPUS));
  if (opts.fastForward === 'only') throw nonFastForward(branch ?? HEAD, ourId, remotes[0]!.id);
  const keepsHead = reduced.includes(ourId) || opts.fastForward === 'never';
  const parents = [...(keepsHead ? [ourId] : []), ...remotes.map((remote) => remote.id)];
  const commit = { opts, internal, branch, ourId, parents, named };
  return underAutostash(ctx, opts, () => manyHeadStrategy(ctx, commit, remotes));
};

/** git's `reduce_heads` over HEAD and every named head, and the remotes that survive it. */
const survivingRemotes = async (
  ctx: Context,
  ourId: ObjectId,
  named: ReadonlyArray<MergeRemote>,
): Promise<{
  readonly reduced: ReadonlyArray<ObjectId>;
  readonly remotes: ReadonlyArray<MergeRemote>;
}> => {
  const reduced = (await tryReduceHeads(ctx, [ourId, ...named.map((remote) => remote.id)])) ?? [];
  const remotes = reduced.flatMap(
    (id) => named.find((remote) => remote.id === id && id !== ourId) ?? [],
  );
  return { reduced, remotes };
};

/** git's `try_merge_strategy` for several heads: only `octopus` and `ours` handle them. */
const manyHeadStrategy = (
  ctx: Context,
  commit: MergeCommitInput,
  remotes: ReadonlyArray<OctopusRemote>,
): Promise<MergeEnding> =>
  tryStrategies(ctx, commit, (strategy) => {
    if (strategy === 'ours') return oursAttempt(ctx, commit);
    if (strategy !== 'octopus') return Promise.resolve(FAILED);
    return octopusAttempt(ctx, commit, remotes, strategy);
  });

/**
 * `fmt_merge_msg`'s `find_merge_parents`: a described head (a FETCH_HEAD line)
 * is named in the message only while its commit survives `reduce_heads` with
 * `HEAD` — one `HEAD` already contains drops out.
 */
const describedSurvivors = (
  internal: MergeInternalOptions,
  named: ReadonlyArray<OctopusRemote>,
  reduced: ReadonlyArray<ObjectId>,
): MergeInternalOptions => {
  if (internal.heads === undefined) return internal;
  const heads = internal.heads.filter((_, at) => reduced.includes(named[at]!.id));
  return { ...internal, heads };
};

const fastForward = async (
  ctx: Context,
  opts: SettledMerge,
  internal: MergeInternalOptions,
  branch: RefName | undefined,
  { ourId, theirId }: { readonly ourId: ObjectId; readonly theirId: ObjectId },
): Promise<MergeEnding> =>
  materialiseAndApply(ctx, await getTree(ctx, theirId), async () => {
    // Written through the literal `HEAD`: the branch it names, or HEAD itself when detached.
    await updateRef(ctx, HEAD, theirId, {
      expected: ourId,
      reflogMessage: `${internal.reflogAction ?? `merge ${opts.rev}`}: Fast-forward`,
    });
    return { kind: 'fast-forward', id: theirId, branch };
  });

const MERGE_WRITE_FILES_OP = 'merge:write-files';

export const UNSUPPORTED_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set(['gitlink']);

/** Conflicts whose working-tree file is the one side that still holds the path. */
const SURVIVOR_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set([
  'modify-delete',
  'rename-delete',
  'rename-rename',
  'file-location',
]);

/**
 * Map `materializeTree`'s checkout-flavoured dirty refusal to the merge-family
 * `WORKING_TREE_DIRTY` code, so the whole 3-way merge family speaks one
 * would-overwrite error; any other error passes through untouched. Exported for
 * direct unit testing.
 */
export const asMergeDirtyError = (err: unknown): unknown =>
  err instanceof TsgitError && err.data.code === 'CHECKOUT_OVERWRITE_DIRTY'
    ? workingTreeDirty({ localChanges: err.data.localChanges, untracked: err.data.untracked })
    : err;

/**
 * Materialise a non-conflict merge result (clean true-merge or fast-forward) to
 * the working tree + index: write the target tree's delta against the current
 * index and return the post-write stage-0 entries for the caller to commit under
 * its index lock. Mirrors the clean branch of `applyMergeToWorktree`; the
 * conflict path keeps its own sparse-aware writers.
 */
const materialiseNonConflictTree = async (
  ctx: Context,
  targetTree: ObjectId,
): Promise<ReadonlyArray<IndexEntry>> => {
  const currentIndex = await readIndex(ctx);
  try {
    const result = await materializeTree(ctx, { targetTree, currentIndex, force: false });
    return result.newIndexEntries;
  } catch (err) {
    throw asMergeDirtyError(err);
  }
};

/**
 * Materialise a non-conflict merge result (`targetTree`) to the working tree +
 * index under the index lock, then run `apply` (the ref/commit step) and return
 * its result — releasing the lock either way. Shared by the clean true-merge and
 * fast-forward branches so the lock ceremony lives in one place.
 */
const materialiseAndApply = async <T extends MergeEnding>(
  ctx: Context,
  targetTree: ObjectId,
  apply: () => Promise<T>,
): Promise<T> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const entries = await materialiseNonConflictTree(ctx, targetTree);
    await lock.commit(entries);
    return await apply();
  } finally {
    await lock.release();
  }
};

/** What a merge commit records: its message and identities, the branch it advances, its parents. */
interface MergeCommitInput {
  readonly opts: SettledMerge;
  readonly internal: MergeInternalOptions;
  /** The branch it advances; `undefined` when HEAD is detached. */
  readonly branch: RefName | undefined;
  readonly ourId: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  /** Every head as named, in order: a commit's first name is the one git's `merge_remote_util` keeps. */
  readonly named: ReadonlyArray<MergeRemote>;
}

/** git's `--squash` `finish`: stage `tree` and write `SQUASH_MSG`, leaving HEAD where it is. */
const squashInto = (
  ctx: Context,
  tree: ObjectId,
  ourId: ObjectId,
  heads: ReadonlyArray<ObjectId>,
): Promise<SquashedResult> =>
  materialiseAndApply(ctx, tree, async () => {
    await writeSquashMsg(ctx, await buildSquashMessage(ctx, ourId, heads));
    return { kind: 'squashed', origHead: ourId };
  });

/**
 * The state a conflicted merge stops in: `--squash` keeps `SQUASH_MSG` and a
 * bare conflicts hint in `MERGE_MSG`, else `MERGE_HEAD`, `MERGE_MODE` and the
 * message followed by that hint.
 */
const writeStopState = async (
  ctx: Context,
  opts: SettledMerge,
  ourId: ObjectId,
  heads: ReadonlyArray<ObjectId>,
  paths: ReadonlyArray<FilePath>,
): Promise<void> => {
  if (opts.squash === true) {
    await writeSquashMsg(ctx, await buildSquashMessage(ctx, ourId, heads));
    await writeMergeMsg(ctx, conflictsHint(paths));
    return;
  }
  await writeMergeHeads(ctx, heads);
  await writeMergeMode(ctx, opts.fastForward);
  const message = sanitizeMessage(opts.message, { allowEmpty: false });
  await writeMergeMsg(ctx, conflictMergeMsg(message, paths));
};

/** git's `--no-commit`: stage `tree` and keep `write_merge_state`'s files, leaving HEAD where it is. */
const stopBeforeCommit = (
  ctx: Context,
  opts: SettledMerge,
  tree: ObjectId,
  ourId: ObjectId,
  heads: ReadonlyArray<ObjectId>,
  message: string = `${opts.message}\n`,
): Promise<MergeEnding> =>
  materialiseAndApply(ctx, tree, async () => {
    await writeMergeHeads(ctx, heads);
    await writeMergeMode(ctx, opts.fastForward);
    await writeMergeMsg(ctx, message);
    return { kind: 'stopped', mergeHead: heads[0]!, origHead: ourId };
  });

/** git's `sign_commit`: `-S` / `--no-gpg-sign`, else `commit.gpgSign`. */
const mergeSignature = async (
  ctx: Context,
  opts: SettledMerge,
  data: CommitData,
): Promise<string | undefined> => {
  const config = await readConfig(ctx);
  if (!(opts.sign ?? config.commit?.gpgSign === true)) return undefined;
  return signCommitData(ctx, config, data, opts.signKey);
};

const TAG_DECODER = new TextDecoder();

/** git's `handle_signed_tag`: a parent first named by a signed tag carries that tag object. */
const signedTagHeader = async (
  ctx: Context,
  remote: MergeRemote | undefined,
): Promise<ExtraHeader | undefined> => {
  if (remote === undefined) return undefined;
  const tag = await readObject(ctx, remote.object);
  if (tag.type !== 'tag' || tag.data.gpgSignature === undefined) return undefined;
  return mergeTagHeader(TAG_DECODER.decode((await readRawObject(ctx, tag.id)).content));
};

/** git's `append_merge_tag_headers`: one `mergetag` header per signed-tag parent, in parent order. */
const mergeTagHeaders = async (
  ctx: Context,
  parents: ReadonlyArray<ObjectId>,
  named: ReadonlyArray<MergeRemote>,
): Promise<ReadonlyArray<ExtraHeader>> => {
  const firstNames = parents.map((parent) => named.find((remote) => remote.id === parent));
  const headers = await Promise.all(firstNames.map((remote) => signedTagHeader(ctx, remote)));
  return headers.filter((header) => header !== undefined);
};

/** git's `finish_automerge`: commit the merged tree and log `note` behind the reflog action. */
const commitCleanMerge = async (
  ctx: Context,
  input: MergeCommitInput,
  mergedTree: ObjectId,
  note: string,
): Promise<MergeEnding> => {
  const { opts, ourId, parents } = input;
  const heads = parents.filter((id) => id !== ourId);
  if (opts.squash === true) return headless(squashInto(ctx, mergedTree, ourId, heads));
  if (opts.commit === false) return stopBeforeCommit(ctx, opts, mergedTree, ourId, heads);
  const commitData = await mergeCommitData(ctx, input, mergedTree);
  // git dies on a failed signing with the merge materialised and its state kept, MERGE_MSG
  // as `prepare_to_commit` wrote it: the message without its final newline.
  const gpgSignature = await mergeSignature(ctx, opts, commitData).catch(async (error: unknown) => {
    await stopBeforeCommit(ctx, opts, mergedTree, ourId, heads, commitData.message.slice(0, -1));
    throw error;
  });
  return materialiseAndApply(ctx, mergedTree, () =>
    writeMergeCommit(ctx, input, { commitData, gpgSignature }, note),
  );
};

/** The merge commit's data: its author, committer, cleaned message and mergetag headers. */
const mergeCommitData = async (
  ctx: Context,
  { opts, parents, named }: MergeCommitInput,
  mergedTree: ObjectId,
): Promise<CommitData> => {
  const author = await resolveMergeAuthor(ctx, opts);
  const committer = resolveMergeCommitter(opts, author);
  const message = sanitizeMessage(opts.message, { allowEmpty: false });
  return {
    tree: mergedTree,
    parents,
    author,
    committer,
    message,
    extraHeaders: await mergeTagHeaders(ctx, parents, named),
  };
};

/** Store the (signed) merge commit and advance HEAD behind the reflog action. */
const writeMergeCommit = async (
  ctx: Context,
  { opts, internal, branch, ourId, parents }: MergeCommitInput,
  {
    commitData,
    gpgSignature,
  }: { readonly commitData: CommitData; readonly gpgSignature: string | undefined },
  note: string,
): Promise<MergeResult> => {
  const { extraHeaders, ...unsigned } = commitData;
  const signed = gpgSignature === undefined ? unsigned : { ...unsigned, gpgSignature };
  const id = await createCommitWithStoredHeaders(ctx, signed, extraHeaders);
  // Written through the literal `HEAD`: the branch it names, or HEAD itself when detached.
  await updateRef(ctx, HEAD, id, {
    expected: ourId,
    reflogMessage: `${internal.reflogAction ?? `merge ${opts.rev}`}: ${note}`,
  });
  return { kind: 'merge', id, branch, parents };
};

/**
 * git's `octopus` strategy, which `resolve` runs as `git-merge-one-file` does:
 * the index must match `HEAD`; a conflict on the last head is left to resolve.
 */
const octopusAttempt = async (
  ctx: Context,
  commit: MergeCommitInput,
  remotes: ReadonlyArray<OctopusRemote>,
  strategy: string,
): Promise<StrategyAttempt> => {
  const ours = await flattenTree(ctx, await getTree(ctx, commit.ourId));
  await assertIndexMatches(ctx, ours.entries);
  const result = await octopusMerge(ctx, commit.ourId, remotes);
  if (result.kind === 'clean')
    return { kind: 'clean', tree: result.tree, note: mergeMadeBy(strategy) };
  return {
    kind: 'conflict',
    weight: conflictWeight(result.conflicts),
    persist: () => persistOctopusConflict(ctx, commit, result, ours.entries),
  };
};

const assertIndexMatches = async (ctx: Context, ours: FlatEntries): Promise<void> => {
  const { entries } = await readIndex(ctx);
  const indexed = new Set(entries.map((entry) => entry.path));
  const staged = new Set([
    ...entries.filter((entry) => !sameEntry(ours.get(entry.path), entry)).map((e) => e.path),
    ...[...ours.keys()].filter((path) => !indexed.has(path)),
  ]);
  if (staged.size > 0) throw workingTreeDirty({ localChanges: [...staged].sort(), untracked: [] });
};

const sameEntry = (committed: FlatTreeEntry | undefined, entry: FlatTreeEntry): boolean =>
  committed?.id === entry.id && committed.mode === entry.mode;

/** The working-tree moves from `ours` to `target`: each path added or changed, then each removed. */
const outcomesBetween = (
  ours: FlatEntries,
  target: FlatEntries,
  spared: ReadonlySet<FilePath>,
): MergeOutcome[] => [
  ...[...target].map(
    ([path, { id, mode }]): MergeOutcome => ({ status: 'resolved-known', path, id, mode }),
  ),
  ...[...ours.keys()]
    .filter((path) => !target.has(path) && !spared.has(path))
    .map((path): MergeOutcome => ({ status: 'resolved-deleted', path })),
];

/**
 * The octopus's last head left conflicts: the working tree takes the merged
 * entries (and, for a path `git-merge-one-file` refused, what it held), each
 * content conflict its marked bytes; `MERGE_HEAD` lists every head merged.
 */
const persistOctopusConflict = async (
  ctx: Context,
  commit: MergeCommitInput,
  result: Extract<OctopusResult, { readonly kind: 'conflict' }>,
  ours: FlatEntries,
): Promise<MergeEnding> => {
  const marked = result.conflicts.filter((conflict) => conflict.conflictContent !== undefined);
  const outcomes = outcomesBetween(ours, result.worktree, new Set(marked.map((c) => c.path)));
  const changed = changedPaths(outcomes, result.conflicts, ours);
  await assertNothingOverwritten(ctx, changed);
  validateMergeWritePaths(outcomes, result.conflicts, changed);
  const matcher = await loadSparseMatcher(ctx);
  const merged = outcomesBetween(new Map(), result.merged, new Set());
  const remotes = commit.parents.filter((id) => id !== commit.ourId);
  await underIndexLock(ctx, async () => {
    await writeConflictingWorkingTree(ctx, outcomes, marked, changed, matcher);
    const paths = sortedRecordedPaths(result.conflicts);
    await writeStopState(ctx, commit.opts, commit.ourId, remotes, paths);
    return buildConflictIndexEntries(merged, result.conflicts, matcher, []);
  });
  return conflictOutcome(commit.opts, result.conflicts, remotes[0]!, commit.ourId);
};

type MergeTreeResult =
  | { readonly kind: 'clean'; readonly tree: ObjectId }
  | {
      readonly kind: 'conflict';
      readonly outcomes: ReadonlyArray<MergeOutcome>;
      readonly conflicts: ReadonlyArray<MergeConflict>;
      readonly ours: ReadonlyMap<FilePath, { readonly id: ObjectId; readonly mode: FileMode }>;
    };

interface MergeTreeInput {
  readonly ourId: ObjectId;
  readonly theirId: ObjectId;
  readonly baseId: ObjectId | undefined;
  readonly strategy: OrtStrategyOptions;
}

/** The strategy's boolean `renormalize` becomes the content merger's resolved attribute settings. */
const contentSettings = (
  { renormalize: _requested, ...settings }: OrtStrategyOptions,
  renormalize: RenormalizeSettings | undefined,
): ContentMergeSettings => (renormalize === undefined ? settings : { ...settings, renormalize });

const computeMergeTreeResult = async (
  ctx: Context,
  input: MergeTreeInput,
  revName: string,
): Promise<MergeTreeResult> => {
  const { strategy } = input;
  const trees = await readMergeSides(ctx, input);
  const labels: MergeLabels = mergeLabels(revName, input.baseId);
  const { base, ours, theirs } = trees;
  const renormalize = strategy.renormalize
    ? { attributes: renormalizeAttributeLookup(base, ours, theirs) }
    : undefined;
  const contentMerger = buildContentMerger(ctx, labels, contentSettings(strategy, renormalize));
  const detected = await detectMergeRenames(ctx, base, ours, theirs, strategy.renames);
  const renames = await mergeCollidingRenameSources(ctx, trees, detected, contentMerger);
  const merged = await mergeTrees(
    base,
    ours,
    theirs,
    contentMerger,
    labels,
    renames,
    strategy.variant,
    renormalize && buildBlobUnchanged(ctx, renormalize),
  );
  return settleMergeTree(ctx, merged, ours);
};

/** The three sides a merge reads, flattened — and subtree-shifted onto ours when asked. */
interface FlatMergeSides {
  readonly base: FlatTree | undefined;
  readonly ours: FlatTree;
  readonly theirs: FlatTree;
}

const readMergeSides = async (
  ctx: Context,
  { ourId, theirId, baseId, strategy }: MergeTreeInput,
): Promise<FlatMergeSides> => {
  const ourTreeId = await getTree(ctx, ourId);
  const theirTreeId = await getTree(ctx, theirId);
  const baseTreeId = baseId !== undefined ? await getTree(ctx, baseId) : undefined;
  const [ourFlat, theirSide, baseSide] = await Promise.all([
    flattenTree(ctx, ourTreeId),
    flattenTree(ctx, theirTreeId),
    baseTreeId !== undefined ? flattenTree(ctx, baseTreeId) : Promise.resolve(undefined),
  ]);
  const shift = strategy.subtreeShift;
  if (shift === undefined) return { base: baseSide, ours: ourFlat, theirs: theirSide };
  const ours = { tree: ourTreeId, flat: ourFlat };
  const [theirs, base] = await Promise.all([
    shiftMergeSide(ctx, ours, { tree: theirTreeId, flat: theirSide }, shift),
    shiftMergeSide(ctx, ours, { tree: baseTreeId, flat: baseSide }, shift),
  ]);
  return { base, ours: ourFlat, theirs };
};

/** A clean merge's synthesised tree, or its conflicts with every split rename's blob staged. */
const settleMergeTree = async (
  ctx: Context,
  result: TreeMergeResult,
  ourFlat: FlatTree,
): Promise<MergeTreeResult> => {
  if (result.cleanMerge) {
    const tree = await synthesiseMergedTree(ctx, result.outcomes);
    return { kind: 'clean', tree };
  }
  const staged = await stageSplitRenameBlobs(ctx, result.conflicts);
  return {
    kind: 'conflict',
    outcomes: result.outcomes.map((outcome) =>
      outcome.status === 'conflict'
        ? { ...outcome, conflict: staged.get(outcome.conflict) ?? outcome.conflict }
        : outcome,
    ),
    conflicts: result.conflicts.map((conflict) => staged.get(conflict) ?? conflict),
    ours: ourFlat.entries,
  };
};

/**
 * A rename/rename(1to2)'s merged content is staged at both destinations: write
 * that blob and stage it in place of the side's own.
 */
const stageSplitRenameBlobs = async (
  ctx: Context,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<ReadonlyMap<MergeConflict, MergeConflict>> => {
  const staged = new Map<MergeConflict, MergeConflict>();
  for (const conflict of conflicts) {
    if (conflict.type !== 'rename-rename' || conflict.conflictContent === undefined) continue;
    const blob = { type: 'blob', content: conflict.conflictContent, id: '' as ObjectId } as const;
    const id = await writeObject(ctx, blob);
    staged.set(
      conflict,
      conflict.ourId === undefined ? { ...conflict, theirId: id } : { ...conflict, ourId: id },
    );
  }
  return staged;
};

interface LeafRecord {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const collectLeaves = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<LeafRecord[]> => {
  const leaves: LeafRecord[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'resolved-deleted' || outcome.status === 'conflict') continue;
    if (outcome.status === 'resolved-merged') {
      // The empty-string `id` is a sentinel — `writeObject` computes the
      // real ObjectId from the content and returns it. The cast lets us
      // construct the typed input without circular dependence on the hash.
      const id = await writeObject(ctx, {
        type: 'blob',
        content: outcome.bytes,
        id: '' as ObjectId,
      });
      leaves.push({ path: outcome.path, id, mode: outcome.mode });
      continue;
    }
    // unchanged | resolved-known
    leaves.push({ path: outcome.path, id: outcome.id, mode: outcome.mode });
  }
  return leaves;
};

const synthesiseMergedTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<ObjectId> => {
  const leaves = await collectLeaves(ctx, outcomes);
  return writeNestedTree(ctx, leaves);
};

interface PartitionedLeaves {
  readonly files: ReadonlyArray<LeafRecord>;
  readonly subdirs: ReadonlyMap<string, ReadonlyArray<LeafRecord>>;
}

const partitionByPrefix = (leaves: ReadonlyArray<LeafRecord>): PartitionedLeaves => {
  const files: LeafRecord[] = [];
  const subdirs = new Map<string, LeafRecord[]>();
  for (const leaf of leaves) {
    const slashIndex = leaf.path.indexOf('/');
    if (slashIndex === -1) {
      files.push(leaf);
      continue;
    }
    const prefix = leaf.path.slice(0, slashIndex);
    const rest = leaf.path.slice(slashIndex + 1) as FilePath;
    const sub: LeafRecord = { path: rest, id: leaf.id, mode: leaf.mode };
    const bucket = subdirs.get(prefix);
    if (bucket === undefined) subdirs.set(prefix, [sub]);
    else bucket.push(sub);
  }
  return { files, subdirs };
};

/**
 * Sentinel `parentIndex` meaning "this frame's parent is the root" — the
 * root is never itself a member of `frames` (see `LeafTrieFrame`), so it
 * can't be addressed by a real array index.
 */
const ROOT_PARENT_LEVEL_INDEX = -1;

/**
 * One NAMED node of the leaf trie below the root. The root itself is
 * excluded from `frames` — it's the one node with no name, so keeping it out
 * of the array (its files live in `LeafTrie.rootFiles` instead) makes `name`
 * non-optional for every real frame. `parentIndex` is either
 * `ROOT_PARENT_LEVEL_INDEX` or another index into `frames`.
 */
interface LeafTrieFrame {
  readonly name: FilePath;
  readonly files: ReadonlyArray<LeafRecord>;
  readonly parentIndex: number;
}

interface LeafTrie {
  readonly rootFiles: ReadonlyArray<LeafRecord>;
  readonly frames: ReadonlyArray<LeafTrieFrame>;
  /** `levels[d]` lists every frame index at nesting depth `d + 1` — the root's own depth (0) is never a `frames` member. */
  readonly levels: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Discover the leaf trie level by level with an explicit queue instead of
 * recursion, checking the depth cap BEFORE partitioning each level — an
 * adversarial commit with pathologically deep paths is refused the moment
 * it crosses `maxDepth`, without ever partitioning the level beyond it.
 * Matches the previous recursive guard's contract exactly (it checked
 * `depth > maxDepth` at the top of each call, before doing that call's
 * work), so both sites refuse at `depth === maxDepth + 1`. The root's own
 * check (`depth === 0`) is applied before its leaves are partitioned, same
 * as every other level — reachable whenever `core.maxTreeDepth` is
 * configured negative.
 */
const buildLeafTrie = (rootLeaves: ReadonlyArray<LeafRecord>, maxDepth: number): LeafTrie => {
  if (maxDepth < 0) throw treeDepthExceeded(0);
  const { files: rootFiles, subdirs: rootSubdirs } = partitionByPrefix(rootLeaves);

  const frames: LeafTrieFrame[] = [];
  const levels: number[][] = [];
  let currentLevel: Array<{
    readonly name: FilePath;
    readonly leaves: ReadonlyArray<LeafRecord>;
    readonly parentIndex: number;
  }> = [];
  for (const [prefix, subLeaves] of rootSubdirs) {
    currentLevel.push({
      name: prefix as FilePath,
      leaves: subLeaves,
      parentIndex: ROOT_PARENT_LEVEL_INDEX,
    });
  }
  let depth = 1;
  while (currentLevel.length > 0) {
    if (depth > maxDepth) throw treeDepthExceeded(depth);
    const levelIndices: number[] = [];
    const nextLevel: typeof currentLevel = [];
    for (const node of currentLevel) {
      const index = frames.length;
      const { files, subdirs } = partitionByPrefix(node.leaves);
      frames.push({ name: node.name, files, parentIndex: node.parentIndex });
      levelIndices.push(index);
      for (const [prefix, subLeaves] of subdirs) {
        nextLevel.push({ name: prefix as FilePath, leaves: subLeaves, parentIndex: index });
      }
    }
    levels.push(levelIndices);
    currentLevel = nextLevel;
    depth += 1;
  }
  return { rootFiles, frames, levels };
};

const leavesToTreeEntries = (files: ReadonlyArray<LeafRecord>): TreeEntry[] =>
  files.map((f) => treeEntry(f.mode, f.path, f.id));

/**
 * Write the leaf trie deepest-level-first. Every frame WITHIN a level is
 * resolved in parallel via `Promise.all` — each depends only on its own
 * files (already known) and its own children's already-written ids (from
 * the level below, already merged into its entry list by the previous
 * iteration), never on a level-sibling — so this is the same "resolve
 * independent subdirs concurrently" property the original recursive
 * `Promise.all` had over one parent's direct children, generalised to a
 * whole level (a strictly wider, still-correct parallelism: entries from
 * unrelated parents at the same depth now overlap too). Swapping this
 * bounded fan-out for a sequential `for` loop would still produce the exact
 * same final tree oid — the write order across independent branches never
 * affects any individual branch's content-addressed id — so unit-level
 * output assertions cannot distinguish parallel from serial without timing
 * or call-order instrumentation; the parallelism is a wall-clock
 * optimisation for merges with many top-level directories, not an
 * observable behaviour.
 */
const writeLeafTrie = async (ctx: Context, trie: LeafTrie): Promise<ObjectId> => {
  const rootTreeEntries = leavesToTreeEntries(trie.rootFiles);
  const treeEntries = trie.frames.map((frame) => leavesToTreeEntries(frame.files));
  for (let level = trie.levels.length - 1; level >= 0; level -= 1) {
    const written = await boundedMapFor(ctx, 'ioBound', trie.levels[level]!, async (index) => ({
      index,
      id: await writeTree(ctx, treeEntries[index]!),
    }));
    for (const { index, id } of written) {
      const frame = trie.frames[index]!;
      const parentEntries =
        frame.parentIndex === ROOT_PARENT_LEVEL_INDEX
          ? rootTreeEntries
          : treeEntries[frame.parentIndex]!;
      parentEntries.push(treeEntry(FILE_MODE.DIRECTORY, frame.name, id));
    }
  }
  return writeTree(ctx, rootTreeEntries);
};

/** Build a nested tree from flat leaf records. Exported for direct unit testing. */
export const writeNestedTree = async (
  ctx: Context,
  leaves: ReadonlyArray<LeafRecord>,
): Promise<ObjectId> => {
  const maxDepth = await resolveMaxTreeDepth(ctx);
  return writeLeafTrie(ctx, buildLeafTrie(leaves, maxDepth));
};

/**
 * Persist the conflicting-merge state on disk's write order:
 * working-tree files → ORIG_HEAD → MERGE_HEAD → MERGE_MSG → index.
 *
 * Unsupported conflict types, would-overwrite refusals, and hostile
 * entry-path refusals are checked upfront BEFORE any disk write so the
 * operation fails atomically (HEAD/index/working-tree untouched, no
 * MERGE_HEAD, no leaked index lock).
 */
const persistConflictState = async (
  ctx: Context,
  opts: SettledMerge,
  result: Extract<MergeTreeResult, { readonly kind: 'conflict' }>,
  ourId: ObjectId,
  theirId: ObjectId,
): Promise<MergeEnding> => {
  const changed = await refuseUnwritableConflicts(ctx, result);
  await writeConflictState(ctx, { opts, result, ourId, theirId }, changed);
  return conflictOutcome(opts, result.conflicts, theirId, ourId);
};

type ConflictedTree = Extract<MergeTreeResult, { readonly kind: 'conflict' }>;

/**
 * Every refusal, before the first write; returns the paths the merge changes.
 * The whole-set path gate is hoisted above the write wave and above
 * `acquireIndexLock`: every outcome/conflict path this call is about to write
 * is validated in one upfront pass, so a hostile name anywhere in the batch
 * refuses before the FIRST byte is written, not partway through the
 * concurrent write wave — mirrors `validateChangesetPaths`
 * (apply-changeset.ts) and `restoreUntracked`'s pre-pass (stash.ts).
 */
const refuseUnwritableConflicts = async (
  ctx: Context,
  result: ConflictedTree,
): Promise<ReturnType<typeof changedPaths>> => {
  rejectUnsupportedConflicts(result.conflicts);
  const changed = changedPaths(result.outcomes, result.conflicts, result.ours);
  await assertNothingOverwritten(ctx, changed);
  validateMergeWritePaths(result.outcomes, result.conflicts, changed);
  return changed;
};

/**
 * AUTO_MERGE, then — under the index lock — the working tree, the stop state
 * and the conflicted index. loadSparseMatcher is a pure config/pattern-file
 * read — no lock needed. A defined matcher keeps excluded blob-backed paths
 * out of the working tree and marks their stage-0 conflict-state entries
 * skip-worktree.
 */
const writeConflictState = async (
  ctx: Context,
  {
    opts,
    result,
    ourId,
    theirId,
  }: {
    readonly opts: SettledMerge;
    readonly result: ConflictedTree;
    readonly ourId: ObjectId;
    readonly theirId: ObjectId;
  },
  changed: ReturnType<typeof changedPaths>,
): Promise<void> => {
  const matcher = await loadSparseMatcher(ctx);
  const merged = await mergedBlobEntries(ctx, result.outcomes);
  // Recorded before the first write: a broken AUTO_MERGE fails the merge as git's does.
  await writeAutoMerge(
    ctx,
    await conflictResultTree(ctx, result.outcomes, result.conflicts, merged),
  );
  await underIndexLock(ctx, async () => {
    await writeConflictingWorkingTree(ctx, result.outcomes, result.conflicts, changed, matcher);
    await writeStopState(ctx, opts, ourId, [theirId], sortedRecordedPaths(result.conflicts));
    return buildConflictIndexEntries(result.outcomes, result.conflicts, matcher, merged);
  });
};

/**
 * Refuse before any write when materialising the merge would clobber a
 * tracked working file with local changes, or squat an untracked file on a
 * path the merge adds — pure, lock-free reads, so the refusal is atomic.
 */
const assertNothingOverwritten = async (
  ctx: Context,
  changed: ReadonlySet<FilePath>,
): Promise<void> => {
  const currentIndex = await readIndex(ctx);
  const { localChanges, untracked } = await findWouldOverwrite(ctx, changed, currentIndex);
  if (localChanges.length > 0 || untracked.length > 0) {
    throw workingTreeDirty({ localChanges, untracked });
  }
};

/**
 * Run `write` under the index lock and commit the entries it returns. The
 * lock is always released — `commit` flips it to a no-op on success.
 */
const underIndexLock = async (
  ctx: Context,
  write: () => Promise<ReadonlyArray<IndexEntry>>,
): Promise<void> => {
  const lock = await acquireIndexLock(ctx);
  try {
    await lock.commit(await write());
  } finally {
    await lock.release();
  }
};

const conflictOutcome = (
  opts: SettledMerge,
  conflicts: ReadonlyArray<MergeConflict>,
  mergeHead: ObjectId,
  origHead: ObjectId,
): MergeEnding => {
  const descriptors = conflicts.map((c) => ({ path: c.path, type: c.type }));
  if (opts.squash === true) {
    return {
      kind: 'headless-squash',
      result: { kind: 'squashed', origHead, conflicts: descriptors },
    };
  }
  return { kind: 'conflict', conflicts: descriptors, mergeHead, origHead };
};

/**
 * Reject conflict types that v1 cannot persist as resolvable merge state
 * (`rename-rename`, `gitlink`). Fires BEFORE `acquireIndexLock` in the
 * caller so an unsupported conflict surfaces atomically — no stale
 * `index.lock`, no working-tree pollution, no MERGE_HEAD on disk.
 * Exported for direct unit testing.
 */
export const rejectUnsupportedConflicts = (conflicts: ReadonlyArray<MergeConflict>): void => {
  for (const conflict of conflicts) {
    if (UNSUPPORTED_CONFLICT_TYPES.has(conflict.type)) {
      throw unsupportedOperation(
        'merge',
        `conflict type '${conflict.type}' not supported in v1 (path=${conflict.path})`,
      );
    }
  }
};

/** True iff a sparse matcher is active AND rejects the path. */
const isExcluded = (matcher: SparseMatcher | undefined, path: FilePath): boolean =>
  matcher !== undefined && !matcher(path);

const writeConflictingWorkingTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  changed: ReadonlySet<FilePath>,
  matcher: SparseMatcher | undefined,
): Promise<void> => {
  // Only outcomes the merge actually changes reach the working tree; an
  // outcome the merge leaves alone (e.g. `unchanged` on both sides) must
  // not be rewritten from its committed blob, or it would clobber bytes the
  // user modified locally at a path the merge never touched. Conflict
  // outcomes carry no path and are materialised by the conflicts batch below.
  const touched = outcomes.filter(
    (outcome) => outcome.status !== 'conflict' && changed.has(outcome.path),
  );
  // One scanner for the whole call, shared by both bounded batches below:
  // its per-directory memo means a deep tree with many paths under the
  // same symlinked directory costs one `lstat` per distinct directory, not
  // one per path.
  const scanner = createLeadingPathScanner(ctx);
  // Every deletion lands before the writer reads attributes, as git unlinks
  // before its first checkout: a deleted `.gitattributes` must not govern the writes.
  await runBounded(ctx, touched.filter(isDeletion), (outcome) =>
    removeOutcomeFromTree(ctx, outcome),
  );
  const writer = await createMergeResultWriter(ctx, outcomes, conflicts);
  // Bounded parallelism — independent path writes overlap, but the pool
  // caps in-flight at the ioBound policy so a 10k-path merge doesn't
  // exhaust file descriptors.
  await runBounded(ctx, touched.filter(isWrite), (outcome) =>
    writeOutcomeToTree(outcome, matcher, writer, scanner),
  );
  // Conflicted paths are materialised even when sparse-excluded — a conflict
  // the user cannot see is unresolvable, so `writeConflictToTree` takes no
  // matcher.
  await runBounded(ctx, conflicts, (conflict) =>
    writeConflictToTree(ctx, conflict, writer, scanner),
  );
};

/**
 * Bounded parallel for-each: run side-effecting `fn` over `items` with at
 * most the ioBound policy in flight. A thin void specialization of
 * `boundedMapFor` (discards results).
 */
const runBounded = async <T>(
  ctx: Context,
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  await boundedMapFor(ctx, 'ioBound', items, fn);
};

type DeletedOutcome = Extract<MergeOutcome, { readonly status: 'resolved-deleted' }>;

const isDeletion = (outcome: MergeOutcome): outcome is DeletedOutcome =>
  outcome.status === 'resolved-deleted';

type WrittenOutcome = Exclude<MergeOutcome, DeletedOutcome>;

const isWrite = (outcome: MergeOutcome): outcome is WrittenOutcome => !isDeletion(outcome);

/**
 * Remove a `resolved-deleted` outcome's file.
 * A delete carries no mode of its own; REGULAR stands in because the only
 * mode-sensitive rule validation can trigger — the `.gitmodules`-symlink
 * rejection — is a write-time concern that does not apply to a removal.
 */
export const removeOutcomeFromTree = async (
  ctx: Context,
  outcome: DeletedOutcome,
): Promise<void> => {
  validateIndexPath(outcome.path, NO_PARSER_OFFSET, FILE_MODE.REGULAR);
  await removeWorkingTreeFile(ctx, outcome.path);
};

/**
 * Write a single merge outcome to the working tree. Exported for direct unit
 * testing.
 *
 * Sparse handling splits on where the content lives:
 * - `unchanged` / `resolved-known` are backed by a committed blob, so an
 *   excluded path is skipped — the working tree keeps only in-pattern files.
 * - `resolved-merged` carries its merged bytes in memory only; this write is
 *   their sole persistence, so the path is always materialised.
 * - `resolved-deleted` is not handled here: the delete wave removes those
 *   before any write, so callers never pass one.
 */
export const writeOutcomeToTree = async (
  outcome: WrittenOutcome,
  matcher: SparseMatcher | undefined,
  writer: WorkingTreeWriter,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  // Every outcome path is sourced from a tree walk (the merge's `ours`/
  // `theirs` flatten), never from a parsed index, so it is validated here
  // regardless of status. `conflict` is skipped because this function no-ops
  // on it (the conflict itself is validated by the parallel conflicts batch).
  if (outcome.status === 'conflict') return;
  validateIndexPath(outcome.path, NO_PARSER_OFFSET, outcome.mode);
  if (outcome.status === 'resolved-merged') {
    // The merged bytes exist only in memory — this write is their sole
    // persistence, so the path is materialised regardless of the matcher.
    await writer.writeBytes(outcome.path, outcome.bytes, outcome.mode, scanner);
    return;
  }
  if (isExcluded(matcher, outcome.path)) return;
  await writer.writeBlob(outcome.path, outcome.id, outcome.mode, scanner);
};

export const writeConflictToTree = async (
  ctx: Context,
  conflict: MergeConflict,
  writer: WorkingTreeWriter,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  // Materialise with the merged mode when the merge resolved one, else the
  // surviving side's (ours, or theirs for modify-delete with ours deleted) so
  // the kind (symlink / exec bit) is preserved. Every conflict constructor
  // pairs ids with modes, so bytes being derivable implies a mode exists; the
  // guard checks anyway and skips the blob read when no mode is present.
  //
  // Path validation runs unconditionally, whether or not a mode is derivable:
  // `conflictsToIndexEntries` still writes an index entry for a mode-less
  // conflict, so its path reaches `.git/index` regardless of whether this
  // function goes on to write working-tree bytes. REGULAR stands in when no
  // mode is derivable — the only mode-sensitive rule is the write-time-only
  // `.gitmodules`-symlink rejection, inapplicable when nothing is written.
  const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
  validateIndexPath(conflict.path, NO_PARSER_OFFSET, mode ?? FILE_MODE.REGULAR);
  if (conflict.type === 'distinct-types') {
    await writeDistinctTypesSides(writer, conflict, scanner);
    return;
  }
  if (mode === undefined) return;
  const bytes = await materialiseConflictBytes(ctx, conflict);
  if (bytes === undefined) return;
  await writer.writeBytes(conflict.path, bytes, mode, scanner);
};

// Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
const READ_BLOB_OPTS = { maxBytes: MAX_CONFLICT_OUTPUT_BYTES } as const;

const readOursBlob = (ctx: Context, conflict: MergeConflict): Promise<Uint8Array> | undefined => {
  if (conflict.ourId === undefined) return undefined;
  return readBlob(ctx, conflict.ourId, READ_BLOB_OPTS).then((b) => b.content);
};

const materialiseMarkedOrOurs = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  if (conflict.conflictContent !== undefined) return conflict.conflictContent;
  return readOursBlob(ctx, conflict);
};

/** Derive the working-tree bytes for a conflicting path. Exported for direct unit testing. */
export const materialiseConflictBytes = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  if (conflict.type === 'content') return materialiseMarkedOrOurs(ctx, conflict);
  if (conflict.type === 'add-add') return materialiseMarkedOrOurs(ctx, conflict);
  if (conflict.type === 'binary') return readOursBlob(ctx, conflict);
  if (conflict.type === 'type-change') return readOursBlob(ctx, conflict);
  if (SURVIVOR_CONFLICT_TYPES.has(conflict.type)) {
    // Preserve the surviving side's bytes (whichever has an id).
    const survivorId = conflict.ourId ?? conflict.theirId;
    if (survivorId === undefined) return undefined;
    return (await readBlob(ctx, survivorId, READ_BLOB_OPTS)).content;
  }
  return undefined;
};

const zeroStat = (mode: FileMode): StatData => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
});

/** Build the conflict-state index entries. Exported for direct unit testing. */
export const buildConflictIndexEntries = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  matcher: SparseMatcher | undefined,
  merged: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  // Blob-backed clean outcomes stage here; `merged` carries the line-merged
  // paths, already written as blobs (resolved-deleted contributes nothing).
  const stage0: IndexEntry[] = [...merged];
  for (const outcome of outcomes) {
    if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
      // An excluded clean path is recorded skip-worktree so `status` does not
      // report the (deliberately un-written) file as deleted.
      stage0.push(
        isExcluded(matcher, outcome.path)
          ? skipWorktreeEntry({ path: outcome.path, id: outcome.id, mode: outcome.mode })
          : {
              ...zeroStat(outcome.mode),
              id: outcome.id,
              flags: STAGE0_FLAGS,
              path: outcome.path,
            },
      );
    }
  }

  const stageConflicts = conflictsToIndexEntries(conflicts, zeroStat);
  // serializeIndex sorts by path only (V8's sort is stable so the
  // upstream stage ordering survives) but the canonical git index
  // requires (path, stage) order. Sort explicitly here to make the
  // invariant load-bearing on our own code rather than V8's
  // stable-sort guarantee.
  const combined = [...stage0, ...stageConflicts];
  combined.sort((a, b) => {
    // Stryker disable next-line EqualityOperator: equivalent — for equal paths `<=`/`>=` both return -1; same-path entries always arrive stage-ascending (conflictsToIndexEntries sorts, stage-0 precedes them), so -1 already matches the correct order.
    if (a.path < b.path) return -1;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — for any distinct-path pair V8's sort derives the order from the `a.path < b.path → -1` rule above (evaluated in whichever argument order yields `<`), so this `>` branch never changes the observable sort result.
    if (a.path > b.path) return 1;
    // Stryker disable next-line ArithmeticOperator: equivalent — the stage branch only compares equal-path entries, which always arrive stage-ascending (conflictsToIndexEntries sorts conflict stages and rejects duplicate paths; stage-0 entries all share stage 0), so the comparator is a no-op on an already-ordered run regardless of sign.
    return a.flags.stage - b.flags.stage;
  });
  return combined;
};

/** Resolve the merge-commit author. Exported for direct unit testing. */
export const resolveMergeAuthor = async (
  ctx: Context,
  opts: MergeRunInput,
): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  // A signingKey-only `[user]` (no name/email) is not an identity.
  const cfgUser =
    config.user?.name !== undefined && config.user?.email !== undefined
      ? {
          name: config.user.name,
          email: config.user.email,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: '+0000',
        }
      : undefined;
  const authorInput: { explicit?: AuthorIdentity; configUser?: AuthorIdentity } = {};
  if (opts.author !== undefined) authorInput.explicit = opts.author;
  if (cfgUser !== undefined) authorInput.configUser = cfgUser;
  return resolveAuthor(authorInput);
};

/** Resolve the merge-commit committer. Exported for direct unit testing. */
export const resolveMergeCommitter = (
  opts: MergeRunInput,
  author: AuthorIdentity,
): AuthorIdentity => {
  const committerInput: {
    explicit?: AuthorIdentity;
    author?: AuthorIdentity;
    configUser?: AuthorIdentity;
  } = { author };
  if (opts.committer !== undefined) committerInput.explicit = opts.committer;
  return resolveCommitter(committerInput);
};

const getTree = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};

import {
  configBadBooleanValue,
  configBadNumericValue,
  configBadZlibLevel,
  configMissingValue,
  operationInProgress,
} from '../../../domain/commands/error.js';
import { notARepository, workTreeConfigInvalid, workTreeRequired } from '../../../domain/index.js';
import { RefName } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { refNotFound } from '../../../domain/refs/error.js';
import {
  CHERRY_PICK_HEAD,
  MERGE_HEAD,
  REBASE_HEAD,
  REVERT_HEAD,
} from '../../../domain/refs/state-files.js';
import {
  dubiousOwnership,
  implicitBareRepository,
  repositoryExtensionsUnsupported,
  repositoryFormatVersionUnsupported,
} from '../../../domain/repository/error.js';
import { isRefsLinkText, isValidHeadContent } from '../../../domain/repository/head-ref.js';
import {
  CHERRY_PICK,
  MERGE,
  type PendingOperation,
  REBASE,
  REVERT,
} from '../../../domain/sequencer/operation-labels.js';
import type { Context, RepositoryFormatRefusal } from '../../../ports/context.js';
import {
  findFirstInvalidBoolean,
  findFirstInvalidBooleanInSection,
  findFirstInvalidCompression,
  findFirstInvalidLogAllRefUpdates,
  findFirstValuelessEntry,
  type InvalidBooleanEntry,
  type InvalidCompressionEntry,
  memoizeGateVerdict,
  openConfigEpoch,
  type ValuelessEntry,
} from '../config-read.js';
import { getRefStore, type ResolveDirectResult } from '../ref-store.js';
import { validateHead } from './head-file.js';

const HEAD_REF = RefName.from('HEAD');

/**
 * `readHeadRaw`'s return shape: `ResolveDirectResult` narrowed to exclude
 * `'missing'` (`readHeadRaw` throws `REF_NOT_FOUND` for that case instead of
 * returning it) — one shape, not two structurally identical unions. Kept as
 * a named alias so `HeadState` stays the type every call site imports.
 */
export type HeadState = Exclude<ResolveDirectResult, { readonly kind: 'missing' }>;

/**
 * Smallest-`line` selection shared by every eager gate in this file: distinct
 * keys always occupy distinct physical config lines (the tokenizer emits at
 * most one entry per line), so ties never occur and `<` alone decides.
 */
const pickLowerLine = <T extends { readonly line: number }>(
  a: T | undefined,
  b: T | undefined,
): T | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.line < b.line ? a : b;
};

const DISCOVERY_CORE_BOOLEAN_KEYS: ReadonlyArray<string> = ['bare'];
const DISCOVERY_EXTENSIONS_BOOLEAN_KEYS: ReadonlyArray<string> = ['worktreeconfig'];

/**
 * git's discovery-tier boolean refusal: `core.bare` and
 * `extensions.worktreeConfig` refuse EVERY command, the `config` porcelain
 * included, which is why the gate sits in `assertRepository` rather than the
 * `[core]`-only eager gate the porcelain deliberately skips.
 */
const assertDiscoveryBooleansValid = async (ctx: Context): Promise<void> => {
  const [coreBare, worktreeConfig] = await Promise.all([
    findFirstInvalidBoolean(ctx, 'core', undefined, DISCOVERY_CORE_BOOLEAN_KEYS),
    findFirstInvalidBoolean(ctx, 'extensions', undefined, DISCOVERY_EXTENSIONS_BOOLEAN_KEYS),
  ]);
  const found = pickLowerLine(coreBare, worktreeConfig);
  if (found !== undefined) throw configBadBooleanValue(found.key, found.source, found.value);
};

/**
 * Confirm `ctx` points at a real repository: `${gitDir}/HEAD` exists AND its
 * content parses as a head — git refuses a present-but-malformed gitdir with
 * the same up-front `not a git repository` fatal it uses for an absent one,
 * so an explicit `gitDir` naming a directory whose `HEAD` is garbage must
 * not be half-operated on — then run the discovery-tier boolean gate.
 * Returns the repo root (workDir for non-bare; gitDir for bare repos where
 * gitDir IS the root).
 */
export const assertRepository = async (ctx: Context): Promise<FilePath> => {
  if (!(await hasUsableHead(ctx))) {
    throw notARepository((ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath);
  }
  return await assertDiscoveryAndRoot(ctx);
};

/**
 * `assertDiscoveryBooleansValid` plus the resolved repo root — the part of
 * `assertRepository` that runs once `hasUsableHead` has passed. Extracted so
 * the memoised operational verdict (`computeGateVerdict`, below) can share it
 * without re-running `hasUsableHead`, which stays per-command.
 */
const assertDiscoveryAndRoot = async (ctx: Context): Promise<FilePath> => {
  await assertDiscoveryBooleansValid(ctx);
  return (ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath;
};

/**
 * The SAME head predicate discovery applies (`validate_headref`): a symlinked
 * `HEAD` is judged by its LINK TEXT — `refs/…` qualifies even when dangling —
 * and a regular file by its content. Keeping the two tiers on one rule is
 * what stops a directory from passing discovery and then refusing every
 * command. The read itself is `validateHead`'s job (discovery-tier: this
 * runs BEFORE a ref backend exists, so it stays a raw files-layout probe; a
 * reftable repository satisfies it through the stub file exactly as git
 * intends) — this predicate only interprets the shape it returns, and an
 * `unusable` result (absent, EACCES, EISDIR, EIO, …) always collapses to
 * "no usable head": git's own `validate_headref` returns the same -1 for a
 * failed `open`, so the refusal outcome matches regardless of the failure
 * class.
 */
const hasUsableHead = async (ctx: Context): Promise<boolean> => {
  const head = await validateHead(ctx);
  if (head.kind === 'symlink') return isRefsLinkText(head.linkText);
  if (head.kind === 'file') return isValidHeadContent(head.content);
  return false;
};

const CORE_STRING_KEYS: ReadonlyArray<string> = ['excludesfile', 'attributesfile'];
// `logallrefupdates` is deliberately excluded: it accepts a third literal
// ("always") beyond git's boolean grammar, so it takes its own tri-state-aware
// finder (`findFirstInvalidLogAllRefUpdates`) rather than this plain set.
const CORE_BOOLEAN_KEYS: ReadonlyArray<string> = ['sparsecheckout', 'sparsecheckoutcone'];
const DIFF_BOOLEAN_KEYS: ReadonlyArray<string> = ['cachetextconv'];

type EagerCandidate =
  | { readonly kind: 'valueless'; readonly line: number; readonly entry: ValuelessEntry }
  | { readonly kind: 'compression'; readonly line: number; readonly entry: InvalidCompressionEntry }
  | { readonly kind: 'boolean'; readonly line: number; readonly entry: InvalidBooleanEntry };

const throwEagerCandidate = (candidate: EagerCandidate): never => {
  if (candidate.kind === 'valueless') {
    const { entry } = candidate;
    throw configMissingValue(entry.key, entry.source, entry.line);
  }
  if (candidate.kind === 'boolean') {
    const { entry } = candidate;
    throw configBadBooleanValue(entry.key, entry.source, entry.value);
  }
  const { entry } = candidate;
  if (entry.failure.kind === 'numeric') {
    throw configBadNumericValue(entry.key, entry.source, entry.failure.value, entry.failure.reason);
  }
  throw configBadZlibLevel(entry.failure.level);
};

/**
 * Refuse when a `[core]` path-like (`excludesfile`/`attributesfile`) is
 * present-but-valueless, when a compression key (`loosecompression`/
 * `compression`) is present with any invalid value (valueless, bad integer,
 * or integer outside zlib's `-1..9`), or when a boolean key
 * (`core.sparseCheckout`, `core.sparseCheckoutCone`, `core.logAllRefUpdates`,
 * or any `[diff *]` subsection's `cachetextconv`) holds a value git's boolean
 * grammar refuses — mirroring git's eager `git_default_config` validation,
 * which dies on the operational surface while the `config` porcelain
 * (`assertRepository` alone) survives. `hookspath` is NOT in this broad set:
 * it dies on a narrower surface.
 *
 * `core.maxTreeDepth` used to be checked here too, first and unconditionally.
 * It no longer is: measured against git 2.55.0 on `status`/`commit` alone —
 * two of the five commands where git happens to name the class ahead of a
 * streaming class — that ordering generalised into a claim that did not
 * hold, and the eager gate over-refused three verbs git runs (`branch.list`,
 * `tag.list`, `branch.rename`) because git has no die-set for the class at
 * all: it is reached only by the object store, the index, the commit-graph,
 * or one of four builtins' own prologues. The class now lives at those
 * boundaries (`internal/repo-settings-gate.ts`'s `assertRepoSettingsValid`),
 * validated independently of this gate.
 *
 * Cross-class ordering (the five classes below): run all five finders in
 * parallel and throw the LOWEST-line entry's shape — string
 * (`CONFIG_MISSING_VALUE`), compression (`CONFIG_BAD_NUMERIC_VALUE` /
 * `CONFIG_BAD_ZLIB_LEVEL`), or boolean (`CONFIG_BAD_BOOLEAN_VALUE`). No-op
 * when every class is valid or absent.
 */
export const assertEagerConfigValid = async (ctx: Context): Promise<void> => {
  const [str, comp, boolCore, logAllRefUpdates, boolDiff] = await Promise.all([
    findFirstValuelessEntry(ctx, 'core', undefined, CORE_STRING_KEYS),
    findFirstInvalidCompression(ctx),
    findFirstInvalidBoolean(ctx, 'core', undefined, CORE_BOOLEAN_KEYS),
    findFirstInvalidLogAllRefUpdates(ctx),
    // git ignores a subsectionless `[diff] cachetextconv` (the key only exists
    // per-driver), so only subsectioned entries can refuse here.
    findFirstInvalidBooleanInSection(ctx, 'diff', DIFF_BOOLEAN_KEYS, { requireSubsection: true }),
  ]);
  const candidates: ReadonlyArray<EagerCandidate | undefined> = [
    str === undefined ? undefined : { kind: 'valueless', line: str.line, entry: str },
    comp === undefined ? undefined : { kind: 'compression', line: comp.line, entry: comp },
    boolCore === undefined ? undefined : { kind: 'boolean', line: boolCore.line, entry: boolCore },
    logAllRefUpdates === undefined
      ? undefined
      : { kind: 'boolean', line: logAllRefUpdates.line, entry: logAllRefUpdates },
    boolDiff === undefined ? undefined : { kind: 'boolean', line: boolDiff.line, entry: boolDiff },
  ];
  const selected = candidates.reduce<EagerCandidate | undefined>(
    (winner, candidate) => pickLowerLine(winner, candidate),
    undefined,
  );
  if (selected !== undefined) throwEagerCandidate(selected);
};

const throwFormatRefusal = (refusal: RepositoryFormatRefusal): never => {
  if (refusal.kind === 'version') throw repositoryFormatVersionUnsupported(refusal.version);
  throw repositoryExtensionsUnsupported(refusal.version, refusal.extensions);
};

/**
 * The ownership gate: `implicitBare` refuses ahead of `untrusted` — the one
 * measured ordering between the two — and `trustedDirectories` does not lift
 * the implicit-bare refusal. `foreignPath` is passed only when it is present
 * AND differs from `path`, so a reported value always names a directory
 * OTHER than the one `path` already names. Both reads are synchronous: the
 * layout is frozen at open time, so this is no I/O and no per-command cost.
 */
const assertTrusted = (ctx: Context, path: FilePath): void => {
  if (ctx.layout.implicitBare === true) throw implicitBareRepository(ctx.layout.gitDir);
  if (ctx.layout.untrusted === true) {
    const { foreignPath } = ctx.layout;
    const foreign =
      foreignPath !== undefined && foreignPath !== path ? (foreignPath as FilePath) : undefined;
    throw dubiousOwnership(path, foreign);
  }
};

/**
 * The acceptance tier: a repository the gates below reject is not operated on at
 * all. Every verb except the four surviving `config` read verbs takes this or
 * `assertOperationalRepository`.
 *
 * Insertion point: the ownership gate's `implicitBare` and `untrusted` arms land
 * ABOVE the format arm, and their relative order is that gate's to decide rather
 * than this one's.
 */
export const assertAcceptedRepository = async (ctx: Context): Promise<FilePath> => {
  const root = await assertRepository(ctx);
  return assertTrustedAndFormat(ctx, root);
};

/** `assertTrusted` plus the format-version refusal, both synchronous/zero-I/O — shared by `assertAcceptedRepository` and the memoised operational verdict below. */
const assertTrustedAndFormat = (ctx: Context, root: FilePath): FilePath => {
  assertTrusted(ctx, root);
  const refusal = ctx.layout.formatRefusal;
  if (refusal !== undefined) throwFormatRefusal(refusal);
  return root;
};

/**
 * The config-derived half of the operational gate:
 * `assertDiscoveryBooleansValid`, `assertTrusted`, the format-version
 * refusal, and `assertEagerConfigValid` — plus the resolved repo root. Pure
 * given `ctx.layout` (frozen at open time) and the token stream
 * `config-read.ts` already caches per Context, so a second command against
 * the SAME, unchanged Context does not re-run the eight finder walks —
 * `assertOperationalRepository`, below, memoises this via
 * `memoizeGateVerdict` (defined in `config-read.ts`, alongside
 * `invalidateConfigCache`, so the memo drops whenever that invalidator
 * fires without this module importing it back). `hasUsableHead` is
 * deliberately OUTSIDE the memo — it is what notices an externally deleted
 * or rewritten HEAD between two commands on the same Context.
 */
const computeGateVerdict = async (ctx: Context): Promise<FilePath> => {
  const root = assertTrustedAndFormat(ctx, await assertDiscoveryAndRoot(ctx));
  await assertEagerConfigValid(ctx);
  return root;
};

/**
 * The operational entry point: confirm the repository is accepted AND that
 * the `[core]` section passes full validation, then return the repo root.
 * Operational commands take this; the config porcelain stays on the bare
 * `assertRepository` so it survives a valueless or invalid `[core]` entry
 * (git's split). Three named steps, in order:
 *
 * 1. `hasUsableHead` — runs fresh on every call; the one part of this gate
 *    that must notice a HEAD change made outside `updateConfig*`.
 * 2. `openConfigEpoch` — the one `stat` of `.git/config` this command pays;
 *    everything downstream this command reads config through is served
 *    from the entry it trusts.
 * 3. The memoised verdict — served from the per-session memo, re-derived
 *    only when the epoch just re-keyed it.
 *
 * The two steps are never parallelised: a `stat` of config ahead of the HEAD
 * check would read a non-repository's config before refusing it.
 */
export const assertOperationalRepository = async (ctx: Context): Promise<FilePath> => {
  if (!(await hasUsableHead(ctx))) {
    throw notARepository((ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath);
  }
  await openConfigEpoch(ctx);
  return await memoizeGateVerdict(ctx, computeGateVerdict);
};

/**
 * git's `setup_work_tree()`: refuse when the work-tree config is bogus, then
 * when there is no work tree. Returns the work tree so callers stop reading
 * it unguarded — the compiler enforces that every work-tree read downstream
 * of this call is reached only once a work tree is proven to exist.
 *
 * Synchronous: unlike the config-driven `isBare`/`assertNotBare` this
 * replaces, the layout is already resolved at open time, so no config read
 * (and no `await`) is needed here.
 */
export const requireWorkTree = (ctx: Context, operation: string): string => {
  if (ctx.layout.workTreeConfigBogus === true) throw workTreeConfigInvalid(ctx.layout.gitDir);
  const workDir = ctx.layout.workDir;
  if (workDir === undefined) throw workTreeRequired(operation);
  return workDir;
};

/**
 * HEAD resolved through the ref backend — the seam every other ref read
 * already uses. Verdict: bug, fixed here — this used to read `<gitDir>/HEAD`
 * as a raw file directly, which answers with a reftable stub instead of the
 * real value once the backend is reftable; deferring to `getRefStore` like
 * every other ref closes that gap. Missing → REF_NOT_FOUND.
 */
export const readHeadRaw = async (ctx: Context): Promise<HeadState> => {
  const result = await getRefStore(ctx).resolveDirect(HEAD_REF);
  if (result.kind === 'missing') throw refNotFound(HEAD_REF);
  return result;
};

/** The current branch's full ref when HEAD is symbolic; `undefined` when detached. */
export const branchRefFromHead = (head: HeadState): RefName | undefined =>
  head.kind === 'symbolic' ? head.target : undefined;

/** `branchRefFromHead(readHeadRaw(ctx))` — the current branch's full ref, or `undefined` when detached. */
export const currentBranchRef = async (ctx: Context): Promise<RefName | undefined> =>
  branchRefFromHead(await readHeadRaw(ctx));

const PENDING_MARKERS: ReadonlyArray<{
  readonly file: string;
  readonly operation: PendingOperation;
}> = [
  { file: MERGE_HEAD, operation: MERGE },
  { file: CHERRY_PICK_HEAD, operation: CHERRY_PICK },
  { file: REVERT_HEAD, operation: REVERT },
  { file: REBASE_HEAD, operation: REBASE },
];

/**
 * Reject mutations when an in-progress operation has left a marker file behind.
 * Catches the four standard markers; first match in PENDING_MARKERS order wins
 * (MERGE_HEAD beats the rest), but the existence checks fan out in parallel.
 *
 * Pass `except` (a single operation or a list) to skip those markers — used by
 * `commit` to allow the resolving commit of a conflicted merge / cherry-pick,
 * and by `add` to allow staging the resolution of any in-progress operation.
 */
export const assertNoPendingOperation = async (
  ctx: Context,
  options: { readonly except?: PendingOperation | ReadonlyArray<PendingOperation> } = {},
): Promise<void> => {
  const except = options.except;
  const isExcepted = (op: PendingOperation): boolean =>
    Array.isArray(except) ? except.includes(op) : except === op;
  const flags = await Promise.all(
    PENDING_MARKERS.map((m) => ctx.fs.exists(`${ctx.layout.gitDir}/${m.file}`)),
  );
  // Stryker disable next-line EqualityOperator: equivalent — relaxing the bound to `i <= length` adds one iteration at `i === PENDING_MARKERS.length`, where `PENDING_MARKERS[i]` is `undefined`; the `marker === undefined` guard below immediately `continue`s, so no extra check or throw occurs.
  for (let i = 0; i < PENDING_MARKERS.length; i += 1) {
    const marker = PENDING_MARKERS[i];
    if (marker === undefined) continue;
    if (isExcepted(marker.operation)) continue;
    if (flags[i] === true) throw operationInProgress(marker.operation);
  }
};

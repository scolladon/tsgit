import {
  configBadBooleanValue,
  configBadNumericValue,
  configBadZlibLevel,
  configMissingValue,
  operationInProgress,
} from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { bareRepository, notARepository } from '../../../domain/index.js';
import { type ObjectId, RefName } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { refNotFound } from '../../../domain/refs/error.js';
import { parseLooseRef } from '../../../domain/refs/index.js';
import {
  CHERRY_PICK_HEAD,
  MERGE_HEAD,
  REBASE_HEAD,
  REVERT_HEAD,
} from '../../../domain/refs/state-files.js';
import {
  CHERRY_PICK,
  MERGE,
  type PendingOperation,
  REBASE,
  REVERT,
} from '../../../domain/sequencer/operation-labels.js';
import type { Context } from '../../../ports/context.js';
import {
  findFirstInvalidBoolean,
  findFirstInvalidBooleanInSection,
  findFirstInvalidCompression,
  findFirstInvalidLogAllRefUpdates,
  findFirstValuelessEntry,
  findLastInvalidMaxTreeDepth,
  type InvalidBooleanEntry,
  type InvalidCompressionEntry,
  readConfig,
  type ValuelessEntry,
} from '../config-read.js';

const HEAD_REF = RefName.from('HEAD');

/** Discriminated union returned by `readHeadRaw`. */
export type HeadState =
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'direct'; readonly id: ObjectId };

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
 * Confirm `ctx` points at a real repository: `${gitDir}/HEAD` exists, then run
 * the discovery-tier boolean gate. Returns the repo root (workDir for
 * non-bare; gitDir for bare repos where gitDir IS the root).
 */
export const assertRepository = async (ctx: Context): Promise<FilePath> => {
  const headPath = `${ctx.layout.gitDir}/HEAD`;
  if (!(await ctx.fs.exists(headPath))) {
    throw notARepository(ctx.layout.workDir as FilePath);
  }
  await assertDiscoveryBooleansValid(ctx);
  const root = ctx.layout.bare ? ctx.layout.gitDir : ctx.layout.workDir;
  return root as FilePath;
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
 * or integer outside zlib's `-1..9`), when a boolean key
 * (`core.sparseCheckout`, `core.sparseCheckoutCone`, `core.logAllRefUpdates`,
 * or any `[diff *]` subsection's `cachetextconv`) holds a value git's boolean
 * grammar refuses, or when `core.maxTreeDepth` resolves to an invalid value —
 * mirroring git's eager `git_default_config` validation, which dies on the
 * operational surface while the `config` porcelain (`assertRepository`
 * alone) survives. `hookspath` is NOT in this broad set: it dies on a
 * narrower surface.
 *
 * `core.maxTreeDepth` is checked FIRST, unconditionally, ahead of the
 * five-way line-ordered reduction below, and is thrown before that
 * reduction ever runs — it is not a `pickLowerLine` candidate. Every other
 * key here dies on its first malformed occurrence, because git observes
 * each config line once through its streaming `git_default_config`
 * callback, so "lowest line wins" is a faithful proxy for "first
 * encountered". `core.maxTreeDepth` is different: git resolves it through
 * its cached config-set lookup, which is last-wins on the EFFECTIVE value —
 * an earlier malformed line that a later valid line overrides is never
 * observed, and conversely an earlier valid line can be overridden by a
 * later malformed one regardless of what other classes occupy the lines in
 * between. That validation model cannot be folded into a line-position
 * comparison against the other five classes, so `core.maxTreeDepth` is
 * resolved and, if invalid, thrown separately before they are even
 * consulted. This ordering is PINNED against measured git behaviour (a
 * malformed `core.loosecompression` or `core.sparseCheckout` on an earlier
 * line still loses to `core.maxTreeDepth`), not a stylistic choice.
 *
 * Cross-class ordering (the remaining five): run all five finders in
 * parallel and throw the LOWEST-line entry's shape — string
 * (`CONFIG_MISSING_VALUE`), compression (`CONFIG_BAD_NUMERIC_VALUE` /
 * `CONFIG_BAD_ZLIB_LEVEL`), or boolean (`CONFIG_BAD_BOOLEAN_VALUE`). No-op
 * when every class is valid or absent.
 */
export const assertEagerConfigValid = async (ctx: Context): Promise<void> => {
  const [maxTreeDepth, str, comp, boolCore, logAllRefUpdates, boolDiff] = await Promise.all([
    findLastInvalidMaxTreeDepth(ctx),
    findFirstValuelessEntry(ctx, 'core', undefined, CORE_STRING_KEYS),
    findFirstInvalidCompression(ctx),
    findFirstInvalidBoolean(ctx, 'core', undefined, CORE_BOOLEAN_KEYS),
    findFirstInvalidLogAllRefUpdates(ctx),
    // git ignores a subsectionless `[diff] cachetextconv` (the key only exists
    // per-driver), so only subsectioned entries can refuse here.
    findFirstInvalidBooleanInSection(ctx, 'diff', DIFF_BOOLEAN_KEYS, { requireSubsection: true }),
  ]);
  if (maxTreeDepth !== undefined) {
    throw configBadNumericValue(
      maxTreeDepth.key,
      maxTreeDepth.source,
      maxTreeDepth.value,
      maxTreeDepth.reason,
    );
  }
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

/**
 * The operational entry point: confirm a real repository (HEAD exists) AND that
 * the `[core]` section passes full validation, then return the repo root.
 * Operational commands take this; the config porcelain stays on the bare
 * `assertRepository` so it survives a valueless or invalid `[core]` entry
 * (git's split).
 */
export const assertOperationalRepository = async (ctx: Context): Promise<FilePath> => {
  const root = await assertRepository(ctx);
  await assertEagerConfigValid(ctx);
  return root;
};

/** Read `core.bare` from `.git/config`. Defaults to false when missing. */
export const isBare = async (ctx: Context): Promise<boolean> => {
  const config = await readConfig(ctx);
  return config.core?.bare ?? false;
};

/**
 * Throw `BARE_REPOSITORY` when the repo is bare, attaching `operation` so the
 * caller can surface "cannot <operation> on a bare repository".
 */
export const assertNotBare = async (ctx: Context, operation: string): Promise<void> => {
  if (await isBare(ctx)) {
    throw bareRepository(operation);
  }
};

/** Read and parse `.git/HEAD`. Missing → REF_NOT_FOUND. */
export const readHeadRaw = async (ctx: Context): Promise<HeadState> => {
  const path = `${ctx.layout.gitDir}/HEAD`;
  let content: string;
  try {
    content = await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') {
      throw refNotFound(HEAD_REF);
    }
    throw err;
  }
  const parsed = parseLooseRef(content);
  if (parsed.type === 'symbolic') {
    return { kind: 'symbolic', target: parsed.target };
  }
  return { kind: 'direct', id: parsed.target };
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

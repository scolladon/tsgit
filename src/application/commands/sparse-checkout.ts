/**
 * `sparseCheckout` porcelain — git-parity sparse-checkout management, exposed
 * as the `repo.sparseCheckout.*` nested namespace (`list` / `set` / `add` /
 * `reapply` / `disable`). Each verb is a Context-aware function; the namespace
 * binder lives in `internal/sparse-checkout-namespace.ts`.
 *
 * Persistence ordering: a mutating verb computes its matcher in memory, runs
 * `applySparseCheckout` FIRST, and only AFTER a successful apply persists the
 * pattern file and config — a failed apply leaves `.git` untouched.
 */
import { invalidOption } from '../../domain/commands/error.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import {
  buildConeSpec,
  buildSparseMatcher,
  parseSparseCheckout,
  type SparseMatcher,
  type SparseSpec,
  serializeCone,
} from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import { enableWorktreeConfig } from '../primitives/internal/enable-worktree-config.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { loadSparseMatcher, readSparsePatternText } from '../primitives/read-sparse-checkout.js';
import { readSparseConfig } from '../primitives/read-sparse-config.js';
import { updateScopedConfigEntries } from '../primitives/update-config.js';
import { writeSparsePatternText } from '../primitives/write-sparse-checkout.js';
import {
  type ApplySparseCheckoutOpts,
  type ApplySparseCheckoutResult,
  applySparseCheckout,
} from './internal/apply-sparse-checkout.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  requireWorkTree,
} from './internal/repo-state.js';

export interface SparseCheckoutListResult {
  readonly cone: boolean;
  readonly patterns: ReadonlyArray<string>;
}

export interface SparseCheckoutAppliedResult {
  readonly cone: boolean;
  readonly materialized: number;
  readonly removed: number;
  readonly retained: ReadonlyArray<FilePath>;
}

export interface SparseCheckoutSetInput {
  readonly patterns: ReadonlyArray<string>;
  readonly cone?: boolean;
  readonly force?: boolean;
}

export interface SparseCheckoutAddInput {
  readonly patterns: ReadonlyArray<string>;
  readonly force?: boolean;
}

export interface SparseCheckoutReapplyInput {
  readonly force?: boolean;
}

export interface SparseCheckoutDisableInput {
  readonly force?: boolean;
}

/**
 * Sparse checkout needs a worktree and a quiet repo — gate every verb. The
 * repo-settings class is checked right after the gate, BEFORE the work-tree
 * requirement — git's `sparse-checkout.c` prologue dies on the class before
 * `setup_work_tree`, so a bare repo's `sparse-checkout list` names the class,
 * not the missing work tree.
 */
const assertSparseReady = async (ctx: Context): Promise<void> => {
  await assertOperationalRepository(ctx);
  await assertRepoSettingsValid(ctx);
  requireWorkTree(ctx, 'sparse-checkout');
  await assertNoPendingOperation(ctx);
};

/** Map a parsed spec onto the `list` output: sorted recursive dirs / raw lines. */
const specToList = (spec: SparseSpec): SparseCheckoutListResult => {
  if (spec.mode === 'cone') {
    return { cone: true, patterns: [...spec.recursive].sort() };
  }
  return { cone: false, patterns: spec.rules.map((rule) => rule.source) };
};

export const sparseCheckoutList = async (ctx: Context): Promise<SparseCheckoutListResult> => {
  await assertSparseReady(ctx);
  const sparse = await readSparseConfig(ctx);
  if (!sparse.enabled) {
    return { cone: false, patterns: [] };
  }
  const text = (await readSparsePatternText(ctx)) ?? '';
  return specToList(parseSparseCheckout(text, sparse.cone).spec);
};

/**
 * Build `applySparseCheckout` opts, omitting `force` when undefined —
 * `exactOptionalPropertyTypes` forbids passing an explicit `undefined`.
 */
const applyOpts = (
  matcher: SparseMatcher | undefined,
  force: boolean | undefined,
): ApplySparseCheckoutOpts => (force === undefined ? { matcher } : { matcher, force });

interface PersistOptions {
  readonly force: boolean | undefined;
  readonly recordMode: boolean;
}

const DISABLE_ENTRIES = [
  { section: 'core', key: 'sparseCheckout', value: 'false' },
  { section: 'core', key: 'sparseCheckoutCone', value: 'false' },
  { section: 'index', key: 'sparse', value: 'false' },
] as const;

/** Record the mode keys in the worktree layer with the casing git writes them in. */
const recordSparseMode = async (ctx: Context, cone: boolean): Promise<void> => {
  await enableWorktreeConfig(ctx);
  await updateScopedConfigEntries(ctx, 'worktree', [
    { section: 'core', key: 'sparseCheckout', value: 'true' },
    { section: 'core', key: 'sparseCheckoutCone', value: cone ? 'true' : 'false' },
  ]);
};

/**
 * When asked, record the mode first — git's `set` writes its config before it
 * touches the work tree, so a refused update leaves the config written — then
 * apply `spec` and persist the pattern file.
 */
const applyAndPersist = async (
  ctx: Context,
  spec: SparseSpec,
  text: string,
  options: PersistOptions,
): Promise<SparseCheckoutAppliedResult> => {
  if (options.recordMode) {
    await recordSparseMode(ctx, spec.mode === 'cone');
  }
  const applied = await applySparseCheckout(
    ctx,
    applyOpts(buildSparseMatcher(spec), options.force),
  );
  await writeSparsePatternText(ctx, text);
  return toApplied(spec.mode === 'cone', applied);
};

export const sparseCheckoutSet = async (
  ctx: Context,
  input: SparseCheckoutSetInput,
): Promise<SparseCheckoutAppliedResult> => {
  await assertSparseReady(ctx);
  if (input.patterns.length === 0) {
    throw invalidOption('patterns', 'set requires at least one pattern');
  }
  const sparse = await readSparseConfig(ctx);
  const useCone = input.cone ?? (sparse.enabled ? sparse.cone : true);
  const { spec, text } = buildSpecAndText(useCone, input.patterns);
  const recordMode = input.cone !== undefined || !sparse.enabled;
  return applyAndPersist(ctx, spec, text, { force: input.force, recordMode });
};

export const sparseCheckoutAdd = async (
  ctx: Context,
  input: SparseCheckoutAddInput,
): Promise<SparseCheckoutAppliedResult> => {
  await assertSparseReady(ctx);
  if (input.patterns.length === 0) {
    throw invalidOption('patterns', 'add requires at least one pattern');
  }
  const sparse = await readSparseConfig(ctx);
  if (!sparse.enabled) {
    throw invalidOption('action', 'add requires sparse checkout to be enabled');
  }
  const existing = (await readSparsePatternText(ctx)) ?? '';
  const { spec, text } = combineSpecAndText(sparse.cone, existing, input.patterns);
  return applyAndPersist(ctx, spec, text, { force: input.force, recordMode: false });
};

export const sparseCheckoutReapply = async (
  ctx: Context,
  input?: SparseCheckoutReapplyInput,
): Promise<SparseCheckoutAppliedResult> => {
  await assertSparseReady(ctx);
  const matcher = await loadSparseMatcher(ctx);
  if (matcher === undefined) {
    throw invalidOption('action', 'reapply requires sparse checkout to be enabled');
  }
  const sparse = await readSparseConfig(ctx);
  const applied = await applySparseCheckout(ctx, applyOpts(matcher, input?.force));
  return toApplied(sparse.cone, applied);
};

export const sparseCheckoutDisable = async (
  ctx: Context,
  input?: SparseCheckoutDisableInput,
): Promise<SparseCheckoutAppliedResult> => {
  await assertSparseReady(ctx);
  const applied = await applySparseCheckout(ctx, applyOpts(undefined, input?.force));
  await enableWorktreeConfig(ctx);
  await updateScopedConfigEntries(ctx, 'worktree', DISABLE_ENTRIES);
  return toApplied(false, applied);
};

/** Non-cone file text: one pattern per line, each terminated as git writes it. */
const nonConeText = (patterns: ReadonlyArray<string>): string =>
  patterns.map((pattern) => `${pattern}\n`).join('');

/** Build the spec + on-disk text for a fresh `set` from the user's patterns. */
const buildSpecAndText = (
  useCone: boolean,
  patterns: ReadonlyArray<string>,
): { readonly spec: SparseSpec; readonly text: string } => {
  if (useCone) {
    const spec = buildConeSpec(patterns);
    return { spec, text: serializeCone(spec) };
  }
  const text = nonConeText(patterns);
  // `false`: the caller chose non-cone, so the patterns are interpreted with
  // gitignore last-match-wins semantics even when they happen to be
  // cone-shaped — a cone parse would select a different path set.
  return { spec: parseSparseCheckout(text, false).spec, text };
};

/** Build the combined spec + text for `add` — existing patterns plus the new ones. */
const combineSpecAndText = (
  useCone: boolean,
  existing: string,
  added: ReadonlyArray<string>,
): { readonly spec: SparseSpec; readonly text: string } => {
  if (useCone) {
    const current = parseSparseCheckout(existing, true).spec;
    const dirs = current.mode === 'cone' ? [...current.recursive, ...added] : added;
    const spec = buildConeSpec(dirs);
    return { spec, text: serializeCone(spec) };
  }
  const kept = specToList(parseSparseCheckout(existing, false).spec).patterns;
  const text = nonConeText([...kept, ...added]);
  // `false`: non-cone mode — interpret the combined patterns with gitignore
  // semantics even if the result is cone-shaped (see `buildSpecAndText`).
  return { spec: parseSparseCheckout(text, false).spec, text };
};

const toApplied = (
  cone: boolean,
  applied: ApplySparseCheckoutResult,
): SparseCheckoutAppliedResult => ({
  cone,
  materialized: applied.materialized,
  removed: applied.removed,
  retained: applied.retained,
});

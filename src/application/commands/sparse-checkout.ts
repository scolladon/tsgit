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
import { readConfig } from '../primitives/config-read.js';
import { loadSparseMatcher, readSparsePatternText } from '../primitives/read-sparse-checkout.js';
import { updateCoreConfig } from '../primitives/update-config.js';
import { writeSparsePatternText } from '../primitives/write-sparse-checkout.js';
import {
  type ApplySparseCheckoutOpts,
  type ApplySparseCheckoutResult,
  applySparseCheckout,
} from './internal/apply-sparse-checkout.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';
import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';

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

/** Sparse checkout needs a worktree and a quiet repo — gate every verb. */
const assertSparseReady = async (ctx: Context): Promise<void> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  await assertNotBare(ctx, 'sparse-checkout');
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
  const config = await readConfig(ctx);
  if (config.core?.sparseCheckout !== true) {
    return { cone: false, patterns: [] };
  }
  const coneRequested = config.core.sparseCheckoutCone === true;
  const text = (await readSparsePatternText(ctx)) ?? '';
  return specToList(parseSparseCheckout(text, coneRequested).spec);
};

/**
 * Build `applySparseCheckout` opts, omitting `force` when undefined —
 * `exactOptionalPropertyTypes` forbids passing an explicit `undefined`.
 */
const applyOpts = (
  matcher: SparseMatcher | undefined,
  force: boolean | undefined,
): ApplySparseCheckoutOpts => (force === undefined ? { matcher } : { matcher, force });

/** Apply `spec`, then persist the pattern file and `core` config (set ordering). */
const applyAndPersist = async (
  ctx: Context,
  spec: SparseSpec,
  text: string,
  force: boolean | undefined,
): Promise<SparseCheckoutAppliedResult> => {
  const applied = await applySparseCheckout(ctx, applyOpts(buildSparseMatcher(spec), force));
  await writeSparsePatternText(ctx, text);
  await updateCoreConfig(ctx, {
    sparseCheckout: 'true',
    sparseCheckoutCone: spec.mode === 'cone' ? 'true' : 'false',
  });
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
  const config = await readConfig(ctx);
  const useCone = input.cone ?? config.core?.sparseCheckoutCone ?? true;
  const { spec, text } = buildSpecAndText(useCone, input.patterns);
  return applyAndPersist(ctx, spec, text, input.force);
};

export const sparseCheckoutAdd = async (
  ctx: Context,
  input: SparseCheckoutAddInput,
): Promise<SparseCheckoutAppliedResult> => {
  await assertSparseReady(ctx);
  if (input.patterns.length === 0) {
    throw invalidOption('patterns', 'add requires at least one pattern');
  }
  const config = await readConfig(ctx);
  if (config.core?.sparseCheckout !== true) {
    throw invalidOption('action', 'add requires sparse checkout to be enabled');
  }
  const useCone = config.core.sparseCheckoutCone === true;
  const existing = (await readSparsePatternText(ctx)) ?? '';
  const { spec, text } = combineSpecAndText(useCone, existing, input.patterns);
  return applyAndPersist(ctx, spec, text, input.force);
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
  const config = await readConfig(ctx);
  const applied = await applySparseCheckout(ctx, applyOpts(matcher, input?.force));
  return toApplied(config.core?.sparseCheckoutCone === true, applied);
};

export const sparseCheckoutDisable = async (
  ctx: Context,
  input?: SparseCheckoutDisableInput,
): Promise<SparseCheckoutAppliedResult> => {
  await assertSparseReady(ctx);
  const applied = await applySparseCheckout(ctx, applyOpts(undefined, input?.force));
  await updateCoreConfig(ctx, { sparseCheckout: 'false' });
  return toApplied(false, applied);
};

/** Build the spec + on-disk text for a fresh `set` from the user's patterns. */
const buildSpecAndText = (
  useCone: boolean,
  patterns: ReadonlyArray<string>,
): { readonly spec: SparseSpec; readonly text: string } => {
  if (useCone) {
    const spec = buildConeSpec(patterns);
    return { spec, text: serializeCone(spec) };
  }
  const text = patterns.join('\n');
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
  const lines = existing === '' ? added : [existing, ...added];
  const text = lines.join('\n');
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

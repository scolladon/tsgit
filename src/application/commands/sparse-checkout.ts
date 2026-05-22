/**
 * Tier-1 `sparseCheckout` command — git-parity sparse-checkout management.
 * One command, discriminated `action` (`list` / `set` / `add` / `reapply` /
 * `disable`), mirroring `reflog` / `branch` (design §10, ADR-071).
 *
 * Persistence ordering: a mutating action computes its matcher in memory, runs
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

export type SparseCheckoutAction =
  | { readonly action: 'list' }
  | {
      readonly action: 'set';
      readonly patterns: ReadonlyArray<string>;
      readonly cone?: boolean;
      readonly force?: boolean;
    }
  | { readonly action: 'add'; readonly patterns: ReadonlyArray<string>; readonly force?: boolean }
  | { readonly action: 'reapply'; readonly force?: boolean }
  | { readonly action: 'disable'; readonly force?: boolean };

export type SparseCheckoutResult =
  | { readonly kind: 'list'; readonly cone: boolean; readonly patterns: ReadonlyArray<string> }
  | {
      readonly kind: 'applied';
      readonly cone: boolean;
      readonly materialized: number;
      readonly removed: number;
      readonly retained: ReadonlyArray<FilePath>;
    };

/** Sparse checkout needs a worktree and a quiet repo — gate every action. */
const assertSparseReady = async (ctx: Context): Promise<void> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'sparse-checkout');
  await assertNoPendingOperation(ctx);
};

export const sparseCheckout = async (
  ctx: Context,
  opts: SparseCheckoutAction,
): Promise<SparseCheckoutResult> => {
  await assertSparseReady(ctx);
  if (opts.action === 'list') return runList(ctx);
  if (opts.action === 'set') return runSet(ctx, opts);
  if (opts.action === 'add') return runAdd(ctx, opts);
  if (opts.action === 'reapply') return runReapply(ctx, opts);
  return runDisable(ctx, opts);
};

/** Map a parsed spec onto the `list` output: sorted recursive dirs / raw lines. */
const specToList = (spec: SparseSpec): SparseCheckoutResult => {
  if (spec.mode === 'cone') {
    return { kind: 'list', cone: true, patterns: [...spec.recursive].sort() };
  }
  return { kind: 'list', cone: false, patterns: spec.rules.map((rule) => rule.source) };
};

const runList = async (ctx: Context): Promise<SparseCheckoutResult> => {
  const config = await readConfig(ctx);
  if (config.core?.sparseCheckout !== true) {
    return { kind: 'list', cone: false, patterns: [] };
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
): Promise<SparseCheckoutResult> => {
  const applied = await applySparseCheckout(ctx, applyOpts(buildSparseMatcher(spec), force));
  await writeSparsePatternText(ctx, text);
  await updateCoreConfig(ctx, {
    sparseCheckout: 'true',
    sparseCheckoutCone: spec.mode === 'cone' ? 'true' : 'false',
  });
  return toApplied(spec.mode === 'cone', applied);
};

const runSet = async (
  ctx: Context,
  opts: Extract<SparseCheckoutAction, { action: 'set' }>,
): Promise<SparseCheckoutResult> => {
  if (opts.patterns.length === 0) {
    throw invalidOption('patterns', 'set requires at least one pattern');
  }
  const config = await readConfig(ctx);
  const useCone = opts.cone ?? config.core?.sparseCheckoutCone ?? true;
  const { spec, text } = buildSpecAndText(useCone, opts.patterns);
  return applyAndPersist(ctx, spec, text, opts.force);
};

const runAdd = async (
  ctx: Context,
  opts: Extract<SparseCheckoutAction, { action: 'add' }>,
): Promise<SparseCheckoutResult> => {
  if (opts.patterns.length === 0) {
    throw invalidOption('patterns', 'add requires at least one pattern');
  }
  const config = await readConfig(ctx);
  if (config.core?.sparseCheckout !== true) {
    throw invalidOption('action', 'add requires sparse checkout to be enabled');
  }
  const useCone = config.core.sparseCheckoutCone === true;
  const existing = (await readSparsePatternText(ctx)) ?? '';
  const { spec, text } = combineSpecAndText(useCone, existing, opts.patterns);
  return applyAndPersist(ctx, spec, text, opts.force);
};

const runReapply = async (
  ctx: Context,
  opts: Extract<SparseCheckoutAction, { action: 'reapply' }>,
): Promise<SparseCheckoutResult> => {
  const matcher = await loadSparseMatcher(ctx);
  if (matcher === undefined) {
    throw invalidOption('action', 'reapply requires sparse checkout to be enabled');
  }
  const config = await readConfig(ctx);
  const applied = await applySparseCheckout(ctx, applyOpts(matcher, opts.force));
  return toApplied(config.core?.sparseCheckoutCone === true, applied);
};

const runDisable = async (
  ctx: Context,
  opts: Extract<SparseCheckoutAction, { action: 'disable' }>,
): Promise<SparseCheckoutResult> => {
  const applied = await applySparseCheckout(ctx, applyOpts(undefined, opts.force));
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

const toApplied = (cone: boolean, applied: ApplySparseCheckoutResult): SparseCheckoutResult => ({
  kind: 'applied',
  cone,
  materialized: applied.materialized,
  removed: applied.removed,
  retained: applied.retained,
});

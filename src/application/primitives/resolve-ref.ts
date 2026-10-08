import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { refChainTooDeep, refCycleDetected, refNotFound } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { peelChain, tagHop } from './internal/peel-chain.js';
import { readObject } from './read-object.js';
import { getRefStore, type RefStore } from './ref-store.js';
import { MAX_SYMBOLIC_REF_DEPTH, type ResolveRefOptions } from './types.js';
import { exceedsMaxSymbolicDepth } from './validators.js';

/** {@link resolveDirectChain}'s result: the resolved id, or the ref name the
 *  chain ended on when no candidate exists — never a thrown `REF_NOT_FOUND`,
 *  so a caller sweeping several candidates (rev-parse, resolveCommitIsh)
 *  pays no stack-capturing throw per miss. `found.name` is the chain's
 *  TERMINAL name — the name asked for when it resolves directly, or the last
 *  symref hop's name when it does not. */
export type ChainOutcome =
  | { readonly kind: 'found'; readonly id: ObjectId; readonly name: RefName }
  | { readonly kind: 'missing'; readonly name: RefName };

/** Error codes `refs_resolve_ref_unsafe(RESOLVE_REF_READING)` folds into "does
 *  not resolve for reading": a chain ending on a name that formats invalid, a
 *  loose file whose content is neither an oid nor `ref: …`, a cycle, and a
 *  chain longer than the reading walk's cap — git returns NULL for all four. */
export const UNREADABLE_REF_CODES: ReadonlySet<string> = new Set([
  'INVALID_REF',
  'INVALID_OBJECT_ID',
  'REF_CYCLE_DETECTED',
  'REF_CHAIN_TOO_DEEP',
]);

/**
 * git's `repo_dwim_log` target-name resolution: the name `name`'s chain
 * resolves to for READING — following every symref hop — or `undefined`
 * when the chain ends missing, a link's content or name fails to parse,
 * the chain loops, or it needs more hops than git's reading walk takes.
 */
export async function resolveTerminalName(
  ctx: Context,
  name: RefName | 'HEAD',
): Promise<RefName | undefined> {
  try {
    const store = getRefStore(ctx);
    const outcome = await resolveDirectChain(store, name, MAX_SYMBOLIC_REF_DEPTH);
    return outcome.kind === 'found' ? outcome.name : undefined;
  } catch (err) {
    // Stryker disable next-line StringLiteral: equivalent — the `??` fallback is reached only when `errorDataCode` yields undefined, and no literal put there is a member of UNREADABLE_REF_CODES, so the probe answers false whatever the literal is.
    if (UNREADABLE_REF_CODES.has(errorDataCode(err) ?? '')) return undefined;
    throw err;
  }
}

/**
 * git's `refs_resolve_ref_unsafe(RESOLVE_REF_READING)`: the object id `name`
 * resolves to, or `undefined` when the chain ends missing, loops, runs past
 * the reading walk's cap, or ends on a name or content that does not parse.
 * git's ref iterators (`branch`, `tag -l`, `for-each-ref`, `show-ref`) drop
 * exactly those entries and still exit 0.
 */
export async function resolveRefForReading(
  ctx: Context,
  name: RefName | 'HEAD',
): Promise<ObjectId | undefined> {
  try {
    return await resolveRefOrMissing(ctx, name);
  } catch (err) {
    // Stryker disable next-line StringLiteral: equivalent — the `??` fallback is reached only when `errorDataCode` yields undefined, and no literal put there is a member of UNREADABLE_REF_CODES, so the probe answers false whatever the literal is.
    if (UNREADABLE_REF_CODES.has(errorDataCode(err) ?? '')) return undefined;
    throw err;
  }
}

/**
 * git's `refs_ref_exists` / `refs_read_ref`: whether `name` resolves for
 * READING. A dangling symref does not — so a creation guarded by this check
 * (`tag`, `branch`) writes through it rather than refusing an "existing"
 * name.
 */
export async function refResolvesForReading(
  ctx: Context,
  name: RefName | 'HEAD',
): Promise<boolean> {
  return (await resolveTerminalName(ctx, name)) !== undefined;
}

export async function resolveRef(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ObjectId> {
  const outcome = await resolveChainOutcome(ctx, name, options);
  // The name the chain ENDED on, not the name asked for — a dangling symref
  // `refs/heads/x → refs/heads/gone` reports `gone`, matching today.
  if (outcome.kind === 'missing') throw refNotFound(outcome.name);
  return finalizeOutcome(ctx, outcome, options);
}

/**
 * Same resolution as {@link resolveRef}, except a missing chain resolves to
 * `undefined` instead of throwing `REF_NOT_FOUND` — the miss-signalling shape
 * a candidate sweep needs, since every other failure (cycle, depth, bad
 * content, invalid name) still must propagate.
 */
export async function resolveRefOrMissing(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ObjectId | undefined> {
  const outcome = await resolveChainOutcome(ctx, name, options);
  if (outcome.kind === 'missing') return undefined;
  return finalizeOutcome(ctx, outcome, options);
}

/** One gitrevisions candidate as git's `expand_ref` sees it: resolved (with
 *  the ref its symbolic chain ends at), absent, or unreadable through a symbolic hop (a dangling target, a
 *  cycle, a chain past the cap) or on its own content (a broken ref). */
export type RefCandidateOutcome =
  | { readonly kind: 'found'; readonly id: ObjectId; readonly ref: RefName }
  | { readonly kind: 'missing' }
  | { readonly kind: 'dangling-symref' }
  | { readonly kind: 'broken' };

const MISSING_CANDIDATE: RefCandidateOutcome = { kind: 'missing' };
const DANGLING_CANDIDATE: RefCandidateOutcome = { kind: 'dangling-symref' };
const BROKEN_CANDIDATE: RefCandidateOutcome = { kind: 'broken' };

const isUnreadable = (err: unknown): boolean => UNREADABLE_REF_CODES.has(errorDataCode(err) ?? '');

/** Whether git's `check_refname_format` accepts `name`; a name it refuses
 *  is never read, so it is absent rather than broken. */
const isWellFormed = (name: RefName | 'HEAD'): boolean => {
  if (name === 'HEAD') return true;
  try {
    validateRefName(name);
    return true;
  } catch (err) {
    if (errorDataCode(err) === 'INVALID_REF') return false;
    throw err;
  }
};

/** Why a candidate whose chain failed to read failed: its own first hop
 *  symbolic, or its own content unreadable. */
const unreadableCandidate = async (
  ctx: Context,
  name: RefName | 'HEAD',
): Promise<RefCandidateOutcome> => {
  if (!isWellFormed(name)) return MISSING_CANDIDATE;
  try {
    const own = await getRefStore(ctx).resolveDirect(name as RefName);
    return own.kind === 'symbolic' ? DANGLING_CANDIDATE : BROKEN_CANDIDATE;
  } catch (err) {
    if (isUnreadable(err)) return BROKEN_CANDIDATE;
    throw err;
  }
};

/**
 * {@link resolveRefOrMissing} for a candidate sweep that must tell why a
 * candidate is not this name: a chain ending missing past a symbolic hop is
 * a dangling symref, an unreadable chain is dangling when the candidate
 * itself is symbolic and broken otherwise. Peeling (`options.peel`) happens
 * after, so its failures still reach the caller.
 */
export async function readRefCandidate(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<RefCandidateOutcome> {
  let outcome: ChainOutcome;
  try {
    outcome = await resolveChainOutcome(ctx, name, options);
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    return unreadableCandidate(ctx, name);
  }
  if (outcome.kind === 'missing')
    return outcome.name === name ? MISSING_CANDIDATE : DANGLING_CANDIDATE;
  return { kind: 'found', id: await finalizeOutcome(ctx, outcome, options), ref: outcome.name };
}

const resolveChainOutcome = (
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ChainOutcome> => {
  const maxSymbolicDepth = options?.maxSymbolicDepth ?? MAX_SYMBOLIC_REF_DEPTH;
  return resolveDirectChain(getRefStore(ctx), name, maxSymbolicDepth);
};

const finalizeOutcome = (
  ctx: Context,
  outcome: Extract<ChainOutcome, { kind: 'found' }>,
  options?: ResolveRefOptions,
): Promise<ObjectId> => {
  if (options?.peel !== true) return Promise.resolve(outcome.id);
  // Stryker disable next-line OptionalChaining: equivalent — the guard above returns unless `options?.peel === true`, which no undefined `options` can satisfy, so `options` is always defined here.
  return peelTags(ctx, outcome.id, options?.maxPeelDepth ?? Number.POSITIVE_INFINITY);
};

/**
 * The read-side symbolic-ref walk, shared with the write side's `noDeref`
 * referent read (`internal/ref-write-chain.ts`) rather than copied: follows
 * `initial` through every symbolic hop up to `maxDepth`, refusing
 * `REF_CYCLE_DETECTED` on a repeated name (an O(n²) `includes` scan — fine
 * at this bounded depth; the WRITE walk's own unbounded chain uses an O(1)
 * `Set` instead and must not reuse this check). Store-level: takes a
 * `RefStore`, not a `Context`, so a caller that already has one pays no
 * second `getRefStore` lookup.
 */
export async function resolveDirectChain(
  refStore: RefStore,
  initial: RefName | 'HEAD',
  maxDepth: number,
): Promise<ChainOutcome> {
  const chain: RefName[] = [];
  let current: RefName = initial as RefName;
  let depth = 0;
  for (;;) {
    // Stryker disable next-line StringLiteral,ConditionalExpression: equivalent — validateRefName('HEAD') is a no-op (HEAD is a valid ref name and its return value is discarded), so whether the guard skips it for HEAD or always runs it, behaviour is identical.
    if (current !== 'HEAD') {
      // validateRefName rejects every filesystem path-escape vector — `..`,
      // `:`, `\`, and a leading `/` — before `current` is used to build a
      // path in resolveDirect, so no separate path-containment check is needed.
      // Under the reftable backend that path-escape justification goes
      // vacuous (its resolveDirect looks a name up in a loaded stack, never
      // builds a filesystem path from it) — but the call stays: this is
      // still the shared ref-name grammar gate, and dropping it here would
      // weaken the files backend that walks the same chain.
      validateRefName(current);
    }
    if (chain.includes(current)) {
      throw refCycleDetected([...chain, current]);
    }
    chain.push(current);
    const result = await refStore.resolveDirect(current);
    if (result.kind === 'missing') {
      return { kind: 'missing', name: current };
    }
    if (result.kind === 'direct') {
      return { kind: 'found', id: result.id, name: current };
    }
    // symbolic → follow target
    depth += 1;
    if (exceedsMaxSymbolicDepth(depth, maxDepth)) {
      throw refChainTooDeep(depth, chain);
    }
    current = result.target;
  }
}

/** Peel tags to any depth, as git does, unless the caller caps it; a chain revisiting an object refuses. */
const peelTags = async (ctx: Context, startId: ObjectId, maxDepth: number): Promise<ObjectId> =>
  (await peelChain(ctx, startId, readObject, tagHop, maxDepth)).id;

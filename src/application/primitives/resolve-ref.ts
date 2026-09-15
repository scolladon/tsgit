import { errorDataCode } from '../../domain/error-data-code.js';
import type { GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import { refChainTooDeep, refCycleDetected, refNotFound } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { getRefStore, type RefStore } from './ref-store.js';
import { MAX_PEEL_DEPTH, MAX_SYMBOLIC_REF_DEPTH, type ResolveRefOptions } from './types.js';
import { exceedsMaxPeelDepth, exceedsMaxSymbolicDepth } from './validators.js';

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
const UNREADABLE_REF_CODES = new Set([
  'INVALID_REF',
  'INVALID_OBJECT_ID',
  'REF_CYCLE_DETECTED',
  'REF_CHAIN_TOO_DEEP',
]);

/** git's `SYMREF_MAXDEPTH` (5) bounds the refs a reading resolve READS, the
 *  terminal included — so a chain resolves through at most four symbolic
 *  hops. */
const READING_RESOLVE_MAX_SYMBOLIC_HOPS = 4;

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
    const outcome = await resolveDirectChain(store, name, READING_RESOLVE_MAX_SYMBOLIC_HOPS);
    return outcome.kind === 'found' ? outcome.name : undefined;
  } catch (err) {
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
  return peelChain(ctx, outcome.id, options?.maxPeelDepth ?? MAX_PEEL_DEPTH);
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

async function peelChain(ctx: Context, startId: ObjectId, maxDepth: number): Promise<ObjectId> {
  let current: ObjectId = startId;
  let depth = 0;
  for (;;) {
    const object: GitObject = await readObject(ctx, current);
    if (object.type !== 'tag') return current;
    depth += 1;
    if (exceedsMaxPeelDepth(depth, maxDepth)) {
      throw refChainTooDeep(depth, []);
    }
    current = object.data.object;
  }
}

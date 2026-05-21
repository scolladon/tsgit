import type { GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import { refChainTooDeep, refCycleDetected, refNotFound } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { getRefStore, type RefStore } from './ref-store.js';
import { MAX_PEEL_DEPTH, MAX_SYMBOLIC_REF_DEPTH, type ResolveRefOptions } from './types.js';
import { exceedsMaxPeelDepth, exceedsMaxSymbolicDepth } from './validators.js';

export async function resolveRef(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ObjectId> {
  const maxSymbolicDepth = options?.maxSymbolicDepth ?? MAX_SYMBOLIC_REF_DEPTH;
  const maxPeelDepth = options?.maxPeelDepth ?? MAX_PEEL_DEPTH;
  const peel = options?.peel ?? false;

  const refStore = getRefStore(ctx);
  const id = await resolveDirectChain(refStore, name, maxSymbolicDepth);
  if (!peel) return id;
  return peelChain(ctx, id, maxPeelDepth);
}

async function resolveDirectChain(
  refStore: RefStore,
  initial: RefName | 'HEAD',
  maxDepth: number,
): Promise<ObjectId> {
  const chain: RefName[] = [];
  let current: RefName = initial as RefName;
  let depth = 0;
  for (;;) {
    // Stryker disable next-line StringLiteral,ConditionalExpression: equivalent — validateRefName('HEAD') is a no-op (HEAD is a valid ref name and its return value is discarded), so whether the guard skips it for HEAD or always runs it, behaviour is identical.
    if (current !== 'HEAD') {
      // validateRefName rejects every filesystem path-escape vector — `..`,
      // `:`, `\`, and a leading `/` — before `current` is used to build a
      // path in resolveDirect, so no separate path-containment check is needed.
      validateRefName(current);
    }
    if (chain.includes(current)) {
      throw refCycleDetected([...chain, current]);
    }
    chain.push(current);
    const result = await refStore.resolveDirect(current);
    if (result.kind === 'missing') {
      throw refNotFound(current);
    }
    if (result.kind === 'direct') {
      return result.id;
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

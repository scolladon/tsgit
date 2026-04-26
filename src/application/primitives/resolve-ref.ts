import type { GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import {
  invalidRef,
  refChainTooDeep,
  refCycleDetected,
  refNotFound,
} from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { getRefStore, type RefStore } from './ref-store.js';
import { MAX_PEEL_DEPTH, MAX_SYMBOLIC_REF_DEPTH, type ResolveRefOptions } from './types.js';
import {
  exceedsMaxPeelDepth,
  exceedsMaxSymbolicDepth,
  isContainedRefSegment,
  REASON_TARGET_ESCAPES_GIT_DIR,
} from './validators.js';

export async function resolveRef(
  ctx: Context,
  name: RefName | 'HEAD',
  options?: ResolveRefOptions,
): Promise<ObjectId> {
  const maxSymbolicDepth = options?.maxSymbolicDepth ?? MAX_SYMBOLIC_REF_DEPTH;
  const maxPeelDepth = options?.maxPeelDepth ?? MAX_PEEL_DEPTH;
  const peel = options?.peel ?? false;

  const refStore = getRefStore(ctx);
  const id = await resolveDirectChain(ctx, refStore, name, maxSymbolicDepth);
  if (!peel) return id;
  return peelChain(ctx, id, maxPeelDepth);
}

async function resolveDirectChain(
  ctx: Context,
  refStore: RefStore,
  initial: RefName | 'HEAD',
  maxDepth: number,
): Promise<ObjectId> {
  const chain: RefName[] = [];
  let current: RefName = initial as RefName;
  let depth = 0;
  for (;;) {
    if (current !== 'HEAD') {
      validateRefName(current);
      // Path containment (§5.6 invariant) — redundant for `HEAD` (which is a
      // literal safe segment), required for every other name as belt-and-braces
      // on top of validateRefName.
      assertContainment(ctx.layout.gitDir, current);
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

function assertContainment(_gitDir: string, name: string): void {
  // isContainedRefSegment rejects every character or segment that could cause
  // a `${gitDir}/${name}` path-join to escape (absolute, `..`, `:`, `\\`).
  // Any joined-path check would be a tautology here, so we rely on the
  // deny-list exclusively. gitDir is kept on the signature for future
  // extension (e.g. realpath-based containment once OPFS support lands).
  if (!isContainedRefSegment(name)) {
    throw invalidRef(REASON_TARGET_ESCAPES_GIT_DIR);
  }
}

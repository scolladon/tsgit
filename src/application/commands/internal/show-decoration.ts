/**
 * Build the `oid → decoration` map `show` consumes for `%d`/`%D`: every
 * head/tag/remote ref is resolved (annotated tags peeled to their commit) and
 * grouped by target oid; HEAD is recorded as the symbolic branch it targets, or
 * as a detached marker. Ordering/label rendering lives in the pure
 * `domain/show/decoration.ts`.
 */
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { DecorationRef, RefKind } from '../../../domain/show/index.js';
import type { Context } from '../../../ports/context.js';
import { enumerateRefs } from '../../primitives/enumerate-refs.js';
import { getRefStore } from '../../primitives/ref-store.js';
import { resolveRef } from '../../primitives/resolve-ref.js';

export interface CommitDecoration {
  readonly refs: ReadonlyArray<DecorationRef>;
  readonly headBranch?: string;
  readonly detachedHead?: boolean;
}

const PREFIXES: ReadonlyArray<readonly [string, RefKind]> = [
  ['refs/heads/', 'head'],
  ['refs/tags/', 'tag'],
  ['refs/remotes/', 'remote'],
];

const kindOf = (name: string): RefKind | undefined =>
  PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1];

const resolvePeeled = async (
  ctx: Context,
  name: RefName | 'HEAD',
): Promise<ObjectId | undefined> => {
  try {
    return await resolveRef(ctx, name, { peel: true });
  } catch {
    return undefined;
  }
};

export const buildDecorationMap = async (
  ctx: Context,
): Promise<ReadonlyMap<ObjectId, CommitDecoration>> => {
  const refsByOid = new Map<ObjectId, DecorationRef[]>();
  for (const name of await enumerateRefs(ctx)) {
    const kind = kindOf(name);
    if (kind === undefined) continue;
    const oid = await resolvePeeled(ctx, name);
    if (oid === undefined) continue;
    const list = refsByOid.get(oid) ?? [];
    list.push({ fullName: name, kind });
    refsByOid.set(oid, list);
  }

  const map = new Map<ObjectId, CommitDecoration>();
  for (const [oid, refs] of refsByOid) {
    map.set(oid, { refs });
  }

  const head = await getRefStore(ctx).resolveDirect('HEAD' as RefName);
  if (head.kind === 'missing') return map;
  const headOid = await resolvePeeled(ctx, 'HEAD');
  if (headOid === undefined) return map;
  const existing = map.get(headOid)?.refs ?? [];
  map.set(headOid, {
    refs: existing,
    ...(head.kind === 'symbolic' ? { headBranch: head.target } : { detachedHead: true }),
  });
  return map;
};

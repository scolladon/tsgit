import { leadingOid, type ObjectId, type RefName } from '../../../domain/objects/index.js';
import type { Decoration, DecorationKind } from '../../../domain/pretty/decorations.js';
import type { Context } from '../../../ports/context.js';
import { enumerateRefs } from '../enumerate-refs.js';
import { hasObject } from '../has-object.js';
import { readObject } from '../read-object.js';
import { resolveRefOrMissing } from '../resolve-ref.js';
import { branchRefFromHead, readHeadRaw } from './repo-state.js';
import { loadShallowSet } from './shallow-set.js';

export type RefDecorations = ReadonlyMap<ObjectId, ReadonlyArray<Decoration>>;

const HEAD = 'HEAD';
const REPLACE_PREFIX = 'refs/replace/';
const STASH_REF = 'refs/stash';
const KIND_BY_PREFIX: ReadonlyArray<readonly [string, DecorationKind]> = [
  ['refs/heads/', 'branch'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
];

const kindOfRef = (name: string): DecorationKind => {
  if (name === STASH_REF) return 'stash';
  return KIND_BY_PREFIX.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'other';
};

/** Insertion order; `loadRefDecorations` reverses it, since git prepends to each object's list. */
type Collected = Map<ObjectId, Decoration[]>;

const add = (collected: Collected, id: ObjectId, decoration: Decoration): void => {
  const existing = collected.get(id);
  if (existing === undefined) collected.set(id, [decoration]);
  else existing.push(decoration);
};

/** The annotated tag's own object, then each object it points at, as `add_ref_decoration` walks them. */
const addWithPeeledTargets = async (
  ctx: Context,
  collected: Collected,
  id: ObjectId,
  decoration: Decoration,
): Promise<void> => {
  if (!(await hasObject(ctx, id))) return;
  add(collected, id, decoration);
  let object = await readObject(ctx, id);
  while (object.type === 'tag') {
    add(collected, object.data.object, { kind: 'tag', name: decoration.name });
    object = await readObject(ctx, object.data.object);
  }
};

const addReplaced = async (ctx: Context, collected: Collected, name: string): Promise<void> => {
  const original = leadingOid(name.slice(REPLACE_PREFIX.length), ctx.hashConfig);
  if (original === undefined) return;
  if (!(await hasObject(ctx, original))) return;
  add(collected, original, { kind: 'replaced', name: 'replaced' });
};

const addRef = async (ctx: Context, collected: Collected, name: RefName): Promise<void> => {
  if (name === HEAD) return;
  if (name.startsWith(REPLACE_PREFIX)) return addReplaced(ctx, collected, name);
  const id = await resolveRefOrMissing(ctx, name);
  if (id === undefined) return;
  await addWithPeeledTargets(ctx, collected, id, { kind: kindOfRef(name), name });
};

const addHead = async (ctx: Context, collected: Collected): Promise<void> => {
  const id = await resolveRefOrMissing(ctx, HEAD);
  if (id === undefined) return;
  const attachedTo = branchRefFromHead(await readHeadRaw(ctx));
  const decoration: Decoration =
    attachedTo === undefined
      ? { kind: 'head', name: HEAD }
      : { kind: 'head', name: HEAD, attachedTo };
  await addWithPeeledTargets(ctx, collected, id, decoration);
};

/**
 * `load_ref_decorations(NULL, DECORATE_SHORT_REFS)`: every ref, then HEAD, then the
 * shallow grafts, per object newest-first — no `log.excludeDecoration` filter.
 */
export const loadRefDecorations = async (ctx: Context): Promise<RefDecorations> => {
  const collected: Collected = new Map();
  for (const name of await enumerateRefs(ctx)) await addRef(ctx, collected, name);
  await addHead(ctx, collected);
  for (const id of await loadShallowSet(ctx))
    add(collected, id, { kind: 'grafted', name: 'grafted' });
  return new Map([...collected].map(([id, list]) => [id, [...list].reverse()]));
};

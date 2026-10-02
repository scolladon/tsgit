import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { FILE_MODE } from '../../../../domain/objects/file-mode.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { allObjectIds } from '../../../../domain/storage/pack-index.js';
import type { Context } from '../../../../ports/context.js';
import { listLooseObjectIds } from '../../../primitives/enumerate-objects.js';
import { getObjectStore } from '../../../primitives/object-store.js';
import type { CachedGitObject, ProjectedGitObject } from './object-cache.js';
import { entryType, failedLink, lookup, parsedLinks } from './object-table.js';
import type { FsckFinding } from './types.js';

type ReferentFinding = Extract<
  FsckFinding,
  { readonly type: 'type-conflict' | 'bad-pointer' | 'unexpected-object-type' }
>;

/** What `mark_unreachable_referents` left: every object an unreachable one links to. */
export interface ReferentMarks {
  readonly used: ReadonlySet<ObjectId>;
  readonly findings: ReadonlyArray<ReferentFinding>;
}

interface MarkState {
  readonly types: Map<ObjectId, FsckObjectType>;
  readonly used: Set<ObjectId>;
  readonly findings: ReferentFinding[];
}

/** Every object in the order `odb_for_each_object` lists them: each source's
 *  loose objects, then its packs' entries. */
export async function connectivityReadOrder(ctx: Context): Promise<ReadonlyArray<ObjectId>> {
  const store = await getObjectStore(ctx);
  const ids: ObjectId[] = [];
  for (const source of store.sources) {
    for (const id of await listLooseObjectIds(ctx, source)) ids.push(id);
    for (const pack of await source.registry.all()) {
      for (const id of allObjectIds(await pack.index())) ids.push(id);
    }
  }
  return ids;
}

/** `fsck_walk` of a tree: every entry it looks up as its mode says is used. */
function markTreeEntries(state: MarkState, obj: ProjectedGitObject & { type: 'tree' }): void {
  for (const entry of obj.entries) {
    if (entry.mode === FILE_MODE.GITLINK) continue;
    const conflict = lookup(state.types, entry.id, entryType(entry.mode));
    if (conflict === undefined) state.used.add(entry.id);
    else state.findings.push(conflict);
  }
}

/** `fsck_walk` of a commit or tag: its parse looks every link up first. */
function markParsedLinks(state: MarkState, id: ObjectId, obj: ProjectedGitObject): void {
  const failed = failedLink(state.types, id, obj);
  if (failed !== undefined) {
    state.findings.push(...failed);
    return;
  }
  for (const { target } of parsedLinks(obj)) state.used.add(target);
}

/** One unreachable object, walked as the type its first lookup gave it. */
function markReferents(state: MarkState, id: ObjectId, obj: ProjectedGitObject): void {
  const type = state.types.get(id) ?? obj.type;
  state.types.set(id, type);
  if (type !== obj.type) {
    if (type !== 'blob')
      state.findings.push({ type: 'unexpected-object-type', id, expectedType: type });
    return;
  }
  if (obj.type === 'tree') markTreeEntries(state, obj);
  else markParsedLinks(state, id, obj);
}

/**
 * git's `mark_unreachable_referents` under `--connectivity-only`: every
 * object the walk did not reach, in `order`, is walked as typed by the walk
 * (`typed`) or by an earlier referent's lookup — else as its own type — and
 * marks every link it can look up as used.
 */
export function markUnreachableReferents(
  order: ReadonlyArray<ObjectId>,
  reached: ReadonlySet<ObjectId>,
  typed: ReadonlyMap<ObjectId, FsckObjectType> | undefined,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): ReferentMarks {
  const state: MarkState = { types: new Map(typed), used: new Set(), findings: [] };
  const walked = new Set<ObjectId>();
  for (const id of order) {
    const obj = objectCache.get(id);
    if (obj == null || reached.has(id) || walked.has(id)) continue;
    walked.add(id);
    markReferents(state, id, obj);
  }
  return { used: state.used, findings: state.findings };
}

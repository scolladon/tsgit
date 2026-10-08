import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { FILE_MODE } from '../../../../domain/objects/file-mode.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { listLooseObjectIds } from '../../../primitives/enumerate-objects.js';
import { getObjectStore } from '../../../primitives/object-store.js';
import { EXIT_CORRUPT, EXIT_PACK } from './exit-codes.js';
import type { CachedGitObject, ProjectedGitObject } from './object-cache.js';
import { snapshotTips } from './pack-verify-order.js';
import { attributeTo } from './source-attribution.js';
import type { FsckFinding, FsckOptions } from './types.js';

/** One copy as git's full fsck reads it; a pack entry names its `pack`. */
export interface ReadCopy {
  readonly id: ObjectId;
  readonly pack?: string;
  readonly objectsDir?: string;
}

export type TypeConflict = Extract<FsckFinding, { readonly type: 'type-conflict' }>;

type TableFinding = Extract<
  FsckFinding,
  { readonly type: 'type-conflict' | 'unparseable-object' | 'bad-pointer' | 'broken-links' }
>;

export type BadPointer = Extract<FsckFinding, { readonly type: 'bad-pointer' }>;

/** What git's object table settled while fsck read every copy. */
export interface ObjectTable {
  readonly findings: ReadonlyArray<TableFinding>;
  readonly exitBit: number;
  /** Every object whose own parse failed: git never records it present. */
  readonly unparsed: ReadonlySet<ObjectId>;
  /** Per tree, the entries its lookups cannot resolve — every later walk of
   *  the tree meets the same conflicts. */
  readonly unresolvedEntries: ReadonlyMap<ObjectId, ReadonlyArray<TypeConflict>>;
}

interface TableState {
  readonly types: Map<ObjectId, FsckObjectType>;
  readonly parsed: Set<ObjectId>;
  readonly read: Set<ObjectId>;
  readonly findings: TableFinding[];
  readonly unparsed: Set<ObjectId>;
  readonly unresolvedEntries: Map<ObjectId, ReadonlyArray<TypeConflict>>;
}

export interface Link {
  readonly link: BadPointer['link'];
  readonly target: ObjectId;
  readonly expectedType: FsckObjectType;
}

const EMPTY_TABLE: ObjectTable = {
  findings: [],
  exitBit: 0,
  unparsed: new Set(),
  unresolvedEntries: new Map(),
};

/** Every loose copy in the order `fsck_source` reads them, source by source. */
async function looseReadOrder(ctx: Context): Promise<ReadonlyArray<ReadCopy>> {
  const store = await getObjectStore(ctx);
  const copies: ReadCopy[] = [];
  for (const source of store.sources) {
    const attribution = attributeTo(store, source);
    for (const id of await listLooseObjectIds(ctx, source)) copies.push({ id, ...attribution });
  }
  return copies;
}

/** git's `lookup_<type>`: the first lookup types the object, another type conflicts. */
export function lookup(
  types: Map<ObjectId, FsckObjectType>,
  id: ObjectId,
  expectedType: FsckObjectType,
): TypeConflict | undefined {
  const held = types.get(id);
  if (held === undefined) types.set(id, expectedType);
  if (held === undefined || held === expectedType) return undefined;
  return { type: 'type-conflict', id, objectType: held, expectedType };
}

/** The links a commit's or tag's parse looks up, in parse order. */
export function parsedLinks(obj: ProjectedGitObject): ReadonlyArray<Link> {
  if (obj.type === 'commit') {
    const parents = obj.parents.map((target) => ({
      link: 'parent' as const,
      target,
      expectedType: 'commit' as const,
    }));
    return [{ link: 'tree', target: obj.tree, expectedType: 'tree' }, ...parents];
  }
  if (obj.type === 'tag')
    return [{ link: 'tag', target: obj.object, expectedType: obj.objectType }];
  return [];
}

/** git's `parse_<type>_buffer`: stops at the first link it cannot look up. */
export function failedLink(
  types: Map<ObjectId, FsckObjectType>,
  id: ObjectId,
  obj: ProjectedGitObject,
): readonly [TypeConflict, BadPointer] | undefined {
  for (const { link, target, expectedType } of parsedLinks(obj)) {
    const conflict = lookup(types, target, expectedType);
    if (conflict !== undefined) return [conflict, { type: 'bad-pointer', id, link, target }];
  }
  return undefined;
}

/** `snapshot_refs` parses a ref tip before any copy is read. */
function parseTip(state: TableState, id: ObjectId, obj: ProjectedGitObject): void {
  if (lookup(state.types, id, obj.type) !== undefined) return;
  if (failedLink(state.types, id, obj) === undefined) state.parsed.add(id);
}

/** The type git's tree walk looks an entry up as. */
export const entryType = (mode: string): FsckObjectType =>
  mode === FILE_MODE.DIRECTORY ? 'tree' : 'blob';

/** `fsck_obj`'s walk of a tree looks every entry up by its mode. */
function checkTreeEntries(state: TableState, id: ObjectId, obj: ProjectedGitObject): void {
  if (obj.type !== 'tree') return;
  const conflicts: TypeConflict[] = [];
  for (const entry of obj.entries) {
    if (entry.mode === FILE_MODE.GITLINK) continue;
    const conflict = lookup(state.types, entry.id, entryType(entry.mode));
    if (conflict !== undefined) conflicts.push(conflict);
  }
  if (conflicts.length === 0) return;
  state.findings.push(...conflicts, { type: 'broken-links', id, objectType: 'tree' });
  state.unresolvedEntries.set(id, conflicts);
}

function refuseParse(state: TableState, copy: ReadCopy, causes: ReadonlyArray<TableFinding>): void {
  state.findings.push(...causes, { type: 'unparseable-object', ...copy });
  state.unparsed.add(copy.id);
}

/** A parsed object is never parsed again: its links stay looked up. */
function parseOnce(
  state: TableState,
  id: ObjectId,
  obj: ProjectedGitObject,
): ReadonlyArray<TableFinding> | undefined {
  if (state.parsed.has(id)) return undefined;
  const failed = failedLink(state.types, id, obj);
  if (failed === undefined) state.parsed.add(id);
  return failed;
}

/** `parse_object_buffer` on one copy, then `fsck_obj` when it parsed. */
function readCopy(state: TableState, copy: ReadCopy, obj: ProjectedGitObject): void {
  const { id } = copy;
  const own = lookup(state.types, id, obj.type);
  const failed = own === undefined ? parseOnce(state, id, obj) : [own];
  if (failed === undefined) checkTreeEntries(state, id, obj);
  else refuseParse(state, copy, failed);
}

const findingExitBit = (finding: TableFinding): number => {
  if (finding.type === 'broken-links') return EXIT_CORRUPT;
  if (finding.type !== 'unparseable-object') return 0;
  return finding.pack === undefined ? EXIT_CORRUPT : EXIT_CORRUPT | EXIT_PACK;
};

/**
 * git's object table as a full fsck fills it: `snapshot_refs` parses every
 * ref tip, then every copy is parsed in read order — the first lookup of an
 * object fixes its type, and a parse or tree walk asking another type of it
 * gets nothing. Each object is read at its first copy; `refused` ones never
 * parse.
 */
export function buildObjectTable(
  copies: ReadonlyArray<ReadCopy>,
  tips: Iterable<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  refused: ReadonlySet<ObjectId>,
): ObjectTable {
  const state: TableState = {
    types: new Map(),
    parsed: new Set(),
    read: new Set(),
    findings: [],
    unparsed: new Set(),
    unresolvedEntries: new Map(),
  };
  parseTips(state, tips, objectCache);
  readFirstCopies(state, copies, objectCache, refused);
  return tableOf(state);
}

/** `snapshot_refs`: every ref tip the cache holds, parsed first. */
function parseTips(
  state: TableState,
  tips: Iterable<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): void {
  for (const id of tips) {
    const obj = objectCache.get(id);
    if (obj != null) parseTip(state, id, obj);
  }
}

/** Every copy in read order, each object read at its first copy only. */
function readFirstCopies(
  state: TableState,
  copies: ReadonlyArray<ReadCopy>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  refused: ReadonlySet<ObjectId>,
): void {
  for (const copy of copies) {
    const obj = refused.has(copy.id) ? undefined : objectCache.get(copy.id);
    if (obj == null || state.read.has(copy.id)) continue;
    state.read.add(copy.id);
    readCopy(state, copy, obj);
  }
}

function tableOf(state: TableState): ObjectTable {
  return {
    findings: state.findings,
    exitBit: state.findings.reduce((bit, finding) => bit | findingExitBit(finding), 0),
    unparsed: state.unparsed,
    unresolvedEntries: state.unresolvedEntries,
  };
}

/**
 * The object table a full fsck builds from its ref tips, every loose copy
 * and then every pack entry `verify_pack` checked (`packCopies`). Under
 * `--connectivity-only` git parses no copy.
 */
export async function readObjectTable(
  ctx: Context,
  opts: FsckOptions,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  refused: ReadonlySet<ObjectId>,
  packCopies: ReadonlyArray<ReadCopy>,
): Promise<ObjectTable> {
  if (opts.connectivityOnly === true) return EMPTY_TABLE;
  const copies = [...(await looseReadOrder(ctx)), ...packCopies];
  return buildObjectTable(copies, await snapshotTips(ctx), objectCache, refused);
}

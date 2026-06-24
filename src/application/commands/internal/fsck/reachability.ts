import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { FILE_MODE } from '../../../../domain/objects/file-mode.js';
import type { GitObject, ObjectId } from '../../../../domain/objects/index.js';
import type { CachedGitObject } from './object-cache.js';
import type { FsckFinding } from './types.js';

// ---------------------------------------------------------------------------
// In-edge map (needed for dangling vs merely-unreachable classification)
// ---------------------------------------------------------------------------

function recordOutEdges(obj: GitObject, inEdge: Set<ObjectId>): void {
  if (obj.type === 'commit') {
    inEdge.add(obj.data.tree);
    for (const p of obj.data.parents) inEdge.add(p);
  } else if (obj.type === 'tree') {
    for (const entry of obj.entries) {
      if (entry.mode !== FILE_MODE.GITLINK) inEdge.add(entry.id);
    }
  } else if (obj.type === 'tag') {
    inEdge.add(obj.data.object);
  }
}

/**
 * Scan ALL universe objects to collect oids that have at least one in-edge
 * from another present (universe) object. Separate scan so that
 * unreachable objects with internal edges are not misclassified as dangling.
 */
export function buildInEdgeMap(
  universe: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): Set<ObjectId> {
  const inEdge = new Set<ObjectId>();
  for (const id of universe) {
    const obj = objectCache.get(id);
    if (obj != null) recordOutEdges(obj, inEdge);
    // null (corrupt / unreadable) — no edges recorded
  }
  return inEdge;
}

// ---------------------------------------------------------------------------
// BFS reachability walk
// ---------------------------------------------------------------------------

interface GraphEdge {
  readonly fromId: ObjectId;
  readonly fromType: FsckObjectType;
  readonly toId: ObjectId;
  readonly toType: FsckObjectType | 'unknown';
}

interface TagRef {
  readonly tagId: ObjectId;
  readonly tagName: string;
  readonly targetId: ObjectId;
  readonly targetType: FsckObjectType;
}

interface WalkResult {
  readonly reached: Set<ObjectId>;
  readonly missingIds: Set<ObjectId>;
  readonly brokenEdges: ReadonlyArray<GraphEdge>;
  readonly rootCommits: ReadonlyArray<ObjectId>;
  readonly tagRefs: ReadonlyArray<TagRef>;
}

interface BfsState {
  readonly universe: ReadonlySet<ObjectId>;
  readonly reached: Set<ObjectId>;
  readonly missingIds: Set<ObjectId>;
  readonly brokenEdges: GraphEdge[];
  readonly rootCommits: ObjectId[];
  readonly tagRefs: TagRef[];
  readonly queue: ObjectId[];
}

function enqueueIfPresent(state: BfsState, id: ObjectId): void {
  if (!state.universe.has(id)) {
    state.missingIds.add(id);
  } else if (!state.reached.has(id)) {
    state.queue.push(id);
  }
}

function processCommit(state: BfsState, id: ObjectId, obj: GitObject & { type: 'commit' }): void {
  const { tree, parents } = obj.data;
  if (!state.universe.has(tree)) {
    state.missingIds.add(tree);
    state.brokenEdges.push({ fromId: id, fromType: 'commit', toId: tree, toType: 'tree' });
  } else {
    enqueueIfPresent(state, tree);
  }
  for (const parent of parents) {
    if (!state.universe.has(parent)) {
      state.missingIds.add(parent);
      state.brokenEdges.push({ fromId: id, fromType: 'commit', toId: parent, toType: 'commit' });
    } else {
      enqueueIfPresent(state, parent);
    }
  }
  if (parents.length === 0) state.rootCommits.push(id);
}

function processTree(state: BfsState, id: ObjectId, obj: GitObject & { type: 'tree' }): void {
  for (const entry of obj.entries) {
    if (entry.mode === FILE_MODE.GITLINK) continue;
    const toType: FsckObjectType = entry.mode === FILE_MODE.DIRECTORY ? 'tree' : 'blob';
    if (!state.universe.has(entry.id)) {
      state.missingIds.add(entry.id);
      state.brokenEdges.push({ fromId: id, fromType: 'tree', toId: entry.id, toType });
    } else {
      enqueueIfPresent(state, entry.id);
    }
  }
}

function processTag(state: BfsState, id: ObjectId, obj: GitObject & { type: 'tag' }): void {
  const { object: target, objectType: targetType, tagName } = obj.data;
  if (!state.universe.has(target)) {
    state.missingIds.add(target);
    state.brokenEdges.push({ fromId: id, fromType: 'tag', toId: target, toType: targetType });
  } else {
    enqueueIfPresent(state, target);
    state.tagRefs.push({ tagId: id, tagName, targetId: target, targetType });
  }
}

function visitObject(state: BfsState, id: ObjectId, obj: GitObject): void {
  state.reached.add(id);
  if (obj.type === 'commit') processCommit(state, id, obj);
  if (obj.type === 'tree') processTree(state, id, obj);
  if (obj.type === 'tag') processTag(state, id, obj);
}

/**
 * BFS over the reachable object graph starting from `seeds`.
 * Walks commit→(tree, parents), tree→entries (non-gitlink), tag→target.
 */
export function buildReachableSet(
  universe: ReadonlySet<ObjectId>,
  seeds: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): WalkResult {
  const state: BfsState = {
    universe,
    reached: new Set(),
    missingIds: new Set(),
    brokenEdges: [],
    rootCommits: [],
    tagRefs: [],
    queue: [...seeds],
  };

  while (state.queue.length > 0) {
    const id = state.queue.pop();
    if (id === undefined || state.reached.has(id)) continue;
    if (!universe.has(id)) {
      state.missingIds.add(id);
      continue;
    }
    const obj = objectCache.get(id);
    if (obj == null) {
      // Corrupt/unreadable — mark reached, no further edges
      state.reached.add(id);
    } else {
      visitObject(state, id, obj);
    }
  }

  return {
    reached: state.reached,
    missingIds: state.missingIds,
    brokenEdges: state.brokenEdges,
    rootCommits: state.rootCommits,
    tagRefs: state.tagRefs,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyObjects(
  universe: ReadonlySet<ObjectId>,
  reached: ReadonlySet<ObjectId>,
  inEdgePresent: ReadonlySet<ObjectId>,
): { unreachable: ReadonlyArray<ObjectId>; dangling: ReadonlyArray<ObjectId> } {
  const unreachable: ObjectId[] = [];
  const dangling: ObjectId[] = [];
  for (const id of universe) {
    if (reached.has(id)) continue;
    unreachable.push(id);
    if (!inEdgePresent.has(id)) dangling.push(id);
  }
  return { unreachable, dangling };
}

// ---------------------------------------------------------------------------
// Finding assembly helpers
// ---------------------------------------------------------------------------

export function collectTypeFindings(
  ids: ReadonlyArray<ObjectId>,
  type: 'unreachable' | 'dangling',
  findings: FsckFinding[],
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): void {
  for (const id of ids) {
    const obj = objectCache.get(id);
    if (obj != null) {
      findings.push({ type, id, objectType: obj.type });
    }
    // null (unreadable) — skip (already in reached/not reachable anyway)
  }
}

/** Determine the object type for an oid from the cache. */
export function resolveObjectType(
  id: ObjectId,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): FsckObjectType | 'unknown' {
  const obj = objectCache.get(id);
  return obj != null ? obj.type : 'unknown';
}

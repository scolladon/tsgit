import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { FILE_MODE } from '../../../../domain/objects/file-mode.js';
import type { GitObject, ObjectId } from '../../../../domain/objects/index.js';
import type { CachedGitObject } from './object-cache.js';
import type { FsckFinding, UnreadableMode } from './types.js';

// ---------------------------------------------------------------------------
// In-edge map (needed for dangling vs merely-unreachable classification)
// ---------------------------------------------------------------------------

function recordOutEdges(obj: GitObject, inEdge: Set<ObjectId>): void {
  if (obj.type === 'commit') {
    inEdge.add(obj.data.tree);
    for (const p of obj.data.parents) inEdge.add(p);
  } else if (obj.type === 'tree') {
    for (const entry of obj.entries) {
      // Stryker disable next-line ConditionalExpression: equivalent — gitlink shas (external commits) are not in the local universe; classifyObjects only iterates universe objects, so adding them to inEdge has no effect.
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
// Reachability walk
// ---------------------------------------------------------------------------

export interface GraphEdge {
  readonly fromId: ObjectId;
  readonly fromType: FsckObjectType;
  readonly toId: ObjectId;
  readonly toType: FsckObjectType | 'unknown';
}

export interface TagRef {
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

interface WalkState {
  readonly universe: ReadonlySet<ObjectId>;
  readonly reached: Set<ObjectId>;
  readonly missingIds: Set<ObjectId>;
  readonly brokenEdges: GraphEdge[];
  readonly rootCommits: ObjectId[];
  readonly tagRefs: TagRef[];
  readonly worklist: ObjectId[];
}

function enqueueIfPresent(state: WalkState, id: ObjectId): void {
  // Stryker disable next-line ConditionalExpression: equivalent — already-reached ids pushed again are immediately skipped by the state.reached.has(id) guard in the main loop.
  if (!state.reached.has(id)) {
    state.worklist.push(id);
  }
}

function processCommit(state: WalkState, id: ObjectId, obj: GitObject & { type: 'commit' }): void {
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

function processTree(state: WalkState, id: ObjectId, obj: GitObject & { type: 'tree' }): void {
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

function processTag(state: WalkState, id: ObjectId, obj: GitObject & { type: 'tag' }): void {
  const { object: target, objectType: targetType, tagName } = obj.data;
  if (!state.universe.has(target)) {
    state.missingIds.add(target);
    state.brokenEdges.push({ fromId: id, fromType: 'tag', toId: target, toType: targetType });
  } else {
    enqueueIfPresent(state, target);
    state.tagRefs.push({ tagId: id, tagName, targetId: target, targetType });
  }
}

function visitObject(state: WalkState, id: ObjectId, obj: GitObject): void {
  state.reached.add(id);
  if (obj.type === 'commit') processCommit(state, id, obj);
  if (obj.type === 'tree') processTree(state, id, obj);
  if (obj.type === 'tag') processTag(state, id, obj);
}

/**
 * Reachability walk over the object graph starting from `seeds`.
 * Walks commit→(tree, parents), tree→entries (non-gitlink), tag→target.
 */
export function buildReachableSet(
  universe: ReadonlySet<ObjectId>,
  seeds: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): WalkResult {
  const state: WalkState = {
    universe,
    reached: new Set(),
    missingIds: new Set(),
    brokenEdges: [],
    rootCommits: [],
    tagRefs: [],
    worklist: [...seeds],
  };

  while (state.worklist.length > 0) {
    const id = state.worklist.pop();
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

/** Everything needed to type an oid for a finding, grouped once. */
export interface TypeResolution {
  readonly objectCache: ReadonlyMap<ObjectId, CachedGitObject>;
  readonly recovered: ReadonlyMap<ObjectId, FsckObjectType>;
  readonly unreadable: UnreadableMode;
}

function collectTypeFindings(
  ids: ReadonlyArray<ObjectId>,
  type: 'unreachable' | 'dangling',
  resolution: TypeResolution,
): ReadonlyArray<FsckFinding> {
  const findings: FsckFinding[] = [];
  for (const id of ids) {
    if (resolution.objectCache.get(id) == null && resolution.unreadable === 'skip') continue;
    findings.push({ type, id, objectType: resolveObjectType(id, resolution) });
  }
  return findings;
}

/**
 * Determine the object type for an oid from the cache, falling back to the
 * header-recovery probe's retained type — never a new 'unknown' derivation:
 * `'unknown'` means no stored header could be obtained at all.
 */
function resolveObjectType(id: ObjectId, resolution: TypeResolution): FsckObjectType | 'unknown' {
  const obj = resolution.objectCache.get(id);
  if (obj != null) return obj.type;
  return resolution.recovered.get(id) ?? 'unknown';
}

/** The connectivity walk's classified output, as `assembleConnectivityFindings` consumes it. */
export interface ConnectivityClassification {
  readonly missingIds: ReadonlySet<ObjectId>;
  readonly brokenEdges: ReadonlyArray<GraphEdge>;
  readonly unreachable: ReadonlyArray<ObjectId>;
  readonly dangling: ReadonlyArray<ObjectId>;
  readonly rootCommits: ReadonlyArray<ObjectId>;
  readonly tagRefs: ReadonlyArray<TagRef>;
}

/**
 * Assemble every connectivity-derived finding: missing (typed from the
 * referring edge where one exists — git emits the type it expected from
 * context, avoiding a read of an object known absent), broken-link,
 * unreachable/dangling (typed via `TypeResolution`), root and tagged.
 */
function missingAndBrokenLinkFindings(
  missingIds: ReadonlySet<ObjectId>,
  brokenEdges: ReadonlyArray<GraphEdge>,
  resolution: TypeResolution,
): ReadonlyArray<FsckFinding> {
  const missingTypeFromEdge = new Map<ObjectId, FsckObjectType | 'unknown'>();
  for (const edge of brokenEdges) {
    if (!missingTypeFromEdge.has(edge.toId)) {
      missingTypeFromEdge.set(edge.toId, edge.toType);
    }
  }
  const findings: FsckFinding[] = [];
  for (const id of missingIds) {
    const objectType = missingTypeFromEdge.get(id) ?? resolveObjectType(id, resolution);
    findings.push({ type: 'missing', id, objectType });
  }
  for (const edge of brokenEdges) {
    findings.push({ type: 'broken-link', ...edge });
  }
  return findings;
}

function rootAndTagFindings(
  rootCommits: ReadonlyArray<ObjectId>,
  tagRefs: ReadonlyArray<TagRef>,
): ReadonlyArray<FsckFinding> {
  const findings: FsckFinding[] = [];
  for (const id of rootCommits) findings.push({ type: 'root', id });
  for (const { tagId, tagName, targetId, targetType } of tagRefs) {
    findings.push({ type: 'tagged', id: targetId, objectType: targetType, tagName, tag: tagId });
  }
  return findings;
}

/** Loop-appends, never `push(...spread)` — the unreachable/dangling sets are
 *  sized by the repository's object count, and an argument spread overflows
 *  the call stack in the low six figures. */
function appendAll(target: FsckFinding[], source: ReadonlyArray<FsckFinding>): void {
  for (const finding of source) target.push(finding);
}

export function assembleConnectivityFindings(
  classification: ConnectivityClassification,
  resolution: TypeResolution,
): ReadonlyArray<FsckFinding> {
  const { missingIds, brokenEdges, unreachable, dangling, rootCommits, tagRefs } = classification;
  const findings: FsckFinding[] = [];
  appendAll(findings, missingAndBrokenLinkFindings(missingIds, brokenEdges, resolution));
  appendAll(findings, collectTypeFindings(unreachable, 'unreachable', resolution));
  appendAll(findings, collectTypeFindings(dangling, 'dangling', resolution));
  appendAll(findings, rootAndTagFindings(rootCommits, tagRefs));
  return findings;
}

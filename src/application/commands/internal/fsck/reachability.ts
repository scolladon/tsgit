import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { FILE_MODE } from '../../../../domain/objects/file-mode.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import type { CachedGitObject, ProjectedGitObject } from './object-cache.js';
import type { FsckFinding, UnreadableMode } from './types.js';

// ---------------------------------------------------------------------------
// In-edge map (needed for dangling vs merely-unreachable classification)
// ---------------------------------------------------------------------------

function recordOutEdges(obj: ProjectedGitObject, inEdge: Set<ObjectId>): void {
  if (obj.type === 'commit') {
    inEdge.add(obj.tree);
    for (const p of obj.parents) inEdge.add(p);
  } else if (obj.type === 'tree') {
    for (const entry of obj.entries) {
      // Stryker disable next-line ConditionalExpression: equivalent — gitlink shas (external commits) are not in the local universe; classifyObjects only iterates universe objects, so adding them to inEdge has no effect.
      if (entry.mode !== FILE_MODE.GITLINK) inEdge.add(entry.id);
    }
  } else if (obj.type === 'tag') {
    inEdge.add(obj.object);
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
  readonly unreadableEdges: ReadonlyArray<GraphEdge>;
  readonly rootCommits: ReadonlyArray<ObjectId>;
  readonly tagRefs: ReadonlyArray<TagRef>;
}

interface WalkState {
  readonly universe: ReadonlySet<ObjectId>;
  readonly objectCache: ReadonlyMap<ObjectId, CachedGitObject>;
  /** `unreadable === 'skip'` (default, non-connectivityOnly) — the
   *  connectivityOnly mode's own handling of a null cache entry is left
   *  untouched, so this is false there. */
  readonly contentUnreadableIsMissing: boolean;
  /** Unreadable (null-cache) ids also claimed by a pack — git's own
   *  `has_object_pack`: `isContentUnreadable` never fires for one of these,
   *  since git's `check_object` trusts the pack copy and never learns the
   *  entry is corrupt. */
  readonly packMemberIds: ReadonlySet<ObjectId>;
  readonly reached: Set<ObjectId>;
  readonly missingIds: Set<ObjectId>;
  readonly brokenEdges: GraphEdge[];
  readonly unreadableEdges: GraphEdge[];
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

/**
 * Whether `id` is present in the universe (its loose/pack file exists and
 * was enumerated) but no reader could type it — the class of failure git's
 * `read_loose_object` folds into the SAME refusal as an absent object, once
 * something else references it. Gated to default (non-connectivityOnly)
 * mode: connectivityOnly keeps its own handling of an unreadable object,
 * untouched here. Also excludes any id with a pack copy: git's
 * `check_object` (`has_object_pack`) trusts a pack's claim on an id and
 * never even attempts the read that would learn the entry is corrupt, so
 * that id is never reported missing — only `enqueueIfPresent`'s ordinary
 * routing applies to it.
 */
function isContentUnreadable(state: WalkState, id: ObjectId): boolean {
  return (
    state.contentUnreadableIsMissing &&
    state.universe.has(id) &&
    state.objectCache.get(id) == null &&
    !state.packMemberIds.has(id)
  );
}

type EdgeRoute = 'broken' | 'unreadable-missing' | 'enqueued';

/**
 * Route one graph edge's target, git-faithfully: absent from the universe
 * entirely is a broken link (git's own `missing <type>` PLUS a broken-link
 * report); present but content-unreadable in default mode is ALSO `missing`
 * — typed from this SAME edge — but git's `read_loose_object` never learns
 * enough about the object to consider the EDGE itself broken, so no
 * broken-link finding follows it. Marks the target reached either way it's
 * missing, so `classifyObjects` never ALSO reports it unreachable/dangling
 * on top of `missing` — git prints only one line for it, never both.
 */
function routeEdgeTarget(state: WalkState, edge: GraphEdge): EdgeRoute {
  if (!state.universe.has(edge.toId)) {
    state.missingIds.add(edge.toId);
    state.brokenEdges.push(edge);
    return 'broken';
  }
  if (isContentUnreadable(state, edge.toId)) {
    state.missingIds.add(edge.toId);
    state.reached.add(edge.toId);
    state.unreadableEdges.push(edge);
    return 'unreadable-missing';
  }
  enqueueIfPresent(state, edge.toId);
  return 'enqueued';
}

function processCommit(
  state: WalkState,
  id: ObjectId,
  obj: ProjectedGitObject & { type: 'commit' },
): void {
  const { tree, parents } = obj;
  routeEdgeTarget(state, { fromId: id, fromType: 'commit', toId: tree, toType: 'tree' });
  for (const parent of parents) {
    routeEdgeTarget(state, { fromId: id, fromType: 'commit', toId: parent, toType: 'commit' });
  }
  if (parents.length === 0) state.rootCommits.push(id);
}

function processTree(
  state: WalkState,
  id: ObjectId,
  obj: ProjectedGitObject & { type: 'tree' },
): void {
  for (const entry of obj.entries) {
    if (entry.mode === FILE_MODE.GITLINK) continue;
    const toType: FsckObjectType = entry.mode === FILE_MODE.DIRECTORY ? 'tree' : 'blob';
    routeEdgeTarget(state, { fromId: id, fromType: 'tree', toId: entry.id, toType });
  }
}

function processTag(
  state: WalkState,
  id: ObjectId,
  obj: ProjectedGitObject & { type: 'tag' },
): void {
  const { object: target, objectType: targetType, tagName } = obj;
  const edge: GraphEdge = { fromId: id, fromType: 'tag', toId: target, toType: targetType };
  // git's tag walk marks the target reachable — and so reports `tagged` —
  // whenever it is PRESENT, whether or not it could be typed: only a
  // genuinely absent (broken-link) target drops the report.
  if (routeEdgeTarget(state, edge) !== 'broken') {
    state.tagRefs.push({ tagId: id, tagName, targetId: target, targetType });
  }
}

function visitObject(state: WalkState, id: ObjectId, obj: ProjectedGitObject): void {
  state.reached.add(id);
  if (obj.type === 'commit') processCommit(state, id, obj);
  if (obj.type === 'tree') processTree(state, id, obj);
  if (obj.type === 'tag') processTag(state, id, obj);
}

/**
 * Reachability walk over the object graph starting from `seeds`.
 * Walks commit→(tree, parents), tree→entries (non-gitlink), tag→target.
 * `unreadable` gates whether a REACHED-but-content-unreadable id is
 * reported `missing` (default mode) or left as a bare "reached, no edges"
 * root the way connectivityOnly has always handled it.
 */
export function buildReachableSet(
  universe: ReadonlySet<ObjectId>,
  seeds: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  unreadable: UnreadableMode,
  packMemberIds: ReadonlySet<ObjectId>,
): WalkResult {
  const state: WalkState = {
    universe,
    objectCache,
    contentUnreadableIsMissing: unreadable === 'skip',
    packMemberIds,
    reached: new Set(),
    missingIds: new Set(),
    brokenEdges: [],
    unreadableEdges: [],
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
      // Corrupt/unreadable, no further edges — either a ROOT (no referring
      // edge routed it here), or a REFERENCED id whose pack copy
      // `routeEdgeTarget` trusted (`isContentUnreadable`'s pack-membership
      // exclusion) and so enqueued here instead of diverting to
      // `missingIds`.
      state.reached.add(id);
    } else {
      visitObject(state, id, obj);
    }
  }

  return {
    reached: state.reached,
    missingIds: state.missingIds,
    brokenEdges: state.brokenEdges,
    unreadableEdges: state.unreadableEdges,
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
  /** Edges that route a REACHED, content-unreadable id to `missingIds` —
   *  typing-only, never rendered as their own `broken-link` finding (see
   *  `routeEdgeTarget`'s own doc comment for why the two never double-report). */
  readonly unreadableEdges: ReadonlyArray<GraphEdge>;
  readonly unreachable: ReadonlyArray<ObjectId>;
  readonly dangling: ReadonlyArray<ObjectId>;
  readonly rootCommits: ReadonlyArray<ObjectId>;
  readonly tagRefs: ReadonlyArray<TagRef>;
}

/** Missing ids first (typed from the referring edge where one exists — git
 *  emits the type it expected from context, avoiding a read of an object
 *  known absent), then every broken-link edge. */
function missingAndBrokenLinkFindings(
  missingIds: ReadonlySet<ObjectId>,
  brokenEdges: ReadonlyArray<GraphEdge>,
  unreadableEdges: ReadonlyArray<GraphEdge>,
  resolution: TypeResolution,
): ReadonlyArray<FsckFinding> {
  const missingTypeFromEdge = new Map<ObjectId, FsckObjectType | 'unknown'>();
  for (const edge of [...brokenEdges, ...unreadableEdges]) {
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

/**
 * Assemble every connectivity-derived finding, in emission order: missing,
 * broken-link, unreachable/dangling (typed via `TypeResolution`), root and
 * tagged.
 */
export function assembleConnectivityFindings(
  classification: ConnectivityClassification,
  resolution: TypeResolution,
): ReadonlyArray<FsckFinding> {
  const { missingIds, brokenEdges, unreadableEdges, unreachable, dangling, rootCommits, tagRefs } =
    classification;
  const findings: FsckFinding[] = [];
  appendAll(
    findings,
    missingAndBrokenLinkFindings(missingIds, brokenEdges, unreadableEdges, resolution),
  );
  appendAll(findings, collectTypeFindings(unreachable, 'unreachable', resolution));
  appendAll(findings, collectTypeFindings(dangling, 'dangling', resolution));
  appendAll(findings, rootAndTagFindings(rootCommits, tagRefs));
  return findings;
}

import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { FILE_MODE } from '../../../../domain/objects/file-mode.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import type { GraphCommit } from './graph-commits.js';
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
 * `reached`, given under connectivityOnly, excludes the walk's objects: git
 * marks only an unreachable object's links used there
 * (`mark_unreachable_referents`), so a reached object it never walked names
 * nothing.
 */
export function buildInEdgeMap(
  universe: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  reached?: ReadonlySet<ObjectId>,
): Set<ObjectId> {
  const inEdge = new Set<ObjectId>();
  for (const id of universe) {
    if (reached?.has(id) === true) continue;
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

/** What git's walk reports about an object it could not walk as typed. */
export type TypeFinding = Extract<
  FsckFinding,
  { readonly type: 'unknown-object-type' | 'unexpected-object-type' }
>;

/**
 * git's connectivity-only typing: an object is typed by the first parse that
 * links to it, and walked through whatever its copy serves — never re-hashed.
 */
export interface WalkTypingInput {
  /** Every object typed before the walk pops anything (`typedBeforeWalk`). */
  readonly typedBeforeWalk: ReadonlyMap<ObjectId, FsckObjectType>;
  /** Every root whose served copy hashes to another id: popped untyped, git
   *  cannot type it. */
  readonly unparseable: ReadonlySet<ObjectId>;
  /** Every walked object the commit-graph holds, as the graph describes it. */
  readonly graphCommits: ReadonlyMap<ObjectId, GraphCommit>;
}

interface WalkTyping {
  readonly typed: Map<ObjectId, FsckObjectType>;
  readonly unparseable: ReadonlySet<ObjectId>;
  readonly graphCommits: ReadonlyMap<ObjectId, GraphCommit>;
}

export interface WalkResult {
  readonly reached: Set<ObjectId>;
  readonly missingIds: Set<ObjectId>;
  readonly brokenEdges: ReadonlyArray<GraphEdge>;
  readonly unreadableEdges: ReadonlyArray<GraphEdge>;
  readonly rootCommits: ReadonlyArray<ObjectId>;
  readonly tagRefs: ReadonlyArray<TagRef>;
  /** Objects the walk reached but could not walk as typed, in pop order. */
  readonly typeFindings: ReadonlyArray<TypeFinding>;
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
  /** git's promisor objects: reached, yet never descended into nor missing. */
  readonly promised: ReadonlySet<ObjectId>;
  readonly reached: Set<ObjectId>;
  readonly missingIds: Set<ObjectId>;
  readonly brokenEdges: GraphEdge[];
  readonly unreadableEdges: GraphEdge[];
  readonly rootCommits: ObjectId[];
  readonly tagRefs: TagRef[];
  readonly typeFindings: TypeFinding[];
  /** Undefined outside connectivityOnly, where every walked object is pre-typed. */
  readonly typing: WalkTyping | undefined;
  readonly worklist: ObjectId[];
  /** git's `REACHABLE` flag: set when an object is pushed, so each is pushed
   *  once, at its first discovery — which fixes the order objects pop in. */
  readonly pushed: Set<ObjectId>;
}

function enqueueIfPresent(state: WalkState, id: ObjectId): void {
  if (state.pushed.has(id)) return;
  state.pushed.add(id);
  state.worklist.push(id);
}

/** git's `lookup_<type>`: an object keeps the type of the first link naming it. */
function typeOnce(typed: Map<ObjectId, FsckObjectType>, id: ObjectId, type: FsckObjectType): void {
  if (!typed.has(id)) typed.set(id, type);
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

/** An edge a parse just read: its target typed by the link itself. */
type LinkEdge = GraphEdge & { readonly toType: FsckObjectType };

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
function routeEdgeTarget(state: WalkState, edge: LinkEdge): EdgeRoute {
  if (state.typing !== undefined) typeOnce(state.typing.typed, edge.toId, edge.toType);
  if (state.promised.has(edge.toId)) {
    enqueueIfPresent(state, edge.toId);
    return 'enqueued';
  }
  if (!state.universe.has(edge.toId)) {
    state.missingIds.add(edge.toId);
    state.brokenEdges.push(edge);
    return 'broken';
  }
  if (isContentUnreadable(state, edge.toId)) {
    state.missingIds.add(edge.toId);
    // Stryker disable next-line CallExpression: equivalent — collectTypeFindings (findings assembly) independently skips any id with a null cache entry in 'skip' mode, the exact pair of conditions isContentUnreadable already required to reach this branch, so a missing `reached` mark here is caught by that second guard too; kept for the belt-and-suspenders reason this function's own doc comment gives, not because it is load-bearing today.
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
  const edge: LinkEdge = { fromId: id, fromType: 'tag', toId: target, toType: targetType };
  // git's tag walk marks the target reachable — and so reports `tagged` —
  // whenever it is PRESENT, whether or not it could be typed: only a
  // genuinely absent (broken-link) target drops the report.
  if (routeEdgeTarget(state, edge) !== 'broken') {
    state.tagRefs.push({ tagId: id, tagName, targetId: target, targetType });
  }
}

/**
 * git's `fsck_walk` under connectivityOnly: a typed object is parsed as its
 * type from whatever its copy serves — a blob is never read, any other type
 * the copy is not is `Object <id> not a <type>`; an untyped one is
 * `parse_object`ed, which refuses a copy hashing to another id.
 */
function walksAsTyped(state: WalkState, id: ObjectId, obj: ProjectedGitObject): boolean {
  const typing = state.typing;
  if (typing === undefined) return true;
  const linked = typing.typed.get(id);
  if (linked === undefined) return parsesUntyped(state, typing, id);
  if (linked === obj.type) return true;
  if (linked !== 'blob') {
    state.typeFindings.push({ type: 'unexpected-object-type', id, expectedType: linked });
  }
  return false;
}

/**
 * git's `repo_parse_commit` under connectivityOnly: a commit its walk already
 * typed is filled from the commit-graph when the graph holds it — tree and
 * parents from the graph, the object's own bytes never read.
 */
function graphParsedCommit(state: WalkState, id: ObjectId): GraphCommit | undefined {
  const typing = state.typing;
  if (typing?.typed.get(id) !== 'commit') return undefined;
  return typing.graphCommits.get(id);
}

function parsesUntyped(state: WalkState, typing: WalkTyping, id: ObjectId): boolean {
  if (!typing.unparseable.has(id)) return true;
  state.typeFindings.push({ type: 'unknown-object-type', id });
  return false;
}

/** The links git's `parse_object` types: a tree's entries wait for its walk. */
function parsedLinks(obj: ProjectedGitObject): ReadonlyArray<readonly [ObjectId, FsckObjectType]> {
  if (obj.type === 'commit') {
    return [[obj.tree, 'tree'], ...obj.parents.map((parent) => [parent, 'commit'] as const)];
  }
  if (obj.type === 'tag') return [[obj.object, obj.objectType]];
  return [];
}

/** Where git's fsck types objects before its walk pops anything. */
export interface PreWalkParses {
  /** Every ref tip `snapshot_refs` parses. */
  readonly refTips: Iterable<ObjectId>;
  /** Every index entry `fsck_index` looks up as a blob. */
  readonly indexBlobs: Iterable<ObjectId>;
  /** Every cache-tree and resolve-undo oid `fsck_index` parses. */
  readonly parsedIndexIds: Iterable<ObjectId>;
}

/** Every object typed before the walk: each parsed object and the links its
 *  parse types, each index entry as a blob. The first type an object gets wins. */
export function typedBeforeWalk(
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  parses: PreWalkParses,
): ReadonlyMap<ObjectId, FsckObjectType> {
  const typed = new Map<ObjectId, FsckObjectType>();
  const typeParsed = (id: ObjectId): void => {
    const obj = objectCache.get(id);
    if (obj == null) return;
    typeOnce(typed, id, obj.type);
    for (const [link, type] of parsedLinks(obj)) typeOnce(typed, link, type);
  };
  for (const id of parses.refTips) typeParsed(id);
  for (const id of parses.indexBlobs) typeOnce(typed, id, 'blob');
  for (const id of parses.parsedIndexIds) typeParsed(id);
  return typed;
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
 * root the way connectivityOnly has always handled it. `typing`, given
 * under connectivityOnly, types objects in git's pop order (`walksAsTyped`).
 */
export function buildReachableSet(
  universe: ReadonlySet<ObjectId>,
  seeds: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  unreadable: UnreadableMode,
  packMemberIds: ReadonlySet<ObjectId>,
  promised: ReadonlySet<ObjectId>,
  typing?: WalkTypingInput,
): WalkResult {
  const state: WalkState = {
    universe,
    objectCache,
    contentUnreadableIsMissing: unreadable === 'skip',
    packMemberIds,
    promised,
    reached: new Set(),
    missingIds: new Set(),
    brokenEdges: [],
    unreadableEdges: [],
    rootCommits: [],
    tagRefs: [],
    typeFindings: [],
    typing:
      typing === undefined
        ? undefined
        : {
            typed: new Map(typing.typedBeforeWalk),
            unparseable: typing.unparseable,
            graphCommits: typing.graphCommits,
          },
    worklist: [...seeds],
    pushed: new Set(seeds),
  };

  while (state.worklist.length > 0) {
    const id = state.worklist.pop();
    if (id === undefined || state.reached.has(id)) continue;
    if (promised.has(id)) {
      // git's `mark_object`: a promisor object is reached, its links never followed.
      state.reached.add(id);
      continue;
    }
    if (!universe.has(id)) {
      state.missingIds.add(id);
      continue;
    }
    const graphCommit = graphParsedCommit(state, id);
    const obj = graphCommit ?? objectCache.get(id);
    if (obj == null) {
      // Corrupt/unreadable, no further edges — either a ROOT (no referring
      // edge routed it here), or a REFERENCED id whose pack copy
      // `routeEdgeTarget` trusted (`isContentUnreadable`'s pack-membership
      // exclusion) and so enqueued here instead of diverting to
      // `missingIds`.
      state.reached.add(id);
    } else if (walksAsTyped(state, id, obj)) {
      visitObject(state, id, obj);
    } else {
      state.reached.add(id);
    }
  }

  return {
    reached: state.reached,
    missingIds: state.missingIds,
    brokenEdges: state.brokenEdges,
    unreadableEdges: state.unreadableEdges,
    rootCommits: state.rootCommits,
    tagRefs: state.tagRefs,
    typeFindings: state.typeFindings,
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
  /** Index entry oids — git looks each one up as a blob, so a missing one is a blob. */
  readonly indexBlobs: ReadonlySet<ObjectId>;
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

/** A missing id's type as git's lookup made it: a blob for an index entry. */
const expectedType = (id: ObjectId, resolution: TypeResolution): FsckObjectType | 'unknown' =>
  resolution.indexBlobs.has(id) ? 'blob' : resolveObjectType(id, resolution);

/**
 * git's walk under `--no-full`: a missing object a pack holds is forgotten
 * (`has_object_pack`) — never missing, never a broken link's target. An
 * unreadable one the run did enumerate never gets here with a pack copy
 * (`packMemberIds`). Returns `walk` itself when nothing is excused.
 */
export async function excusePackHeld(
  walk: WalkResult,
  packHolds: (id: ObjectId) => Promise<boolean>,
): Promise<WalkResult> {
  const excused = new Set<ObjectId>();
  for (const id of walk.missingIds) {
    if (await packHolds(id)) excused.add(id);
  }
  if (excused.size === 0) return walk;
  return {
    ...walk,
    missingIds: new Set([...walk.missingIds].filter((id) => !excused.has(id))),
    brokenEdges: walk.brokenEdges.filter((edge) => !excused.has(edge.toId)),
  };
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
    const objectType = missingTypeFromEdge.get(id) ?? expectedType(id, resolution);
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
 * broken-link, unreachable/dangling (typed via `TypeResolution`), then —
 * outside connectivity-only — root and tagged.
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
  // git prints these from `fsck_obj` alone, which connectivity-only never runs.
  if (resolution.unreadable === 'skip')
    appendAll(findings, rootAndTagFindings(rootCommits, tagRefs));
  return findings;
}

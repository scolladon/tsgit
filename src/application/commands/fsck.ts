import type { FsckObjectType, FsckSeverity } from '../../domain/fsck/index.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { listReflogs, readReflog } from '../primitives/reflog-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FsckFinding =
  | { readonly type: 'dangling'; readonly id: ObjectId; readonly objectType: FsckObjectType }
  | { readonly type: 'unreachable'; readonly id: ObjectId; readonly objectType: FsckObjectType }
  | {
      readonly type: 'missing';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType | 'unknown';
    }
  | {
      readonly type: 'broken-link';
      readonly fromId: ObjectId;
      readonly fromType: FsckObjectType;
      readonly toId: ObjectId;
      readonly toType: FsckObjectType | 'unknown';
    }
  | {
      readonly type: 'bad-object';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType;
      readonly msgId: string;
      readonly severity: FsckSeverity;
    }
  | {
      readonly type: 'hash-mismatch';
      readonly id: ObjectId;
      readonly actual: ObjectId;
    }
  | {
      readonly type: 'bad-ref';
      readonly ref: RefName;
      readonly msgId: string;
      readonly severity: FsckSeverity;
      readonly target?: ObjectId;
    }
  | { readonly type: 'root'; readonly id: ObjectId }
  | {
      readonly type: 'tagged';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType;
      readonly tagName: string;
      readonly tag: ObjectId;
    };

export interface FsckOptions {
  /** Skip object-content validation, links only. */
  readonly connectivityOnly?: boolean;
  /** Default true — reflog oids are roots; false to exclude. */
  readonly reflogRoots?: boolean;
  /** Default true — index oids are roots. */
  readonly indexRoot?: boolean;
  /** Default true — include packs. */
  readonly full?: boolean;
  /** WARN-class msg-ids upgraded to ERROR (+exit bit). */
  readonly strict?: boolean;
  /** Default true — run refs-verify pass. */
  readonly checkReferences?: boolean;
}

export interface FsckResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  /** Composite exit bitmask: 0=clean, 2=missing/broken-link. */
  readonly exitCode: number;
}

// ---------------------------------------------------------------------------
// Exit-code bits (3b/3c add the rest of the bitmask)
// ---------------------------------------------------------------------------

const EXIT_MISSING = 2;

// ---------------------------------------------------------------------------
// Root collection
// ---------------------------------------------------------------------------

async function addRefRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const refNames = await enumerateRefs(ctx);
  for (const ref of refNames) {
    try {
      roots.add(await resolveRef(ctx, ref, { peel: false }));
    } catch {
      // Unresolvable ref (unborn, dangling symref, etc.) — tolerated
    }
  }
}

async function addReflogRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const reflogNames = await listReflogs(ctx);
  await Promise.all(
    reflogNames.map(async (ref) => {
      try {
        const entries = await readReflog(ctx, ref);
        for (const entry of entries) {
          roots.add(entry.oldId);
          roots.add(entry.newId);
        }
      } catch {
        // Unreadable reflog — tolerated
      }
    }),
  );
}

async function addIndexRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  try {
    const index = await readIndex(ctx);
    for (const entry of index.entries) {
      if (entry.flags.stage === 0) roots.add(entry.id);
    }
  } catch {
    // Missing or corrupt index — tolerated
  }
}

/**
 * Collect all oids that serve as reachability roots:
 * - Each resolved ref (HEAD + all refs/*)
 * - Reflog old/new oids (when reflogRoots !== false)
 * - Index entry oids (when indexRoot !== false)
 */
async function collectRoots(ctx: Context, opts: FsckOptions): Promise<ReadonlySet<ObjectId>> {
  const roots = new Set<ObjectId>();
  await addRefRoots(ctx, roots);
  if (opts.reflogRoots !== false) await addReflogRoots(ctx, roots);
  if (opts.indexRoot !== false) await addIndexRoots(ctx, roots);
  return roots;
}

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
 * Scan ALL universe objects to collect which oids have at least one in-edge
 * from another present (universe) object. Separate from the BFS so that
 * unreachable objects with internal edges are not misclassified as dangling.
 */
async function buildInEdgeMap(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
): Promise<Set<ObjectId>> {
  const inEdge = new Set<ObjectId>();
  for (const id of universe) {
    try {
      recordOutEdges(await readObject(ctx, id, { verifyHash: false }), inEdge);
    } catch {
      // Corrupt / unreadable — no edges recorded
    }
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

async function visitObject(ctx: Context, state: BfsState, id: ObjectId): Promise<void> {
  state.reached.add(id);
  let obj: GitObject;
  try {
    obj = await readObject(ctx, id, { verifyHash: false });
  } catch {
    return; // Corrupt/unreadable — in reached, no further edges
  }
  if (obj.type === 'commit') processCommit(state, id, obj);
  else if (obj.type === 'tree') processTree(state, id, obj);
  else if (obj.type === 'tag') processTag(state, id, obj);
}

/**
 * BFS over the reachable object graph starting from `seeds`.
 * Walks commit→(tree, parents), tree→entries (non-gitlink), tag→target.
 */
async function buildReachableSet(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  seeds: ReadonlySet<ObjectId>,
): Promise<WalkResult> {
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
    await visitObject(ctx, state, id);
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

function classifyObjects(
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
// Finding assembly
// ---------------------------------------------------------------------------

async function collectTypeFindings(
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
  type: 'unreachable' | 'dangling',
  findings: FsckFinding[],
): Promise<void> {
  for (const id of ids) {
    try {
      const obj = await readObject(ctx, id, { verifyHash: false });
      findings.push({ type, id, objectType: obj.type });
    } catch {
      // Unreadable — skip (already in reached/not reachable anyway)
    }
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function fsck(ctx: Context, opts: FsckOptions = {}): Promise<FsckResult> {
  await assertRepository(ctx);

  const allIds = await enumerateObjects(ctx, { includePacks: opts.full !== false });
  const universe = new Set(allIds);

  const [roots, inEdgePresent] = await Promise.all([
    collectRoots(ctx, opts),
    buildInEdgeMap(ctx, universe),
  ]);

  const { reached, missingIds, brokenEdges, rootCommits, tagRefs } = await buildReachableSet(
    ctx,
    universe,
    roots,
  );

  const { unreachable, dangling } = classifyObjects(universe, reached, inEdgePresent);

  const findings: FsckFinding[] = [];

  for (const id of missingIds) {
    findings.push({ type: 'missing', id, objectType: await resolveObjectType(ctx, id) });
  }
  for (const edge of brokenEdges) {
    findings.push({ type: 'broken-link', ...edge });
  }
  await collectTypeFindings(ctx, unreachable, 'unreachable', findings);
  await collectTypeFindings(ctx, dangling, 'dangling', findings);
  for (const id of rootCommits) findings.push({ type: 'root', id });
  for (const { tagId, tagName, targetId, targetType } of tagRefs) {
    findings.push({ type: 'tagged', id: targetId, objectType: targetType, tagName, tag: tagId });
  }

  const exitCode = missingIds.size > 0 || brokenEdges.length > 0 ? EXIT_MISSING : 0;
  return { findings, exitCode };
}

/** Determine the object type of an oid by reading it lightly. */
async function resolveObjectType(ctx: Context, id: ObjectId): Promise<FsckObjectType | 'unknown'> {
  try {
    return (await readObject(ctx, id, { verifyHash: false })).type;
  } catch {
    return 'unknown';
  }
}

import { TsgitError } from '../../domain/error.js';
import type { FsckObjectType, FsckSeverity } from '../../domain/fsck/index.js';
import { validateObject } from '../../domain/fsck/index.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import { parseHeader, serializeObject, ZERO_OID } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { looseCompressedBytes } from '../primitives/object-resolver.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { getRefStore } from '../primitives/ref-store.js';
import { listReflogs, readReflog } from '../primitives/reflog-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';

export type { FsckObjectType, FsckSeverity } from '../../domain/fsck/index.js';

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
      /** 'unknown' when the object is undecodable and its type cannot be determined. */
      readonly objectType: FsckObjectType | 'unknown';
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
// Exit-code bits (pinned against real git 2.54.0)
// bit 1 = generic fsck error: content-ERROR, strict-upgraded WARN, corrupt, hash-mismatch
// bit 2 = missing / broken-link / ref→absent-sha
// bit 8 = refs-verify content failure (3c)
// ---------------------------------------------------------------------------

const EXIT_CONTENT_ERROR = 1;
const EXIT_CORRUPT = 1;
const EXIT_HASH_MISMATCH = 1;
const EXIT_MISSING = 2;
const EXIT_REFS_CONTENT = 8;

// ---------------------------------------------------------------------------
// Root collection
// ---------------------------------------------------------------------------

async function addRefRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<void> {
  const refNames = await enumerateRefs(ctx);
  for (const ref of refNames) {
    try {
      const id = await resolveRef(ctx, ref, { peel: false });
      // Only add to roots if the OID is present in the universe.
      // Absent OIDs are reported as bad-ref(badRefOid) by the refs-verify pass
      // and must NOT be added to roots (would produce spurious 'missing' findings).
      if (universe.has(id)) roots.add(id);
    } catch {
      // Unresolvable ref (unborn, dangling symref, malformed content) — tolerated
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
          // ZERO_OID is the "no object" sentinel git writes for creation events
          // (first reflog entry of any ref). It is not a real object reference
          // and must never be treated as a reachability root.
          if (entry.oldId !== ZERO_OID) roots.add(entry.oldId);
          if (entry.newId !== ZERO_OID) roots.add(entry.newId);
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
async function collectRoots(
  ctx: Context,
  opts: FsckOptions,
  universe: ReadonlySet<ObjectId>,
): Promise<ReadonlySet<ObjectId>> {
  const roots = new Set<ObjectId>();
  await addRefRoots(ctx, roots, universe);
  if (opts.reflogRoots !== false) await addReflogRoots(ctx, roots);
  if (opts.indexRoot !== false) await addIndexRoots(ctx, roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Refs-verify pass
// ---------------------------------------------------------------------------

type BadRefFinding = FsckFinding & { readonly type: 'bad-ref' };

/** Matches a valid SHA-1 (40-hex) or SHA-256 (64-hex) OID. */
const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Classify and report findings for a single loose ref's raw content.
 * Returns findings + accumulated exit-bit contribution.
 *
 * Content format check (badRefContent) is gated by `checkContentFormat`.
 * Absent-OID check (badRefOid) is always run, matching git's behaviour
 * with `--no-references` (pinned: matrix #9a, exit 2 both ways).
 */
function checkLooseRef(
  ref: RefName,
  raw: string,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
): { readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number } {
  const content = raw.replace(/[\r\n]+$/, '');

  if (content.startsWith('ref: ')) {
    // Symref — absent symref targets not an error (unborn branch = OK, matrix #9c)
    return { findings: [], exitBit: 0 };
  }

  if (!OID_RE.test(content)) {
    // Malformed content: badRefContent (gated) + synthesised zero-OID pointer (always)
    const badFindings: BadRefFinding[] = [];
    let bit = EXIT_MISSING; // zero-OID pointer always contributes bit 2
    if (checkContentFormat) {
      badFindings.push({ type: 'bad-ref', ref, msgId: 'badRefContent', severity: 'error' });
      bit |= EXIT_REFS_CONTENT;
    }
    badFindings.push({
      type: 'bad-ref',
      ref,
      msgId: 'badRefOid',
      severity: 'error',
      target: ZERO_OID,
    });
    return { findings: badFindings, exitBit: bit };
  }

  const oid = content as ObjectId;
  if (universe.has(oid)) return { findings: [], exitBit: 0 };
  // Valid OID format but absent from object store
  return {
    findings: [{ type: 'bad-ref', ref, msgId: 'badRefOid', severity: 'error', target: oid }],
    exitBit: EXIT_MISSING,
  };
}

/**
 * Verify every ref's content and OID-reachability.
 *
 * Two sub-checks run independently:
 * - **Content format** (gated by `checkReferences`): loose-ref must be a valid hex OID
 *   or `ref: <target>`. Malformed → `badRefContent` (bit 8) + synthesised zero-OID → `badRefOid`
 *   (bit 2). Pinned: matrix #9b, composite exit 10 = 2|8.
 * - **OID presence** (always): every ref OID (loose + packed) must be in the object universe.
 *   Absent → `badRefOid` (bit 2). Pinned: matrix #9a, exit 2 same with/without `--no-references`.
 */
async function runRefsVerifyPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
): Promise<{ readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number }> {
  const findings: BadRefFinding[] = [];
  let exitBit = 0;

  const refStore = getRefStore(ctx);
  const refNames = await enumerateRefs(ctx);

  for (const ref of refNames) {
    const raw = await refStore.readLooseRaw(ref);
    if (raw !== undefined) {
      const { findings: f, exitBit: b } = checkLooseRef(ref, raw, universe, checkContentFormat);
      findings.push(...f);
      exitBit |= b;
      continue;
    }

    // Not a loose ref — check packed-refs entry for OID presence
    const packed = await refStore.getPackedRefs();
    for (const entry of packed.entries) {
      if (entry.name !== ref) continue;
      if (!universe.has(entry.id)) {
        findings.push({
          type: 'bad-ref',
          ref,
          msgId: 'badRefOid',
          severity: 'error',
          target: entry.id,
        });
        exitBit |= EXIT_MISSING;
      }
      break;
    }
  }

  return { findings, exitBit };
}

// ---------------------------------------------------------------------------
// Object-content validation pass
// ---------------------------------------------------------------------------

type RawObjectResult =
  | { readonly ok: true; readonly kind: FsckObjectType; readonly rawBody: Uint8Array }
  | { readonly ok: false; readonly msgId: string };

/**
 * Read an object's raw decompressed body for content validation.
 *
 * For loose objects: inflate the compressed bytes and return the body (after
 * the git `<type> <size>\0` header). This preserves zero-padded file modes
 * and other normalisation-defeated bytes that tsgit's strict parsers reject.
 *
 * For pack objects: re-serialize the parsed object. Packs never contain
 * zero-padded modes (git normalises on pack write), so re-serialisation is
 * correct for all catalogue checks that apply to packed objects.
 */
async function tryGetRawObjectBody(ctx: Context, id: ObjectId): Promise<RawObjectResult> {
  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) {
    let inflated: Uint8Array;
    try {
      inflated = await ctx.compressor.inflate(compressed);
    } catch {
      // Inflate failure: the compressed bytes are corrupt — type is unknown.
      return { ok: false, msgId: 'unterminatedHeader' };
    }
    try {
      const { type, contentOffset } = parseHeader(inflated);
      return { ok: true, kind: type, rawBody: inflated.subarray(contentOffset) };
    } catch (err) {
      // Header-parse failure: inflated successfully but header is malformed.
      // Distinguish unknown type (unknownType) from missing NUL (unterminatedHeader).
      const reason =
        err instanceof TsgitError && err.data.code === 'INVALID_OBJECT_HEADER'
          ? (err.data as { reason: string }).reason
          : '';
      const msgId = reason.startsWith('unknown object type') ? 'unknownType' : 'unterminatedHeader';
      return { ok: false, msgId };
    }
  }

  // Pack object — go through the normal parse path and re-serialize
  try {
    const obj = await readObject(ctx, id, { verifyHash: false });
    const full = serializeObject(obj, ctx.hashConfig);
    const { contentOffset } = parseHeader(full);
    return { ok: true, kind: obj.type, rawBody: full.subarray(contentOffset) };
  } catch {
    return { ok: false, msgId: 'badType' };
  }
}

/** Special filenames whose blob content triggers dedicated fsck checks. */
const SPECIAL_BLOB_NAMES: ReadonlySet<string> = new Set(['.gitmodules', '.gitattributes']);

/**
 * Scan all tree objects in the universe and record blob OIDs that appear
 * under a special filename (.gitmodules, .gitattributes) in any tree.
 *
 * Pinned real git 2.54.0: git checks .gitmodules/.gitattributes blob content
 * at any tree depth — not only the root tree. If the same blob OID appears
 * under multiple names, the last special name wins (precedence is
 * non-deterministic, but in practice each blob has one name).
 */
async function buildBlobFilenameMap(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
): Promise<ReadonlyMap<ObjectId, string>> {
  const map = new Map<ObjectId, string>();
  for (const id of universe) {
    let obj: Awaited<ReturnType<typeof readObject>>;
    try {
      obj = await readObject(ctx, id, { verifyHash: false });
    } catch {
      continue;
    }
    if (obj.type !== 'tree') continue;
    for (const entry of obj.entries) {
      if (SPECIAL_BLOB_NAMES.has(entry.name)) {
        map.set(entry.id, entry.name);
      }
    }
  }
  return map;
}

interface ContentValidationResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitBit: number;
}

/** Validate one object's content and hash, accumulating findings and an exit bit. */
async function validateOneObject(
  ctx: Context,
  id: ObjectId,
  strict: boolean,
  blobFilenames: ReadonlyMap<ObjectId, string>,
): Promise<ContentValidationResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;

  const rawResult = await tryGetRawObjectBody(ctx, id);
  if (!rawResult.ok) {
    findings.push({
      type: 'bad-object',
      id,
      objectType: 'unknown',
      msgId: rawResult.msgId,
      severity: 'error',
    });
    return { findings, exitBit: EXIT_CORRUPT };
  }

  const { kind, rawBody } = rawResult;

  // For blobs, pass the filename when the blob appears under a special name
  // (.gitmodules / .gitattributes) so content checks fire (gitmodulesUrl, …).
  const fileName = kind === 'blob' ? blobFilenames.get(id) : undefined;
  const catalogueFindings = validateObject(
    fileName !== undefined ? { rawBody, kind, strict, fileName } : { rawBody, kind, strict },
  );
  for (const { msgId, severity } of catalogueFindings) {
    findings.push({ type: 'bad-object', id, objectType: kind, msgId, severity });
    if (severity === 'error') exitBit |= EXIT_CONTENT_ERROR;
  }

  // Hash check: verify separately (hash-mismatch does not preclude catalogue checks).
  try {
    await readObject(ctx, id, { verifyHash: true });
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'OBJECT_HASH_MISMATCH') {
      const actual = (err.data as { actual: ObjectId }).actual;
      findings.push({ type: 'hash-mismatch', id, actual });
      exitBit |= EXIT_HASH_MISMATCH;
    }
    // Parse errors for loose objects are validated above — not a hash fault.
  }

  return { findings, exitBit };
}

/**
 * Validate object contents for the entire universe.
 * Skipped when connectivityOnly is true.
 * Returns bad-object and hash-mismatch findings plus the OR'd exit bit.
 */
async function runContentValidationPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  strict: boolean,
  blobFilenames: ReadonlyMap<ObjectId, string>,
): Promise<ContentValidationResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;

  for (const id of universe) {
    const { findings: objFindings, exitBit: objBit } = await validateOneObject(
      ctx,
      id,
      strict,
      blobFilenames,
    );
    findings.push(...objFindings);
    exitBit |= objBit;
  }

  return { findings, exitBit };
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

  // Build blob→filename map for special-file content checks (.gitmodules, .gitattributes).
  // Skipped when connectivityOnly since content checks are also skipped in that mode.
  const blobFilenames =
    opts.connectivityOnly === true
      ? (new Map() as ReadonlyMap<ObjectId, string>)
      : await buildBlobFilenameMap(ctx, universe);

  // Content validation pass (skipped when connectivityOnly)
  const contentResult =
    opts.connectivityOnly === true
      ? { findings: [] as FsckFinding[], exitBit: 0 }
      : await runContentValidationPass(ctx, universe, opts.strict === true, blobFilenames);

  // Refs-verify pass: always checks absent OIDs; content-format check gated by checkReferences.
  // Runs before collectRoots so absent-OID refs are reported as bad-ref (not 'missing').
  const refsResult = await runRefsVerifyPass(ctx, universe, opts.checkReferences !== false);

  const [roots, inEdgePresent] = await Promise.all([
    collectRoots(ctx, opts, universe),
    buildInEdgeMap(ctx, universe),
  ]);

  const { reached, missingIds, brokenEdges, rootCommits, tagRefs } = await buildReachableSet(
    ctx,
    universe,
    roots,
  );

  const { unreachable, dangling } = classifyObjects(universe, reached, inEdgePresent);

  const findings: FsckFinding[] = [...contentResult.findings, ...refsResult.findings];

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

  const connectivityBit = missingIds.size > 0 || brokenEdges.length > 0 ? EXIT_MISSING : 0;
  const exitCode = contentResult.exitBit | connectivityBit | refsResult.exitBit;
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

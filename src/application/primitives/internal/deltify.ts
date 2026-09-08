/**
 * The lazy deltify window: sorts a corpus into pack emission order, then
 * slides a bounded window of recently-emitted objects over it, offering
 * each one as a candidate `OFS_DELTA` base for its successors. The only
 * piece of the delta-writing path that reads object content.
 *
 * Determinism is structural: no `Map`/`Set`, no `Date.now`, no
 * `Math.random`, no `Promise.race` anywhere in the selection path — the
 * window is a plain array walked in index order, and every comparison the
 * search makes is a pure function of (object set, config, adapter).
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  createDeltaIndex,
  type DeltaIndex,
  encodeDeltaFromIndex,
} from '../../../domain/storage/delta-encode.js';
import {
  acceptsDeltaEntry,
  comparePackEmissionOrder,
  type DeltaPolicy,
  NO_RECENCY,
  type PackEmissionKey,
} from '../../../domain/storage/delta-policy.js';
import {
  type BasePackEntryType,
  objectTypeToPackEntryType,
  PACK_ENTRY_TYPE,
  type PackWriterBaseEntry,
  type PackWriterDeltaEntry,
  type PackWriterEntry,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import type { PackObjectInput } from '../build-pack.js';
import {
  type ObjectMetadataWithContent,
  readObjectMetadataWithContent,
  readRawObject,
} from '../read-object.js';
import { boundedMapFor } from './concurrency.js';

export interface DeltifiedEntry {
  readonly id: ObjectId;
  readonly entry: PackWriterEntry;
  /** Where this object sat in `deltifyEntries`' input list. Emission order is
   *  the packer's own (type, nameHash, size, recency, oid), so a caller
   *  holding per-object data keyed by its input order needs this to line the
   *  two up — without it the only bridge back is the oid, which costs a hex
   *  decode per object. */
  readonly sourceIndex: number;
}

interface EmissionEntry extends PackEmissionKey {
  readonly id: ObjectId;
  /** Index into `deltifyEntries`' input list, carried through the emission
   *  sort so the caller can map an emitted ordinal back to its own input. */
  readonly sourceIndex: number;
  /** The loose route's already-inflated content, when `buildEmissionOrder`
   *  could afford to carry it forward (see `boundCarriedContent`) — absent
   *  for every packed object and for any loose object beyond the residency
   *  bound, both of which the emission loop re-reads instead. */
  readonly content?: Uint8Array;
}

interface PendingMember {
  readonly id: ObjectId;
  readonly type: BasePackEntryType;
  readonly chainDepth: number;
  readonly content: Uint8Array;
  readonly emissionIndex: number;
}

interface WindowMember extends PendingMember {
  readonly index: DeltaIndex;
}

interface Candidate {
  readonly delta: Uint8Array;
  readonly chainDepth: number;
  readonly emissionIndex: number;
}

/**
 * Threads the loose route's already-inflated content (see
 * `readObjectMetadataWithContent`) into each `EmissionEntry`, capped at
 * `budget` total carried bytes so one `deltifyEntries` call never holds
 * materially more loose content resident at once than `ctx.deltaCache`
 * itself is configured to — the same "how much raw object content this
 * session keeps resident to avoid a redundant read" policy, reused rather
 * than duplicated as an unrelated second constant. Objects beyond the cap,
 * and every packed object (whose `content` is always `undefined`), fall
 * back to the plain second read the emission loop already had — never a
 * regression, only a bounded improvement.
 */
function boundCarriedContent(
  objects: ReadonlyArray<PackObjectInput>,
  metas: ReadonlyArray<ObjectMetadataWithContent>,
  budget: number,
): EmissionEntry[] {
  const entries: EmissionEntry[] = [];
  let carriedBytes = 0;
  for (const [i, object] of objects.entries()) {
    const meta = metas[i]!;
    const key = {
      id: object.id,
      sourceIndex: i,
      type: objectTypeToPackEntryType(meta.type),
      nameHash: object.nameHash ?? 0,
      uncompressedSize: meta.uncompressedSize,
      recency: object.recency ?? NO_RECENCY,
    };
    const content = meta.content;
    if (content === undefined || carriedBytes + content.length > budget) {
      entries.push(key);
      continue;
    }
    carriedBytes += content.length;
    entries.push({ ...key, content });
  }
  return entries;
}

async function buildEmissionOrder(
  ctx: Context,
  objects: ReadonlyArray<PackObjectInput>,
): Promise<ReadonlyArray<EmissionEntry>> {
  const metas = await boundedMapFor(ctx, 'ioBound', objects, (object) =>
    readObjectMetadataWithContent(ctx, object.id),
  );
  const keys = boundCarriedContent(objects, metas, ctx.deltaCache.maxSize);
  return [...keys].sort(comparePackEmissionOrder);
}

/** No incumbent yet scores exactly like a candidate one shallower than any
 *  real chain position — git's own `try_delta` reference depth for the
 *  no-delta-yet case. */
const NO_INCUMBENT_REF_DEPTH = 1;

/**
 * git's own `try_delta` byte budget: the size a candidate base at
 * `baseDepth` must fit its delta into, so that a deeper base has to earn its
 * place with something smaller while a shallower one is allowed more room.
 * With no incumbent the budget is half the target's size minus one digest
 * (roughly "a delta only pays off if it beats storing the object outright,
 * with a hash-sized margin"); with one, it is the incumbent's own delta
 * length. Both are then scaled by how much of the remaining depth budget
 * this candidate's position leaves.
 *
 * `budget` is computed the way C's `unsigned long` arithmetic computes it,
 * underflow included: for a `targetSize` under twice `hashSize`, subtracting
 * `hashSize` goes negative, which in git's real, unsigned type wraps to a
 * huge positive number — effectively no limit at all. This is replicated
 * deliberately, not clamped to zero: a sha256 repository hits this for every
 * object under 64 bytes (sha1: 40), and clamping would quietly turn off a
 * code path real git actually runs. `undefined` stands in for that wrapped,
 * unbounded state.
 * @internal — exported only for the vector coverage below.
 */
export function searchBound(
  targetSize: number,
  hashSize: number,
  incumbent: Candidate | undefined,
  baseDepth: number,
  maxDepth: number,
): number | undefined {
  const [budget, refDepth] =
    incumbent === undefined
      ? [Math.floor(targetSize / 2) - hashSize, NO_INCUMBENT_REF_DEPTH]
      : [incumbent.delta.length, incumbent.chainDepth + 1];
  if (budget < 0) return undefined;
  return Math.floor((budget * (maxDepth - baseDepth)) / (maxDepth - refDepth + 1));
}

/**
 * git's own two guards run first: a cross-type candidate never matches, and
 * one already at the depth cap can never become a base — this second guard
 * is not something the bound computation subsumes, because the bound's
 * unbounded arm (a budget that went negative and wrapped) skips the depth scaling entirely
 * and would otherwise let a depth-saturated candidate through. The bound
 * itself then governs fit: `0` refuses outright before any encoding is
 * attempted, `undefined` hands `encodeDeltaFromIndex` no cap at all, and any
 * other value is the delta's maximum length — inclusive, matching git's own
 * `create_delta`, which only refuses an output position strictly past the
 * limit. What comes back is judged by git's same-size rule: a delta tying
 * the incumbent's own length keeps the incumbent unless the new candidate
 * is strictly shallower; anything left over is decided purely by visit
 * order (most-recent-first in `selectBestCandidate`).
 */
function tryCandidate(
  member: WindowMember,
  content: Uint8Array,
  type: BasePackEntryType,
  policy: DeltaPolicy,
  hashSize: number,
  best: Candidate | undefined,
): Candidate | undefined {
  if (member.type !== type || member.chainDepth >= policy.maxDepth) return undefined;
  const bound = searchBound(content.length, hashSize, best, member.chainDepth, policy.maxDepth);
  if (bound === 0) return undefined;
  const delta = encodeDeltaFromIndex(member.index, content, bound);
  if (delta === undefined) return undefined;
  const tiesIncumbent =
    best !== undefined &&
    delta.length === best.delta.length &&
    member.chainDepth >= best.chainDepth;
  if (tiesIncumbent) return undefined;
  return { delta, chainDepth: member.chainDepth, emissionIndex: member.emissionIndex };
}

/** Candidates are tried most-recently-added first — an array walked back to
 *  front, never a hash-keyed container. */
function selectBestCandidate(
  content: Uint8Array,
  window: ReadonlyArray<WindowMember>,
  type: BasePackEntryType,
  policy: DeltaPolicy,
  hashSize: number,
): Candidate | undefined {
  let best: Candidate | undefined;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const found = tryCandidate(window[i]!, content, type, policy, hashSize, best);
    if (found !== undefined) best = found;
  }
  return best;
}

function baseEntry(
  type: BasePackEntryType,
  content: Uint8Array,
  compressedData: Uint8Array,
): PackWriterBaseEntry {
  return { type, uncompressedSize: content.length, compressedData };
}

function deltaEntry(candidate: Candidate, compressedData: Uint8Array): PackWriterDeltaEntry {
  return {
    type: PACK_ENTRY_TYPE.OFS_DELTA,
    uncompressedSize: candidate.delta.length,
    compressedData,
    baseIndex: candidate.emissionIndex,
  };
}

/**
 * Deflates only when a candidate won the search: one deflate for a plain
 * base, two — delta and content — when a candidate must be judged against
 * the base entry it would replace.
 */
async function buildDeltifiedEntry(
  ctx: Context,
  type: BasePackEntryType,
  content: Uint8Array,
  candidate: Candidate | undefined,
): Promise<{ readonly entry: PackWriterEntry; readonly chainDepth: number }> {
  if (candidate === undefined) {
    const compressedData = await ctx.compressor.deflate(content);
    return { entry: baseEntry(type, content, compressedData), chainDepth: 0 };
  }
  const [deltaBytes, baseBytes] = await Promise.all([
    ctx.compressor.deflate(candidate.delta),
    ctx.compressor.deflate(content),
  ]);
  if (!acceptsDeltaEntry(deltaBytes.length, baseBytes.length)) {
    return { entry: baseEntry(type, content, baseBytes), chainDepth: 0 };
  }
  return { entry: deltaEntry(candidate, deltaBytes), chainDepth: candidate.chainDepth + 1 };
}

function exceedsCount(window: ReadonlyArray<WindowMember>, policy: DeltaPolicy): boolean {
  return window.length >= policy.window;
}

function exceedsBudget(residentBytes: number, incomingBytes: number, policy: DeltaPolicy): boolean {
  return policy.windowMemoryBudget > 0 && residentBytes + incomingBytes > policy.windowMemoryBudget;
}

/** A member's true resident cost: its content bytes PLUS the `DeltaIndex`
 *  built on admission (`heads` + `next`) — canonical git charges the same
 *  `sizeof_delta_index()` against `window_memory_limit`. Shared by admission
 *  and eviction so the two can never drift apart. */
function memberWeight(member: Pick<WindowMember, 'content' | 'index'>): number {
  return member.content.length + member.index.heads.byteLength + member.index.next.byteLength;
}

/** The window array and its resident-byte total, encapsulated as one value
 *  so the two can never drift apart the way two hand-kept variables can.
 *  `window` stays a plain array walked back to front — never a hash-keyed
 *  container — `evictToFit`/`admitToWindow` just stop mutating it in place
 *  and return a new one instead (CQS: query in, new value out). */
interface WindowState {
  readonly window: ReadonlyArray<WindowMember>;
  readonly residentBytes: number;
}

/** Evicts the oldest member (index 0, FIFO) while either bound is violated —
 *  both checks run on every admission. Pure: returns a new `WindowState`,
 *  never mutates `window`. */
function evictToFit(
  window: ReadonlyArray<WindowMember>,
  residentBytes: number,
  policy: DeltaPolicy,
  incomingBytes: number,
): WindowState {
  let members = window;
  let bytes = residentBytes;
  while (members.length > 0 && exceedsCount(members, policy)) {
    bytes -= memberWeight(members[0]!);
    members = members.slice(1);
  }
  while (members.length > 0 && exceedsBudget(bytes, incomingBytes, policy)) {
    bytes -= memberWeight(members[0]!);
    members = members.slice(1);
  }
  return { window: members, residentBytes: bytes };
}

/**
 * Admits `pending` to the window unless it — content PLUS its built index —
 * alone exceeds the whole memory budget: a candidate that large is never
 * admitted, so nothing ever offers it as a base. The index is built here, on
 * admission, and dropped whenever `evictToFit` drops a member. Pure: returns
 * a new `WindowState`, never mutates `window`.
 */
function admitToWindow(
  window: ReadonlyArray<WindowMember>,
  residentBytes: number,
  policy: DeltaPolicy,
  pending: PendingMember,
): WindowState {
  const member: WindowMember = { ...pending, index: createDeltaIndex(pending.content) };
  const memberBytes = memberWeight(member);
  const overBudget = policy.windowMemoryBudget > 0 && memberBytes > policy.windowMemoryBudget;
  if (overBudget) return { window, residentBytes };
  const afterEviction = evictToFit(window, residentBytes, policy, memberBytes);
  return {
    window: [...afterEviction.window, member],
    residentBytes: afterEviction.residentBytes + memberBytes,
  };
}

export async function deltifyEntries(
  ctx: Context,
  objects: ReadonlyArray<PackObjectInput>,
  policy: DeltaPolicy,
): Promise<ReadonlyArray<DeltifiedEntry>> {
  const order = await buildEmissionOrder(ctx, objects);
  let state: WindowState = { window: [], residentBytes: 0 };
  const results: DeltifiedEntry[] = [];
  for (const [emissionIndex, key] of order.entries()) {
    const content = key.content ?? (await readRawObject(ctx, key.id)).content;
    const candidate = selectBestCandidate(
      content,
      state.window,
      key.type,
      policy,
      ctx.hash.digestLength,
    );
    const outcome = await buildDeltifiedEntry(ctx, key.type, content, candidate);
    results.push({ id: key.id, entry: outcome.entry, sourceIndex: key.sourceIndex });
    state = admitToWindow(state.window, state.residentBytes, policy, {
      id: key.id,
      type: key.type,
      chainDepth: outcome.chainDepth,
      content,
      emissionIndex,
    });
  }
  return results;
}

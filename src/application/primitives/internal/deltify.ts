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
  DELTA_ACCEPT_RATIO,
  type DeltaPolicy,
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
import {
  type ObjectMetadataWithContent,
  readObjectMetadataWithContent,
  readRawObject,
} from '../read-object.js';
import { boundedMapFor } from './concurrency.js';

export interface DeltifiedEntry {
  readonly id: ObjectId;
  readonly entry: PackWriterEntry;
}

interface EmissionEntry extends PackEmissionKey {
  readonly id: ObjectId;
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
  oids: ReadonlyArray<ObjectId>,
  metas: ReadonlyArray<ObjectMetadataWithContent>,
  budget: number,
): EmissionEntry[] {
  const entries: EmissionEntry[] = [];
  let carriedBytes = 0;
  for (const [i, id] of oids.entries()) {
    const meta = metas[i]!;
    const key = {
      id,
      type: objectTypeToPackEntryType(meta.type),
      uncompressedSize: meta.uncompressedSize,
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
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<EmissionEntry>> {
  const metas = await boundedMapFor(ctx, 'ioBound', oids, (id) =>
    readObjectMetadataWithContent(ctx, id),
  );
  const keys = boundCarriedContent(oids, metas, ctx.deltaCache.maxSize);
  return [...keys].sort(comparePackEmissionOrder);
}

/**
 * `maxSize` bounds every accepted delta strictly under the incumbent
 * (`best.delta.length - 1`) — `encodeDeltaFromIndex` returns `undefined`
 * for anything that does not fit it — so a hit here is by construction
 * always strictly smaller than `best`. No further length/chain-depth
 * comparison is needed or reachable: the search bound itself forecloses
 * ties, so the policy is exactly "strictly smaller wins; the most
 * recently admitted member breaks anything left" — visit order alone
 * (most-recent-first in `selectBestCandidate`) decides the rest.
 */
function tryCandidate(
  member: WindowMember,
  content: Uint8Array,
  type: BasePackEntryType,
  policy: DeltaPolicy,
  searchBound: number,
  best: Candidate | undefined,
): Candidate | undefined {
  if (member.type !== type || member.chainDepth >= policy.maxDepth) return undefined;
  const maxSize = best === undefined ? searchBound : best.delta.length - 1;
  const delta = encodeDeltaFromIndex(member.index, content, maxSize);
  if (delta === undefined) return undefined;
  return { delta, chainDepth: member.chainDepth, emissionIndex: member.emissionIndex };
}

/** Candidates are tried most-recently-added first — an array walked back to
 *  front, never a hash-keyed container. */
function selectBestCandidate(
  content: Uint8Array,
  window: ReadonlyArray<WindowMember>,
  type: BasePackEntryType,
  policy: DeltaPolicy,
): Candidate | undefined {
  const searchBound = Math.floor(content.length * DELTA_ACCEPT_RATIO);
  let best: Candidate | undefined;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const found = tryCandidate(window[i]!, content, type, policy, searchBound, best);
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
  oids: ReadonlyArray<ObjectId>,
  policy: DeltaPolicy,
): Promise<ReadonlyArray<DeltifiedEntry>> {
  const order = await buildEmissionOrder(ctx, oids);
  let state: WindowState = { window: [], residentBytes: 0 };
  const results: DeltifiedEntry[] = [];
  for (const [emissionIndex, key] of order.entries()) {
    const content = key.content ?? (await readRawObject(ctx, key.id)).content;
    const candidate = selectBestCandidate(content, state.window, key.type, policy);
    const outcome = await buildDeltifiedEntry(ctx, key.type, content, candidate);
    results.push({ id: key.id, entry: outcome.entry });
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

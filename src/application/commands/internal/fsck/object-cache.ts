import { applyGraft } from '../../../../domain/commit/graft.js';
import { decompressFailed, TsgitError } from '../../../../domain/error.js';
import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import type {
  GitObject,
  ObjectId,
  ObjectType,
  TreeEntry,
} from '../../../../domain/objects/index.js';
import { invalidObjectHeader, parseHeader } from '../../../../domain/objects/index.js';
import { MAX_DELTA_CHAIN_DEPTH } from '../../../../domain/storage/delta.js';
import {
  PACK_ENTRY_TYPE,
  packEntryTypeToObjectType,
  parsePackEntryHeader,
} from '../../../../domain/storage/index.js';
import type { Context } from '../../../../ports/context.js';
import { loadShallowSet } from '../../../primitives/internal/shallow-set.js';
import { looseCompressedBytes } from '../../../primitives/object-resolver.js';
import type { PackLookupHit, PackRegistry } from '../../../primitives/pack-registry.js';
import { getPackRegistry, readObject } from '../../../primitives/read-object.js';
import type { UnreadableMode } from './types.js';

// ---------------------------------------------------------------------------
// Object cache — read every universe object exactly once (no hash verification
// here; hash correctness is checked separately in the content-validation pass
// from the raw bytes that pass already reads).
//
// The cache retains a STRUCTURAL PROJECTION, not the whole decoded object:
// `{ type }` plus the out-edge data each downstream pass actually reads
// (commit: tree + grafted parents; tree: entries' id/mode/name; tag: target
// object/type/name). No consumer ever reads a blob's content, so blob
// content is never retained. Peak memory tracks graph metadata (commit/tree/
// tag count) instead of total repository content.
//
// In `'classify'` mode (connectivityOnly), a decode failure additionally
// triggers a probe that re-asks git's own question about the object's STORED
// form: can a `<type> <size>\0` header be recovered from it at all? The
// answer feeds two maps read only at finding-emission time:
// `recovered` upgrades a resolved object's type from 'unknown' to the type
// its header declares; `unrecoverable` is consulted by `assertTypesRecoverable`
// to reject exactly where real git aborts.
// ---------------------------------------------------------------------------

/**
 * The out-edge data each fsck consumer reads for one object type — see the
 * design's traced-consumer table. A blob contributes nothing beyond `type`:
 * content validation reads raw bytes on its own path, never through this
 * cache.
 */
export type ProjectedGitObject =
  | { readonly type: 'blob' }
  | { readonly type: 'tree'; readonly entries: ReadonlyArray<TreeEntry> }
  | {
      readonly type: 'commit';
      readonly tree: ObjectId;
      readonly parents: ReadonlyArray<ObjectId>;
    }
  | {
      readonly type: 'tag';
      readonly object: ObjectId;
      readonly objectType: ObjectType;
      readonly tagName: string;
    };

/** null = unreadable / corrupt object */
export type CachedGitObject = ProjectedGitObject | null;

// One shared, immutable projection for every blob: the variant carries no
// per-object data, and a blob-heavy universe would otherwise retain one
// identical object per blob for the whole command.
const BLOB_PROJECTION: ProjectedGitObject = { type: 'blob' };

/**
 * Reduce a decoded object to the structural projection its fsck consumers
 * read. A switch over the discriminated union, not a default fallthrough —
 * the declared non-nullable `ProjectedGitObject` return type makes a missing
 * variant a compile error (TS2366, "lacks ending return statement"), the
 * same pattern as `git-object.ts`'s `parseObject`/`serializeObject`.
 */
function project(obj: GitObject): ProjectedGitObject {
  switch (obj.type) {
    case 'blob':
      return BLOB_PROJECTION;
    case 'tree':
      return { type: 'tree', entries: obj.entries };
    case 'commit':
      return { type: 'commit', tree: obj.data.tree, parents: obj.data.parents };
    case 'tag':
      return {
        type: 'tag',
        object: obj.data.object,
        objectType: obj.data.objectType,
        tagName: obj.data.tagName,
      };
  }
}

/** The subset of `TsgitErrorData` a header-recovery probe can itself throw. */
type DecodeError = TsgitError & {
  readonly data: {
    readonly code: 'DECOMPRESS_FAILED' | 'INVALID_OBJECT_HEADER';
    readonly reason: string;
  };
};

function isRecoveryCandidate(err: unknown): err is DecodeError {
  return (
    err instanceof TsgitError &&
    (err.data.code === 'DECOMPRESS_FAILED' || err.data.code === 'INVALID_OBJECT_HEADER')
  );
}

/**
 * Codes reachable once an object's bytes are already in hand: the two
 * `isRecoveryCandidate` codes plus every code `parseObject` raises after
 * `parseHeader` has already succeeded. A `Set` membership test, not a `||`
 * chain, so a missing member costs one `ArrayDeclaration` mutant instead of
 * nine `LogicalOperator` operands. It is an allow-list, so it fails toward
 * today: a code missing from it yields 'unknown', never a wrong type and
 * never an abort. Not one member can come from `ctx.fs` — `PERMISSION_DENIED`
 * and `OBJECT_NOT_FOUND` (a refused pack's ids) are outside it structurally.
 */
const RECOVERABLE_DECODE_CODES: ReadonlySet<string> = new Set([
  'DECOMPRESS_FAILED',
  'INVALID_OBJECT_HEADER',
  'INVALID_TREE_ENTRY',
  'INVALID_COMMIT',
  'INVALID_TAG',
  'INVALID_IDENTITY',
  'INVALID_FILE_MODE',
  'INVALID_OBJECT_ID',
  'TREE_ENTRY_LIMIT_EXCEEDED',
]);

function isDecodeFault(err: unknown): boolean {
  return err instanceof TsgitError && RECOVERABLE_DECODE_CODES.has(err.data.code);
}

/**
 * The degrade/propagate policy for every lookup and walk in this file. Only
 * `UNSUPPORTED_OPERATION` (what `mapErrno` folds `EMFILE`, `EIO` and every
 * unnamed errno into) and a non-`TsgitError` (a programming error) propagate
 * — degrading those would report a false integrity verdict under load. Every
 * other `TsgitError` — `PERMISSION_DENIED` included — degrades, because
 * degradation can only coarsen a type label to 'unknown'; it never withholds
 * a finding and never flips a verdict.
 */
// A deferred Tier-A multi-pack-index fault (`pack-int-id`/`large-offset`,
// raised only when one specific entry is decoded) deliberately degrades here
// like any other store fault: git's own parent is BIMODAL on that shape —
// measured both dying at 128 and reporting at 32 on regenerated fixtures,
// depending on whether its walk happens to route the poisoned oid through
// the midx — while its verify child always contains it. tsgit sides with
// the deterministic child shape: the midx-health pass reports the fault as
// `midx-unusable` with exit bit 32 on every run.
function isStoreFault(err: unknown): boolean {
  return err instanceof TsgitError && err.data.code !== 'UNSUPPORTED_OPERATION';
}

async function lookupIfClaimed(
  registry: PackRegistry,
  id: ObjectId,
): Promise<PackLookupHit | undefined> {
  try {
    return await registry.lookup(id);
  } catch (err) {
    if (!isStoreFault(err)) throw err;
    return undefined;
  }
}

type TypedOrUntyped =
  | { readonly kind: 'typed'; readonly objectType: FsckObjectType }
  | { readonly kind: 'untyped' };

type RecoveryOutcome =
  | TypedOrUntyped
  | { readonly kind: 'unrecoverable'; readonly cause: DecodeError };

/** Bound for a pack entry header probe: 1 type/size byte + up to 5
 * size-extension bytes + max(5 OFS-distance continuation bytes, a 32-byte
 * SHA-256 REF_DELTA base id) — 38 bytes for either hash width, rounded up. */
const ENTRY_HEADER_PROBE_BYTES = 64;

function untypedFault(ctx: Context, id: ObjectId, reason: string): TypedOrUntyped {
  ctx.logger?.warn?.('fsck: stored type probe degraded', { objectId: id, reason });
  return { kind: 'untyped' };
}

/**
 * Read the type from a pack entry header at `hit`, following `OFS_DELTA` /
 * `REF_DELTA` base links through entry headers only — it never inflates a
 * body, which is why a corrupt delta body still types (R13). Reached from
 * two places (arm 2: not loose at all; arm 3: loose but header-unrecoverable
 * with a healthy packed twin) — one code path, one function. This never
 * rejects on store damage: a corrupt entry header, an unreadable slice, or an
 * unresolvable base degrades to 'untyped', because a packed object's
 * stored-type recovery can only improve a report, never abort one — retention
 * is monotone. Environmental faults propagate (`isStoreFault`).
 */
async function typeFromEntry(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  hit: PackLookupHit,
): Promise<TypedOrUntyped> {
  try {
    return await walkDeltaChain(ctx, registry, id, hit);
  } catch (err) {
    if (!isStoreFault(err)) throw err;
    return untypedFault(ctx, id, 'pack entry unreadable');
  }
}

async function walkDeltaChain(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  hit: PackLookupHit,
): Promise<TypedOrUntyped> {
  let currentHit = hit;
  for (let depth = 0; depth < MAX_DELTA_CHAIN_DEPTH; depth += 1) {
    const chunk = await currentHit.pack.readSlice(currentHit.offset, ENTRY_HEADER_PROBE_BYTES);
    const header = parsePackEntryHeader(chunk, 0, ctx.hashConfig);

    if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      const baseOffset = currentHit.offset - header.baseDistance;
      if (baseOffset < 0) return untypedFault(ctx, id, 'OFS_DELTA base offset out of range');
      currentHit = { pack: currentHit.pack, offset: baseOffset };
      continue;
    }
    if (header.type === PACK_ENTRY_TYPE.REF_DELTA) {
      const nextHit = await registry.lookup(header.baseId);
      if (nextHit === undefined) {
        return untypedFault(ctx, id, 'REF_DELTA base not claimed by any accessible pack');
      }
      currentHit = nextHit;
      continue;
    }

    return { kind: 'typed', objectType: packEntryTypeToObjectType(header.type) };
  }
  return untypedFault(ctx, id, 'delta chain exceeds max depth');
}

/**
 * Arm 2: the object is not loose at all, so the read that failed was a pack
 * read. Types from the pack entry the registry claims for `id` — never
 * rejects (see `typeFromEntry`'s doc-comment).
 */
async function packedStoredType(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
): Promise<TypedOrUntyped> {
  const hit = await lookupIfClaimed(registry, id);
  if (hit === undefined) {
    return untypedFault(ctx, id, 'not loose and claimed by no accessible pack');
  }
  return await typeFromEntry(ctx, registry, id, hit);
}

/**
 * Re-asks git's own question about an object's STORED form: can a
 * `<type> <size>\0` header be recovered from it? Deliberately uses
 * `parseHeader`, NOT `splitObject` — `splitObject`'s size-mismatch check
 * would abort a row git resolves (a header that parsed perfectly, with a
 * body shorter or longer than declared).
 */
async function recoverStoredType(
  ctx: Context,
  id: ObjectId,
  readErr: unknown,
): Promise<RecoveryOutcome> {
  const registry = getPackRegistry(ctx);
  const looseBytes = await looseCompressedBytes(ctx, id);
  if (looseBytes === undefined) {
    return await packedStoredType(ctx, registry, id);
  }
  if (looseBytes.length === 0) {
    // Git treats an empty file as one it could not read, not one whose type
    // it failed to recover — same reserved 'unknown' verdict as Part 4.
    return { kind: 'untyped' };
  }
  try {
    const { type } = parseHeader(await ctx.compressor.inflate(looseBytes));
    return { kind: 'typed', objectType: type };
  } catch (probeErr) {
    // Narrow: a file that changed under the probe (or any other unrecognised
    // fault, e.g. UNSUPPORTED_OPERATION) surfaces its own fault instead of
    // being laundered into an abort.
    if (!isRecoveryCandidate(probeErr)) throw probeErr;
    const hit = await lookupIfClaimed(registry, id);
    if (hit === undefined) {
      // The reject verdict is gated on the ORIGINAL read failure, not the
      // probe's — the settled two-code test; the cause keeps the store's own
      // code. A file whose damage class changed under the probe stays a
      // tolerated 'unknown'.
      if (isRecoveryCandidate(readErr)) return { kind: 'unrecoverable', cause: readErr };
      return { kind: 'untyped' };
    }
    return await typeFromEntry(ctx, registry, id, hit);
  }
}

export interface ObjectCacheResult {
  readonly cache: ReadonlyMap<ObjectId, CachedGitObject>;
  /** oid → the fault that made its stored type unrecoverable. Empty unless 'classify'. */
  readonly unrecoverable: ReadonlyMap<ObjectId, DecodeError>;
  /** oid → the type its stored header declares, when the body would not parse. Empty unless 'classify'. */
  readonly recovered: ReadonlyMap<ObjectId, FsckObjectType>;
}

interface CacheAccumulator {
  readonly cache: Map<ObjectId, CachedGitObject>;
  readonly unrecoverable: Map<ObjectId, DecodeError>;
  readonly recovered: Map<ObjectId, FsckObjectType>;
}

/**
 * Records a universe object's unreadable slot and, in `'classify'` mode, runs
 * the header-recovery probe: its `typed` outcome upgrades `recovered`, its
 * `unrecoverable` outcome records the cause `fsck.ts` rejects on once
 * reachability is known.
 */
async function recordUnreadable(
  ctx: Context,
  id: ObjectId,
  err: unknown,
  unreadable: UnreadableMode,
  acc: CacheAccumulator,
): Promise<void> {
  acc.cache.set(id, null);
  if (unreadable !== 'classify' || !isDecodeFault(err)) return;
  const recovery = await recoverStoredType(ctx, id, err);
  if (recovery.kind === 'typed') acc.recovered.set(id, recovery.objectType);
  if (recovery.kind === 'unrecoverable') acc.unrecoverable.set(id, recovery.cause);
}

/**
 * Build a map of all universe OIDs to their parsed GitObject (or null when
 * the object cannot be read). Every later pass consumes this map instead of
 * issuing redundant readObject calls.
 */
export async function buildObjectCache(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  unreadable: UnreadableMode,
): Promise<ObjectCacheResult> {
  const acc: CacheAccumulator = {
    cache: new Map(),
    unrecoverable: new Map(),
    recovered: new Map(),
  };
  const shallow = await loadShallowSet(ctx);
  for (const id of universe) {
    try {
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — verifyHash defaults true; any hash-verification throw is caught → stored as null, same as with verifyHash:false.
      const obj = await readObject(ctx, id, { verifyHash: false });
      const grafted = obj.type === 'commit' ? applyGraft(obj, shallow) : obj;
      acc.cache.set(id, project(grafted));
    } catch (err) {
      await recordUnreadable(ctx, id, err, unreadable, acc);
    }
  }
  return acc;
}

const MAX_REASON_LENGTH = 200;

/**
 * A reject reason can embed attacker-chosen bytes (an object header's type
 * and size fields are raw store bytes), and it reaches the thrown error's
 * message with no other sanitiser on the way. Allow-list, mirroring the
 * display sanitiser's variable-width `\xHH…` convention (not reversible —
 * the value is diagnostic, never canonical) but stricter: printable ASCII
 * survives, everything else — tab, newline, C1 controls, bidi overrides —
 * is hex-escaped. Iterates the string lazily by code point (never splits a
 * surrogate, never materialises the input) and bounds the OUTPUT at
 * `MAX_REASON_LENGTH` ASCII units, so both the work done and the string
 * emitted are capped regardless of the input's size or escape expansion.
 */
function sanitizeReason(reason: string): string {
  let out = '';
  for (const ch of reason) {
    const code = ch.codePointAt(0) ?? 0;
    const piece =
      code >= 0x20 && code <= 0x7e ? ch : `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    if (out.length + piece.length > MAX_REASON_LENGTH) break;
    out += piece;
  }
  return out;
}

/**
 * Reject with the store's own error CODE — rebuilt with a sanitised reason,
 * same class — at the first unreachable id whose stored type could not be
 * recovered: git's `die()`, exit 128, empty stdout, every finding withheld.
 * Iterates `unreachable` (git's `check_unreachable_object` domain), never
 * `dangling` (its in-edge-free subset, which would silently pass a
 * referenced-but-unreachable object).
 */
export function assertTypesRecoverable(
  ctx: Context,
  unreachable: ReadonlyArray<ObjectId>,
  unrecoverable: ReadonlyMap<ObjectId, DecodeError>,
): void {
  for (const id of unreachable) {
    const cause = unrecoverable.get(id);
    if (cause === undefined) continue;
    const reason = sanitizeReason(cause.data.reason);
    ctx.logger?.warn?.('fsck: object type unrecoverable', {
      objectId: id,
      code: cause.data.code,
      reason,
    });
    // Same class and code as the store's own error — only the
    // attacker-influenced reason is sanitised on its way across the boundary.
    throw cause.data.code === 'DECOMPRESS_FAILED'
      ? decompressFailed(reason)
      : invalidObjectHeader(reason);
  }
}

/**
 * pack-fetch primitive. Shared between clone (12.1) and the
 * forthcoming fetch (12.2) / push (12.3) commands.
 *
 * Performs the `git-upload-pack` POST and streams the side-banded response
 * straight to a quarantine file (`objects/pack/tmp_pack_<random>`), bounded
 * by `config.maxResponseBytes` and hashed incrementally as bytes arrive —
 * the whole pack is never held in memory at once. Once the trailer verifies
 * against the incrementally-computed digest, the quarantine file is renamed
 * to `pack-<sha>.pack` and its `.idx`/`.rev` siblings are written — exactly
 * git's own on-disk shape for a received pack.
 *
 * Out of scope here (handled by callers): URL validation, capability
 * negotiation, ref-update propagation.
 */
import { fileExists, TsgitError } from '../../domain/error.js';
import { bytesToHex } from '../../domain/objects/encoding.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import {
  applyDelta,
  type BasePackEntryHeader,
  crc32,
  invalidPackEntry,
  invalidPackHeader,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  type PackHeader,
  parsePackEntryHeader,
  parsePackHeader,
} from '../../domain/storage/index.js';
import type { InflateStreamResult } from '../../ports/compressor.js';
import type { Context } from '../../ports/context.js';
import { errorDataCode } from './internal/error-data-code.js';
import { packFilePath, writePackSiblingArtifacts } from './internal/write-pack-artifacts.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { refreshPackRegistry } from './read-object.js';

/**
 * Resolves an object referenced by a REF_DELTA whose base is absent from the
 * pack being walked. Used by `bundle verify` to complete thin packs against
 * the local object store. Return `undefined` when the base is not available;
 * the caller will treat the delta as unresolvable.
 */
export type ExternalBaseResolver = (
  baseOid: ObjectId,
) => Promise<
  { readonly type: 'commit' | 'tree' | 'blob' | 'tag'; readonly content: Uint8Array } | undefined
>;

const TEXT_ENCODER = new TextEncoder();
const PACK_HEADER_BYTES = 12;
const SIDE_BAND_CAPS: ReadonlySet<string> = new Set(['side-band-64k', 'side-band']);
const PROGRESS_TICK_BYTES = 65_536;
/** git's own quarantine prefix: `objects/pack/tmp_pack_<6 random chars>`. */
const TMP_PACK_PREFIX = 'tmp_pack_';
const TMP_PACK_SUFFIX_LENGTH = 6;
const TMP_PACK_SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/**
 * Default cap on the pack body size, applied when `ctx.config?.maxResponseBytes`
 * is not set. Matches the bound documented in.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
/**
 * Default cap on the entry count declared in the pack header. The 32-bit
 * field is server-controlled; without an explicit ceiling, a malicious server
 * could declare 2^32 entries and drive `walkPackEntries` into a DoS loop even
 * though the pack body itself is bounded by `maxResponseBytes`. Matches the
 * order of magnitude beyond which canonical git refuses to operate. Callers
 * can tighten the limit via `ctx.config?.maxObjectsPerPack`.
 */
const DEFAULT_MAX_OBJECT_COUNT = 50_000_000;

export interface FetchPackInput {
  /** Advertised refs the caller wants. MUST be non-empty (server-side requirement). */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Objects the caller already has (negotiation). Empty for clone, populated for fetch. */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Negotiated capabilities (intersection of advertised + supported). */
  readonly capabilities: ReadonlyArray<string>;
  /** Progress op label — clone uses 'clone:write-objects', fetch uses 'fetch:write-objects'. */
  readonly progressOp: string;
  /**
   * Shallow clone depth. When set, sends `deepen N` and consumes the
   * accompanying `shallow <oid>` / `unshallow <oid>` response block.
   *
   */
  readonly depth?: number;
  /**
   * Partial-clone object filter — a canonical filter spec. When set, a
   * `filter` line is emitted; the caller must have negotiated the `filter`
   * capability.
   */
  readonly filter?: string;
  /**
   * When true, write an empty `pack-<sha>.promisor` sentinel beside the pack
   * so the objects it references but omits are treated as promised.
   */
  readonly promisor?: boolean;
}

export interface FetchPackResult {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  /** Hex-encoded SHA of the pack trailer; also the on-disk filename stem. */
  readonly packSha: string;
  /** Commits the server advertised as new shallow boundaries (empty when depth is unset). */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits the server advertised as no-longer-shallow (empty when depth is unset). */
  readonly unshallow: ReadonlyArray<ObjectId>;
}

export interface PackDownload {
  /** The raw sideband pack body, not yet drained — the receive side streams
   *  it straight to a quarantine file rather than buffering it. */
  readonly packBody: AsyncIterable<Uint8Array>;
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

/**
 * Negotiates and drains the pack body for one `fetchPack` call. Callers bind
 * the wire version and the transport session into this closure — `fetchPack`
 * itself stays version-agnostic, matching every other caller of the shared
 * `PackDownload` shape.
 */
export type NegotiatePackBytes = (ctx: Context, input: FetchPackInput) => Promise<PackDownload>;

export const fetchPack = async (
  ctx: Context,
  negotiatePackBytes: NegotiatePackBytes,
  input: FetchPackInput,
): Promise<FetchPackResult> => {
  ctx.progress.start(input.progressOp);
  try {
    const download = await downloadPack(ctx, negotiatePackBytes, input);
    return await materializePack(ctx, download, input);
  } finally {
    ctx.progress.end(input.progressOp);
  }
};

const emptyPackResult = (
  shallow: ReadonlyArray<ObjectId>,
  unshallow: ReadonlyArray<ObjectId>,
): FetchPackResult => ({
  packPath: '',
  idxPath: '',
  objectCount: 0,
  packSha: '',
  shallow,
  unshallow,
});

/**
 * Post-download tail: stream the pack into quarantine, verify the trailer,
 * walk entries, then either suppress or promote it (rename + sibling
 * artefacts). Split out of `fetchPack` so the negotiated response can be
 * fully verified (trailer + entry walk) before deciding whether it is
 * empty — a malformed pack that merely *looks* empty (bad trailer,
 * truncated entries) must still throw, never be silently dropped.
 */
const materializePack = async (
  ctx: Context,
  download: PackDownload,
  input: FetchPackInput,
): Promise<FetchPackResult> => {
  const packDir = packsDir(commonGitDir(ctx));
  const receipt = await receivePackToQuarantine(ctx, input, packDir, download.packBody);
  // git-upload-pack returns a zero-byte body when the client's `have` set
  // already covers every wanted oid. This is a legitimate protocol state
  // (the server has nothing to send), not an error. Surface it as an
  // empty result so the caller can advance refs and return cleanly.
  if (receipt.totalBytes === 0) {
    return emptyPackResult(download.shallow, download.unshallow);
  }
  const entries = await walkQuarantinedEntries(ctx, receipt.tmpPath, receipt.totalBytes);
  // A verified pack can legitimately carry zero entries (e.g. the negotiated
  // response round-tripped a pack rather than a zero-byte body). Suppress
  // promoting it, same as the zero-byte-body guard above.
  if (entries.length === 0) {
    await cleanupQuarantine(ctx, receipt.tmpPath);
    return emptyPackResult(download.shallow, download.unshallow);
  }
  try {
    await renamePackIntoPlace(ctx, receipt.tmpPath, packFilePath(packDir, receipt.packSha));
  } catch (err) {
    // A rename failure leaves the verified quarantine file behind unless
    // cleaned up here — nothing later in this function gets a chance to.
    await cleanupQuarantine(ctx, receipt.tmpPath);
    throw err;
  }
  const written = await writePackSiblingArtifacts(ctx, {
    packDir,
    entries,
    packSha: receipt.packSha,
    promisor: input.promisor === true,
  });
  // Drop the per-Context pack-registry cache so reads through this same
  // handle (e.g. a follow-up merge in `pull`) see the just-written pack.
  refreshPackRegistry(ctx);
  return {
    packPath: written.packPath,
    idxPath: written.idxPath,
    objectCount: written.objectCount,
    packSha: written.packSha,
    shallow: download.shallow,
    unshallow: download.unshallow,
  };
};

/** Reads the quarantined pack back from disk (it was never resident in
 *  memory during receive) and walks its entries through `diskPackByteSource`
 *  — the same `inflateAllEntries`/`resolveAllEntries` pipeline `walkPackEntries`
 *  uses, fed by bounded `readSlice` windows instead of one whole-pack buffer.
 *  Failures here mean the body is malformed even though its trailer
 *  verified, so the quarantine file is cleaned up before rethrow. */
const walkQuarantinedEntries = async (
  ctx: Context,
  tmpPath: string,
  totalBytes: number,
): Promise<ReadonlyArray<WalkedEntry>> => {
  try {
    const pending = await inflateAllEntries(ctx, diskPackByteSource(ctx, tmpPath, totalBytes));
    return await walkFromPending(ctx, pending);
  } catch (err) {
    // The read-back is inside this try alongside the walk itself — a
    // failure reading the just-written quarantine file back off disk must
    // reap the temp file exactly like a malformed-body failure does, not
    // leak it because the read happened to fail before the walk started.
    await cleanupQuarantine(ctx, tmpPath);
    throw err;
  }
};

/**
 * Thin adapter boundary: `fetchPack` stays version-agnostic, the injected
 * `negotiatePackBytes` (bound to a wire version + transport session by the
 * caller) does the actual request/response work.
 */
const downloadPack = async (
  ctx: Context,
  negotiatePackBytes: NegotiatePackBytes,
  input: FetchPackInput,
): Promise<PackDownload> => negotiatePackBytes(ctx, input);

/** Random 6-character suffix in git's own `tmp_pack_XXXXXX` shape. Not
 *  security-sensitive (the containing directory is already trusted), so
 *  `Math.random` matches this codebase's other non-cryptographic tokens
 *  (e.g. `reftable-transaction.ts`'s lock retry jitter). */
const randomTmpPackName = (): string => {
  let suffix = '';
  for (let i = 0; i < TMP_PACK_SUFFIX_LENGTH; i += 1) {
    suffix += TMP_PACK_SUFFIX_ALPHABET[Math.floor(Math.random() * TMP_PACK_SUFFIX_ALPHABET.length)];
  }
  return `${TMP_PACK_PREFIX}${suffix}`;
};

/** Bounds `claimQuarantinePath`'s retry loop — a collision on every one of
 *  this many independently-drawn 6-character suffixes is astronomically
 *  unlikely; this is a defence-in-depth ceiling, not an expected path. */
const MAX_QUARANTINE_NAME_ATTEMPTS = 8;

/**
 * Claims a unique quarantine path via an exclusive create, retrying with a
 * fresh random suffix on a name collision — git's own `mkstemp` gives the
 * same guarantee for free; `writeStream` has no exclusive-create option, so
 * claiming the name here, before the streaming write starts, is what keeps
 * a same-name collision from silently clobbering another in-flight
 * quarantine write. The claimed (empty) placeholder is immediately
 * overwritten in place by the caller's streaming write to the same path.
 */
const claimQuarantinePath = async (ctx: Context, packDir: string): Promise<string> => {
  for (let attempt = 0; attempt < MAX_QUARANTINE_NAME_ATTEMPTS; attempt += 1) {
    const candidate = `${packDir}/${randomTmpPackName()}`;
    try {
      await ctx.fs.writeExclusive(candidate, new Uint8Array(0));
      return candidate;
    } catch (err) {
      if (errorDataCode(err) !== 'FILE_EXISTS') throw err;
    }
  }
  throw fileExists(`${packDir}/${TMP_PACK_PREFIX}<random>`);
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * Best-effort removal of a quarantine file: `ctx.fs.rm` is not idempotent
 * (it throws `FILE_NOT_FOUND` on a missing path), so a cleanup racing an
 * already-completed rename — or a second cleanup attempt — must swallow
 * exactly that code and rethrow everything else. A blanket `catch {}` would
 * hide a real fault (e.g. permission denied) behind a silent no-op.
 *
 * Empirically confirmed: killing the *server* side of a real clone mid-stream
 * (a handled failure on the client, not a hard kill) never leaves a stray
 * temp pack behind — git's own clone command removes the whole destination
 * it was creating on that path. This unlink gives the same "no stray pack
 * debris after a handled failure" outcome for callers (fetch/pull against an
 * existing repository) where wiping the whole repo on failure would be wrong.
 */
const removeQuarantineFileIfPresent = async (ctx: Context, path: string): Promise<void> => {
  try {
    await ctx.fs.rm(path);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return;
    throw err;
  }
};

/**
 * A quarantine unlink on a handled-failure path is best-effort — it must
 * never be able to REPLACE the diagnosis it was cleaning up after. Every
 * failure call site in this file sits inside a `catch`/early-return about
 * to surface (or having just surfaced) the real error — trailer mismatch,
 * PACK_TOO_LARGE, a malformed body — so a *second*, unrelated failure right
 * here (e.g. PERMISSION_DENIED unlinking the temp file) swallows silently
 * rather than masking that original diagnosis. `removeQuarantineFileIfPresent`
 * itself stays selective (FILE_NOT_FOUND only) rather than a blanket catch,
 * so any future caller that DOES need to observe a genuine cleanup fault
 * still can.
 */
const cleanupQuarantine = (ctx: Context, path: string): Promise<void> =>
  removeQuarantineFileIfPresent(ctx, path).catch(() => {});

/** Renames a verified quarantine file into its final `pack-<sha>.pack` name. */
const renamePackIntoPlace = async (
  ctx: Context,
  tmpPath: string,
  finalPath: string,
): Promise<void> => {
  await ctx.fs.rename(tmpPath, finalPath);
};

interface QuarantineReceipt {
  readonly tmpPath: string;
  /** Total bytes streamed. Zero means a legitimate empty pack body — no
   *  quarantine file survives this case, matching the pre-streaming
   *  zero-byte-body guard. */
  readonly totalBytes: number;
  /** Empty when `totalBytes` is zero (there is no trailer to hash). */
  readonly packSha: string;
}

/**
 * Streams `source` straight into `objects/pack/tmp_pack_<random>`, hashing
 * the trailer incrementally as bytes arrive — the whole pack is never held
 * in memory at once. The last `ctx.hash.digestLength` bytes are withheld
 * from the hasher behind a small sliding tail buffer until the stream ends
 * (only then is it known which bytes are the trailer rather than body), so
 * the retained state stays bounded by one chunk plus the digest width,
 * never by the pack's total size. Verification happens here, against the
 * incrementally-computed digest, before the caller ever sees a path to
 * rename — "the trailer-verify-before-trust refusal must fire before any
 * object becomes readable".
 */
const receivePackToQuarantine = async (
  ctx: Context,
  input: FetchPackInput,
  packDir: string,
  source: AsyncIterable<Uint8Array>,
): Promise<QuarantineReceipt> => {
  const cap = ctx.config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const trailerLen = ctx.hash.digestLength;
  const hasher = ctx.hash.createHasher();
  const tmpPath = await claimQuarantinePath(ctx, packDir);
  let total = 0;
  let lastTick = 0;
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  async function* tee(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      total += chunk.byteLength;
      if (total > cap) throw packTooLargeBytes(cap);
      const combined = concatBytes(tail, chunk);
      if (combined.length > trailerLen) {
        const boundary = combined.length - trailerLen;
        hasher.update(combined.subarray(0, boundary));
        tail = combined.slice(boundary);
      } else {
        tail = combined;
      }
      if (total - lastTick >= PROGRESS_TICK_BYTES) {
        ctx.progress.update(input.progressOp, total);
        lastTick = total;
      }
      yield chunk;
    }
  }

  try {
    await ctx.fs.writeStream(tmpPath, tee());
  } catch (err) {
    await cleanupQuarantine(ctx, tmpPath);
    throw err;
  }

  // Stryker disable next-line ConditionalExpression: equivalent — when `total === 0` no chunk was consumed so `lastTick` is also 0, making `tailUnticked` false; forcing `sawProgress` true cannot change the AND result.
  const sawProgress = total !== 0;
  const tailUnticked = total !== lastTick;
  if (sawProgress && tailUnticked) {
    ctx.progress.update(input.progressOp, total);
  }

  if (total === 0) {
    await cleanupQuarantine(ctx, tmpPath);
    return { tmpPath, totalBytes: 0, packSha: '' };
  }
  if (total < PACK_HEADER_BYTES + trailerLen) {
    await cleanupQuarantine(ctx, tmpPath);
    throw invalidPackHeader('trailer mismatch: pack too short for header + trailer');
  }

  const expectedHex = await hasher.digestHex();
  const actualHex = bytesToHex(tail);
  if (expectedHex !== actualHex) {
    await cleanupQuarantine(ctx, tmpPath);
    throw invalidPackHeader(`trailer mismatch: expected ${expectedHex}, got ${actualHex}`);
  }

  return { tmpPath, totalBytes: total, packSha: expectedHex };
};

/**
 * Raise `PACK_TOO_LARGE` for a byte-cap overrun. The existing variant carries
 * `objectCount`, which we set to 0 here because the cap is enforced before any
 * entry is parsed — the message text is informational for byte-cap callers;
 * `data.limit` is the byte cap that was exceeded.
 */
const packTooLargeBytes = (limit: number): TsgitError =>
  new TsgitError({ code: 'PACK_TOO_LARGE', objectCount: 0, limit });

export const hasSideBand = (caps: ReadonlyArray<string>): boolean =>
  caps.some((c) => SIDE_BAND_CAPS.has(c));

export const verifyPackTrailer = async (packBytes: Uint8Array, ctx: Context): Promise<string> => {
  const trailerLen = ctx.hash.digestLength;
  if (packBytes.length < PACK_HEADER_BYTES + trailerLen) {
    throw invalidPackHeader('trailer mismatch: pack too short for header + trailer');
  }
  const bodyEnd = packBytes.length - trailerLen;
  const body = packBytes.subarray(0, bodyEnd);
  const trailerBytes = packBytes.subarray(bodyEnd);
  const expectedHex = await ctx.hash.hashHex(body);
  const actualHex = bytesToHex(trailerBytes);
  if (expectedHex !== actualHex) {
    throw invalidPackHeader(`trailer mismatch: expected ${expectedHex}, got ${actualHex}`);
  }
  return expectedHex;
};

interface WalkedEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

type BaseTypeName = 'commit' | 'tree' | 'blob' | 'tag';

interface PendingEntry {
  readonly offset: number;
  readonly header: PackEntryHeader;
  readonly inflated: Uint8Array;
  readonly crc32: number;
}

interface ResolvedEntry {
  readonly id: string;
  readonly type: BaseTypeName;
  readonly content: Uint8Array;
  readonly crc32: number;
  readonly offset: number;
}

/**
 * Byte-source seam for `inflateAllEntries`' sequential entry walk: reads
 * either an already-resident pack buffer (`inMemoryPackByteSource` — every
 * existing `walkPackEntries` caller: `bundle-verify.ts`, in-memory fetch
 * paths, unchanged) or the quarantined pack file on disk in bounded windows
 * (`diskPackByteSource` — `walkQuarantinedEntries`). Both report entry data
 * through this one shape so the walk loop below is written once and behaves
 * identically over either source.
 *
 * `TCrcContext` lets a source thread whatever it needs from `inflateEntry`
 * into the matching `entryCrc32` call as an ordinary parameter, instead of
 * the caller trusting an undocumented "these two calls happen in this order"
 * invariant enforced only by a shared mutable variable. The in-memory source
 * has nothing to thread (`undefined`); the disk source threads the window
 * `inflateEntry` actually read from.
 */
interface PackByteSource<TCrcContext = undefined> {
  readonly totalBytes: number;
  /** Parses the 12-byte pack header. */
  header(): Promise<PackHeader>;
  /** Parses the entry header starting at `offset`. */
  entryHeader(offset: number): Promise<PackEntryHeader>;
  /**
   * Inflates the zlib stream starting at `dataOffset`. `declaredSize` — the
   * entry header's own declared output length — is passed through so a
   * source can bound the inflate to it; every source does, since every
   * conformant entry inflates to exactly this many bytes, so the bound costs
   * nothing on a valid pack and stops a mismatched stream at the declared
   * size rather than the adapter's much larger default cap. `offset` (the
   * entry's own start) is also given — the disk source anchors its read
   * window there rather than at `dataOffset`, so the window that ends up
   * satisfying inflation also covers the entry's header bytes, letting
   * `entryCrc32` read the whole `[offset, entryEnd)` range back with no
   * further I/O. Returns the inflate result alongside whatever `crcContext`
   * the matching `entryCrc32` call needs.
   */
  inflateEntry(
    offset: number,
    dataOffset: number,
    declaredSize: number,
  ): Promise<{ readonly result: InflateStreamResult; readonly crcContext: TCrcContext }>;
  /** CRC32 over the raw entry bytes `[offset, entryEnd)`. Always called
   *  immediately after `inflateEntry` has resolved that same range, with
   *  the `crcContext` that call returned. */
  entryCrc32(offset: number, entryEnd: number, crcContext: TCrcContext): Promise<number>;
}

/** Wraps an already-resident pack buffer — the shape every existing
 *  `walkPackEntries` caller already provides. No windowing: the buffer IS
 *  the whole pack, exactly as before this change. */
const inMemoryPackByteSource = (ctx: Context, packBytes: Uint8Array): PackByteSource => ({
  totalBytes: packBytes.length,
  header: async () => parsePackHeader(packBytes),
  entryHeader: async (offset) => parsePackEntryHeader(packBytes, offset, ctx.hashConfig),
  inflateEntry: async (_offset, dataOffset, declaredSize) => ({
    result: await ctx.compressor.streamInflate(packBytes, dataOffset, declaredSize),
    crcContext: undefined,
  }),
  entryCrc32: async (offset, entryEnd) => crc32(packBytes.subarray(offset, entryEnd)),
});

/**
 * Bounded read window for walking the quarantined pack back off disk
 * (`diskPackByteSource`). The receive path streams the pack to the
 * quarantine file without ever holding it whole in memory (see the module
 * doc comment); reading it back for the entry walk must keep that same
 * bound rather than reintroducing a whole-pack buffer. 256 KiB is large
 * enough that a typical object's header plus compressed data (commits and
 * trees run a few KB; most blobs too) is satisfied by a single `readSlice`
 * call, small enough that RSS stays flat no matter how large the pack is.
 * On a valid pack this is also the peak: every window growth restarts its
 * doubling ladder from this size, anchored fresh at the entry that needed
 * it, so an entry whose compressed span exceeds one window still resolves
 * correctly with a peak single read of at most that one entry's own
 * compressed span (rounded up to the next doubling, never past
 * `trailerStart`) — never the whole pack, and never inflated by an
 * unrelated entry's earlier growth.
 */
export const DISK_WALK_WINDOW_BYTES = 256 * 1024;

interface DiskWindow {
  readonly start: number;
  readonly bytes: Uint8Array;
}

/**
 * Reads an error's `data.reason` structurally, mirroring `errorDataCode`
 * (`./internal/error-data-code.js`) — a mixed-module-graph harness gives the
 * adapter's `TsgitError` a different class identity than this module's, so
 * `instanceof` can't be trusted; the `data` shape is the stable contract.
 */
const errorDataReason = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { readonly data?: { readonly reason?: unknown } }).data;
  return typeof data?.reason === 'string' ? data.reason : undefined;
};

/**
 * The decompress failure reason that means "the window ended before the
 * entry's zlib stream did" — worth a bigger window. Every adapter's decoder
 * is normalized to raise this exact reason for premature end of input: the
 * zero-dependency decoder (memory/browser adapters, `inflateZlibMember`)
 * raises it directly, and `NodeCompressor.streamInflate` classifies node:zlib's
 * `Z_BUF_ERROR` structurally and re-emits this same string rather than the
 * one node itself uses — node's wording is node's to change, not a contract
 * this module can pin against. Every other decode failure (bad huffman
 * codes, an out-of-range back-reference, a checksum mismatch, the
 * inflated-output safety cap) means the bytes already read are already
 * enough to prove the entry invalid — retrying would only redo the same
 * failing decode against a needlessly larger read, or, for the safety cap,
 * redo the very inflate work the cap exists to cut short. This reason is
 * itself ambiguous — a corrupted length or code table can walk a decoder
 * off the end of a genuinely well-sized window exactly the way a real
 * truncation does — but retrying stays bounded by `trailerStart`, so the
 * worst case is a few extra bounded re-reads, never an unbounded one.
 */
const RETRYABLE_DECOMPRESS_REASON = 'unexpected end of deflate stream';

/** Entry-header parse failures sharing this prefix (`decodeTypeAndSize`,
 *  `decodeOfsDistance`, the REF_DELTA base-id read — see `pack-entry.ts`)
 *  all mean a varint or fixed-width field ran off the end of the bytes it
 *  was given: the same window-too-small shape as the decompress case above.
 *  A reserved/unknown type byte or an over-long size/distance encoding
 *  reports a *different* reason — those are read from bytes that WERE
 *  present, so they are never window-sizing artifacts. */
const RETRYABLE_ENTRY_HEADER_REASON_PREFIX = 'unexpected end of';

/** Whether `w` already IS a fresh window anchored exactly at `anchor`, sized
 *  to the documented window — i.e. growth's next rung must double past it
 *  rather than re-fetch the identical bytes. Any other window (in
 *  particular a REUSED one, started earlier than `anchor`) has not yet had
 *  the documented size tried from `anchor` itself. */
const isFreshDocumentedWindow = (w: DiskWindow, anchor: number, documented: number): boolean =>
  w.start === anchor && w.bytes.length === documented;

/** Whether `w` was itself delivered by a fetch anchored exactly at `anchor`
 *  — as opposed to a REUSED window carried over from an earlier, smaller
 *  offset. Only a window satisfying this has a length that means anything
 *  as a "what did the last fetch AT THIS ANCHOR deliver" baseline. */
const isAnchoredHere = (w: DiskWindow, anchor: number): boolean => w.start === anchor;

const isRetryableWindowFailure = (err: unknown): boolean => {
  const reason = errorDataReason(err);
  if (reason === undefined) return false;
  switch (errorDataCode(err)) {
    case 'INVALID_PACK_ENTRY':
      return reason.startsWith(RETRYABLE_ENTRY_HEADER_REASON_PREFIX);
    case 'DECOMPRESS_FAILED':
      return reason === RETRYABLE_DECOMPRESS_REASON;
    default:
      return false;
  }
};

/**
 * `parsePackEntryHeader` reports `INVALID_PACK_ENTRY.data.offset` as
 * whatever offset it was called with — here, `offset - windowStart`,
 * relative to the currently-held window rather than the pack. Every other
 * offset this module reports (and the in-memory source, where `offset`
 * already IS absolute) is pack-absolute, so the window-relative value is
 * corrected back to absolute before the error can leave this source.
 * Errors of any other shape pass through unchanged.
 */
const withAbsoluteEntryOffset = (err: unknown, windowStart: number): unknown => {
  if (errorDataCode(err) !== 'INVALID_PACK_ENTRY') return err;
  const data = (err as { readonly data: { readonly offset: number; readonly reason: string } })
    .data;
  return invalidPackEntry(data.offset + windowStart, data.reason);
};

/**
 * Reads the quarantine file at `tmpPath` in bounded `DISK_WALK_WINDOW_BYTES`
 * windows, sliding forward as `inflateAllEntries` walks entries in strictly
 * increasing offset order (per the receive-path contract: header parse at
 * `offset`, zlib stream from `dataOffset`, `bytesConsumed` advances to
 * `entryEnd`). A window is reused across entries whenever the next entry's
 * start already falls inside it — the common case, since most objects are
 * far smaller than the window.
 *
 * When a header parse or a compressed stream turns out to straddle or
 * exceed the window currently held, `withGrowth` retries — but only for
 * failures `isRetryableWindowFailure` recognises as "ran off the end of the
 * bytes available", and always by re-anchoring fresh at the entry's own
 * `offset` and restarting the doubling ladder at `DISK_WALK_WINDOW_BYTES`,
 * never by doubling whatever window happened to be held (a window reused
 * from an earlier, larger entry would otherwise ratchet the ladder up
 * further with every later entry that also needs to grow, even though each
 * one only ever needs a window sized to its own span). Every other failure
 * — a corrupt type nibble, an over-long size/distance encoding, corrupt
 * zlib data, the inflated-output safety cap — propagates immediately,
 * without growing the window at all. Growth that IS attempted is still
 * capped at `trailerStart`: a retryable failure that persists once the
 * window already reaches every byte the entry could legitimately span is a
 * genuine parse/inflate error, not a sizing problem.
 */
const diskPackByteSource = (
  ctx: Context,
  tmpPath: string,
  totalBytes: number,
): PackByteSource<DiskWindow> => {
  const trailerStart = totalBytes - ctx.hash.digestLength;
  let window: DiskWindow | undefined;

  const fetchWindow = async (start: number, length: number): Promise<DiskWindow> => {
    const bytes = await ctx.fs.readSlice(tmpPath, start, length);
    const fresh: DiskWindow = { start, bytes };
    window = fresh;
    return fresh;
  };

  /** The window size to start from for a fresh read anchored at `anchor`:
   *  the documented window, clamped so it never reaches past the trailer. */
  const initialWindowSize = (anchor: number): number =>
    Math.min(DISK_WALK_WINDOW_BYTES, Math.max(0, trailerStart - anchor));

  /** The size of the next growth-fetch, given the size of the last one
   *  `withGrowth`'s own loop fetched fresh at `anchor` (`0` means none yet).
   *  The first growth fetch is always the plain documented window size —
   *  never a doubling of whatever window happened to be held before the
   *  retry, reused or otherwise; only the second and later growth fetches
   *  for this same anchor double, clamped so growth never reaches past the
   *  trailer. */
  const nextRung = (priorRung: number, anchor: number): number =>
    priorRung === 0 ? initialWindowSize(anchor) : Math.min(priorRung * 2, trailerStart - anchor);

  /** Reuses the held window when `anchor` already falls inside it; fetches
   *  a fresh one, anchored at `anchor`, otherwise. Reuse never checks how
   *  much room is left past `anchor` — that is `withGrowth`'s job below. */
  const windowCovering = async (anchor: number): Promise<DiskWindow> => {
    if (
      window !== undefined &&
      anchor >= window.start &&
      anchor < window.start + window.bytes.length
    ) {
      return window;
    }
    return fetchWindow(anchor, initialWindowSize(anchor));
  };

  /**
   * Given a retryable failure caught against `w`, fetches the next growth
   * window and folds it into `withGrowth`'s running state — or rethrows
   * `err` when growth cannot help: the failure isn't a sizing problem, the
   * window already reaches `trailerStart`, or — the short-read-filesystem
   * case (NFS/SMB/FUSE — NodeFileSystem.readSlice issues one non-looping
   * handle.read) — the fetch delivered no more than the last one anchored
   * HERE did. Growth is driven by the REQUESTED size (`rung`), but a
   * short-read adapter can keep returning the same capped window forever
   * regardless of how large `rung` grows; the exhaustion check above reads
   * DELIVERED size, so it alone would never trip against such an adapter.
   * `deliveredAtAnchor` is `undefined` only for the very first fetch
   * anchored here (a REUSED window carries no baseline to compare against,
   * so it can never fail this check) — see `isAnchoredHere`.
   */
  const growOrRethrow = async (
    err: unknown,
    w: DiskWindow,
    anchor: number,
    rung: number,
    deliveredAtAnchor: number | undefined,
  ): Promise<{
    readonly w: DiskWindow;
    readonly rung: number;
    readonly deliveredAtAnchor: number;
  }> => {
    if (!isRetryableWindowFailure(err)) throw err;
    if (w.start + w.bytes.length >= trailerStart) throw err;
    const grownRung = nextRung(rung, anchor);
    const grown = await fetchWindow(anchor, grownRung);
    if (deliveredAtAnchor !== undefined && grown.bytes.length <= deliveredAtAnchor) throw err;
    return { w: grown, rung: grownRung, deliveredAtAnchor: grown.bytes.length };
  };

  const withGrowth = async <T>(
    anchor: number,
    attempt: (w: DiskWindow) => Promise<T> | T,
  ): Promise<T> => {
    let w = await windowCovering(anchor);
    const documented = initialWindowSize(anchor);
    // 0 means "no growth fetch made at `anchor` yet" (see `nextRung`); `w`'s
    // first value can instead already BE that fetch — `windowCovering`
    // returns a fresh, documented-size window whenever it didn't reuse one
    // — in which case growth should double past it, not repeat it.
    let rung = isFreshDocumentedWindow(w, anchor, documented) ? documented : 0;
    // `undefined` means "no delivery observed AT THIS ANCHOR yet" — a window
    // REUSED from an earlier, smaller-offset anchor carries no baseline: its
    // length reflects an unrelated fetch, not what a fetch anchored HERE
    // delivers, so it must never fail the non-progress check in
    // `growOrRethrow` (a coincidentally equal length there is not a stall,
    // just two unrelated fetches both clamped to the same documented size).
    let deliveredAtAnchor = isAnchoredHere(w, anchor) ? w.bytes.length : undefined;
    for (;;) {
      try {
        return await attempt(w);
      } catch (err) {
        ({ w, rung, deliveredAtAnchor } = await growOrRethrow(
          err,
          w,
          anchor,
          rung,
          deliveredAtAnchor,
        ));
      }
    }
  };

  return {
    totalBytes,
    header: async () => parsePackHeader(await ctx.fs.readSlice(tmpPath, 0, PACK_HEADER_BYTES)),
    entryHeader: (offset) =>
      withGrowth(offset, (w) => {
        try {
          // `parsePackEntryHeader` reports `dataOffset` as an index into the
          // buffer it was handed — i.e. relative to `w.start`, not the
          // pack's own absolute offsets. Every other seam in this file (and
          // every caller of `entryHeader`) works in absolute offsets, so the
          // shift back happens right here, once, at the window boundary.
          const local = parsePackEntryHeader(w.bytes, offset - w.start, ctx.hashConfig);
          return { ...local, dataOffset: local.dataOffset + w.start };
        } catch (err) {
          throw withAbsoluteEntryOffset(err, w.start);
        }
      }),
    inflateEntry: (offset, dataOffset, declaredSize) =>
      withGrowth(offset, async (w) => ({
        result: await ctx.compressor.streamInflate(w.bytes, dataOffset - w.start, declaredSize),
        crcContext: w,
      })),
    entryCrc32: async (offset, entryEnd, crcContext) => {
      // `crcContext` is the window `inflateEntry` actually read from for
      // this same `offset`. That call cannot have consumed more bytes than
      // it was handed, so `crcContext` necessarily spans through `entryEnd`
      // already — no extra read.
      return crc32(
        crcContext.bytes.subarray(offset - crcContext.start, entryEnd - crcContext.start),
      );
    },
  };
};

/**
 * Shared tail for both walk entry points: resolves deltas against the
 * already-inflated pending entries, then sorts by offset before mapping
 * down to the public `WalkedEntry` shape. Delta resolution
 * (`resolveAllEntries`) holds every resolved entry's full content in memory
 * at once — that residency is unrelated to the read-back windowing above
 * and is out of scope here.
 */
const walkFromPending = async (
  ctx: Context,
  pending: ReadonlyArray<PendingEntry>,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const resolved = await resolveAllEntries(ctx, pending, externalBaseResolver);
  // The sort below only orders the WalkedEntry array; nothing observable
  // depends on that order — `objectCount` reads `.length`, and `buildIdx`
  // feeds `serializePackIndex`, which re-sorts entries by SHA before writing.
  // Stryker disable next-line MethodExpression: equivalent — `resolveAllEntries` is module-internal and never shares the array, so the defensive `.slice()` copy cannot change behaviour.
  const copied = resolved.slice();
  // Stryker disable next-line ArithmeticOperator,MethodExpression: equivalent — the WalkedEntry order is unobservable (objectCount uses `.length`; serializePackIndex re-sorts by SHA), so a broken comparator — or dropping the `.sort()` entirely — changes nothing downstream.
  const ordered = copied.sort((a, b) => a.offset - b.offset);
  return ordered.map((r) => ({ id: r.id, crc32: r.crc32, offset: r.offset }));
};

export const walkPackEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const pending = await inflateAllEntries(ctx, inMemoryPackByteSource(ctx, packBytes));
  return walkFromPending(ctx, pending, externalBaseResolver);
};

const inflateAllEntries = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
): Promise<ReadonlyArray<PendingEntry>> => {
  const header = await source.header();
  const objectCountCap = ctx.config?.maxObjectsPerPack ?? DEFAULT_MAX_OBJECT_COUNT;
  if (header.objectCount > objectCountCap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: header.objectCount,
      limit: objectCountCap,
    });
  }
  const trailerStart = source.totalBytes - ctx.hash.digestLength;
  const out: PendingEntry[] = [];
  let offset = PACK_HEADER_BYTES;
  for (let i = 0; i < header.objectCount; i += 1) {
    const entryHeader = await source.entryHeader(offset);
    const inflated = await source.inflateEntry(offset, entryHeader.dataOffset, entryHeader.size);
    const entryEnd = entryHeader.dataOffset + inflated.result.bytesConsumed;
    // Defence-in-depth guard. The trailer is always verified before either
    // byte source above is ever walked — `verifyPackTrailer` for an
    // in-memory buffer (`bundle-verify.ts`), `receivePackToQuarantine`'s
    // incremental hash for the quarantine file — so the final
    // `digestLength` bytes are fixed as `sha(body)` by the time this runs;
    // `streamInflate` reports the minimal valid zlib-stream length. An
    // entry whose stream consumed bytes past `trailerStart` would require
    // those SHA bytes to also be a valid zlib continuation — unreachable
    // for any verifiable pack.
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — `entryEnd > trailerStart` is unreachable once the trailer has been accepted; the throw cannot fire.
    if (entryEnd > trailerStart) {
      // Stryker disable next-line StringLiteral: equivalent — the guarded throw is unreachable (see above), so its message is never observed.
      throw invalidPackHeader('entry extends past pack trailer');
    }
    const entryCrc = await source.entryCrc32(offset, entryEnd, inflated.crcContext);
    out.push({ offset, header: entryHeader, inflated: inflated.result.output, crc32: entryCrc });
    offset = entryEnd;
  }
  if (offset !== trailerStart) {
    throw invalidPackHeader('extra bytes between last entry and trailer');
  }
  return out;
};

const resolveAllEntries = async (
  ctx: Context,
  pending: ReadonlyArray<PendingEntry>,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ReadonlyArray<ResolvedEntry>> => {
  const byOffset = new Map<number, ResolvedEntry>();
  const byId = new Map<string, ResolvedEntry>();
  let unresolved: ReadonlyArray<PendingEntry> = pending;
  while (unresolved.length > 0) {
    const next: PendingEntry[] = [];
    let progress = false;
    for (const entry of unresolved) {
      const resolved = await tryResolveEntry(ctx, entry, byOffset, byId, externalBaseResolver);
      if (resolved === undefined) {
        next.push(entry);
      } else {
        byOffset.set(resolved.offset, resolved);
        byId.set(resolved.id, resolved);
        progress = true;
      }
    }
    if (!progress) throw firstUnresolvedError(next);
    unresolved = next;
  }
  return [...byOffset.values()];
};

const firstUnresolvedError = (unresolved: ReadonlyArray<PendingEntry>): Error => {
  const first = unresolved[0];
  // equivalent-mutant: `first === undefined` defensive branch is unreachable —
  // `resolveAllEntries` only calls this helper when `unresolved.length > 0`.
  // The branch exists so a future refactor that violates that invariant fails
  // with a clear message instead of throwing on `first.header`; flipping it to
  // always-false would only break that hypothetical future code path.
  if (first === undefined) {
    // Stryker disable next-line StringLiteral: equivalent — this branch is unreachable; `resolveAllEntries` only calls `firstUnresolvedError` with a non-empty `next` queue, so `first` is always defined.
    return invalidPackHeader('unresolved deltas: empty queue (internal invariant violated)');
  }
  const refBaseId = refDeltaBaseId(first.header);
  if (refBaseId !== undefined) {
    return invalidPackHeader(`unresolved REF_DELTA: base ${refBaseId} not in pack`);
  }
  return invalidPackHeader(`unresolved entry at offset ${first.offset}`);
};

const refDeltaBaseId = (header: PackEntryHeader): string | undefined => {
  if (isBaseHeader(header)) return undefined;
  if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) return undefined;
  return header.baseId;
};

const tryResolveEntry = async (
  ctx: Context,
  entry: PendingEntry,
  byOffset: ReadonlyMap<number, ResolvedEntry>,
  byId: ReadonlyMap<string, ResolvedEntry>,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ResolvedEntry | undefined> => {
  if (isBaseHeader(entry.header)) {
    const type = baseTypeName(entry.header.type);
    const id = await computeLooseObjectId(ctx, type, entry.inflated);
    return { id, type, content: entry.inflated, crc32: entry.crc32, offset: entry.offset };
  }
  if (entry.header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
    const baseOffset = entry.offset - entry.header.baseDistance;
    if (baseOffset < PACK_HEADER_BYTES) {
      throw invalidPackHeader(
        `OFS_DELTA at offset ${entry.offset} points before pack body: distance ${entry.header.baseDistance}`,
      );
    }
    const base = byOffset.get(baseOffset);
    if (base === undefined) return undefined;
    return await resolveDelta(ctx, entry, base);
  }
  // REF_DELTA — base may be in-pack or supplied by an external resolver.
  const packBase = byId.get(entry.header.baseId);
  if (packBase !== undefined) return await resolveDelta(ctx, entry, packBase);
  if (externalBaseResolver === undefined) return undefined;
  const external = await externalBaseResolver(entry.header.baseId as ObjectId);
  if (external === undefined) return undefined;
  const syntheticBase: ResolvedEntry = {
    id: entry.header.baseId,
    type: external.type,
    content: external.content,
    crc32: 0,
    offset: 0,
  };
  return await resolveDelta(ctx, entry, syntheticBase);
};

const resolveDelta = async (
  ctx: Context,
  entry: PendingEntry,
  base: ResolvedEntry,
): Promise<ResolvedEntry> => {
  const content = applyDelta(base.content, entry.inflated);
  const id = await computeLooseObjectId(ctx, base.type, content);
  return { id, type: base.type, content, crc32: entry.crc32, offset: entry.offset };
};

const isBaseHeader = (header: PackEntryHeader): header is BasePackEntryHeader => {
  return (
    header.type === PACK_ENTRY_TYPE.COMMIT ||
    header.type === PACK_ENTRY_TYPE.TREE ||
    header.type === PACK_ENTRY_TYPE.BLOB ||
    header.type === PACK_ENTRY_TYPE.TAG
  );
};

const baseTypeName = (type: BasePackEntryHeader['type']): BaseTypeName => {
  switch (type) {
    case PACK_ENTRY_TYPE.COMMIT:
      return 'commit';
    case PACK_ENTRY_TYPE.TREE:
      return 'tree';
    case PACK_ENTRY_TYPE.BLOB:
      return 'blob';
    case PACK_ENTRY_TYPE.TAG:
      return 'tag';
  }
};

const computeLooseObjectId = async (
  ctx: Context,
  typeName: string,
  content: Uint8Array,
): Promise<string> => {
  const headerBytes = TEXT_ENCODER.encode(`${typeName} ${content.length}\0`);
  const loose = new Uint8Array(headerBytes.length + content.length);
  loose.set(headerBytes, 0);
  loose.set(content, headerBytes.length);
  return await ctx.hash.hashHex(loose);
};

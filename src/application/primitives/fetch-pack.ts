/**
 * pack-fetch primitive. Shared between clone (12.1) and the
 * forthcoming fetch (12.2) / push (12.3) commands.
 *
 * Performs the `git-upload-pack` POST and streams the side-banded response
 * straight to a quarantine file (`objects/pack/tmp_pack_<random>`), bounded
 * by `config.maxResponseBytes` and hashed incrementally as bytes arrive —
 * the whole pack is never held in memory at once. Once the trailer verifies
 * against the incrementally-computed digest, the quarantine file is either
 * discarded (its content-addressed destination is already on disk) or
 * renamed to `pack-<sha>.pack` with its `.idx`/`.rev` siblings written —
 * exactly git's own on-disk shape for a received pack.
 *
 * Out of scope here (handled by callers): URL validation, capability
 * negotiation, ref-update propagation.
 */
import { fileExists, TsgitError } from '../../domain/error.js';
import { bytesToHex } from '../../domain/objects/encoding.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import { invalidPackHeader } from '../../domain/storage/index.js';
import { PACK_HEADER_SIZE } from '../../domain/storage/pack-entry.js';
import type { Context } from '../../ports/context.js';
import { errorDataCode } from './internal/error-data-code.js';
import { indexQuarantinedPack } from './internal/index-pack.js';
import {
  packFilePath,
  packIdxFilePath,
  writePackSiblingArtifacts,
} from './internal/write-pack-artifacts.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { refreshPackRegistry } from './read-object.js';

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
 * walk entries, then resolve one of three outcomes — suppress an empty pack,
 * adopt one whose content-addressed destination is already on disk, or
 * promote a new one (rename + sibling artefacts). In the adopted-outcome
 * case the quarantine copy is unlinked as a handled outcome, same as the
 * empty-pack case, so the temp-file posture stays the same across all three.
 * Split out of `fetchPack` so the negotiated response can be fully verified
 * (trailer + entry walk) before deciding whether it is empty — a malformed
 * pack that merely *looks* empty (bad trailer, truncated entries) must still
 * throw, never be silently dropped.
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
  const entries = await indexQuarantinedPack(ctx, receipt.tmpPath, receipt.totalBytes, (p) =>
    cleanupQuarantine(ctx, p),
  );
  // A verified pack can legitimately carry zero entries (e.g. the negotiated
  // response round-tripped a pack rather than a zero-byte body). Suppress
  // promoting it, same as the zero-byte-body guard above.
  if (entries.count === 0) {
    await cleanupQuarantine(ctx, receipt.tmpPath);
    return emptyPackResult(download.shallow, download.unshallow);
  }
  const destinationPackPath = packFilePath(packDir, receipt.packSha);
  // Packs are content-addressed by their trailer SHA, so a file already
  // occupying this exact name is, by construction, this same pack — matching
  // git's own already-present test, which is path existence, never content
  // (a tampered destination is deliberately left as-is, not overwritten).
  // Checked BEFORE the rename so an existing file is never clobbered.
  if (await ctx.fs.exists(destinationPackPath)) {
    await cleanupQuarantine(ctx, receipt.tmpPath);
    refreshPackRegistry(ctx);
    return {
      packPath: destinationPackPath,
      idxPath: packIdxFilePath(packDir, receipt.packSha),
      objectCount: entries.count,
      packSha: receipt.packSha,
      shallow: download.shallow,
      unshallow: download.unshallow,
    };
  }
  try {
    await renamePackIntoPlace(ctx, receipt.tmpPath, destinationPackPath);
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
    // Stryker disable next-line BlockStatement: equivalent — removeQuarantineFileIfPresent has one caller, cleanupQuarantine, which wraps this whole call in `.catch(() => {})`; every branch here (return vs rethrow, any error code) resolves to the same observable no-op through that caller. `fetch-pack.test.ts`'s "cleanup fails with something other than FILE_NOT_FOUND" pin proves the FILE_NOT_FOUND and PERMISSION_DENIED paths already converge on the same outcome.
  } catch (err) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: equivalent — same single-caller swallow as above: whether this returns or rethrows, and for which code, is unobservable through cleanupQuarantine's `.catch(() => {})`.
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
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — the only case these mutants can flip is `combined.length <= trailerLen`, where `boundary` is 0 or negative; `hasher.update(combined.subarray(0, boundary))` clamps to an empty slice (a genuine no-op — node:crypto and the memory hasher both treat a zero-byte update as unchanged state) and `combined.slice(boundary)` clamps to a full copy of `combined`, byte-identical to the else arm's `tail = combined`.
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
    // Stryker disable next-line StringLiteral: equivalent — receivePackToQuarantine has one caller (materializePack), which branches on `receipt.totalBytes === 0` and returns `emptyPackResult`'s hardcoded `packSha: ''` in that case, never reading this receipt's `packSha` field — its value here is unobservable.
    return { tmpPath, totalBytes: 0, packSha: '' };
  }
  if (total < PACK_HEADER_SIZE + trailerLen) {
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
  if (packBytes.length < PACK_HEADER_SIZE + trailerLen) {
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

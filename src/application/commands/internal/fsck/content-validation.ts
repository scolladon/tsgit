import { TsgitError } from '../../../../domain/error.js';
import type {
  FsckObjectType,
  FsckSeverityTable,
  ObjectFinding,
  ValidateObjectInput,
} from '../../../../domain/fsck/index.js';
import { retypeSeverity, validateObject } from '../../../../domain/fsck/index.js';
import { bytesEqual, encode } from '../../../../domain/objects/encoding.js';
import { classifyLooseBody } from '../../../../domain/objects/git-object.js';
import type { HashConfig } from '../../../../domain/objects/hash-config.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { serializeHeader } from '../../../../domain/objects/index.js';
import { MAX_INFLATE_OUTPUT_BYTES } from '../../../../ports/compressor.js';
import type { Context } from '../../../../ports/context.js';
import {
  inflateLooseBuffered,
  type LooseBufferedRead,
  looseCompressedBytes,
} from '../../../primitives/object-resolver.js';
import { readRawObject } from '../../../primitives/read-object.js';
import { EXIT_CONTENT_ERROR, EXIT_CORRUPT, EXIT_HASH_MISMATCH } from './exit-codes.js';
import { hasPackCopy } from './object-cache.js';
import type { FsckFinding } from './types.js';

/** An object whose raw bytes a reader did decode, ready for the catalogue and
 *  the hash check alike. */
interface ReadableObject {
  readonly ok: true;
  readonly kind: FsckObjectType;
  readonly rawBody: Uint8Array;
  /**
   * Computes this object's hash from its as-stored bytes, for
   * verification against the indexed id. A closure (not a materialised
   * buffer) so the packed arm can hash header+body incrementally without
   * ever concatenating them.
   */
  readonly computeHash: () => Promise<string>;
}

/**
 * The undecodable-object arm, told apart from a readable one by `ok`.
 * `reachabilityUnknown` is git-faithfulness bookkeeping the caller
 * (`validateOneObject`) reads to build `runContentValidationPass`'s
 * `typeUnknownIds`: true exactly when THIS refusal is content-validation's
 * OWN — the general object resolver (`object-cache.ts`'s `buildObjectCache`,
 * via `readObject`) still succeeds reading the SAME object, unlike every
 * OTHER `ok:false` cause here, which also fails `inflateLooseBuffered` /
 * `readObject`'s own read. git's own `read_loose_object` is one combined
 * read that types AND validates an object together, so a refusal there
 * means git's reachability graph never learns the object's type either —
 * `fsck.ts` nulls these ids in the shared object cache to match, before the
 * reachability pass ever reads it. Required (not optional) so a producer
 * that forgets to set it is a compile error, never a silent `undefined`.
 */
type RawObjectResult =
  | ReadableObject
  | { readonly ok: false; readonly msgId: string; readonly reachabilityUnknown: boolean };

/** The loose arm's header-parse failure, told apart by the reason
 *  `parseHeader` refused with: an unknown type word is `unknownType`,
 *  anything else (a missing NUL above all) is `unterminatedHeader`. Also
 *  fails `readObject`'s own read (the SAME `inflateLooseBuffered` call), so
 *  `reachabilityUnknown` is false — the general resolver never disagrees. */
function looseHeaderFailure(err: TsgitError): RawObjectResult {
  // A zlib decode fault (DECOMPRESS_FAILED) reaches here too, now that the
  // buffered tier's own inflate call can fail before parseHeader ever runs
  // — this condition is genuinely live, never equivalent-true.
  const reason =
    err.data.code === 'INVALID_OBJECT_HEADER'
      ? (err.data as { reason: string }).reason
      : // Stryker disable next-line StringLiteral: equivalent — reason is read only by reason.startsWith('unknown object type'); neither '' nor 'Stryker was here!' starts with that prefix, so msgId stays 'unterminatedHeader'.
        '';
  const msgId = reason.startsWith('unknown object type') ? 'unknownType' : 'unterminatedHeader';
  return { ok: false, msgId, reachabilityUnknown: false };
}

/** The stored header's own byte length, derived from a buffered read's
 *  already-known content length — never a second header parse. */
function headerLengthOf(buffered: LooseBufferedRead): number {
  return buffered.bytes.byteLength - buffered.split.content.byteLength;
}

/** The zero-fill chunk fed to the hasher for an under-run's residual claim —
 *  fixed-size and shared across calls, so padding up to git's declared size
 *  never costs one claim-sized allocation, however large the claim. */
const ZERO_PAD_CHUNK_BYTES = 64 * 1024;
const ZERO_PAD_CHUNK = new Uint8Array(ZERO_PAD_CHUNK_BYTES);

/**
 * git's own hash for an under-run blob's zero-padded claim
 * (`unpack_loose_rest`'s `xmallocz`, an UNINITIALISED allocation — git's own
 * padding bytes, and so its reported hash, are not actually deterministic):
 * the header, the real (shorter) body, then `declaredSize - body.length`
 * zero bytes streamed to the hasher in fixed-size chunks — never
 * materialised as one claim-sized buffer. Zero-fill is tsgit's own
 * deterministic choice for the bytes git leaves uninitialised, not a
 * transcription of git's actual (nondeterministic) padding.
 */
async function hashZeroPadded(
  ctx: Context,
  header: Uint8Array,
  body: Uint8Array,
  declaredSize: number,
): Promise<string> {
  const hasher = ctx.hash.createHasher();
  hasher.update(header);
  hasher.update(body);
  let remaining = declaredSize - body.byteLength;
  while (remaining > 0) {
    const chunkSize = Math.min(remaining, ZERO_PAD_CHUNK_BYTES);
    hasher.update(ZERO_PAD_CHUNK.subarray(0, chunkSize));
    remaining -= chunkSize;
  }
  return hasher.digestHex();
}

/**
 * A blob whose body overran its claim while still fitting git's 32-byte
 * header window: both the catalogued body and the hash git reports use the
 * claimed prefix, never the overrun tail — `inflateLooseBuffered` already
 * refused anything past the window, so `rawBody`'s slice never runs short.
 */
function truncatedResult(
  ctx: Context,
  buffered: LooseBufferedRead,
  type: FsckObjectType,
): RawObjectResult {
  const { bytes, split } = buffered;
  const hashInput = bytes.subarray(0, headerLengthOf(buffered) + split.declaredSize);
  return {
    ok: true,
    kind: type,
    rawBody: split.content.subarray(0, split.declaredSize),
    computeHash: () => ctx.hash.hashHex(hashInput),
  };
}

/**
 * A blob whose body under-ran its claim: the catalogue reads the real
 * (shorter) body, while the hash git reports pads to the claim — bounded so
 * a hostile multi-gigabyte claim is reported as undecodable instead of
 * hashing gigabytes of padding.
 */
function underrunResult(
  ctx: Context,
  buffered: LooseBufferedRead,
  type: FsckObjectType,
): RawObjectResult {
  const { split } = buffered;
  if (split.declaredSize > MAX_INFLATE_OUTPUT_BYTES) {
    // tsgit's own safety ceiling, not a git-faithfulness gate: the general
    // resolver has no matching cap (`applyLooseVerdict`'s 'underrun' arm
    // serves the claim uncapped), so a reachability-typing divergence is
    // POSSIBLE here too, symmetric to `bigBlobTruncateResult`'s. Left
    // `false` (out of THIS fix's scope — no probe of git's own behaviour at
    // this ceiling has been done, unlike the measured bigFileThreshold gap).
    return { ok: false, msgId: 'unterminatedHeader', reachabilityUnknown: false };
  }
  const header = buffered.bytes.subarray(0, headerLengthOf(buffered));
  return {
    ok: true,
    kind: type,
    rawBody: split.content,
    computeHash: () => hashZeroPadded(ctx, header, split.content, split.declaredSize),
  };
}

/**
 * A blob past `core.bigFileThreshold` whose body under-ran its claim: git's
 * `check_stream_oid` streams the real bytes and hashes them under the
 * DECLARED-size header, exactly as they are stored — never padded to the
 * claim, so this is the SAME formula `'honest'` uses (`ctx.hash.hashHex` of
 * the buffered bytes verbatim), just reached via a size-lying claim instead
 * of an honest one. No `MAX_INFLATE_OUTPUT_BYTES` ceiling applies: the cost
 * this bounds is the zero-padding `underrunResult` streams, which a big-file
 * claim never pays in the first place.
 */
function bigBlobUnderrunResult(ctx: Context, buffered: LooseBufferedRead): RawObjectResult {
  return {
    ok: true,
    kind: 'blob',
    rawBody: buffered.split.content,
    computeHash: () => ctx.hash.hashHex(buffered.bytes),
  };
}

/**
 * A blob whose body under-ran its claim, routed by `core.bigFileThreshold`:
 * git's type check gates ONLY on blob (never reached for a commit/tree/tag,
 * which always takes `underrunResult`'s zero-padded path regardless of
 * size), so this is the loose-native classify() 'underrun' arm's own
 * routing, never `nonBlobRefuseResult`'s.
 */
function blobUnderrunResult(
  ctx: Context,
  buffered: LooseBufferedRead,
  bigFileThreshold: number,
): RawObjectResult {
  return buffered.split.declaredSize > bigFileThreshold
    ? bigBlobUnderrunResult(ctx, buffered)
    : underrunResult(ctx, buffered, 'blob');
}

/**
 * A blob past `core.bigFileThreshold` whose body overran its claim: git's
 * `check_stream_oid` streams exactly the declared-size window from the
 * inflate output — an over-run leaves undrained trailing bytes the stream
 * never accounts for, which git reports as a corrupt loose object (`error:
 * corrupt loose object '<oid>'`), the SAME undecodable finding an
 * unparseable header reports, never a truncated-prefix hash. `reachabilityUnknown`
 * is true: `readObject`'s general (buffered-mode) read has no
 * `core.bigFileThreshold` gate of its own and still succeeds typing this
 * object as a blob — pinned live against git 2.55.0 (scrubbed env): with
 * this same shape, `git fsck` prints no `dangling blob` line at all (git's
 * `check_stream_oid` refusal denies its reachability graph the type too),
 * while `git cat-file -t/-s/-p` succeed unrelated (a DIFFERENT, streaming
 * code path that ignores the claim and `core.bigFileThreshold` alike).
 */
function bigBlobTruncateResult(): RawObjectResult {
  return { ok: false, msgId: 'unterminatedHeader', reachabilityUnknown: true };
}

/**
 * A blob whose body overran its claim, routed by `core.bigFileThreshold`:
 * git's type check gates ONLY on blob (never reached for a commit/tree/tag,
 * which always takes `nonBlobRefuseResult`'s truncated-prefix path
 * regardless of size), mirroring `blobUnderrunResult`'s own routing for the
 * opposite (under-run) direction.
 */
function blobTruncateResult(
  ctx: Context,
  buffered: LooseBufferedRead,
  bigFileThreshold: number,
): RawObjectResult {
  return buffered.split.declaredSize > bigFileThreshold
    ? bigBlobTruncateResult()
    : truncatedResult(ctx, buffered, 'blob');
}

/**
 * git's `read_loose_object` has no type check at all: a commit/tree/tag
 * whose body disagreed with its claim takes the SAME path a blob does —
 * an under-run zero-pads (`hash-path mismatch`), and an over-run that still
 * fits git's 32-byte header window truncates to the claim and hashes the
 * prefix (also `hash-path mismatch`, never corrupt); only an over-run PAST
 * the window still refuses, but that refusal already fired earlier inside
 * `inflateLooseBuffered`, before `classifyLooseBody` ever ran. This
 * `'refuse'` verdict folds both in-window directions together, so this
 * re-derives which one applies from the same comparison the blob arms
 * already make.
 */
function nonBlobRefuseResult(ctx: Context, buffered: LooseBufferedRead): RawObjectResult {
  const { split } = buffered;
  return split.content.byteLength < split.declaredSize
    ? underrunResult(ctx, buffered, split.type)
    : truncatedResult(ctx, buffered, split.type);
}

/**
 * git's buffered-tier verdict (`classifyLooseBody`), told into fsck's
 * raw-body result: `'honest'` hashes the stored bytes as written; a
 * commit/tree/tag disagreement (`'refuse'`) is re-routed by
 * `nonBlobRefuseResult` to the same truncated-prefix or zero-padded path a
 * blob takes — `classifyLooseBody`'s `'underrun'` and `'truncate'` verdicts
 * are only ever a blob (a commit/tree/tag disagreeing at all is `'refuse'`),
 * so THOSE two cases are `core.bigFileThreshold`'s one gate.
 */
function looseVerdictResult(
  ctx: Context,
  buffered: LooseBufferedRead,
  bigFileThreshold: number,
): RawObjectResult {
  const { bytes, split } = buffered;
  switch (classifyLooseBody(split)) {
    case 'honest':
      return {
        ok: true,
        kind: split.type,
        rawBody: split.content,
        computeHash: () => ctx.hash.hashHex(bytes),
      };
    case 'truncate':
      return blobTruncateResult(ctx, buffered, bigFileThreshold);
    case 'underrun':
      return blobUnderrunResult(ctx, buffered, bigFileThreshold);
    case 'refuse':
      return nonBlobRefuseResult(ctx, buffered);
  }
}

/**
 * A loose object's raw body, read through git's buffered tier
 * (`inflateLooseBuffered`) so a size-lying blob reports the same identity
 * fsck's own hash check hashes elsewhere. Hashing stays on the bytes AS
 * STORED — a malformed on-disk header must hash as written, never as a
 * canonical reconstruction. Rethrows anything that is not a `TsgitError`
 * (no swallow).
 */
async function looseRawObjectBody(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  bigFileThreshold: number,
): Promise<RawObjectResult> {
  try {
    const buffered = await inflateLooseBuffered(ctx, id, compressed);
    return looseVerdictResult(ctx, buffered, bigFileThreshold);
  } catch (err) {
    if (!(err instanceof TsgitError)) throw err;
    return looseHeaderFailure(err);
  }
}

/**
 * A packed object's raw body, read as the pre-parse bytes it is stored as.
 *
 * Going through `readObject`'s domain parser would throw on exactly the faults
 * the catalogue exists to report (duplicate name, `.`, `..`, an embedded `/`),
 * collapsing every such packed tree into `badType`; and re-serializing a parsed
 * Tree re-sorts its entries, so hashing that re-sorted form against an unsorted
 * tree's id would report a false hash-mismatch. `raw.type`/`raw.content` are
 * the object's own bytes — no re-serialisation — so hashing them (via the
 * canonical header, built fresh rather than carried as a field) avoids both,
 * without ever concatenating header and body into one buffer.
 */
async function packedRawObjectBody(ctx: Context, id: ObjectId): Promise<RawObjectResult> {
  try {
    // Stryker disable next-line ObjectLiteral: equivalent — readRawObject reads `options?.verifyHash ?? false`, so an empty options object resolves to the same false.
    const raw = await readRawObject(ctx, id, { verifyHash: false });
    return {
      ok: true,
      kind: raw.type,
      rawBody: raw.content,
      computeHash: async () => {
        const hasher = ctx.hash.createHasher();
        hasher.update(serializeHeader(raw.type, raw.content.length));
        hasher.update(raw.content);
        return hasher.digestHex();
      },
    };
  } catch {
    // Packed objects have no path-based reachability override mechanism
    // (`ObjectStorage` gates it to 'loose' — this function's own caller
    // never reads `reachabilityUnknown` for a packed result), so `false`
    // here is inert bookkeeping, not a claim that packed reads never
    // diverge from `readObject`'s own typing.
    return { ok: false, msgId: 'badType', reachabilityUnknown: false };
  }
}

/** Which store answered a `tryGetRawObjectBody` read — the one fact
 *  `validateOneObject` needs beyond the bytes themselves, since ONLY a loose
 *  read carries git's own hash-gates-catalogue rule (`resolvedRawObject`'s
 *  own doc comment). */
type ObjectStorage = 'loose' | 'packed';

interface ResolvedRawObject {
  readonly storage: ObjectStorage;
  readonly result: RawObjectResult;
}

/** Read an object's raw decompressed body for content validation, from
 *  whichever store holds it — tagged with which store that was. */
async function tryGetRawObjectBody(
  ctx: Context,
  id: ObjectId,
  bigFileThreshold: number,
): Promise<ResolvedRawObject> {
  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) {
    return {
      storage: 'loose',
      result: await looseRawObjectBody(ctx, id, compressed, bigFileThreshold),
    };
  }
  return { storage: 'packed', result: await packedRawObjectBody(ctx, id) };
}

const GITMODULES_NAME_BYTES = encode('.gitmodules');
const GITATTRIBUTES_NAME_BYTES = encode('.gitattributes');

/**
 * The special filename `nameBytes` matches, when it matches one of fsck's
 * two dedicated blob-content checks. Compares raw bytes — never the entry's
 * decoded `name` — so a byte sequence that merely decodes to one of these
 * literals is never mistaken for it.
 */
function specialBlobName(nameBytes: Uint8Array): string | undefined {
  if (bytesEqual(nameBytes, GITMODULES_NAME_BYTES)) return '.gitmodules';
  if (bytesEqual(nameBytes, GITATTRIBUTES_NAME_BYTES)) return '.gitattributes';
  return undefined;
}

/**
 * Scan all tree objects in the universe to record blob OIDs that appear
 * under a special filename (.gitmodules, .gitattributes) in any tree.
 *
 * Pinned real git 2.54.0: git checks .gitmodules/.gitattributes blob content
 * at any tree depth — not only the root tree. If the same blob OID appears
 * under multiple names, the last special name wins (precedence is
 * non-deterministic, but in practice each blob has one name).
 */
export function buildBlobFilenameMap(
  universe: ReadonlySet<ObjectId>,
  objectCache: ReadonlyMap<ObjectId, import('./object-cache.js').CachedGitObject>,
): ReadonlyMap<ObjectId, string> {
  const map = new Map<ObjectId, string>();
  for (const id of universe) {
    const obj = objectCache.get(id);
    if (obj == null || obj.type !== 'tree') continue;
    for (const entry of obj.entries) {
      const specialName = specialBlobName(entry.nameBytes);
      if (specialName !== undefined) {
        map.set(entry.id, specialName);
      }
    }
  }
  return map;
}

interface ContentValidationResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitBit: number;
}

/** A sub-check that found nothing and carries no exit bit. */
const EMPTY_RESULT: ContentValidationResult = { findings: [], exitBit: 0 };

/** Everything the catalogue pass needs beyond the object itself. */
interface CatalogueOptions {
  readonly strict: boolean;
  readonly blobFilenames: ReadonlyMap<ObjectId, string>;
  readonly severities: FsckSeverityTable;
  readonly skipped: ReadonlySet<string>;
  readonly bigFileThreshold: number;
}

/**
 * Build the kind-specific `validateObject` input. Every oid-bearing kind needs
 * the repository's own hash config: a raw tree's binary shas carry no width
 * marker of their own, and a commit's `tree`/`parent` and a tag's `object`
 * lines are only well-formed at their repository's hex width — a 40-hex tree
 * pointer is a full oid under SHA-1 but a truncated one under SHA-256, and
 * real git refuses each in the other's repository. Only `blob` needs no
 * config, and only `blob` optionally carries the special-file name used by
 * `.gitmodules`/`.gitattributes` content checks.
 */
function buildValidateObjectInput(
  hashConfig: HashConfig,
  kind: FsckObjectType,
  rawBody: Uint8Array,
  strict: boolean,
  fileName: string | undefined,
): ValidateObjectInput {
  switch (kind) {
    case 'blob':
      return fileName !== undefined
        ? { kind, rawBody, strict, fileName }
        : { kind, rawBody, strict };
    case 'tree':
    case 'commit':
    case 'tag':
      return { kind, rawBody, strict, hashConfig };
  }
}

/** The refusal for an object no reader could decode. git raises it through
 *  `error()`, never `report()`, so no `fsck.<msg-id>` re-types it: the report
 *  and its exit bit both stand whatever the repository configured. */
const unreadableObjectResult = (id: ObjectId, msgId: string): ContentValidationResult => ({
  findings: [{ type: 'bad-object', id, objectType: 'unknown', msgId, severity: 'error' }],
  exitBit: EXIT_CORRUPT,
});

/** Every catalogue finding the repository's `fsck.<msg-id>` table still
 *  reports, and the exit bit its error-severity ones carry. */
function retypedFindings(
  id: ObjectId,
  kind: FsckObjectType,
  catalogued: ReadonlyArray<ObjectFinding>,
  severities: FsckSeverityTable,
): ContentValidationResult {
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  for (const finding of catalogued) {
    const severity = retypeSeverity(severities, finding.msgId, finding.severity);
    if (severity === 'ignore') continue;
    findings.push({ type: 'bad-object', id, objectType: kind, msgId: finding.msgId, severity });
    if (severity === 'error') exitBit |= EXIT_CONTENT_ERROR;
  }
  return { findings, exitBit };
}

/**
 * One object's catalogue findings. `fsck.skipList` reaches exactly here: git
 * still runs every check and drops the REPORT for a listed oid, so the finding
 * and the exit bit it would have carried disappear together. The
 * unreadable-object arm and the hash check are `error()` calls in git, never
 * `report()` ones, and no list silences them.
 */
function catalogueResult(
  ctx: Context,
  id: ObjectId,
  raw: ReadableObject,
  options: CatalogueOptions,
): ContentValidationResult {
  if (options.skipped.has(id)) return EMPTY_RESULT;
  // For blobs, pass filename when the blob appears under a special name
  // (.gitmodules / .gitattributes) so content checks fire (gitmodulesUrl, …).
  const fileName = raw.kind === 'blob' ? options.blobFilenames.get(id) : undefined;
  const input = buildValidateObjectInput(
    ctx.hashConfig,
    raw.kind,
    raw.rawBody,
    options.strict,
    fileName,
  );
  return retypedFindings(id, raw.kind, validateObject(input), options.severities);
}

/**
 * The object's own hash, verified from the bytes already read (no second
 * `readObject`). For an honest loose object this hashes the full inflated
 * bytes (header + body) as stored; for a size-lying loose blob it hashes
 * git's own buffered-tier bytes instead (the truncated prefix or the
 * zero-padded claim — `looseVerdictResult`); for pack objects the object's
 * own header (rebuilt from its type + content) followed by its own body,
 * not a re-encoding. A hash that cannot be computed at all is the corrupt
 * object the catalogue checks may already have reported.
 */
async function hashResult(id: ObjectId, raw: ReadableObject): Promise<ContentValidationResult> {
  try {
    const computedHash = await raw.computeHash();
    if (computedHash === id) return EMPTY_RESULT;
    return {
      findings: [{ type: 'hash-mismatch', id, actual: computedHash as ObjectId }],
      exitBit: EXIT_HASH_MISMATCH,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * Whether a hash mismatch on THIS storage kind must suppress the catalogue.
 * git's `read_loose_object` returns on a hash-path disagreement before
 * `fsck_loose` ever calls `fsck_obj` — a loose mismatch is never catalogued.
 * A packed read carries no comparable path to disagree with: git walks every
 * packed object by offset and always runs its catalogue, mismatch or not.
 */
function catalogueSuppressedByHash(storage: ObjectStorage, hash: ContentValidationResult): boolean {
  return storage === 'loose' && hash.findings.length > 0;
}

/** `validateOneObject`'s own outcome, extending the plain findings/exitBit
 *  shape with the one extra fact `runContentValidationPass` folds into
 *  `typeUnknownIds` — never carried on `ContentValidationResult` itself,
 *  since nothing past `runContentValidationPass`'s own loop reads it. */
interface ValidateOneObjectOutcome extends ContentValidationResult {
  readonly reachabilityUnknown: boolean;
}

/** Validate one object's content and hash, accumulating findings and exit bit. */
async function validateOneObject(
  ctx: Context,
  id: ObjectId,
  options: CatalogueOptions,
): Promise<ValidateOneObjectOutcome> {
  const { storage, result: rawResult } = await tryGetRawObjectBody(
    ctx,
    id,
    options.bigFileThreshold,
  );
  if (!rawResult.ok) {
    return {
      ...unreadableObjectResult(id, rawResult.msgId),
      reachabilityUnknown: rawResult.reachabilityUnknown,
    };
  }
  const hash = await hashResult(id, rawResult);
  // git's `read_loose_object` returns on EVERY loose hash-path disagreement
  // before `parse_object_buffer` ever runs, not only the over-threshold
  // over-run `bigBlobTruncateResult` refuses outright — pinned live against
  // git 2.55.0 (scrubbed env) across an honest-body wrong-path blob, a
  // zero-padded under-run, a truncated-prefix over-run, and the big-file
  // streamed variant of each: real git's stdout never names any of them.
  // BUT git's reachability graph (`check_object`/`has_object_pack`) never
  // even consults this loose path when a PACK copy of the same id exists —
  // it types the object from the pack instead, so only a loose mismatch
  // with NO pack copy backing it is `true` here, letting fsck.ts's
  // `withUnreadableOverrides` null this id in the reachability cache so a
  // REFERRER reports `missing` instead of this id getting a spurious
  // `dangling`/`unreachable` finding of its own.
  if (catalogueSuppressedByHash(storage, hash)) {
    const reachabilityUnknown = !(await hasPackCopy(ctx, id));
    return { ...hash, reachabilityUnknown };
  }
  const catalogue = catalogueResult(ctx, id, rawResult, options);
  return {
    findings: [...catalogue.findings, ...hash.findings],
    exitBit: catalogue.exitBit | hash.exitBit,
    reachabilityUnknown: false,
  };
}

/** `runContentValidationPass`'s own result, `ContentValidationResult` plus
 *  the ids `fsck.ts` must null in the shared object cache before the
 *  reachability pass reads it — see `RawObjectResult`'s own doc comment for
 *  why this divergence exists at all. */
export interface ContentValidationPassResult extends ContentValidationResult {
  readonly typeUnknownIds: ReadonlySet<ObjectId>;
}

/**
 * Validate object contents for the entire universe.
 * Skipped when connectivityOnly is true.
 * Returns bad-object and hash-mismatch findings plus OR'd exit bit.
 */
export async function runContentValidationPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  strict: boolean,
  blobFilenames: ReadonlyMap<ObjectId, string>,
  severities: FsckSeverityTable,
  skipped: ReadonlySet<string>,
  bigFileThreshold: number,
): Promise<ContentValidationPassResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  const typeUnknownIds = new Set<ObjectId>();
  const options: CatalogueOptions = {
    strict,
    blobFilenames,
    severities,
    skipped,
    bigFileThreshold,
  };

  for (const id of universe) {
    const outcome = await validateOneObject(ctx, id, options);
    findings.push(...outcome.findings);
    exitBit |= outcome.exitBit;
    if (outcome.reachabilityUnknown) typeUnknownIds.add(id);
  }

  return { findings, exitBit, typeUnknownIds };
}

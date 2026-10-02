import { TsgitError } from '../../../../domain/error.js';
import { errorDataCode } from '../../../../domain/error-data-code.js';
import type {
  FsckObjectType,
  FsckSeverityTable,
  ObjectFinding,
  ValidateObjectInput,
} from '../../../../domain/fsck/index.js';
import { retypeSeverity, validateObject } from '../../../../domain/fsck/index.js';
import {
  MSG_GITATTRIBUTES_BLOB,
  MSG_GITATTRIBUTES_MISSING,
  MSG_GITMODULES_BLOB,
  MSG_GITMODULES_MISSING,
} from '../../../../domain/fsck/msg-ids.js';
import { classifyLooseBody } from '../../../../domain/objects/git-object.js';
import type { HashConfig } from '../../../../domain/objects/hash-config.js';
import type { GitObject, ObjectContent, ObjectId } from '../../../../domain/objects/index.js';
import { serializeHeader } from '../../../../domain/objects/index.js';
import { MAX_INFLATE_OUTPUT_BYTES } from '../../../../ports/compressor.js';
import type { Context } from '../../../../ports/context.js';
import {
  inflateLooseBuffered,
  type LooseBufferedRead,
} from '../../../primitives/object-resolver.js';
import { readObject } from '../../../primitives/read-object.js';
import { EXIT_CONTENT_ERROR, EXIT_CORRUPT, EXIT_HASH_MISMATCH, EXIT_PACK } from './exit-codes.js';
import { hasPackCopy, type PackedLocation, packedLocationOf } from './object-cache.js';
import { type LooseCopy, looseCopiesOf } from './object-presence.js';
import {
  SPECIAL_BLOB_NAMES,
  type SpecialBlobLedger,
  type SpecialBlobName,
} from './special-blobs.js';
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
  // — the branch below is genuinely reachable both ways, even though its
  // downstream msgId turns out the same regardless (see the marker below).
  const reason =
    // Stryker disable next-line ConditionalExpression: equivalent — looseHeaderFailure only ever receives INVALID_OBJECT_HEADER or DECOMPRESS_FAILED (inflateLooseBuffered's only throw codes); both carry .reason and no DECOMPRESS_FAILED reason starts with 'unknown object type', so msgId is unchanged either way.
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
  if (split.declaredSize >= MAX_INFLATE_OUTPUT_BYTES) {
    // Inclusive on purpose: a claim of EXACTLY the ceiling is itself
    // "gigabytes of padding" (this JSDoc's own phrase), the case this
    // refusal exists to avoid — never let it slip through as the one
    // claim size this ceiling forgets to cover.
    //
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
  // Stryker disable next-line EqualityOperator: equivalent — classifyLooseBody returns 'honest' (never reaching this 'refuse' arm) whenever content.byteLength === declaredSize, so equality is already excluded here and < vs <= can never disagree.
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

export interface ContentValidationResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitBit: number;
}

/** A sub-check that found nothing and carries no exit bit. */
const EMPTY_RESULT: ContentValidationResult = { findings: [], exitBit: 0 };

/** Everything the catalogue pass needs beyond the object itself. */
export interface CatalogueOptions {
  readonly strict: boolean;
  readonly specialBlobs: SpecialBlobLedger;
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

/** Every special filename a blob is queued under, marking its check done —
 *  git's `fsck_blob`, which checks a blob's content only while it is queued. */
function claimSpecialNames(
  ledger: SpecialBlobLedger,
  id: ObjectId,
): ReadonlyArray<SpecialBlobName> {
  const fileNames = ledger.queuedNames(id);
  ledger.markDone(id);
  return fileNames;
}

/** An object's catalogue findings, a blob's once per special filename it is
 *  checked under, in git's order. */
function catalogueFindings(
  ctx: Context,
  body: Pick<ReadableObject, 'kind' | 'rawBody'>,
  strict: boolean,
  fileNames: ReadonlyArray<SpecialBlobName>,
): ReadonlyArray<ObjectFinding> {
  const checked = fileNames.length === 0 ? [undefined] : fileNames;
  return checked.flatMap((fileName) =>
    validateObject(
      buildValidateObjectInput(ctx.hashConfig, body.kind, body.rawBody, strict, fileName),
    ),
  );
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
  // git's `fsck_tree` queues a tree's special blobs before any report, so a
  // skip-listed tree still queues them.
  if (raw.kind === 'tree') options.specialBlobs.noteTree(id);
  if (options.skipped.has(id)) return EMPTY_RESULT;
  const fileNames = raw.kind === 'blob' ? claimSpecialNames(options.specialBlobs, id) : [];
  const catalogued = catalogueFindings(ctx, raw, options.strict, fileNames);
  return retypedFindings(id, raw.kind, catalogued, options.severities);
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

/** git's `verify_pack` verdict on one damaged entry: its own error, bit 4. */
const packEntryResult = (
  finding: Extract<FsckFinding, { type: 'pack-entry-unpackable' | 'pack-entry-corrupt' }>,
): ContentValidationResult => ({ findings: [finding], exitBit: EXIT_PACK });

/** `validateOneObject`'s own outcome, extending the plain findings/exitBit
 *  shape with the one extra fact `runContentValidationPass` folds into
 *  `typeUnknownIds` — never carried on `ContentValidationResult` itself,
 *  since nothing past `runContentValidationPass`'s own loop reads it. */
interface ValidateOneObjectOutcome extends ContentValidationResult {
  readonly reachabilityUnknown: boolean;
}

/** A packed-only object is `verify_pack`'s, copy by copy — never this pass's. */
const LEFT_TO_VERIFY_PACK: ValidateOneObjectOutcome = {
  ...EMPTY_RESULT,
  reachabilityUnknown: false,
};

/** Validate one loose object's content and hash, accumulating findings and exit bit. */
async function validateLooseObject(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  options: CatalogueOptions,
): Promise<ValidateOneObjectOutcome> {
  const rawResult = await looseRawObjectBody(ctx, id, compressed, options.bigFileThreshold);
  if (!rawResult.ok) {
    return {
      ...unreadableObjectResult(id, rawResult.msgId),
      reachabilityUnknown: rawResult.reachabilityUnknown,
    };
  }
  const hash = await hashResult(id, rawResult);
  // git's `read_loose_object` returns on EVERY loose hash-path disagreement
  // before `parse_object_buffer` ever runs — pinned live against git 2.55.0.
  // Its reachability graph (`check_object`/`has_object_pack`) never consults
  // this loose path when a PACK copy of the same id exists, so only a loose
  // mismatch with NO pack copy backing it nulls the id for reachability.
  if (hash.findings.length > 0) {
    return { ...hash, reachabilityUnknown: !(await hasPackCopy(ctx, id)) };
  }
  return { ...catalogueResult(ctx, id, rawResult, options), reachabilityUnknown: false };
}

/** Every loose copy, each read and reported on its own; the id stays
 *  typeable for reachability while any one copy parses. */
async function validateLooseCopies(
  ctx: Context,
  id: ObjectId,
  copies: ReadonlyArray<LooseCopy>,
  options: CatalogueOptions,
): Promise<ValidateOneObjectOutcome> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  let reachabilityUnknown = true;
  for (const { compressed, attribution } of copies) {
    const own = await validateLooseObject(ctx, id, compressed, options);
    findings.push(...own.findings.map((finding) => ({ ...finding, ...attribution })));
    exitBit |= own.exitBit;
    reachabilityUnknown &&= own.reachabilityUnknown;
  }
  return { findings, exitBit, reachabilityUnknown };
}

/** git's `fsck_source` reads every loose copy in every source; a packed-only
 *  object is left to `verify_pack`, and one no store holds is the generic
 *  refusal. */
async function validateOneObject(
  ctx: Context,
  id: ObjectId,
  options: CatalogueOptions,
): Promise<ValidateOneObjectOutcome> {
  const copies = await looseCopiesOf(ctx, id);
  if (copies.length > 0) return validateLooseCopies(ctx, id, copies, options);
  if ((await packedLocationOf(ctx, id)) !== undefined) return LEFT_TO_VERIFY_PACK;
  return { ...unreadableObjectResult(id, 'badType'), reachabilityUnknown: false };
}

/** One pack entry as `verify_packfile` meets it: where it sits, and how to
 *  unpack it from exactly there — never from whichever copy the store reads. */
export interface PackedEntry {
  readonly id: ObjectId;
  readonly location: PackedLocation;
  readonly unpack: () => Promise<ObjectContent>;
}

/** The entry's own bytes, or `undefined` when they no longer unpack. Hashes
 *  the bytes as stored (canonical header + body), never a re-serialisation. */
async function unpackedEntry(
  ctx: Context,
  entry: PackedEntry,
): Promise<ReadableObject | undefined> {
  try {
    const raw = await entry.unpack();
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
  } catch (err) {
    if (errorDataCode(err) === undefined) throw err;
    return undefined;
  }
}

/**
 * git's per-entry `verify_packfile` step: `cannot unpack`, else `packed … is
 * corrupt`, else `fsck_obj_buffer` — which clears `SEEN`, so every copy runs
 * the catalogue again. Its errors reach the exit code only through
 * `verify_pack`'s own return: bit 4, never bit 1.
 */
export async function validatePackedEntry(
  ctx: Context,
  entry: PackedEntry,
  options: CatalogueOptions,
): Promise<ContentValidationResult> {
  const { id, location } = entry;
  const { pack, offset, attribution } = location;
  const raw = await unpackedEntry(ctx, entry);
  if (raw === undefined) {
    return packEntryResult({ type: 'pack-entry-unpackable', pack, id, offset, ...attribution });
  }
  const hash = await hashResult(id, raw);
  if (hash.findings.length > 0) {
    return packEntryResult({ type: 'pack-entry-corrupt', pack, id, ...attribution });
  }
  const catalogue = catalogueResult(ctx, id, raw, options);
  return { findings: catalogue.findings, exitBit: catalogue.exitBit === 0 ? 0 : EXIT_PACK };
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
  options: CatalogueOptions,
): Promise<ContentValidationPassResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  const typeUnknownIds = new Set<ObjectId>();

  for (const id of universe) {
    const outcome = await validateOneObject(ctx, id, options);
    findings.push(...outcome.findings);
    exitBit |= outcome.exitBit;
    if (outcome.reachabilityUnknown) typeUnknownIds.add(id);
  }

  return { findings, exitBit, typeUnknownIds };
}

/** `fsck_blobs`' own msg-ids for a queued name that reads as no blob. */
const DEFERRED_MISFIT_MSG_IDS: Readonly<
  Record<SpecialBlobName, { readonly missing: string; readonly notBlob: string }>
> = {
  '.gitmodules': { missing: MSG_GITMODULES_MISSING, notBlob: MSG_GITMODULES_BLOB },
  '.gitattributes': { missing: MSG_GITATTRIBUTES_MISSING, notBlob: MSG_GITATTRIBUTES_BLOB },
};

/** The finding `fsck_blobs` raises for a queued special blob that is not one:
 *  `<name>Missing` when no copy reads, `<name>Blob` when it is not a blob. */
function deferredMisfitResult(
  id: ObjectId,
  objectType: FsckObjectType,
  msgId: string,
  severities: FsckSeverityTable,
): ContentValidationResult {
  const severity = retypeSeverity(severities, msgId, 'error');
  if (severity === 'ignore') return EMPTY_RESULT;
  return {
    findings: [{ type: 'bad-object', id, objectType, msgId, severity }],
    exitBit: severity === 'error' ? EXIT_CONTENT_ERROR : 0,
  };
}

/** The object behind a queued special blob, or `undefined` when no copy reads. */
async function readQueuedObject(ctx: Context, id: ObjectId): Promise<GitObject | undefined> {
  try {
    return await readObject(ctx, id);
  } catch (err) {
    if (errorDataCode(err) === undefined) throw err;
    return undefined;
  }
}

/** One queued special blob, read through the store as `fsck_blobs` does. */
async function deferredCheck(
  ctx: Context,
  id: ObjectId,
  fileName: SpecialBlobName,
  options: CatalogueOptions,
): Promise<ContentValidationResult> {
  const misfit = DEFERRED_MISFIT_MSG_IDS[fileName];
  const object = await readQueuedObject(ctx, id);
  if (object === undefined) {
    return deferredMisfitResult(id, 'blob', misfit.missing, options.severities);
  }
  if (object.type !== 'blob') {
    return deferredMisfitResult(id, object.type, misfit.notBlob, options.severities);
  }
  const fileNames = claimSpecialNames(options.specialBlobs, id);
  const body = { kind: 'blob', rawBody: object.content } as const;
  const catalogued = catalogueFindings(ctx, body, options.strict, fileNames);
  return retypedFindings(id, 'blob', catalogued, options.severities);
}

/**
 * git's `fsck_finish`: every special blob a checked tree queued but no copy
 * met in place is read once through the store and checked — outside any
 * pack, so its errors carry bit 1, never bit 4.
 */
export async function runDeferredSpecialBlobChecks(
  ctx: Context,
  options: CatalogueOptions,
): Promise<ContentValidationResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  for (const fileName of SPECIAL_BLOB_NAMES) {
    for (const id of options.specialBlobs.pendingUnder(fileName)) {
      if (options.skipped.has(id)) continue;
      const own = await deferredCheck(ctx, id, fileName, options);
      findings.push(...own.findings);
      exitBit |= own.exitBit;
    }
  }
  return { findings, exitBit };
}

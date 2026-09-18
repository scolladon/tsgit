import { TsgitError } from '../../../../domain/error.js';
import type {
  FsckObjectType,
  FsckSeverityTable,
  ObjectFinding,
  ValidateObjectInput,
} from '../../../../domain/fsck/index.js';
import { retypeSeverity, validateObject } from '../../../../domain/fsck/index.js';
import { bytesEqual, encode } from '../../../../domain/objects/encoding.js';
import type { HashConfig } from '../../../../domain/objects/hash-config.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { parseHeader, serializeHeader } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { looseCompressedBytes } from '../../../primitives/object-resolver.js';
import { readRawObject } from '../../../primitives/read-object.js';
import { EXIT_CONTENT_ERROR, EXIT_CORRUPT, EXIT_HASH_MISMATCH } from './exit-codes.js';
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

type RawObjectResult = ReadableObject | { readonly ok: false; readonly msgId: string };

/** The loose arm's header-parse failure, told apart by the reason
 *  `parseHeader` refused with: an unknown type word is `unknownType`,
 *  anything else (a missing NUL above all) is `unterminatedHeader`. */
function looseHeaderFailure(err: unknown): RawObjectResult {
  const reason =
    // Stryker disable next-line ConditionalExpression: equivalent — parseHeader only throws TsgitError with code INVALID_OBJECT_HEADER; the condition is always true when reached.
    err instanceof TsgitError && err.data.code === 'INVALID_OBJECT_HEADER'
      ? (err.data as { reason: string }).reason
      : // Stryker disable next-line StringLiteral: equivalent — reason is read only by reason.startsWith('unknown object type'); neither '' nor 'Stryker was here!' starts with that prefix, so msgId stays 'unterminatedHeader'.
        '';
  const msgId = reason.startsWith('unknown object type') ? 'unknownType' : 'unterminatedHeader';
  return { ok: false, msgId };
}

/** The object's inflated bytes, or `undefined` when the compressed bytes are
 *  corrupt — a fault the caller reports as a type it could not even read. */
async function inflateOrUndefined(
  ctx: Context,
  compressed: Uint8Array,
): Promise<Uint8Array | undefined> {
  try {
    return await ctx.compressor.inflate(compressed);
  } catch {
    return undefined;
  }
}

/**
 * The body that follows a loose object's git `<type> <size>\0` header.
 * Hashing stays on the inflated on-disk bytes AS STORED — a malformed on-disk
 * header must hash as written, never as a canonical reconstruction.
 */
function parsedLooseObject(ctx: Context, inflated: Uint8Array): RawObjectResult {
  try {
    const { type, contentOffset } = parseHeader(inflated);
    return {
      ok: true,
      kind: type,
      rawBody: inflated.subarray(contentOffset),
      computeHash: () => ctx.hash.hashHex(inflated),
    };
  } catch (err) {
    return looseHeaderFailure(err);
  }
}

/**
 * A loose object's raw body. Reading it from the on-disk bytes preserves
 * zero-padded file modes and other normalisation-defeated bytes that tsgit's
 * strict parsers reject, so the catalogue gets to classify them.
 */
async function looseRawObjectBody(ctx: Context, compressed: Uint8Array): Promise<RawObjectResult> {
  const inflated = await inflateOrUndefined(ctx, compressed);
  if (inflated === undefined) return { ok: false, msgId: 'unterminatedHeader' };
  return parsedLooseObject(ctx, inflated);
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
    return { ok: false, msgId: 'badType' };
  }
}

/** Read an object's raw decompressed body for content validation, from
 *  whichever store holds it. */
async function tryGetRawObjectBody(ctx: Context, id: ObjectId): Promise<RawObjectResult> {
  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) return looseRawObjectBody(ctx, compressed);
  return packedRawObjectBody(ctx, id);
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
 * `readObject`). For loose objects this hashes the full inflated bytes
 * (header + body) as stored; for pack objects the object's own header
 * (rebuilt from its type + content) followed by its own body, not a
 * re-encoding. A mismatch does not preclude the catalogue checks, and a
 * hash that cannot be computed at all is the corrupt object those checks
 * may already have reported.
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

/** Validate one object's content and hash, accumulating findings and exit bit. */
async function validateOneObject(
  ctx: Context,
  id: ObjectId,
  options: CatalogueOptions,
): Promise<ContentValidationResult> {
  const rawResult = await tryGetRawObjectBody(ctx, id);
  if (!rawResult.ok) return unreadableObjectResult(id, rawResult.msgId);
  const catalogue = catalogueResult(ctx, id, rawResult, options);
  const hash = await hashResult(id, rawResult);
  return {
    findings: [...catalogue.findings, ...hash.findings],
    exitBit: catalogue.exitBit | hash.exitBit,
  };
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
): Promise<ContentValidationResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  const options: CatalogueOptions = { strict, blobFilenames, severities, skipped };

  for (const id of universe) {
    const { findings: objFindings, exitBit: objBit } = await validateOneObject(ctx, id, options);
    findings.push(...objFindings);
    exitBit |= objBit;
  }

  return { findings, exitBit };
}

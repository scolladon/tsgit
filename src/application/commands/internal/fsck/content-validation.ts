import { TsgitError } from '../../../../domain/error.js';
import type {
  FsckObjectType,
  FsckSeverityTable,
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

type RawObjectResult =
  | {
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
  | { readonly ok: false; readonly msgId: string };

/**
 * Read an object's raw decompressed body for content validation.
 *
 * For loose objects: inflate compressed bytes and return body (after the
 * git `<type> <size>\0` header). This preserves zero-padded file modes and
 * other normalisation-defeated bytes that tsgit's strict parsers reject.
 * The full inflated bytes are also returned for hash verification.
 *
 * For pack objects: read the pre-parse bytes directly (no domain parse, no
 * re-serialisation), so a malformed packed object is classified by the
 * catalogue instead of being swallowed into a generic `badType` finding, and
 * hash verification is computed from the object's ORIGINAL bytes rather than
 * a canonicalised re-encoding.
 */
async function tryGetRawObjectBody(ctx: Context, id: ObjectId): Promise<RawObjectResult> {
  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) {
    let inflated: Uint8Array;
    try {
      inflated = await ctx.compressor.inflate(compressed);
    } catch {
      // Inflate failure: compressed bytes are corrupt — type unknown.
      return { ok: false, msgId: 'unterminatedHeader' };
    }
    try {
      const { type, contentOffset } = parseHeader(inflated);
      return {
        ok: true,
        kind: type,
        rawBody: inflated.subarray(contentOffset),
        // The loose arm keeps hashing the inflated on-disk bytes AS STORED —
        // a malformed on-disk header must still hash as written, never a
        // canonical reconstruction.
        computeHash: () => ctx.hash.hashHex(inflated),
      };
    } catch (err) {
      // Header-parse failure: inflated successfully but header is malformed.
      // Distinguish unknown type (unknownType) from missing NUL (unterminatedHeader).
      const reason =
        // Stryker disable next-line ConditionalExpression: equivalent — parseHeader only throws TsgitError with code INVALID_OBJECT_HEADER; the condition is always true when reached.
        err instanceof TsgitError && err.data.code === 'INVALID_OBJECT_HEADER'
          ? (err.data as { reason: string }).reason
          : // Stryker disable next-line StringLiteral: equivalent — reason is read only by reason.startsWith('unknown object type'); neither '' nor 'Stryker was here!' starts with that prefix, so msgId stays 'unterminatedHeader'.
            '';
      const msgId = reason.startsWith('unknown object type') ? 'unknownType' : 'unterminatedHeader';
      return { ok: false, msgId };
    }
  }

  // Pack object — read the pre-parse bytes directly. Going through readObject's
  // domain parser would throw on exactly the faults the catalogue exists to
  // report (duplicate name, '.', '..', an embedded '/'), collapsing every such
  // packed tree into badType; and re-serializing a parsed Tree re-sorts its
  // entries, so hashing that re-sorted form against an unsorted tree's id
  // would report a false hash-mismatch. `raw.type`/`raw.content` are the
  // object's own bytes — no re-serialisation — so hashing them (via the
  // canonical header, built fresh rather than carried as a field) avoids
  // both, without ever concatenating header and body into one buffer.
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

/** Validate one object's content and hash, accumulating findings and exit bit. */
async function validateOneObject(
  ctx: Context,
  id: ObjectId,
  strict: boolean,
  blobFilenames: ReadonlyMap<ObjectId, string>,
  severities: FsckSeverityTable,
  skipped: ReadonlySet<string>,
): Promise<ContentValidationResult> {
  const findings: FsckFinding[] = [];
  let exitBit = 0;

  const rawResult = await tryGetRawObjectBody(ctx, id);
  if (!rawResult.ok) {
    const severity = retypeSeverity(severities, rawResult.msgId, 'error');
    if (severity === 'ignore') return { findings, exitBit };
    findings.push({
      type: 'bad-object',
      id,
      objectType: 'unknown',
      msgId: rawResult.msgId,
      severity,
    });
    return { findings, exitBit: severity === 'error' ? EXIT_CORRUPT : 0 };
  }

  const { kind, rawBody, computeHash } = rawResult;

  // For blobs, pass filename when the blob appears under a special name
  // (.gitmodules / .gitattributes) so content checks fire (gitmodulesUrl, …).
  const fileName = kind === 'blob' ? blobFilenames.get(id) : undefined;
  // `fsck.skipList` reaches exactly here: git still runs every check and
  // drops the REPORT for a listed oid, so the finding and the exit bit it
  // would have carried disappear together. The corrupt-object arm above and
  // the hash check below are `error()` calls in git, never `report()` ones,
  // and no list silences them.
  const catalogueFindings = skipped.has(id)
    ? []
    : validateObject(buildValidateObjectInput(ctx.hashConfig, kind, rawBody, strict, fileName));
  for (const catalogued of catalogueFindings) {
    const severity = retypeSeverity(severities, catalogued.msgId, catalogued.severity);
    if (severity === 'ignore') continue;
    findings.push({ type: 'bad-object', id, objectType: kind, msgId: catalogued.msgId, severity });
    if (severity === 'error') exitBit |= EXIT_CONTENT_ERROR;
  }

  // Hash check: verify hash from the bytes already read (no second readObject).
  // For loose objects this hashes the full inflated bytes (header + body) as
  // stored. For pack objects it hashes the object's own header (rebuilt from
  // its type + content) followed by its own body, not a re-encoding.
  // Hash-mismatch does not preclude catalogue checks above.
  try {
    const computedHash = await computeHash();
    if (computedHash !== id) {
      findings.push({ type: 'hash-mismatch', id, actual: computedHash as ObjectId });
      exitBit |= EXIT_HASH_MISMATCH;
    }
  } catch {
    // Hash computation failure — treated as a corrupt object; catalogue checks may already have fired.
  }

  return { findings, exitBit };
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

  for (const id of universe) {
    const { findings: objFindings, exitBit: objBit } = await validateOneObject(
      ctx,
      id,
      strict,
      blobFilenames,
      severities,
      skipped,
    );
    findings.push(...objFindings);
    exitBit |= objBit;
  }

  return { findings, exitBit };
}

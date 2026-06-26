import { TsgitError } from '../../../../domain/error.js';
import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { validateObject } from '../../../../domain/fsck/index.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { parseHeader, serializeObject } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { looseCompressedBytes } from '../../../primitives/object-resolver.js';
import { readObject } from '../../../primitives/read-object.js';
import { EXIT_CONTENT_ERROR, EXIT_CORRUPT, EXIT_HASH_MISMATCH } from './exit-codes.js';
import type { FsckFinding } from './types.js';

type RawObjectResult =
  | {
      readonly ok: true;
      readonly kind: FsckObjectType;
      readonly rawBody: Uint8Array;
      /** Full bytes (including header) for hash verification. */
      readonly hashBytes: Uint8Array;
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
 * For pack objects: re-serialize the parsed object. Packs never contain
 * zero-padded modes (git normalises on pack write), so re-serialisation is
 * correct and all catalogue checks apply to packed objects.
 * The re-serialized bytes are returned for hash verification.
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
        hashBytes: inflated,
      };
    } catch (err) {
      // Header-parse failure: inflated successfully but header is malformed.
      // Distinguish unknown type (unknownType) from missing NUL (unterminatedHeader).
      const reason =
        // Stryker disable next-line ConditionalExpression: equivalent — parseHeader only throws TsgitError with code INVALID_OBJECT_HEADER; the condition is always true when reached.
        err instanceof TsgitError && err.data.code === 'INVALID_OBJECT_HEADER'
          ? (err.data as { reason: string }).reason
          : '';
      const msgId = reason.startsWith('unknown object type') ? 'unknownType' : 'unterminatedHeader';
      return { ok: false, msgId };
    }
  }

  // Pack object — go through normal parse path and re-serialize
  try {
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — verifyHash defaults true; hash-verification throws are caught below → returns { ok: false, msgId: 'badType' }, same outcome.
    const obj = await readObject(ctx, id, { verifyHash: false });
    const full = serializeObject(obj, ctx.hashConfig);
    const { contentOffset } = parseHeader(full);
    return { ok: true, kind: obj.type, rawBody: full.subarray(contentOffset), hashBytes: full };
  } catch {
    return { ok: false, msgId: 'badType' };
  }
}

/** Special filenames whose blob content triggers dedicated fsck checks. */
const SPECIAL_BLOB_NAMES: ReadonlySet<string> = new Set(['.gitmodules', '.gitattributes']);

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
      // Stryker disable next-line ConditionalExpression: equivalent — non-special filenames are mapped but validateBlob returns [] for them; no finding is affected.
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

/** Validate one object's content and hash, accumulating findings and exit bit. */
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

  const { kind, rawBody, hashBytes } = rawResult;

  // For blobs, pass filename when the blob appears under a special name
  // (.gitmodules / .gitattributes) so content checks fire (gitmodulesUrl, …).
  // Stryker disable next-line ConditionalExpression: equivalent — blobFilenames only maps blob ids; non-blob ids return undefined → fileName stays undefined → same dispatch path.
  const fileName = kind === 'blob' ? blobFilenames.get(id) : undefined;
  const catalogueFindings = validateObject(
    fileName !== undefined ? { rawBody, kind, strict, fileName } : { rawBody, kind, strict },
  );
  for (const { msgId, severity } of catalogueFindings) {
    findings.push({ type: 'bad-object', id, objectType: kind, msgId, severity });
    if (severity === 'error') exitBit |= EXIT_CONTENT_ERROR;
  }

  // Hash check: verify hash from the bytes already read (no second readObject).
  // For loose objects hashBytes is the full inflated bytes (header + body).
  // For pack objects hashBytes is the re-serialized canonical form.
  // Hash-mismatch does not preclude catalogue checks above.
  try {
    const computedHash = await ctx.hash.hashHex(hashBytes);
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

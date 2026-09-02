import type {
  BundleHashAlgorithm,
  BundlePrerequisite,
  BundleRef,
  BundleVersion,
  ParsedBundleHeader,
} from '../../domain/bundle/index.js';
import { bundlePrerequisiteAlgorithmMismatch } from '../../domain/commands/error.js';
import { TsgitError, unsupportedOperation } from '../../domain/error.js';
import { configFor } from '../../domain/objects/hash-config.js';
import { parseHeader, serializeObject } from '../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import type { ObjectFilter } from '../../domain/protocol/object-filter.js';
import { notARepository } from '../../domain/repository/error.js';
import type { Context } from '../../ports/context.js';
import { deriveContext } from '../primitives/derive-context.js';
import { verifyPackTrailer } from '../primitives/fetch-pack.js';
import { type ExternalBaseResolver, walkPackEntries } from '../primitives/internal/index-pack.js';
import { layoutFailsAcceptance } from '../primitives/internal/layout-verdict.js';
import { readObject } from '../primitives/read-object.js';
import { readBundle } from './internal/read-bundle.js';

export interface BundleVerifyInput {
  readonly path: string;
}

export interface BundleVerifyResult {
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly missingPrerequisites: ReadonlyArray<ObjectId>;
  readonly prerequisitesPresent: boolean;
  readonly recordsCompleteHistory: boolean;
  readonly filter?: ObjectFilter;
}

/**
 * Verifying a bundle resolves its prerequisites against the repository, so a
 * repository the acceptance tier rejected is not one this verb can use.
 *
 * git demotes such a repository to *absent* here rather than raising its
 * ownership fatal — measured on 2.55.0 with the owner check forced to fail:
 * `bundle verify` exits 1 with `need a repository to verify a bundle`, byte
 * for byte what it prints outside any repository at all, while `status` on
 * the same fixture exits 128 with the dubious-ownership fatal and
 * `bundle list-heads` still exits 0 (it reads only the bundle). The
 * repository-absent refusal is therefore the faithful shape, which is why
 * this verb cannot simply take the acceptance tier: that tier raises the
 * ownership and format families, and git raises neither of them here.
 */
const assertUsableForBundleVerify = (ctx: Context): void => {
  if (!layoutFailsAcceptance(ctx.layout)) return;
  throw notARepository((ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath);
};

export const bundleVerify = async (
  ctx: Context,
  input: BundleVerifyInput,
): Promise<BundleVerifyResult> => {
  assertUsableForBundleVerify(ctx);
  const { header, packBytes } = await readBundle(ctx, input.path);
  assertPrerequisiteAlgorithmMatches(ctx, header);
  const missingPrerequisites = await findMissingPrerequisites(ctx, header.prerequisites);
  if (missingPrerequisites.length > 0) {
    return buildResult(header, missingPrerequisites);
  }
  // The pack itself is framed at the bundle's OWN declared algorithm — never
  // the surrounding repository's — so a cross-format complete bundle (no
  // prerequisites, hence never refused above) still verifies correctly.
  const packCtx = contextForBundleAlgorithm(ctx, header.hashAlgorithm);
  await verifyPackTrailer(packBytes, packCtx);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — a 0-prerequisite (complete) bundle's pack is self-contained, so no REF_DELTA ever reaches the external resolver; always building it (mutant) only allocates a Map+closure walkPackEntries never invokes — identical outcome for every git-produced bundle, regardless of which algorithm frames the parse.
  const resolver = header.prerequisites.length > 0 ? buildExternalBaseResolver(ctx) : undefined;
  await walkPackEntries(packCtx, packBytes, resolver);
  return buildResult(header, []);
};

/**
 * Cross-format refusal, raised BEFORE the prerequisite-presence lookup: once
 * `findMissingPrerequisites` runs, the distinction between "the repository
 * lacks this commit" (exit 1) and "this oid was never in the repository's
 * algorithm to begin with" (exit 128) is lost — both look like
 * OBJECT_NOT_FOUND. Fires only when prerequisites exist: a cross-format
 * *complete* bundle (no prerequisites) verifies `is okay` in both
 * directions (measured on git 2.55.0), so the guard cannot sit on the
 * header read — `bundleListHeads`, which runs outside a repository
 * entirely, would then need it too.
 */
const assertPrerequisiteAlgorithmMatches = (ctx: Context, header: ParsedBundleHeader): void => {
  const first = header.prerequisites[0];
  if (first === undefined) return;
  if (header.hashAlgorithm === ctx.hashConfig.algorithm) return;
  throw bundlePrerequisiteAlgorithmMismatch(
    first.oid,
    header.hashAlgorithm,
    ctx.hashConfig.algorithm,
  );
};

/**
 * A `Context` reframed onto `algorithm` for the pack-structural reads
 * (trailer digest, entry-header oid width) that must match the BUNDLE's own
 * declared algorithm rather than the surrounding repository's. Resolving a
 * prerequisite's external base object is a genuine repository read and
 * deliberately stays keyed on the original `ctx.hashConfig` — only the pack
 * framing moves.
 *
 * `withAlgorithm` is optional on the port so a caller-supplied `HashService`
 * need not be re-instantiable. When it is absent the bundle's own width is
 * unreachable, and there is no safe fallback: no bundle path may take its
 * width from the surrounding repository, and proceeding at the repository's
 * width reads the pack wrongly (measured: a 32-byte-oid pack read at 20 bytes
 * fails as `INVALID_PACK_HEADER`, a confusing error in place of a clear
 * refusal). Refuse instead, as `clone` does in the same situation.
 *
 * `deriveContext` keeps the session across this hash-algorithm change: the
 * only path that reaches a real algorithm swap is a mismatch with ZERO
 * prerequisites (any mismatch WITH prerequisites already refused in
 * `assertPrerequisiteAlgorithmMatches`, before this runs), and a
 * zero-prerequisite bundle never resolves an external base — so no
 * oid-keyed cache holds an entry at this point. `bundle-verify.test.ts`
 * asserts exactly that.
 */
const contextForBundleAlgorithm = (ctx: Context, algorithm: BundleHashAlgorithm): Context => {
  if (algorithm === ctx.hashConfig.algorithm) return ctx;
  const hash = ctx.hash.withAlgorithm?.(algorithm);
  if (hash === undefined) {
    throw unsupportedOperation(
      'bundle verify',
      `the supplied hash service cannot switch to the bundle's declared algorithm ${algorithm}`,
    );
  }
  return deriveContext(
    ctx,
    { hash, hashConfig: configFor(algorithm) },
    { keepSessionAcrossHashChange: true },
  );
};

const buildResult = (
  header: ParsedBundleHeader,
  missingPrerequisites: ReadonlyArray<ObjectId>,
): BundleVerifyResult => ({
  version: header.version,
  hashAlgorithm: header.hashAlgorithm,
  refs: header.refs,
  prerequisites: header.prerequisites,
  missingPrerequisites,
  prerequisitesPresent: missingPrerequisites.length === 0,
  recordsCompleteHistory: header.prerequisites.length === 0,
  ...(header.filter !== undefined ? { filter: header.filter } : {}),
});

const resolveExternalBase = async (ctx: Context, baseOid: ObjectId) => {
  try {
    const obj = await readObject(ctx, baseOid, { verifyHash: true });
    const raw = serializeObject(obj, ctx.hashConfig);
    const { contentOffset } = parseHeader(raw);
    return { type: obj.type, content: raw.subarray(contentOffset) };
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND') return undefined;
    throw err;
  }
};

const buildExternalBaseResolver = (ctx: Context): ExternalBaseResolver => {
  const cache = new Map<ObjectId, Awaited<ReturnType<ExternalBaseResolver>>>();
  return async (baseOid: ObjectId) => {
    if (cache.has(baseOid)) return cache.get(baseOid);
    const resolved = await resolveExternalBase(ctx, baseOid);
    cache.set(baseOid, resolved);
    return resolved;
  };
};

const findMissingPrerequisites = async (
  ctx: Context,
  prerequisites: ReadonlyArray<BundlePrerequisite>,
): Promise<ReadonlyArray<ObjectId>> => {
  const missing: ObjectId[] = [];
  for (const prereq of prerequisites) {
    if (await isMissingObject(ctx, prereq.oid)) missing.push(prereq.oid);
  }
  return missing;
};

const isMissingObject = async (ctx: Context, oid: ObjectId): Promise<boolean> => {
  try {
    await readObject(ctx, oid, { verifyHash: true });
    return false;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND') return true;
    throw err;
  }
};

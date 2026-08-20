import type {
  BundleHashAlgorithm,
  BundlePrerequisite,
  BundleRef,
  BundleVersion,
  ParsedBundleHeader,
} from '../../domain/bundle/index.js';
import { TsgitError } from '../../domain/error.js';
import { parseHeader, serializeObject } from '../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import { notARepository } from '../../domain/repository/error.js';
import type { Context } from '../../ports/context.js';
import {
  type ExternalBaseResolver,
  verifyPackTrailer,
  walkPackEntries,
} from '../primitives/fetch-pack.js';
import { layoutFailsTrustGate } from '../primitives/internal/layout-verdict.js';
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
  if (!layoutFailsTrustGate(ctx.layout) && ctx.layout.formatRefusal === undefined) return;
  throw notARepository((ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath);
};

export const bundleVerify = async (
  ctx: Context,
  input: BundleVerifyInput,
): Promise<BundleVerifyResult> => {
  assertUsableForBundleVerify(ctx);
  const { header, packBytes } = await readBundle(ctx, input.path);
  const missingPrerequisites = await findMissingPrerequisites(ctx, header.prerequisites);
  if (missingPrerequisites.length > 0) {
    return buildResult(header, missingPrerequisites);
  }
  await verifyPackTrailer(packBytes, ctx);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — a 0-prerequisite (complete) bundle's pack is self-contained, so no REF_DELTA ever reaches the external resolver; always building it (mutant) only allocates a Map+closure walkPackEntries never invokes — identical outcome for every git-produced bundle.
  const resolver = header.prerequisites.length > 0 ? buildExternalBaseResolver(ctx) : undefined;
  await walkPackEntries(ctx, packBytes, resolver);
  return buildResult(header, []);
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
});

const resolveExternalBase = async (ctx: Context, baseOid: ObjectId) => {
  try {
    const obj = await readObject(ctx, baseOid);
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
    await readObject(ctx, oid);
    return false;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND') return true;
    throw err;
  }
};

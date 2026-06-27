import type {
  BundleHashAlgorithm,
  BundlePrerequisite,
  BundleRef,
  BundleVersion,
} from '../../domain/bundle/index.js';
import { TsgitError } from '../../domain/error.js';
import { parseHeader, serializeObject } from '../../domain/objects/index.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import {
  type ExternalBaseResolver,
  verifyPackTrailer,
  walkPackEntries,
} from '../primitives/fetch-pack.js';
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

export const bundleVerify = async (
  ctx: Context,
  input: BundleVerifyInput,
): Promise<BundleVerifyResult> => {
  const { header, packBytes } = await readBundle(ctx, input.path);
  const missingPrerequisites = await findMissingPrerequisites(ctx, header.prerequisites);
  if (missingPrerequisites.length > 0) {
    return buildResult(header, missingPrerequisites);
  }
  await verifyPackTrailer(packBytes, ctx);
  const resolver = header.prerequisites.length > 0 ? buildExternalBaseResolver(ctx) : undefined;
  await walkPackEntries(ctx, packBytes, resolver);
  return buildResult(header, []);
};

const buildResult = (
  header: {
    version: BundleVersion;
    hashAlgorithm: BundleHashAlgorithm;
    refs: ReadonlyArray<BundleRef>;
    prerequisites: ReadonlyArray<BundlePrerequisite>;
  },
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

const buildExternalBaseResolver =
  (ctx: Context): ExternalBaseResolver =>
  async (baseOid: ObjectId) => {
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

import type {
  BundleHashAlgorithm,
  BundlePrerequisite,
  BundleRef,
  BundleVersion,
} from '../../domain/bundle/index.js';
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { verifyPackTrailer, walkPackEntries } from '../primitives/fetch-pack.js';
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
  await verifyPackTrailer(packBytes, ctx);
  await walkPackEntries(ctx, packBytes);
  const missingPrerequisites = await findMissingPrerequisites(ctx, header.prerequisites);
  return {
    version: header.version,
    hashAlgorithm: header.hashAlgorithm,
    refs: header.refs,
    prerequisites: header.prerequisites,
    missingPrerequisites,
    prerequisitesPresent: missingPrerequisites.length === 0,
    recordsCompleteHistory: header.prerequisites.length === 0,
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

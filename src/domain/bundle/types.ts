import type { ObjectId, RefName } from '../objects/object-id.js';

export type BundleVersion = 2 | 3;
export type BundleHashAlgorithm = 'sha1';

export interface BundleRef {
  readonly oid: ObjectId;
  readonly name: RefName;
}

export interface BundlePrerequisite {
  readonly oid: ObjectId;
  readonly comment: string;
}

export interface ParsedBundleHeader {
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly refs: ReadonlyArray<BundleRef>;
  readonly packOffset: number;
}

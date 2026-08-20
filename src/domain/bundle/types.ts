import type { ObjectId, RefName } from '../objects/object-id.js';
import type { ObjectFilter } from '../protocol/object-filter.js';

export type BundleVersion = 2 | 3;
export type BundleHashAlgorithm = 'sha1' | 'sha256';

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
  readonly filter?: ObjectFilter;
  readonly packOffset: number;
}

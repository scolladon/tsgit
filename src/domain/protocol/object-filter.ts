/**
 * Partial-clone object filters (`--filter=<spec>`).
 *
 * tsgit never evaluates a filter itself — the server does. This module only
 * validates a spec and renders its canonical wire form. Supported specs
 * (ADR-078): `blob:none`, `blob:limit=<n>[kmg]`, `tree:<depth>`.
 */
import { invalidFilterSpec } from './error.js';

export type ObjectFilter =
  | { readonly kind: 'blob-none' }
  | { readonly kind: 'blob-limit'; readonly bytes: number }
  | { readonly kind: 'tree-depth'; readonly depth: number };

const BLOB_LIMIT_PREFIX = 'blob:limit=';
const TREE_PREFIX = 'tree:';

/** k/m/g size suffixes for `blob:limit`, matching git's `git_parse_ulong`. */
const SIZE_MULTIPLIER: Readonly<Record<string, number>> = {
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

const BLOB_LIMIT_RE = /^(\d+)([kmg])?$/i;
const DEPTH_RE = /^\d+$/;

const parseBlobLimit = (spec: string): ObjectFilter => {
  const match = spec.slice(BLOB_LIMIT_PREFIX.length).match(BLOB_LIMIT_RE);
  if (match === null) {
    throw invalidFilterSpec(spec, 'bad-blob-limit');
  }
  const digits = match[1] as string;
  const suffix = match[2];
  const base = Number(digits);
  const multiplier = suffix === undefined ? 1 : (SIZE_MULTIPLIER[suffix.toLowerCase()] as number);
  const bytes = base * multiplier;
  if (!Number.isSafeInteger(bytes)) {
    throw invalidFilterSpec(spec, 'bad-blob-limit');
  }
  return { kind: 'blob-limit', bytes };
};

const parseTreeDepth = (spec: string): ObjectFilter => {
  const rest = spec.slice(TREE_PREFIX.length);
  if (!DEPTH_RE.test(rest)) {
    throw invalidFilterSpec(spec, 'bad-tree-depth');
  }
  const depth = Number(rest);
  if (!Number.isSafeInteger(depth)) {
    throw invalidFilterSpec(spec, 'bad-tree-depth');
  }
  return { kind: 'tree-depth', depth };
};

/**
 * Parse a CLI / config / wire filter spec. Pure and total — validates without
 * touching the network. Throws `INVALID_FILTER_SPEC` (with a machine-stable
 * `reason`) on any unsupported or malformed spec.
 */
export const parseObjectFilter = (spec: string): ObjectFilter => {
  if (spec === '') {
    throw invalidFilterSpec(spec, 'empty');
  }
  if (spec === 'blob:none') {
    return { kind: 'blob-none' };
  }
  if (spec.startsWith(BLOB_LIMIT_PREFIX)) {
    return parseBlobLimit(spec);
  }
  if (spec.startsWith(TREE_PREFIX)) {
    return parseTreeDepth(spec);
  }
  throw invalidFilterSpec(spec, 'unknown-kind');
};

/** Render an `ObjectFilter` to its canonical wire/config form. */
export const formatObjectFilter = (filter: ObjectFilter): string => {
  switch (filter.kind) {
    case 'blob-none':
      return 'blob:none';
    case 'blob-limit':
      return `${BLOB_LIMIT_PREFIX}${filter.bytes}`;
    case 'tree-depth':
      return `${TREE_PREFIX}${filter.depth}`;
  }
};

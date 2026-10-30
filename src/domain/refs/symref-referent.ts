/**
 * git's root-ref and symref-referent grammar. Pure predicates — no I/O.
 */
import { isSafeRefName } from './ref-validation.js';
import { FETCH_HEAD, MERGE_HEAD } from './state-files.js';

const ROOT_REF_CHARS = /^[A-Z_-]+$/;
const HEAD_NAME = 'HEAD';
const HEAD_SUFFIX = '_HEAD';
const REFS_PREFIX = 'refs/';

/** Root refs whose names do not follow the `_HEAD` convention. */
const IRREGULAR_ROOT_REFS: ReadonlySet<string> = new Set([
  'AUTO_MERGE',
  'BISECT_EXPECTED_REV',
  'MERGE_AUTOSTASH',
  'NOTES_MERGE_PARTIAL',
  'NOTES_MERGE_REF',
]);

/** Pseudorefs live beside the ref backend, so they are never root refs. */
const PSEUDO_REFS: ReadonlySet<string> = new Set([FETCH_HEAD, MERGE_HEAD]);

const hasRootRefShape = (name: string): boolean =>
  name === HEAD_NAME || name.endsWith(HEAD_SUFFIX) || IRREGULAR_ROOT_REFS.has(name);

/** git's `is_root_ref`: the names stored as a file directly under the gitdir. */
export const isRootRefName = (name: string): boolean =>
  ROOT_REF_CHARS.test(name) && hasRootRefShape(name) && !PSEUDO_REFS.has(name);

/** What a symref body may point at: a root ref, or a well-formed multi-component name. */
export const isValidSymrefReferent = (referent: string): boolean =>
  isRootRefName(referent) || (referent.includes('/') && isSafeRefName(referent));

/** True when `referent` is neither a root ref nor under `refs/`. */
export const isOutsideRefsNamespace = (referent: string): boolean =>
  !isRootRefName(referent) && !referent.startsWith(REFS_PREFIX);

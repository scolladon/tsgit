import { errorDataCode } from '../error-data-code.js';
import type { RefName } from '../objects/index.js';
import { invalidRef } from './error.js';

const INVALID_REF = 'INVALID_REF';

const FORBIDDEN_SIMPLE = new Set(['~', '^', ':', '?', '*', '[', '\\', ' ']);

function throwIfBadChars(name: string): void {
  // Stryker disable next-line EqualityOperator: equivalent — at i === name.length, charCodeAt returns NaN (no guard fires) and name[i] is undefined (skipped), so the extra iteration is observably inert.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw invalidRef('ref name contains forbidden character');
    }
    const ch = name[i];
    if (ch !== undefined && FORBIDDEN_SIMPLE.has(ch)) {
      throw invalidRef('ref name contains forbidden character');
    }
    // U+202A..U+202E (LRE/RLE/PDF/LRO/RLO) and U+2066..U+2069 (LRI/RLI/FSI/PDI)
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      throw invalidRef('ref name contains forbidden Unicode override');
    }
  }
}

export function validateRefName(name: string): RefName {
  if (name === '') {
    throw invalidRef('ref name must not be empty');
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    throw invalidRef('ref name must not start or end with /');
  }
  if (name.startsWith('-')) {
    throw invalidRef('ref name must not start with -');
  }
  if (name === '@') {
    throw invalidRef('ref name must not be single @');
  }
  if (name.includes('..')) {
    throw invalidRef('ref name must not contain ..');
  }
  if (name.includes('//')) {
    throw invalidRef('ref name must not contain consecutive slashes');
  }
  if (name.includes('@{')) {
    throw invalidRef('ref name must not contain @{');
  }
  if (name.endsWith('.')) {
    throw invalidRef('ref name must not end with .');
  }
  throwIfBadChars(name);

  const components = name.split('/');
  for (const component of components) {
    if (component.startsWith('.')) {
      throw invalidRef('ref name component must not start with .');
    }
    if (component.endsWith('.lock')) {
      throw invalidRef('ref name component must not end with .lock');
    }
  }

  return name as RefName;
}

export function isSafeRefName(name: string): boolean {
  try {
    validateRefName(name);
    return true;
  } catch (error) {
    if (errorDataCode(error) === INVALID_REF) return false;
    throw error;
  }
}

const REFS_PREFIX = 'refs/';
/** git's root-ref syntax outside `refs/`: uppercase letters and underscores. */
const ROOT_REF_SYNTAX = /^[A-Z_]+$/;
const BAD_NAME_REFUSAL = 'refusing to update ref with bad name';

/** Components `normalize_path_copy` rewrites; a `.`-led name such as `.x` is kept. */
const REWRITTEN_COMPONENTS: ReadonlySet<string> = new Set(['', '.', '..']);

/**
 * Whether `rest` is its own `normalize_path_copy` image: no empty, `.` or `..` component.
 * An empty rest, and one that starts or ends with `/`, which git refuses before normalizing,
 * each hold an empty component.
 */
const isNormalizedPath = (rest: string): boolean =>
  rest.split('/').every((component) => !REWRITTEN_COMPONENTS.has(component));

/** git's refname_is_safe: refs/ plus a rest that normalizes to itself, or [A-Z_]+. */
export const isRefnameSafe = (name: RefName): boolean => {
  if (name.startsWith(REFS_PREFIX)) return isNormalizedPath(name.slice(REFS_PREFIX.length));
  return ROOT_REF_SYNTAX.test(name);
};

/** git's transaction_refname_valid for an update without a new id: refuses an unsafe name. */
export const assertRefnameSafe = (name: RefName): void => {
  if (!isRefnameSafe(name)) throw invalidRef(BAD_NAME_REFUSAL);
};

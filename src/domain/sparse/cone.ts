import { invalidOption } from '../commands/error.js';
import type { FilePath } from '../objects/object-id.js';
import type { SparseMatcher, SparseSpec } from './sparse-pattern.js';

type ConeSpec = Extract<SparseSpec, { mode: 'cone' }>;

/**
 * Non-empty proper ancestor directory paths of `dir`, deepest first.
 * `properAncestors('a/b/c') = ['a/b', 'a']`. The repository root (`''`) is
 * deliberately excluded — `coneMatcher` handles root files separately.
 */
const properAncestors = (dir: string): ReadonlyArray<string> => {
  const segments = dir.split('/');
  const ancestors: string[] = [];
  // Stryker disable next-line ArithmeticOperator: equivalent — starting `count` at `length + 1` only prepends `dir` itself (`slice(0, count > length)` returns the whole array), which every caller already handles separately: `buildConeSpec` filters it via `recursive.has`, `underRecursive` checks `recursive.has(dir)` before the loop.
  for (let count = segments.length - 1; count > 0; count -= 1) {
    ancestors.push(segments.slice(0, count).join('/'));
  }
  return ancestors;
};

/**
 * Normalise a user-supplied cone directory: POSIX separators, strip leading
 * and trailing `/`. Rejects `.`/`..`/empty segments and the glob
 * metacharacters `*`/`?` — a cone input is a directory, not a pattern. A
 * directory that normalises to the empty string splits to a single empty
 * segment, so the empty-segment guard rejects it.
 */
const normalizeConeDir = (raw: string): string => {
  const posix = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  for (const segment of posix.split('/')) {
    rejectBadSegment(segment, raw);
  }
  return posix;
};

const rejectBadSegment = (segment: string, raw: string): void => {
  if (segment === '' || segment === '.' || segment === '..') {
    throw invalidOption('patterns', `cone directory has an invalid segment: ${raw}`);
  }
  if (segment.includes('*') || segment.includes('?')) {
    throw invalidOption('patterns', `cone directory must not contain glob metacharacters: ${raw}`);
  }
};

/**
 * Build a cone spec from the user's directory list. `R` (recursive) is the
 * normalised directories; `P` (parents) is every proper ancestor of an `R`
 * directory that is not itself in `R`.
 */
export const buildConeSpec = (dirs: ReadonlyArray<string>): ConeSpec => {
  const recursive = new Set(dirs.map(normalizeConeDir));
  const parents = new Set<string>();
  for (const dir of recursive) {
    for (const ancestor of properAncestors(dir)) {
      if (!recursive.has(ancestor)) parents.add(ancestor);
    }
  }
  return { mode: 'cone', recursive, parents };
};

/** Directory portion of a path; `''` for a root-level file. */
const dirname = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

/** True when `dir` is, or is a descendant of, a recursive directory. */
const underRecursive = (dir: string, recursive: ReadonlySet<string>): boolean => {
  if (recursive.has(dir)) return true;
  for (const ancestor of properAncestors(dir)) {
    if (recursive.has(ancestor)) return true;
  }
  return false;
};

/**
 * Build a matcher for a cone spec. A path is included iff its parent
 * directory is the root, OR is a parent dir, OR is under a recursive dir.
 */
export const coneMatcher = (spec: ConeSpec): SparseMatcher => {
  return (path: FilePath): boolean => {
    const dir = dirname(path);
    if (dir === '') return true;
    if (spec.parents.has(dir)) return true;
    return underRecursive(dir, spec.recursive);
  };
};

const CONE_HEADER = '/*\n!/*/\n';

/**
 * Serialize a cone spec into git's exact cone-file shape: the header pair,
 * then every dir in `sort(P union R)` — a parent dir emits its `/d/` line
 * plus the negated wildcard line, a recursive dir emits only `/d/`.
 */
export const serializeCone = (spec: ConeSpec): string => {
  const all = [...spec.parents, ...spec.recursive].sort();
  let body = '';
  for (const dir of all) {
    body += `/${dir}/\n`;
    if (spec.parents.has(dir)) body += `!/${dir}/*/\n`;
  }
  return CONE_HEADER + body;
};

/**
 * Recognise git's cone-file grammar back into a cone spec. Returns
 * `undefined` for any text that is not exactly cone-shaped — the caller then
 * falls back to non-cone matching of the same text.
 */
export const parseCone = (text: string): ConeSpec | undefined => {
  const lines = text.split('\n');
  if (lines[0] !== '/*' || lines[1] !== '!/*/') return undefined;
  const recursive = new Set<string>();
  const parents = new Set<string>();
  let index = 2;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line === '') {
      index += 1;
      continue;
    }
    const dir = parseConeDirLine(line);
    if (dir === undefined) return undefined;
    index += 1;
    if (lines[index] === `!/${dir}/*/`) {
      parents.add(dir);
      index += 1;
    } else {
      recursive.add(dir);
    }
  }
  return { mode: 'cone', recursive, parents };
};

/** Extract `<d>` from a `/<d>/` line, or `undefined` when it is not one. */
const parseConeDirLine = (line: string): string | undefined => {
  if (!line.startsWith('/') || !line.endsWith('/')) return undefined;
  const inner = line.slice(1, -1);
  if (inner === '' || inner.startsWith('!')) return undefined;
  return inner;
};

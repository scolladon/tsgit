import { pathspecOutsideRepo } from './commands/error.js';
import type { FilePath } from './objects/object-id.js';

const MAX_PATH_BYTES = 4096;
const MAX_COMPONENT_BYTES = 255;
const PATH_ENCODER = new TextEncoder();

// `.git` reject is enforced via the regex strip in isForbiddenGitComponent
// below; the explicit set carries only the canonical literal for clarity.
const GIT_FORBIDDEN: ReadonlySet<string> = new Set(['.git']);

/**
 * Validate a working-tree path. Throws `PATHSPEC_OUTSIDE_REPO` for any policy
 * violation. Returns the input as a `FilePath` brand on success.
 *
 * Rules (cross-platform safe; conservative):
 * - Non-empty.
 * - No leading `/` (absolute paths are forbidden).
 * - No `\` (use POSIX separators).
 * - No NUL bytes.
 * - Components allowed-char set: no control characters (0x00-0x1F, 0x7F).
 * - No `.` or `..` components, no empty components.
 * - No `.git` component (case-insensitive). Also rejects NTFS quirks
 *   `.git ` (trailing space), `.git.` (trailing dot), and other prefix-of-`.git`
 *   variants.
 * - Length caps: total path ≤ 4096 bytes; each component ≤ 255 bytes.
 */
export const validateWorkingTreePath = (input: string): FilePath => {
  if (input === '') reject(input);
  if (byteLength(input) > MAX_PATH_BYTES) reject(input);
  if (input.startsWith('/')) reject(input);
  if (input.includes('\\')) reject(input);
  if (input.includes('\0')) reject(input);
  const components = input.split('/');
  for (const component of components) {
    rejectComponent(component, input);
  }
  return input as FilePath;
};

/**
 * True if `component` is `.git` or one of its NTFS-stripped variants
 * (case-insensitive, trailing-dot/space-trimmed). Used by the working-tree
 * walker to skip the host repo's metadata directory and by the path
 * validator to reject paths that would traverse into it.
 */
export const isForbiddenGitComponent = (component: string): boolean => {
  const lowered = component.toLowerCase();
  if (GIT_FORBIDDEN.has(lowered)) return true;
  // NTFS strips trailing spaces/dots — treat any `.git` followed only by
  // whitespace/dots as `.git` (defensive against future variants).
  const trimmed = lowered.replace(/[. ]+$/, '');
  return trimmed === '.git';
};

const reject = (input: string): never => {
  throw pathspecOutsideRepo(input as FilePath);
};

const rejectComponent = (component: string, original: string): void => {
  if (component === '') reject(original); // empty component → trailing slash or // sequence.
  if (component === '.' || component === '..') reject(original);
  if (byteLength(component) > MAX_COMPONENT_BYTES) reject(original);
  if (isForbiddenGitComponent(component)) reject(original);
  // Reject `:` to block NTFS Alternate Data Streams (`.git:$DATA`) and
  // Windows drive-letter qualifiers (`C:relative`). POSIX paths never need `:`.
  if (component.includes(':')) reject(original);
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) reject(original);
  }
};

const byteLength = (s: string): number => PATH_ENCODER.encode(s).length;

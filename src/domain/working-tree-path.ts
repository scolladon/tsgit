import { pathspecOutsideRepo } from './commands/error.js';
import type { FilePath } from './objects/object-id.js';
import { isDotGitAlias } from './path/verify-path.js';

const MAX_PATH_BYTES = 4096;
const MAX_COMPONENT_BYTES = 255;
const PATH_ENCODER = new TextEncoder();

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
 * - No `.git` component, or one of its NTFS (`git~1`, `.git:`-stream) /
 *   HFS+ (ignorable-codepoint) aliases — see `isDotGitAlias`.
 * - Length caps: total path ≤ 4096 bytes; each component ≤ 255 bytes.
 */
export const validateWorkingTreePath = (input: string): FilePath => {
  rejectInputShape(input);
  const components = input.split('/');
  for (const component of components) {
    rejectComponent(component, input);
  }
  return input as FilePath;
};

/**
 * Narrow defence-in-depth for a walker consuming raw `readdir` entries
 * (`walk-working-tree.ts`): the same traversal/injection protections as
 * {@link validateWorkingTreePath} — absolute path, backslash, NUL,
 * dot/dotdot/empty component, control characters, length caps — MINUS the
 * `.git`-alias and `:` rejections. A directory a real filesystem legitimately
 * returns named `git~1`, `.git:stream`, or carrying an HFS ignorable
 * codepoint is not a traversal hazard; the walk boundary must surface it
 * exactly as git's own directory walk does (only an exact, case-folded
 * `.git` collapses there — see `isDotGitWalkEntry`). The widened alias/`:`
 * rejection stays exclusive to `validateWorkingTreePath`'s other callers
 * (user pathspec input, tree/index boundaries), where it is the correct,
 * intentional refusal.
 */
export const validateWalkedEntryPath = (input: string): FilePath => {
  rejectInputShape(input);
  const components = input.split('/');
  for (const component of components) {
    rejectTraversalShape(component, input);
  }
  return input as FilePath;
};

const reject = (input: string): never => {
  throw pathspecOutsideRepo(input as FilePath);
};

const rejectInputShape = (input: string): void => {
  // Stryker disable next-line ConditionalExpression: equivalent — when this fast-path guard is removed (`if (false)`), the empty string still splits to `['']`, whose empty component is rejected by `rejectTraversalShape` with the identical `pathspecOutsideRepo('')` error.
  if (input === '') reject(input);
  if (byteLength(input) > MAX_PATH_BYTES) reject(input);
  // Stryker disable next-line ConditionalExpression,MethodExpression: equivalent — a leading or trailing `/` always produces an empty path component, which `rejectTraversalShape` rejects regardless; this guard only changes which line throws, not the accept/reject verdict or the error data.
  if (input.startsWith('/')) reject(input);
  if (input.includes('\\')) reject(input);
  // Stryker disable next-line ConditionalExpression: equivalent — a NUL byte is code 0x00, always `<= 0x1f`, so the per-component control-char scan rejects it regardless of this fast-path guard.
  if (input.includes('\0')) reject(input);
};

const rejectTraversalShape = (component: string, original: string): void => {
  if (component === '') reject(original); // empty component → trailing slash or // sequence.
  if (component === '.' || component === '..') reject(original);
  if (byteLength(component) > MAX_COMPONENT_BYTES) reject(original);
  // Stryker disable next-line EqualityOperator: equivalent — `i <= component.length` reads one past the end where `charCodeAt` returns NaN; `NaN <= 0x1f` and `NaN === 0x7f` are both false, so the extra iteration never rejects.
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) reject(original);
  }
};

const rejectComponent = (component: string, original: string): void => {
  rejectTraversalShape(component, original);
  if (isDotGitAlias(component)) reject(original);
  // Reject `:` to block NTFS Alternate Data Streams (`.git:$DATA`) and
  // Windows drive-letter qualifiers (`C:relative`). POSIX paths never need `:`.
  if (component.includes(':')) reject(original);
};

const byteLength = (s: string): number => PATH_ENCODER.encode(s).length;

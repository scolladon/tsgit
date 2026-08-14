/**
 * Path-policy abstraction.
 *
 * Encapsulates every platform-aware path operation the Node adapter needs.
 * Production code uses `nativePolicy` (host-matching). Tests inject
 * `windowsPolicy` or `posixPolicy` to simulate either platform on any host,
 * eliminating the "host vs. simulated platform" confusion that was
 * leaking into containment / cache / errno code paths.
 *
 * Design notes:
 * - `sep` is the platform separator string, used for prefix containment.
 * - Three independent capability flags — `caseInsensitive`, `windowsSyntax`,
 *  `honoursNoFollow` — each say exactly what they gate, so a policy that
 *  mixes capabilities (e.g. a hypothetical case-insensitive POSIX
 *  filesystem) sets each on its own merits instead of one flag standing in
 *  for all three. `caseInsensitive` drives ONLY the case-fold in
 *  `normalizeForCompare`; tsgit treats macOS as case-sensitive per Git's
 *  `core.ignorecase` default and POSIX convention, so no shipped policy
 *  sets it without also being Windows today.
 * - `windowsSyntax` drives the Windows-shaped parsing: `rootOf`'s
 *  UNC/drive-letter recognition and `normalizeForCompare`'s extended-prefix
 *  strip + `/`→`\` fold.
 * - `honoursNoFollow` says whether the platform's `open(2)` refuses a
 *  symlink leaf when passed `O_NOFOLLOW`. `false` means the write guard
 *  must fall back to an explicit pre-write `lstat` (see
 *  `NodeFileSystem.assertWritableLeaf`).
 * - `rootOf` returns the volume/drive prefix produced by `path.parse`.
 *  Examples: `/` on POSIX, `'C:\\'` on Windows, `'\\\\server\\share\\'`
 *  for UNC paths.
 * - The interface is *only* the subset NodeFileSystem actually needs; we
 *  intentionally do not expose all of `nodePath`'s surface so callers
 *  can't smuggle host-bound calls back in.
 */

import * as nodePath from 'node:path';

/**
 * The minimal `nodePath`-shaped surface that `makePolicy` consumes.
 * Replaces `typeof nodePath.posix` which admitted both `posix` and
 * `win32` (confusing intent) and exposed every member of the namespace
 * instead of just the ones used. TypeScript cannot block the host
 * `nodePath` namespace from satisfying this structurally; `makePolicy`
 * stays module-private and the only public entry points are the
 * `posixPolicy` / `windowsPolicy` constants.
 *
 * @internal
 */
interface PathPolicySource {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
}

export interface PathPolicy {
  readonly sep: '\\' | '/';
  /** Case-fold comparisons (`normalizeForCompare` lowercases). Nothing else. */
  readonly caseInsensitive: boolean;
  /**
   * Windows path syntax: `rootOf` recognises UNC/drive-letter roots and
   * `normalizeForCompare` applies the extended-prefix strip + `/`→`\` fold.
   */
  readonly windowsSyntax: boolean;
  /**
   * Whether this platform's `open(2)` honours `O_NOFOLLOW` against a
   * symlink leaf. `false` forces write surfaces onto an explicit pre-write
   * `lstat` fallback instead of relying on the syscall flag.
   */
  readonly honoursNoFollow: boolean;
  isAbsolute(path: string): boolean;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  /**
   * Returns the volume/drive prefix produced by `path.parse(p).root`.
   * POSIX: `/` for absolute, `''` for relative.
   * Windows: `'C:\\'`, `'\\\\server\\share\\'`, or `''` for relative.
   */
  rootOf(path: string): string;
  /** Case-fold on case-insensitive platforms; identity otherwise. */
  normalizeForCompare(path: string): string;
}

/**
 * Narrows `nodePath.{posix,win32}.sep` (typed as `string` in `@types/node`)
 * to the literal union the `PathPolicy` interface declares, without an
 * `as` escape. Throws on any other value so a future export of
 * `makePolicy` cannot silently accept an unknown separator.
 *
 * @internal — exported only so the throw arm can be unit-tested.
 */
export const narrowSep = (sep: string): '\\' | '/' => {
  if (sep !== '\\' && sep !== '/') {
    throw new Error(`PathPolicy: unsupported separator ${JSON.stringify(sep)}`);
  }
  return sep;
};

/** Win32 extended-length (`\\?\`) and its UNC variant, plus the plain UNC root. */
const WIN_EXTENDED_PREFIX = '\\\\?\\';
const WIN_EXTENDED_UNC_PREFIX = '\\\\?\\UNC\\';
const WIN_UNC_ROOT = '\\\\';

/**
 * Collapses a Windows extended-length path to its plain form:
 * `\\?\C:\…` → `C:\…`, `\\?\UNC\server\share\…` → `\\server\share\…`.
 *
 * Without this, a `realpath` result carrying the prefix would fail the
 * prefix test in `pathContains` against an otherwise-identical plain sibling
 * — a spurious out-of-tree denial. The UNC arm must precede the bare arm:
 * `\\?\` is itself a prefix of `\\?\UNC\`.
 *
 * The `UNC` token is matched case-sensitively by design: this helper only
 * ever receives `realpath` output, and Win32 `GetFinalPathNameByHandle`
 * (behind Node's `fs.realpath`) always emits the token uppercase.
 */
const stripWinExtendedPrefix = (p: string): string => {
  if (p.startsWith(WIN_EXTENDED_UNC_PREFIX)) {
    return WIN_UNC_ROOT + p.slice(WIN_EXTENDED_UNC_PREFIX.length);
  }
  if (p.startsWith(WIN_EXTENDED_PREFIX)) {
    return p.slice(WIN_EXTENDED_PREFIX.length);
  }
  return p;
};

/** POSIX root: `/` for an absolute path, `''` otherwise. No allocation. */
const posixRootOf = (path: string): string => (path.startsWith('/') ? '/' : '');

/** A plain UNC root (`\\server\share\`) — two non-separator segments after the leading `\\`. */
const WIN_UNC_ROOT_PATTERN = /^\\\\[^\\]+\\[^\\]+\\/;
/** A drive-absolute root (`C:\`). */
const WIN_DRIVE_ROOT_PATTERN = /^[a-zA-Z]:\\/;

/**
 * Windows root, without `path.win32.parse`'s full-path allocation: a UNC
 * share prefix, a drive-absolute prefix, or `''` for anything else
 * (drive-relative and plain-relative paths alike — `rootOf`'s only caller,
 * `realpathNearestExisting`, only ever receives an absolute path).
 */
const windowsRootOf = (path: string): string => {
  const uncMatch = WIN_UNC_ROOT_PATTERN.exec(path);
  if (uncMatch !== null) return uncMatch[0];
  return WIN_DRIVE_ROOT_PATTERN.test(path) ? path.slice(0, 3) : '';
};

/**
 * The three platform-capability flags a policy factory sets independently
 * of one another — see the module header's design notes for what each one
 * gates.
 */
interface PathPolicyCapabilities {
  readonly caseInsensitive: boolean;
  readonly windowsSyntax: boolean;
  readonly honoursNoFollow: boolean;
}

/**
 * `PathPolicy.rootOf`, parameterised directly on the `windowsSyntax`
 * capability rather than closed over a constructed `PathPolicy` — lets a
 * capability combination no exported policy carries (e.g. a hypothetical
 * case-insensitive POSIX filesystem) be pinned in isolation, without
 * exporting `makePolicy` itself.
 * @internal — exported only for that combinatorial test coverage.
 */
export const rootOfForSyntax = (windowsSyntax: boolean, path: string): string =>
  windowsSyntax ? windowsRootOf(path) : posixRootOf(path);

/**
 * `PathPolicy.normalizeForCompare`, parameterised directly on
 * `windowsSyntax` (extended-prefix strip + `/`→`\` fold) and
 * `caseInsensitive` (lowercase) rather than closed over a constructed
 * `PathPolicy` — see `rootOfForSyntax`. The two folds are independent: a
 * `joinPath`-produced path carries `/` unconditionally even on Windows, so
 * the separator fold is gated on `windowsSyntax` alone, never on whether
 * the platform also happens to be case-insensitive.
 * @internal
 */
export const normalizeForCompareWithCapabilities = (
  capabilities: Pick<PathPolicyCapabilities, 'caseInsensitive' | 'windowsSyntax'>,
  path: string,
): string => {
  const syntaxNormalized = capabilities.windowsSyntax
    ? stripWinExtendedPrefix(path).replaceAll('/', '\\')
    : path;
  return capabilities.caseInsensitive ? syntaxNormalized.toLowerCase() : syntaxNormalized;
};

const makePolicy = (impl: PathPolicySource, capabilities: PathPolicyCapabilities): PathPolicy => ({
  sep: narrowSep(impl.sep),
  ...capabilities,
  isAbsolute: (path: string) => impl.isAbsolute(path),
  resolve: (...parts: string[]) => impl.resolve(...parts),
  join: (...parts: string[]) => impl.join(...parts),
  dirname: (path: string) => impl.dirname(path),
  basename: (path: string) => impl.basename(path),
  rootOf: (path: string) => rootOfForSyntax(capabilities.windowsSyntax, path),
  normalizeForCompare: (path: string) => normalizeForCompareWithCapabilities(capabilities, path),
});

export const posixPolicy: PathPolicy = makePolicy(nodePath.posix, {
  caseInsensitive: false,
  windowsSyntax: false,
  honoursNoFollow: true,
});
export const windowsPolicy: PathPolicy = makePolicy(nodePath.win32, {
  caseInsensitive: true,
  windowsSyntax: true,
  honoursNoFollow: false,
});

/**
 * Pick the policy that matches the given platform string. Extracted as a
 * pure helper so both arms are unit-testable on any host (the inline
 * `process.platform` branch is otherwise only ever exercised on its native
 * arm and hides the other from coverage / mutation testing).
 * @internal
 */
export const selectNativePolicy = (platform: NodeJS.Platform): PathPolicy =>
  platform === 'win32' ? windowsPolicy : posixPolicy;

/** Host-matching policy — chosen by `process.platform`. */
export const nativePolicy: PathPolicy = selectNativePolicy(process.platform);

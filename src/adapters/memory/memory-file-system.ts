import {
  directoryNotEmpty,
  fileExists,
  fileNotFound,
  notADirectory,
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../domain/index.js';
import { collapsePosixSegments } from '../../domain/path/collapse-posix-segments.js';
import type { DirEntry, FileHandle, FileStat, FileSystem } from '../../ports/file-system.js';

const DEFAULT_HOME = '/home/user';
const DEFAULT_XDG_CONFIG_HOME = '/home/user/.config';
const DEFAULT_SYSTEM_CONFIG = '/etc/gitconfig';

export interface MemoryFileSystemOptions {
  readonly rootDir: string;
  readonly files?: Readonly<Record<string, Uint8Array>>;
  readonly home?: string;
  readonly xdg?: string;
  readonly systemConfig?: string;
}

interface Timestamps {
  readonly ctimeMs: number;
  readonly mtimeMs: number;
}

const MEMORY_FILE_MODE = 0o100644;

// POSIX's invalid-argument errno name — the literal `mapErrno`'s `default` arm forwards for
// "an attempt was made to make a directory a subdirectory of itself".
const INVALID_ARGUMENT = 'EINVAL';

/** Whether a resolution follows a symbolic link at its final component. */
type LeafResolution = 'follow' | 'no-follow';

/**
 * How a surface walks its path: `'follow'` and `'no-follow'` decide the final component alone;
 * `'create'` does not follow it either, and also refuses to pass through a symbolic link whose
 * target is not a directory, since the entry would otherwise be filed under the link's target.
 */
type WalkMode = LeafResolution | 'create';

interface WalkContext {
  readonly path: string;
  readonly mode: WalkMode;
  // Shared by every link one resolution follows, nested link texts included, so a cycle that
  // only ever passes through intermediate components still exhausts the one budget.
  hops: number;
}

export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();
  private readonly symlinks = new Map<string, string>();
  private readonly times = new Map<string, Timestamps>();
  private readonly rootDir: string;
  private readonly homePath: string;
  private readonly xdgPath: string;
  private readonly systemPath: string;

  constructor(options: MemoryFileSystemOptions) {
    this.rootDir = options.rootDir;
    this.homePath = options.home ?? DEFAULT_HOME;
    this.xdgPath = options.xdg ?? DEFAULT_XDG_CONFIG_HOME;
    this.systemPath = options.systemConfig ?? DEFAULT_SYSTEM_CONFIG;
    this.directories.add(this.rootDir);
    for (const [key, value] of Object.entries(options.files ?? {})) {
      const normalized = this.resolve(key);
      // A seeded file may not land where an earlier key already made a directory — the one
      // route by which `files` and `directories` could otherwise share a key.
      if (this.directories.has(normalized)) throw notADirectory(key);
      this.files.set(normalized, value.slice());
      this.touch(normalized);
      this.ensureParentDirs(normalized);
    }
  }

  homedir = (): string => this.homePath;
  xdgConfigHome = (): string => this.xdgPath;
  systemConfigPath = (): string => this.systemPath;

  read = async (path: string): Promise<Uint8Array> => {
    const normalized = this.walk(path, 'follow');
    const stored = this.files.get(normalized);
    if (stored === undefined) {
      throw this.absentFileRefusal(normalized, path);
    }
    return stored.slice();
  };

  readSlice = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    if (offset < 0 || length < 0) {
      throw permissionDenied(path);
    }
    const normalized = this.walk(path, 'follow');
    const stored = this.files.get(normalized);
    if (stored === undefined) {
      throw this.absentFileRefusal(normalized, path);
    }
    const end = Math.min(offset + length, stored.length);
    return stored.slice(offset, end);
  };

  /** A directory where a file read was expected refuses PERMISSION_DENIED, as Node's EISDIR does. */
  private absentFileRefusal(normalized: string, path: string): TsgitError {
    return this.directories.has(normalized) ? permissionDenied(path) : fileNotFound(path);
  }

  readUtf8 = async (path: string): Promise<string> => {
    const bytes = await this.read(path);
    return new TextDecoder().decode(bytes);
  };

  write = async (path: string, data: Uint8Array): Promise<void> => {
    const normalized = this.walk(path, 'create');
    // node: EISDIR for a directory leaf, ELOOP for a symlink leaf under O_NOFOLLOW —
    // mapErrno sends both to PERMISSION_DENIED.
    if (this.directories.has(normalized) || this.symlinks.has(normalized)) {
      throw permissionDenied(path);
    }
    this.ensureParentDirs(normalized);
    this.files.set(normalized, data.slice());
    this.touch(normalized);
  };

  writeStream = async (path: string, source: AsyncIterable<Uint8Array>): Promise<void> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    await this.write(path, out);
  };

  writeExclusive = async (path: string, data: Uint8Array): Promise<void> => {
    const normalized = this.walk(path, 'create');
    if (this.occupied(normalized)) {
      throw fileExists(path);
    }
    this.ensureParentDirs(normalized);
    this.files.set(normalized, data.slice());
    this.touch(normalized);
  };

  writeUtf8 = async (path: string, content: string): Promise<void> => {
    await this.write(path, new TextEncoder().encode(content));
  };

  appendUtf8 = async (path: string, content: string): Promise<void> => {
    const existing = await this.readExistingUtf8(path);
    await this.writeUtf8(path, existing + content);
  };

  private async readExistingUtf8(path: string): Promise<string> {
    const stored = this.files.get(this.walk(path, 'no-follow'));
    // `TextDecoder().decode(undefined)` is `''`, so a missing file decodes to
    // the empty string without a separate branch.
    return new TextDecoder().decode(stored);
  }

  exists = async (path: string): Promise<boolean> => {
    const normalized = this.walk(path, 'follow');
    return this.files.has(normalized) || this.directories.has(normalized);
  };

  /** POSIX ELOOP threshold — symlink chains longer than this are cycle-detected. */
  private static readonly SYMLINK_FOLLOW_LIMIT = 40;

  stat = async (path: string): Promise<FileStat> => {
    const normalized = this.walk(path, 'follow');
    return this.buildStat(normalized, path);
  };

  lstat = async (path: string): Promise<FileStat> => {
    const normalized = this.walk(path, 'no-follow');
    const target = this.symlinks.get(normalized);
    if (target !== undefined) {
      return this.makeStatRecord({
        size: target.length,
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        times: this.times.get(normalized),
      });
    }
    return this.buildStat(normalized, path);
  };

  lexists = async (path: string): Promise<boolean> => this.occupied(this.walk(path, 'no-follow'));

  readdir = async (path: string): Promise<ReadonlyArray<DirEntry>> => {
    const normalized = this.walk(path, 'follow');
    if (this.files.has(normalized)) {
      throw notADirectory(path);
    }
    if (!this.directories.has(normalized)) {
      throw fileNotFound(path);
    }
    // rootDir='/' is rejected at construction by resolve(), so normalized is always a
    // non-root path under the configured rootDir; appending '/' is safe.
    const prefix = `${normalized}/`;
    const seen = new Map<string, DirEntry>();
    for (const filePath of this.files.keys()) {
      this.addDirectEntry(filePath, prefix, seen, 'file');
    }
    for (const linkPath of this.symlinks.keys()) {
      this.addDirectEntry(linkPath, prefix, seen, 'symlink');
    }
    for (const dirPath of this.directories) {
      // Stryker disable next-line ConditionalExpression: equivalent — when `dirPath === normalized`, addDirectEntry's `!fullPath.startsWith(prefix)` guard also rejects it, since no string starts with its own strict-superstring trailing-slash prefix.
      if (dirPath === normalized) continue;
      this.addDirectEntry(dirPath, prefix, seen, 'directory');
    }
    return Array.from(seen.values());
  };

  mkdir = async (path: string): Promise<void> => {
    const normalized = this.walk(path, 'create');
    if (this.symlinks.has(normalized)) {
      this.mkdirThroughLeafSymlink(path);
      return;
    }
    // The check below would refuse a file leaf too, but with the normalized key as its
    // path; this guard keeps the caller's string, as every other leaf refusal does.
    if (this.files.has(normalized)) {
      throw notADirectory(path);
    }
    this.addDirectoryRecursive(normalized);
  };

  /**
   * `mkdir` is the one write surface whose leaf follows a symlink: a link to an existing
   * directory is a no-op, a link to a regular file keeps this adapter's own not-a-directory
   * report, and a dangling link refuses without creating its target.
   */
  private mkdirThroughLeafSymlink(path: string): void {
    const followed = this.walk(path, 'follow');
    if (this.directories.has(followed)) return;
    if (this.files.has(followed)) throw notADirectory(path);
    throw fileNotFound(path);
  }

  rm = async (path: string): Promise<void> => {
    const normalized = this.walk(path, 'no-follow');
    if (this.files.has(normalized)) {
      this.files.delete(normalized);
      this.times.delete(normalized);
      return;
    }
    if (this.symlinks.has(normalized)) {
      this.symlinks.delete(normalized);
      this.times.delete(normalized);
      return;
    }
    if (this.directories.has(normalized)) {
      if (this.hasChildren(normalized)) {
        // Mirrors mapErrno's ENOTEMPTY arm on the Node adapter — same
        // condition, same code, so cross-adapter callers can branch on
        // a single discriminator.
        throw directoryNotEmpty(path);
      }
      this.directories.delete(normalized);
      this.times.delete(normalized);
      return;
    }
    throw fileNotFound(path);
  };

  rename = async (src: string, dst: string): Promise<void> => {
    const normalizedSrc = this.walk(src, 'no-follow');
    const normalizedDst = this.walk(dst, 'create');
    this.assertRenamable(normalizedSrc, normalizedDst, src);
    if (normalizedSrc === normalizedDst) return;
    if (this.directories.has(normalizedSrc)) {
      this.renameDirectory(normalizedSrc, normalizedDst);
      return;
    }
    this.renameLeaf(normalizedSrc, normalizedDst);
  };

  // `rename` above is synchronous `Map` surgery with no `await` between the
  // deletes and the sets, so it is already atomic with respect to the event
  // loop; the capability is that guarantee exposed under its own name.
  atomicRename = async (src: string, dst: string): Promise<void> => {
    await this.rename(src, dst);
  };

  private assertRenamable(
    normalizedSrc: string,
    normalizedDst: string,
    reportedPath: string,
  ): void {
    const srcIsDirectory = this.directories.has(normalizedSrc);
    if (!srcIsDirectory && !this.files.has(normalizedSrc) && !this.symlinks.has(normalizedSrc)) {
      throw fileNotFound(reportedPath);
    }
    if (normalizedSrc === normalizedDst) return;
    if (!srcIsDirectory) {
      if (this.directories.has(normalizedDst)) throw permissionDenied(reportedPath);
      return;
    }
    if (normalizedDst.startsWith(`${normalizedSrc}/`)) {
      throw unsupportedOperation('filesystem', INVALID_ARGUMENT);
    }
    if (!this.directories.has(normalizedDst)) {
      if (this.files.has(normalizedDst) || this.symlinks.has(normalizedDst)) {
        throw notADirectory(reportedPath);
      }
      return;
    }
    if (this.hasChildren(normalizedDst)) throw directoryNotEmpty(reportedPath);
  }

  private renameLeaf(normalizedSrc: string, normalizedDst: string): void {
    const fileBytes = this.files.get(normalizedSrc);
    const linkTarget = this.symlinks.get(normalizedSrc);
    // Invariant: files.set / symlinks.set always touch(); rm always deletes the timestamp.
    // So when a file or symlink exists at src, times.get(src) is guaranteed to be defined.
    const timestamp = this.times.get(normalizedSrc) as Timestamps;
    this.ensureParentDirs(normalizedDst);
    this.files.delete(normalizedDst);
    this.symlinks.delete(normalizedDst);
    this.times.delete(normalizedDst);
    if (fileBytes !== undefined) {
      this.files.delete(normalizedSrc);
      this.files.set(normalizedDst, fileBytes);
    }
    if (linkTarget !== undefined) {
      this.symlinks.delete(normalizedSrc);
      this.symlinks.set(normalizedDst, linkTarget);
    }
    this.times.delete(normalizedSrc);
    this.times.set(normalizedDst, timestamp);
  }

  /**
   * Move a directory subtree by re-keying every files/symlinks/times/directories
   * entry at `src` or under `src/` to the corresponding `dst` path. Mirrors a
   * POSIX directory rename (what the node adapter does natively).
   */
  private renameDirectory(src: string, dst: string): void {
    this.ensureParentDirs(dst);
    // Stryker disable next-line ConditionalExpression: equivalent — remap only runs (via the guard below) when key===src or key startsWith `${src}/`; at key===src the else-arm slices to '' and yields dst, identical to the then-arm, so forcing the condition false is observationally identical for every key remap receives.
    const remap = (key: string): string => (key === src ? dst : `${dst}${key.slice(src.length)}`);
    const moves = <V>(map: Map<string, V>): void => {
      for (const [key, value] of [...map]) {
        if (key === src || key.startsWith(`${src}/`)) {
          map.delete(key);
          map.set(remap(key), value);
        }
      }
    };
    for (const dir of [...this.directories]) {
      if (dir === src || dir.startsWith(`${src}/`)) {
        this.directories.delete(dir);
        this.directories.add(remap(dir));
      }
    }
    moves(this.files);
    moves(this.symlinks);
    moves(this.times);
  }

  readlink = async (path: string): Promise<string> => {
    const normalized = this.walk(path, 'no-follow');
    const target = this.symlinks.get(normalized);
    if (target === undefined) {
      throw fileNotFound(path);
    }
    return target;
  };

  symlink = async (target: string, path: string): Promise<void> => {
    const normalized = this.walk(path, 'create');
    if (this.occupied(normalized)) {
      throw fileExists(path);
    }
    this.ensureParentDirs(normalized);
    this.symlinks.set(normalized, target);
    this.touch(normalized);
  };

  private occupied(normalized: string): boolean {
    return (
      this.files.has(normalized) ||
      this.symlinks.has(normalized) ||
      this.directories.has(normalized)
    );
  }

  // Modes are not modelled, so this only refuses as the Node adapter does: a symlink leaf first
  // (no portable no-follow chmod exists, live or dangling), then a path with no entry.
  chmod = async (path: string, _mode: number): Promise<void> => {
    const normalized = this.walk(path, 'no-follow');
    if (this.symlinks.has(normalized)) throw permissionDenied(path);
    if (!this.occupied(normalized)) throw fileNotFound(path);
  };

  rmRecursive = async (path: string): Promise<void> => {
    const normalized = this.walk(path, 'no-follow');
    if (this.removeLeafEntry(normalized)) return;
    // Idempotent: a missing path returns void with no error.
    // Stryker disable next-line ConditionalExpression: equivalent — when `normalized` is not a directory it is also missing entirely (leaf cases already returned above), so removeSubtree finds no `${normalized}/`-prefixed keys and is a pure no-op whether or not this guard short-circuits.
    if (!this.directories.has(normalized)) return;
    this.removeSubtree(normalized);
  };

  private removeLeafEntry(normalized: string): boolean {
    if (this.files.has(normalized)) {
      this.files.delete(normalized);
      this.times.delete(normalized);
      // Stryker disable next-line BooleanLiteral: equivalent — the leaf is already deleted; returning false instead only lets rmRecursive fall through to `!directories.has` (true, since files/dirs are disjoint) and return anyway, with removeSubtree a no-op on the now-missing path.
      return true;
    }
    if (this.symlinks.has(normalized)) {
      // Symlink leaf — never follow.
      this.symlinks.delete(normalized);
      this.times.delete(normalized);
      // Stryker disable next-line BooleanLiteral: equivalent — the symlink is already deleted; returning false instead only lets rmRecursive fall through to `!directories.has` (true, since symlinks/dirs are disjoint) and return anyway, with removeSubtree a no-op on the now-missing path.
      return true;
    }
    return false;
  }

  private removeSubtree(normalized: string): void {
    const prefix = `${normalized}/`;
    const matchingFiles = collectStartsWith(this.files.keys(), prefix);
    const matchingLinks = collectStartsWith(this.symlinks.keys(), prefix);
    const matchingDirs = collectMatchingDirs(this.directories, normalized, prefix);
    deleteAll(matchingFiles, this.files, this.times);
    deleteAll(matchingLinks, this.symlinks, this.times);
    deleteAllFromSet(matchingDirs, this.directories, this.times);
  }

  openWithNoFollow = async (path: string, _mode: 'read' | 'write'): Promise<FileHandle> => {
    const normalized = this.walk(path, 'no-follow');
    if (this.symlinks.has(normalized)) {
      // O_NOFOLLOW equivalent: refuse to open through a symlink leaf.
      throw permissionDenied(path);
    }
    if (!this.files.has(normalized)) {
      throw fileNotFound(path);
    }
    return this.makeMemoryHandle(normalized);
  };

  private makeMemoryHandle(normalized: string): FileHandle {
    return {
      read: async (buffer, offset, length, position) => {
        const stored = this.files.get(normalized) as Uint8Array;
        const start = position ?? 0;
        // Stryker disable next-line MethodExpression: equivalent — `end` only feeds `subarray`, which itself clamps both bounds to [0, stored.length]; using max instead of min can only enlarge `end` beyond `stored.length`, which subarray clamps right back, yielding an identical chunk.
        const end = Math.min(start + length, stored.length);
        const chunk = stored.subarray(start, Math.max(start, end));
        buffer.set(chunk, offset);
        return chunk.length;
      },
      write: async (data) => {
        // A handle outlives its path. Once the file it opened has been removed, a write
        // lands on the unlinked file as it does on POSIX — the path is never re-filed, so
        // it cannot collide with a directory or symlink created there since.
        if (!this.files.has(normalized)) return;
        this.files.set(normalized, data.slice());
        this.touch(normalized);
      },
      stat: async () => this.buildStat(normalized, normalized),
      close: async () => {
        // No FD to release in memory; close is a no-op (and idempotent).
      },
    };
  }

  private resolve(path: string): string {
    const normalized = normalizePath(this.rootDir, path);
    if (normalized !== this.rootDir && !normalized.startsWith(`${this.rootDir}/`)) {
      throw permissionDenied(path);
    }
    return normalized;
  }

  /**
   * POSIX resolution over the in-memory tree: every symlinked path component is followed — a
   * relative link text resolves against the link's own directory — and the leaf too under
   * `'follow'`. Every hop is re-checked by `resolve`'s own containment, so a followed target
   * outside the root still refuses. A regular file at a non-final component, reached directly or
   * through a link, refuses NOT_A_DIRECTORY, as Node's own path resolution does; so does a link
   * that resolves to nothing under `'create'`, the code this adapter keeps for every create
   * surface whose parent chain cannot hold the entry. More than `SYMLINK_FOLLOW_LIMIT` hops
   * refuses PERMISSION_DENIED, as Node's ELOOP does.
   */
  private walk(path: string, mode: WalkMode): string {
    const resolved = this.resolve(path);
    // A file or directory filed at the lexical key proves nothing on its chain needs resolving:
    // `directories` is prefix-closed and every create files its key at the walked path, so no
    // file or symlink can stand at any of its ancestors, and the key itself is not a link.
    if (this.files.has(resolved) || this.directories.has(resolved)) return resolved;
    const leaf: LeafResolution = mode === 'follow' ? 'follow' : 'no-follow';
    const segments = segmentsUnder(this.rootDir, resolved);
    return this.resolveSegments(segments, leaf, { path, mode, hops: 0 });
  }

  private resolveSegments(
    segments: ReadonlyArray<string>,
    leaf: LeafResolution,
    walk: WalkContext,
  ): string {
    const last = segments.length - 1;
    let current = this.rootDir;
    for (let index = 0; index < last; index += 1) {
      current = this.resolveIntermediate(`${current}/${segments[index] as string}`, walk);
    }
    if (last < 0) return current;
    return this.resolveLeaf(`${current}/${segments[last] as string}`, leaf, walk);
  }

  private resolveIntermediate(next: string, walk: WalkContext): string {
    if (this.files.has(next)) throw notADirectory(walk.path);
    const target = this.symlinks.get(next);
    if (target === undefined) return next;
    const resolved = this.followLink(next, target, walk);
    if (this.files.has(resolved)) throw notADirectory(walk.path);
    if (walk.mode === 'create' && !this.directories.has(resolved)) throw notADirectory(walk.path);
    return resolved;
  }

  private resolveLeaf(next: string, leaf: LeafResolution, walk: WalkContext): string {
    const target = this.symlinks.get(next);
    if (target === undefined || leaf === 'no-follow') return next;
    return this.followLink(next, target, walk);
  }

  private followLink(link: string, target: string, walk: WalkContext): string {
    walk.hops += 1;
    if (walk.hops >= MemoryFileSystem.SYMLINK_FOLLOW_LIMIT) {
      // POSIX ELOOP: too many levels of symbolic links.
      throw permissionDenied(walk.path);
    }
    const joined = target.startsWith('/') ? target : `${parentOf(link)}/${target}`;
    return this.resolveSegments(segmentsUnder(this.rootDir, this.resolve(joined)), 'follow', walk);
  }

  private ensureParentDirs(normalizedPath: string): void {
    this.addDirectoryRecursive(parentOf(normalizedPath));
  }

  private addDirectoryRecursive(normalizedPath: string): void {
    // A recorded directory proves its whole ancestor chain recorded and free of files and
    // symlinks — `directories` is prefix-closed and disjoint from the other two namespaces
    // on every reachable state — so there is nothing to refuse and nothing to add.
    // Stryker disable next-line ConditionalExpression: equivalent — without this early return the walk below runs over a chain that is already recorded and holds no file or symlink at any level (prefix closure and disjointness hold on every reachable state: the constructor refuses a seeded collision and a stale handle never re-files a removed path), so the check refuses nothing and the add loop re-adds keys that are already present; the forced-true variant is killable (every parent auto-create test) and is suppressed only because the mutator cannot be narrowed.
    if (this.directories.has(normalizedPath)) return;
    // Refuse before recording anything: a file anywhere on the ancestor chain must leave
    // the tree untouched — the all-or-nothing shape of `mkdir -p`. A symlinked ancestor
    // cannot reach here: every caller's own `walk` has already resolved one away, and the
    // constructor's seed path (the one caller that skips `walk`) never has one to find.
    this.assertAncestorChainFree(normalizedPath);
    let current = normalizedPath;
    // The `>=` bound reaches rootDir on purpose: after `rmRecursive(rootDir)` the root is
    // absent and this iteration is what records it again. Dropping the `break` alone is
    // harmless — `parentOf(rootDir)` is '' and fails the bound on the next test.
    while (current.length >= this.rootDir.length) {
      this.directories.add(current);
      // Stryker disable next-line ConditionalExpression: equivalent — forcing this false only lets the loop step to parentOf(rootDir), which is strictly shorter than rootDir and fails the `>=` bound before anything is added; the forced-true variant is killable (it records the leaf alone) and rides along only because the mutator cannot be narrowed.
      if (current === this.rootDir) break;
      current = parentOf(current);
    }
  }

  private assertAncestorChainFree(normalizedPath: string): void {
    let current = normalizedPath;
    // The `>=` bound tests rootDir itself on purpose: once `rmRecursive(rootDir)` has removed
    // the root, a later write can occupy that exact path with a file, and a child written
    // beneath it must refuse. Dropping the `return` alone is harmless — `parentOf(rootDir)`
    // is '' and fails the bound on the next test.
    while (current.length >= this.rootDir.length) {
      if (this.files.has(current)) {
        throw notADirectory(current);
      }
      // Stryker disable next-line ConditionalExpression: equivalent — forcing this false only lets the loop step to parentOf(rootDir), which is strictly shorter than rootDir and fails the `>=` bound before anything is checked; the forced-true variant is killable (it stops after the first segment) and rides along only because the mutator cannot be narrowed.
      if (current === this.rootDir) return;
      current = parentOf(current);
    }
  }

  private touch(normalizedPath: string): void {
    const now = Date.now();
    this.times.set(normalizedPath, { ctimeMs: now, mtimeMs: now });
  }

  private buildStat(normalized: string, path: string): FileStat {
    const fileBytes = this.files.get(normalized);
    if (fileBytes !== undefined) {
      return this.makeStatRecord({
        size: fileBytes.byteLength,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        times: this.times.get(normalized),
      });
    }
    if (this.directories.has(normalized)) {
      return this.makeStatRecord({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        times: this.times.get(normalized),
      });
    }
    throw fileNotFound(path);
  }

  private makeStatRecord(parts: {
    readonly size: number;
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
    readonly times: Timestamps | undefined;
  }): FileStat {
    const timestamps = parts.times ?? { ctimeMs: 0, mtimeMs: 0 };
    return {
      ctimeMs: timestamps.ctimeMs,
      mtimeMs: timestamps.mtimeMs,
      dev: 0,
      ino: 0,
      mode: MEMORY_FILE_MODE,
      uid: 0,
      gid: 0,
      size: parts.size,
      isFile: parts.isFile,
      isDirectory: parts.isDirectory,
      isSymbolicLink: parts.isSymbolicLink,
    };
  }

  private hasChildren(dirPath: string): boolean {
    const prefix = `${dirPath}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    for (const key of this.symlinks.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    for (const key of this.directories) {
      // Stryker disable next-line ConditionalExpression: equivalent — replacing `key !== dirPath` with `true` is a no-op: when `key === dirPath`, `key.startsWith(`${dirPath}/`)` is necessarily false (a string never starts with a strict superstring of itself), so `true && startsWith` collapses to the same result as `key !== dirPath && startsWith`.
      if (key !== dirPath && key.startsWith(prefix)) return true;
    }
    return false;
  }

  private addDirectEntry(
    fullPath: string,
    prefix: string,
    seen: Map<string, DirEntry>,
    kind: 'file' | 'directory' | 'symlink',
  ): void {
    if (!fullPath.startsWith(prefix)) return;
    const remainder = fullPath.slice(prefix.length);
    // Normalized paths never equal prefix exactly (no trailing slash is stored),
    // so remainder is always non-empty here.
    const slashIndex = remainder.indexOf('/');
    const name = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
    // Stryker disable next-line ConditionalExpression: equivalent — files/symlinks/directories are pairwise disjoint and a leaf can have no children, so two iterators reaching the same first-segment `name` always build an identically-shaped DirEntry; skipping the dedup only re-writes the same value.
    if (seen.has(name)) return;
    const isNested = slashIndex !== -1;
    const entry: DirEntry = isNested
      ? { name, isFile: false, isDirectory: true, isSymbolicLink: false }
      : {
          name,
          isFile: kind === 'file',
          isDirectory: kind === 'directory',
          isSymbolicLink: kind === 'symlink',
        };
    seen.set(name, entry);
  }
}

function normalizePath(rootDir: string, path: string): string {
  const joined = path.startsWith('/') ? path : `${rootDir}/${path}`;
  return collapsePosixSegments(joined);
}

/**
 * Returns the parent directory of a normalized path. Assumes rootDir is a non-root path,
 * so `normalizedPath` always contains at least one slash beyond the leading slash.
 */
function parentOf(normalizedPath: string): string {
  return normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
}

/** `resolved`'s path segments below `rootDir`; empty when `resolved` is `rootDir` itself. */
function segmentsUnder(rootDir: string, resolved: string): string[] {
  if (resolved === rootDir) return [];
  return resolved.slice(rootDir.length + 1).split('/');
}

function collectStartsWith(keys: Iterable<string>, prefix: string): string[] {
  // Stryker disable next-line ArrayDeclaration: equivalent — the only consumer (deleteAll) calls Map.delete on each element; a seeded junk key matches no stored path, so its deletion is an unobservable no-op.
  const out: string[] = [];
  for (const key of keys) {
    if (key.startsWith(prefix)) out.push(key);
  }
  return out;
}

function collectMatchingDirs(dirs: Iterable<string>, exact: string, prefix: string): string[] {
  // Stryker disable next-line ArrayDeclaration: equivalent — the only consumer (deleteAllFromSet) calls Set.delete on each element; a seeded junk key matches no stored directory, so its deletion is an unobservable no-op.
  const out: string[] = [];
  for (const key of dirs) {
    if (key === exact || key.startsWith(prefix)) out.push(key);
  }
  return out;
}

function deleteAll(
  keys: ReadonlyArray<string>,
  map: Map<string, unknown>,
  times: Map<string, unknown>,
): void {
  for (const key of keys) {
    map.delete(key);
    times.delete(key);
  }
}

function deleteAllFromSet(
  keys: ReadonlyArray<string>,
  set: Set<string>,
  times: Map<string, unknown>,
): void {
  for (const key of keys) {
    set.delete(key);
    times.delete(key);
  }
}

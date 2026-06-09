import {
  directoryNotEmpty,
  fileExists,
  fileNotFound,
  notADirectory,
  permissionDenied,
  unsupportedOperation,
} from '../../domain/index.js';
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
      this.files.set(normalized, value.slice());
      this.touch(normalized);
      this.ensureParentDirs(normalized);
    }
  }

  homedir = (): string => this.homePath;
  xdgConfigHome = (): string => this.xdgPath;
  systemConfigPath = (): string => this.systemPath;

  read = async (path: string): Promise<Uint8Array> => {
    const normalized = this.resolve(path);
    const stored = this.files.get(normalized);
    if (stored === undefined) {
      throw fileNotFound(path);
    }
    return stored.slice();
  };

  readSlice = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    if (offset < 0 || length < 0) {
      throw permissionDenied(path);
    }
    const normalized = this.resolve(path);
    const stored = this.files.get(normalized);
    if (stored === undefined) {
      throw fileNotFound(path);
    }
    const end = Math.min(offset + length, stored.length);
    return stored.slice(offset, end);
  };

  readUtf8 = async (path: string): Promise<string> => {
    const bytes = await this.read(path);
    return new TextDecoder().decode(bytes);
  };

  write = async (path: string, data: Uint8Array): Promise<void> => {
    const normalized = this.resolve(path);
    this.ensureParentDirs(normalized);
    this.files.set(normalized, data.slice());
    this.touch(normalized);
  };

  writeExclusive = async (path: string, data: Uint8Array): Promise<void> => {
    const normalized = this.resolve(path);
    if (this.files.has(normalized) || this.symlinks.has(normalized)) {
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
    const stored = this.files.get(this.resolve(path));
    // `TextDecoder().decode(undefined)` is `''`, so a missing file decodes to
    // the empty string without a separate branch.
    return new TextDecoder().decode(stored);
  }

  exists = async (path: string): Promise<boolean> => {
    const normalized = this.resolve(path);
    return (
      this.files.has(normalized) ||
      this.directories.has(normalized) ||
      this.symlinks.has(normalized)
    );
  };

  /** POSIX ELOOP threshold — symlink chains longer than this are cycle-detected. */
  private static readonly SYMLINK_FOLLOW_LIMIT = 40;

  stat = async (path: string): Promise<FileStat> => {
    return this.statFollowing(path, path, 0);
  };

  private async statFollowing(
    currentPath: string,
    originalPath: string,
    hops: number,
  ): Promise<FileStat> {
    if (hops >= MemoryFileSystem.SYMLINK_FOLLOW_LIMIT) {
      // POSIX ELOOP: too many levels of symbolic links.
      throw unsupportedOperation('stat', `symlink loop: ${originalPath}`);
    }
    const normalized = this.resolve(currentPath);
    const target = this.symlinks.get(normalized);
    if (target !== undefined) {
      return this.statFollowing(target, originalPath, hops + 1);
    }
    return this.buildStat(normalized, originalPath);
  }

  lstat = async (path: string): Promise<FileStat> => {
    const normalized = this.resolve(path);
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

  readdir = async (path: string): Promise<ReadonlyArray<DirEntry>> => {
    const normalized = this.resolve(path);
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — files and directories are disjoint namespaces, so a file path always fails the `!directories.has` check below, which throws the identical NOT_A_DIRECTORY error.
    if (this.files.has(normalized)) {
      throw notADirectory(path);
    }
    if (!this.directories.has(normalized)) {
      throw notADirectory(path);
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
    const normalized = this.resolve(path);
    // Stryker disable next-line ConditionalExpression,BlockStatement,LogicalOperator: equivalent — addDirectoryRecursive's first iteration re-checks `files.has(normalized) || symlinks.has(normalized)` and throws the identical NOT_A_DIRECTORY, so weakening or removing this guard cannot change behavior.
    if (this.files.has(normalized) || this.symlinks.has(normalized)) {
      throw notADirectory(path);
    }
    this.addDirectoryRecursive(normalized);
  };

  rm = async (path: string): Promise<void> => {
    const normalized = this.resolve(path);
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
    const normalizedSrc = this.resolve(src);
    const normalizedDst = this.resolve(dst);
    const fileBytes = this.files.get(normalizedSrc);
    const linkTarget = this.symlinks.get(normalizedSrc);
    if (fileBytes === undefined && linkTarget === undefined) {
      if (this.directories.has(normalizedSrc)) {
        this.renameDirectory(normalizedSrc, normalizedDst);
        return;
      }
      throw fileNotFound(src);
    }
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
  };

  /**
   * Move a directory subtree by re-keying every files/symlinks/times/directories
   * entry at `src` or under `src/` to the corresponding `dst` path. Mirrors a
   * POSIX directory rename (what the node adapter does natively).
   */
  private renameDirectory(src: string, dst: string): void {
    this.ensureParentDirs(dst);
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
    const normalized = this.resolve(path);
    const target = this.symlinks.get(normalized);
    if (target === undefined) {
      throw fileNotFound(path);
    }
    return target;
  };

  symlink = async (target: string, path: string): Promise<void> => {
    const normalized = this.resolve(path);
    if (
      this.files.has(normalized) ||
      this.symlinks.has(normalized) ||
      this.directories.has(normalized)
    ) {
      throw fileExists(path);
    }
    this.ensureParentDirs(normalized);
    this.symlinks.set(normalized, target);
    this.touch(normalized);
  };

  chmod = async (path: string, _mode: number): Promise<void> => {
    this.resolve(path);
  };

  rmRecursive = async (path: string): Promise<void> => {
    const normalized = this.resolve(path);
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
    const normalized = this.resolve(path);
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

  private ensureParentDirs(normalizedPath: string): void {
    this.addDirectoryRecursive(parentOf(normalizedPath));
  }

  private addDirectoryRecursive(normalizedPath: string): void {
    let current = normalizedPath;
    // equivalent-mutant: changing `>=` to `>` (or dropping the `break` when current === rootDir)
    // has no observable effect — rootDir is seeded into `this.directories` in the constructor
    // and nothing else can store a file/symlink at that exact path, so the extra iteration
    // (or the skipped one) is a no-op for every reachable state.
    while (current.length >= this.rootDir.length) {
      if (this.files.has(current) || this.symlinks.has(current)) {
        throw notADirectory(current);
      }
      this.directories.add(current);
      if (current === this.rootDir) break;
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
  const segments = joined.split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return `/${resolved.join('/')}`;
}

/**
 * Returns the parent directory of a normalized path. Assumes rootDir is a non-root path,
 * so `normalizedPath` always contains at least one slash beyond the leading slash.
 */
function parentOf(normalizedPath: string): string {
  return normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
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

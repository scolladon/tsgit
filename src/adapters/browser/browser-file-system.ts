/// <reference lib="dom" />
import {
  fileExists,
  fileNotFound,
  notADirectory,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../domain/index.js';
import { createLruCache, type LruCache } from '../../domain/storage/lru-cache.js';
import type { DirEntry, FileHandle, FileStat, FileSystem } from '../../ports/file-system.js';

export interface BrowserFileSystemOptions {
  readonly rootHandle: FileSystemDirectoryHandle;
}

const OPFS_FILE_MODE = 0o100644;
const OPFS_DIR_MODE = 0o040755;

// The `parentRealpathCache` shape in src/adapters/node/node-file-system.ts:
// bytes + entries capped, each entry charged its key length. Sized the same
// way — comfortably past the 256 loose-object fanout directories so a full
// history walk does not thrash the cache.
const DIRECTORY_HANDLE_CACHE_MAX_BYTES = 128 * 1024;
const DIRECTORY_HANDLE_CACHE_MAX_ENTRIES = 512;

export class BrowserFileSystem implements FileSystem {
  constructor(private readonly rootHandle: FileSystemDirectoryHandle) {}

  /**
   * Resolved `FileSystemDirectoryHandle` per parent path (the joined
   * segments `walkToParent` was asked to resolve), so a second read under
   * the same parent skips every `getDirectoryHandle` call the first paid.
   * `createLruCache` exposes no key enumeration, so `directoryHandleCacheKeys`
   * mirrors every key ever inserted — a superset of the LRU's live entries
   * once byte/entry eviction has silently dropped some, which is harmless:
   * invalidation only ever calls `delete` on candidate keys, a no-op for one
   * already evicted.
   */
  private readonly directoryHandleCache: LruCache<FileSystemDirectoryHandle> = createLruCache(
    DIRECTORY_HANDLE_CACHE_MAX_BYTES,
    DIRECTORY_HANDLE_CACHE_MAX_ENTRIES,
  );
  private readonly directoryHandleCacheKeys = new Set<string>();

  async read(path: string): Promise<Uint8Array> {
    const handle = await this.resolveFileHandle(path, false);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readSlice(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0) throw permissionDenied(path);
    const handle = await this.resolveFileHandle(path, false);
    const file = await handle.getFile();
    // Blob.slice is lazy — the browser reads only the requested range from the OPFS backing store.
    const slice = file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async readUtf8(path: string): Promise<string> {
    const handle = await this.resolveFileHandle(path, false);
    const file = await handle.getFile();
    return file.text();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const handle = await this.resolveFileHandle(path, true);
    const writable = await handle.createWritable();
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  }

  async writeStream(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const handle = await this.resolveFileHandle(path, true);
    const writable = await handle.createWritable();
    for await (const chunk of source) {
      await writable.write(chunk as FileSystemWriteChunkType);
    }
    await writable.close();
  }

  async writeExclusive(path: string, data: Uint8Array): Promise<void> {
    const segments = this.splitPath(path);
    if (segments.length === 0) throw permissionDenied(path);
    const dir = await this.walkToParent(segments, true, path);
    const leaf = leafSegment(segments, path);
    await this.assertDoesNotExist(dir, leaf, path);
    const handle = await dir.getFileHandle(leaf, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  }

  async writeUtf8(path: string, content: string): Promise<void> {
    await this.write(path, new TextEncoder().encode(content));
  }

  async appendUtf8(path: string, content: string): Promise<void> {
    const handle = await this.resolveFileHandle(path, true);
    const existing = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: existing.size, data: content });
    await writable.close();
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveFileHandle(path, false);
      return true;
    } catch (err) {
      if (isFileNotFound(err)) {
        try {
          await this.resolveDirHandle(path, false);
          return true;
        } catch {
          return false;
        }
      }
      throw err;
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const handle = await this.resolveFileHandle(path, false);
      const file = await handle.getFile();
      return buildFileStat(file.size, file.lastModified, true);
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
      await this.resolveDirHandle(path, false);
      return buildFileStat(0, Date.now(), false);
    }
  }

  async lstat(path: string): Promise<FileStat> {
    // OPFS has no symlinks — same as stat.
    return this.stat(path);
  }

  // One parent walk and one leaf lookup, where `lstat` (this adapter's `stat`) walks twice and
  // raises two refusals for an absent path. The walk refuses as `lstat`'s does; at the leaf, every
  // rejection but a directory occupant reads as absent, as `lstat` reports each FILE_NOT_FOUND.
  async lexists(path: string): Promise<boolean> {
    const segments = this.splitPath(path);
    if (segments.length === 0) return true;
    const parent = await this.walkToParent(segments, false, path).catch((err: unknown) => {
      if (isFileNotFound(err)) return undefined;
      throw err;
    });
    if (parent === undefined) return false;
    return parent.getFileHandle(leafSegment(segments, path), { create: false }).then(
      () => true,
      (err: unknown) => isTypeMismatch(err),
    );
  }

  /** `tryLstat`'s twin of `lstat`: `undefined` exactly where `lstat` refuses FILE_NOT_FOUND. */
  async tryLstat(path: string): Promise<FileStat | undefined> {
    return orAbsentFileNotFound(() => this.lstat(path));
  }

  /** `tryReadUtf8`'s twin of `readUtf8`: `undefined` exactly where `readUtf8` refuses
   *  FILE_NOT_FOUND — on this adapter that includes a directory leaf, which `readUtf8`
   *  reports as absent rather than PERMISSION_DENIED (see `resolveFileHandle`). */
  async tryReadUtf8(path: string): Promise<string | undefined> {
    return orAbsentFileNotFound(() => this.readUtf8(path));
  }

  async readdir(path: string): Promise<ReadonlyArray<DirEntry>> {
    const handle = await this.resolveDirHandle(path, false);
    const entries: DirEntry[] = [];
    const iterable = handle as unknown as {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    };
    for await (const [name, child] of iterable.entries()) {
      entries.push({
        name,
        isFile: child.kind === 'file',
        isDirectory: child.kind === 'directory',
        isSymbolicLink: false,
      });
    }
    return entries;
  }

  async mkdir(path: string): Promise<void> {
    const segments = this.splitPath(path);
    if (segments.length === 0) return;
    const parent = await this.walkToParent(segments, true, path);
    await this.createLeafDirectory(parent, leafSegment(segments, path), path);
  }

  /** The parents map as every other walk does; a regular file holding the leaf itself is an
   *  occupant rather than a blocked segment, which the node adapter's `mkdir -p` reports as
   *  FILE_EXISTS. */
  private async createLeafDirectory(
    dir: FileSystemDirectoryHandle,
    leaf: string,
    path: string,
  ): Promise<void> {
    try {
      await dir.getDirectoryHandle(leaf, { create: true });
    } catch (err) {
      if (isTypeMismatch(err)) throw fileExists(path);
      throw fileNotFound(path);
    }
  }

  async rm(path: string): Promise<void> {
    const segments = this.splitPath(path);
    if (segments.length === 0) throw permissionDenied(path);
    const dir = await this.walkToParent(segments, false, path);
    const leaf = leafSegment(segments, path);
    try {
      await dir.removeEntry(leaf);
    } catch {
      throw fileNotFound(path);
    }
    this.invalidateDirectoryHandleCache(segments.join('/'));
  }

  async rename(src: string, dst: string): Promise<void> {
    // OPFS lacks native rename — emulate via read/write/rm. NON-ATOMIC: a failure or
    // browser crash between `write(dst)` and `rm(src)` leaves both copies. This
    // adapter does not expose `atomicRename` (the port's optional capability) for
    // exactly this reason — callers must branch on its absence rather than assume
    // `rename` is safe to commit through. See FileSystem port JSDoc.
    const data = await this.read(src);
    const dstKey = this.splitPath(dst).join('/');
    // A self-rename is a no-op on every adapter (checked after the read so an absent
    // source still reports FILE_NOT_FOUND); without it the emulation's `rm(src)` would
    // unlink the file it had just rewritten.
    if (this.splitPath(src).join('/') === dstKey) return;
    await this.write(dst, data);
    await this.rm(src); // invalidates src's own cache key as part of `rm`'s own contract
    this.invalidateDirectoryHandleCache(dstKey);
  }

  async readlink(_path: string): Promise<string> {
    throw unsupportedOperation('readlink', 'OPFS does not support symbolic links');
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw unsupportedOperation('symlink', 'OPFS does not support symbolic links');
  }

  async chmod(path: string, _mode: number): Promise<void> {
    // Containment check by resolving the path; OPFS has no permission model, so this is a no-op.
    try {
      await this.resolveFileHandle(path, false);
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
      await this.resolveDirHandle(path, false);
    }
  }

  async rmRecursive(path: string): Promise<void> {
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      // Removing the root itself is meaningless; OPFS does not expose root removal.
      throw permissionDenied(path);
    }
    const parent = await this.walkToParent(segments, false, path).catch((err: unknown) => {
      if (isFileNotFound(err)) return undefined;
      throw err;
    });
    if (parent !== undefined) {
      const leaf = leafSegment(segments, path);
      try {
        await parent.removeEntry(leaf, { recursive: true });
      } catch {
        // OPFS removeEntry throws NotFoundError if the entry is missing — idempotent contract.
      }
    }
    this.invalidateDirectoryHandleCache(segments.join('/'));
  }

  async openWithNoFollow(_path: string, _mode: 'read' | 'write'): Promise<FileHandle> {
    throw unsupportedOperation('openWithNoFollow', 'browser FS does not support O_NOFOLLOW');
  }

  homedir(): string {
    throw unsupportedOperation('homedir', 'browser adapter has no concept of a home directory');
  }

  xdgConfigHome(): string {
    throw unsupportedOperation('xdgConfigHome', 'browser adapter has no XDG config home');
  }

  systemConfigPath(): string {
    throw unsupportedOperation('systemConfigPath', 'browser adapter has no system config path');
  }

  private splitPath(path: string): string[] {
    const normalized = path.replace(/^\/+/, '');
    const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
    for (const segment of segments) {
      if (segment === '..') throw permissionDenied(path);
    }
    return segments;
  }

  private async resolveFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const segments = this.splitPath(path);
    if (segments.length === 0) throw fileNotFound(path);
    const dir = await this.walkToParent(segments, create, path);
    const leaf = leafSegment(segments, path);
    try {
      return await dir.getFileHandle(leaf, { create });
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      // A directory at the leaf rejects with TypeMismatchError whether or not `create` is
      // set. Only the writing arm may report it as a refusal: stat/exists read
      // FILE_NOT_FOUND here as "not a file, try a directory handle" and fall back.
      if (create && isTypeMismatch(err)) throw permissionDenied(path);
      throw fileNotFound(path);
    }
  }

  private async resolveDirHandle(
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const segments = this.splitPath(path);
    if (segments.length === 0) return this.rootHandle;
    const dir = await this.walkToParent(segments, create, path);
    const leaf = leafSegment(segments, path);
    try {
      return await dir.getDirectoryHandle(leaf, { create });
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      // OPFS rejects a directory lookup of a file entry with TypeMismatchError: that entry is
      // present but not a directory, which Node's ENOTDIR and the memory adapter report alike.
      if (isTypeMismatch(err)) throw notADirectory(path);
      throw fileNotFound(path);
    }
  }

  private async walkToParent(
    segments: ReadonlyArray<string>,
    create: boolean,
    path: string,
  ): Promise<FileSystemDirectoryHandle> {
    const key = parentPathKey(segments);
    const cached = key === undefined ? undefined : this.directoryHandleCache.get(key);
    if (cached !== undefined) return cached;
    const dir = await this.walkSegments(segments, create, path);
    if (key !== undefined) this.cacheDirectoryHandle(key, dir);
    return dir;
  }

  private async walkSegments(
    segments: ReadonlyArray<string>,
    create: boolean,
    path: string,
  ): Promise<FileSystemDirectoryHandle> {
    let dir = this.rootHandle;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment === undefined) throw fileNotFound(segments.join('/'));
      try {
        dir = await dir.getDirectoryHandle(segment, { create });
      } catch (err) {
        if (err instanceof TsgitError) throw err;
        // A regular file where a directory is needed: present, but not a directory.
        if (isTypeMismatch(err)) throw notADirectory(path);
        throw fileNotFound(segments.join('/'));
      }
    }
    return dir;
  }

  private cacheDirectoryHandle(key: string, handle: FileSystemDirectoryHandle): void {
    this.directoryHandleCache.set(key, handle, key.length);
    this.directoryHandleCacheKeys.add(key);
  }

  /** Drops every cached entry at `path` or nested under it (`path/...`) — a removed or
   *  renamed-away directory, and any deeper parent path this instance ever cached through it. */
  private invalidateDirectoryHandleCache(path: string): void {
    const prefix = `${path}/`;
    for (const key of this.directoryHandleCacheKeys) {
      if (key === path || key.startsWith(prefix)) {
        this.directoryHandleCache.delete(key);
        this.directoryHandleCacheKeys.delete(key);
      }
    }
  }

  private async assertDoesNotExist(
    dir: FileSystemDirectoryHandle,
    leaf: string,
    path: string,
  ): Promise<void> {
    try {
      await dir.getFileHandle(leaf, { create: false });
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      if (isTypeMismatch(err)) throw fileExists(path);
      if (isNotFoundRejection(err)) return;
      throw err;
    }
    throw fileExists(path);
  }
}

function leafSegment(segments: ReadonlyArray<string>, path: string): string {
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) throw fileNotFound(path);
  return leaf;
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND';
}

/** The joined parent-path cache key `walkToParent` resolves to — `undefined` when there is
 *  nothing to walk (a root-level leaf), so the trivial case is never cached. */
function parentPathKey(segments: ReadonlyArray<string>): string | undefined {
  return segments.length > 1 ? segments.slice(0, -1).join('/') : undefined;
}

/** Runs `probe`, folding a FILE_NOT_FOUND `TsgitError` into `undefined`; every other rejection
 *  — including a non-`TsgitError` — propagates untouched. Shared by `tryLstat`/`tryReadUtf8`. */
async function orAbsentFileNotFound<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe();
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
}

// Reads a rejection's `name` structurally rather than through `instanceof Error`, so a
// DOMException raised in another realm (a handle handed across a worker boundary) is
// still classified — the same posture the application layer takes on `data.code`.
function rejectionName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = (err as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function isTypeMismatch(err: unknown): boolean {
  return rejectionName(err) === 'TypeMismatchError';
}

function isNotFoundRejection(err: unknown): boolean {
  return rejectionName(err) === 'NotFoundError';
}

function buildFileStat(size: number, timeMs: number, isFile: boolean): FileStat {
  return {
    ctimeMs: timeMs,
    mtimeMs: timeMs,
    dev: 0,
    ino: 0,
    mode: isFile ? OPFS_FILE_MODE : OPFS_DIR_MODE,
    uid: 0,
    gid: 0,
    size,
    isFile,
    isDirectory: !isFile,
    isSymbolicLink: false,
  };
}

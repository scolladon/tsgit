/// <reference lib="dom" />
import {
  fileExists,
  fileNotFound,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../domain/index.js';
import type { DirEntry, FileHandle, FileStat, FileSystem } from '../../ports/file-system.js';

export interface BrowserFileSystemOptions {
  readonly rootHandle: FileSystemDirectoryHandle;
}

const OPFS_FILE_MODE = 0o100644;
const OPFS_DIR_MODE = 0o040755;

export class BrowserFileSystem implements FileSystem {
  constructor(private readonly rootHandle: FileSystemDirectoryHandle) {}

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
    const dir = await this.walkToParent(segments, true);
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

  async existsContained(path: string): Promise<boolean> {
    // OPFS has no symlinks, so lstat-semantics ≡ exists-semantics here.
    return this.exists(path);
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
    let dir = this.rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

  async rm(path: string): Promise<void> {
    const segments = this.splitPath(path);
    if (segments.length === 0) throw permissionDenied(path);
    const dir = await this.walkToParent(segments, false);
    const leaf = leafSegment(segments, path);
    try {
      await dir.removeEntry(leaf);
    } catch {
      throw fileNotFound(path);
    }
  }

  async rename(src: string, dst: string): Promise<void> {
    // OPFS lacks native rename — emulate via read/write/rm. NON-ATOMIC: a failure or
    // browser crash between `write(dst)` and `rm(src)` leaves both copies. Callers
    // depending on atomicity (e.g., lock-file protocols) MUST use the Node or Memory
    // adapter. See FileSystem port JSDoc.
    const data = await this.read(src);
    await this.write(dst, data);
    await this.rm(src);
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
    const parent = await this.walkToParent(segments, false).catch((err: unknown) => {
      if (isFileNotFound(err)) return undefined;
      throw err;
    });
    if (parent === undefined) return;
    const leaf = leafSegment(segments, path);
    try {
      await parent.removeEntry(leaf, { recursive: true });
    } catch {
      // OPFS removeEntry throws NotFoundError if the entry is missing — idempotent contract.
    }
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
    const dir = await this.walkToParent(segments, create);
    const leaf = leafSegment(segments, path);
    try {
      return await dir.getFileHandle(leaf, { create });
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      throw fileNotFound(path);
    }
  }

  private async resolveDirHandle(
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const segments = this.splitPath(path);
    if (segments.length === 0) return this.rootHandle;
    const dir = await this.walkToParent(segments, create);
    const leaf = leafSegment(segments, path);
    try {
      return await dir.getDirectoryHandle(leaf, { create });
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      throw fileNotFound(path);
    }
  }

  private async walkToParent(
    segments: ReadonlyArray<string>,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    let dir = this.rootHandle;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment === undefined) throw fileNotFound(segments.join('/'));
      try {
        dir = await dir.getDirectoryHandle(segment, { create });
      } catch (err) {
        if (err instanceof TsgitError) throw err;
        throw fileNotFound(segments.join('/'));
      }
    }
    return dir;
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
      // NotFoundError → safe to create.
      return;
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

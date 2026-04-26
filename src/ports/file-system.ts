/** Metadata returned by stat operations. */
export interface FileStat {
  readonly ctimeMs: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** Nanosecond-precision ctime. Populated by Node adapter (fs.stat({ bigint: true })). Undefined on platforms without ns support. */
  readonly ctimeNs?: bigint;
  /** Nanosecond-precision mtime. Populated by Node adapter. Undefined on platforms without ns support. */
  readonly mtimeNs?: bigint;
}

/** A single entry from a directory listing. */
export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * Minimal subset of Node's `fs/promises` FileHandle. Returned by `openWithNoFollow`.
 *
 * Lifetime: callers MUST `close()` the handle in a `finally` block. Holding handles open
 * across async boundaries can leak file descriptors on Node — keep usage tight.
 */
export interface FileHandle {
  /** Read up to `length` bytes into `buffer` at `offset` (in the buffer). */
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number,
  ) => Promise<number>;
  /** Write the buffer to the file. */
  readonly write: (buffer: Uint8Array) => Promise<void>;
  /** Stat the open file (cheap — uses fstat on Node). */
  readonly stat: () => Promise<FileStat>;
  /** Release the underlying file descriptor. Idempotent — safe to call twice. */
  readonly close: () => Promise<void>;
}

export interface FileSystem {
  /** Read entire file as bytes. Throws FILE_NOT_FOUND if not found. */
  readonly read: (path: string) => Promise<Uint8Array>;

  /** Read a byte slice from a file at the given offset. Throws FILE_NOT_FOUND if not found. */
  readonly readSlice: (path: string, offset: number, length: number) => Promise<Uint8Array>;

  /** Read entire file as UTF-8 string. Throws FILE_NOT_FOUND if not found. */
  readonly readUtf8: (path: string) => Promise<string>;

  /** Write bytes to file, creating parent directories as needed. Overwrites if exists. */
  readonly write: (path: string, data: Uint8Array) => Promise<void>;

  /**
   * Write bytes to file. Fails with FILE_EXISTS if the file already exists (exclusive create).
   *
   * Contract obligations (Phase 7 §14.17):
   * - **Parent-directory creation:** the adapter MUST ensure parent directories exist before the
   *   exclusive write. Equivalent to `mkdir -p dirname(path)` before `open(path, O_EXCL)`. If the
   *   parent is removed between the implicit mkdir and the open (e.g. concurrent `git gc` prunes
   *   the fanout), the adapter retries once: re-create the parent, re-attempt the open. On a second
   *   ENOENT the error propagates as FILE_NOT_FOUND.
   * - **Symlink-safe ancestor check:** the adapter MUST reject writes where any ancestor directory
   *   of `path` is a symbolic link whose resolved target is outside the containment root. This
   *   closes the attack where an attacker replaces `objects/xx/` with a symlink pointing elsewhere.
   *   Implementation: lstat-walk the ancestor chain, or use `openat`-style relative opens.
   */
  readonly writeExclusive: (path: string, data: Uint8Array) => Promise<void>;

  /** Write UTF-8 string to file, creating parent directories as needed. */
  readonly writeUtf8: (path: string, content: string) => Promise<void>;

  /** Check if path exists. */
  readonly exists: (path: string) => Promise<boolean>;

  /** Get file/directory metadata. Throws FILE_NOT_FOUND if not found. Follows symlinks. */
  readonly stat: (path: string) => Promise<FileStat>;

  /** Get file/directory metadata. Throws FILE_NOT_FOUND if not found. Does NOT follow symlinks. */
  readonly lstat: (path: string) => Promise<FileStat>;

  /** List directory entries. Throws NOT_A_DIRECTORY if not a directory. */
  readonly readdir: (path: string) => Promise<ReadonlyArray<DirEntry>>;

  /** Create directory and all parents. No-op if already exists. */
  readonly mkdir: (path: string) => Promise<void>;

  /** Remove file or empty directory. Throws FILE_NOT_FOUND if not found. */
  readonly rm: (path: string) => Promise<void>;

  /**
   * Rename `src` to `dst`. Atomic where the platform supports it (Node: yes on POSIX;
   * Browser OPFS: no — emulated as read + write + rm, caller must tolerate partial
   * failure between steps). Both paths must be on the same logical root.
   */
  readonly rename: (src: string, dst: string) => Promise<void>;

  /** Read the target of a symbolic link. Throws FILE_NOT_FOUND if not a symlink. */
  readonly readlink: (path: string) => Promise<string>;

  /** Create a symbolic link. Creates parent directories as needed. */
  readonly symlink: (target: string, path: string) => Promise<void>;

  /** Set file permissions. No-op on platforms without permission support (OPFS). */
  readonly chmod: (path: string, mode: number) => Promise<void>;

  /**
   * Recursively remove a file or directory tree.
   *
   * Idempotent: a missing path returns void (no error).
   *
   * Symlink-safe: does NOT follow symlinks during traversal. When a directory entry is a
   * symlink, the symlink itself is removed (the link, not its target), and the walk does
   * not descend into it. This prevents an attacker who plants a symlink under a doomed
   * directory from having `rmRecursive` reach outside the containment root.
   */
  readonly rmRecursive: (path: string) => Promise<void>;

  /**
   * Open a file with the platform equivalent of `O_NOFOLLOW` — refuses to open the path
   * if its leaf is a symbolic link. Used by callers that must read/write a regular file
   * without crossing a symlink hop (e.g., lockfile creation under the git dir).
   *
   * - Node: `fs.open(path, O_NOFOLLOW | (mode === 'write' ? O_WRONLY : O_RDONLY))`.
   * - Memory: rejects with `PERMISSION_DENIED` when the leaf is a memory symlink entry.
   * - Browser OPFS: throws `UNSUPPORTED_OPERATION` (OPFS has no symlinks; callers can
   *   fall back to a plain `read`/`write` because the no-follow guarantee holds vacuously).
   *
   * Throws `FILE_NOT_FOUND` if the leaf does not exist (in `read` mode).
   * Throws `PERMISSION_DENIED` if the leaf is a symlink.
   */
  readonly openWithNoFollow: (path: string, mode: 'read' | 'write') => Promise<FileHandle>;
}

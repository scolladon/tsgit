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
}

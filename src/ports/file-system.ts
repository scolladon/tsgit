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

  /**
   * Write bytes to file, creating parent directories as needed. Overwrites a regular file;
   * refuses a directory or a symbolic link at the leaf with PERMISSION_DENIED.
   */
  readonly write: (path: string, data: Uint8Array) => Promise<void>;

  /**
   * Stream bytes to file from an async source, creating parent directories as needed. Overwrites
   * a regular file; refuses a directory or a symbolic link at the leaf with PERMISSION_DENIED.
   * Writes bytes verbatim. A refused write may already have consumed the source: the memory
   * adapter buffers it before writing, while Node refuses at the open — a single-use source is
   * not reusable after a refusal on either.
   */
  readonly writeStream: (path: string, source: AsyncIterable<Uint8Array>) => Promise<void>;

  /**
   * Write bytes to file. Fails with FILE_EXISTS if anything already occupies `path` — a regular
   * file, a directory (empty or not), or a symbolic link, including a dangling one (exclusive
   * create).
   *
   * Contract obligations:
   * - **Parent-directory creation:** the adapter MUST ensure parent directories exist before the
   *  exclusive write. Equivalent to `mkdir -p dirname(path)` before `open(path, O_EXCL)`. If the
   *  parent is removed between the implicit mkdir and the open (e.g. concurrent `git gc` prunes
   *  the fanout), the adapter retries once: re-create the parent, re-attempt the open. On a second
   *  ENOENT the error propagates as FILE_NOT_FOUND.
   * - **Symlink-safe ancestor check:** the adapter MUST reject writes where any ancestor directory
   *  of `path` is a symbolic link whose resolved target is outside the containment root. This
   *  closes the attack where an attacker replaces `objects/xx/` with a symlink pointing elsewhere.
   *  Implementation: lstat-walk the ancestor chain, or use `openat`-style relative opens.
   * - **Ancestor obligation:** a non-directory occupying an ancestor segment of `path` also
   *  refuses. The code at the immediate parent is adapter-dependent (Node reports FILE_EXISTS,
   *  matching its own `mkdir -p`'s EEXIST; the memory adapter reports NOT_A_DIRECTORY carrying
   *  the ancestor path); every deeper ancestor reports NOT_A_DIRECTORY on both.
   */
  readonly writeExclusive: (path: string, data: Uint8Array) => Promise<void>;

  /**
   * Write UTF-8 string to file, creating parent directories as needed. Overwrites a regular
   * file; refuses a directory or a symbolic link at the leaf with PERMISSION_DENIED.
   */
  readonly writeUtf8: (path: string, content: string) => Promise<void>;

  /**
   * Append UTF-8 to a file, creating parent directories and the file as
   * needed. Refuses a directory or a symbolic link at the leaf with
   * PERMISSION_DENIED. Atomic per-call for line-sized writes (relies on
   * `O_APPEND`).
   */
  readonly appendUtf8: (path: string, content: string) => Promise<void>;

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
   * `src === dst` is a no-op on every adapter once `src` exists — an absent `src` is still
   * refused with FILE_NOT_FOUND. On the node and memory adapters, on every platform: a
   * non-directory source refuses a directory destination with PERMISSION_DENIED — the node
   * adapter on linux excepted, where a destination that is one of the source's own ancestors
   * reports DIRECTORY_NOT_EMPTY instead because POSIX does not order the two checks (the memory
   * adapter reports PERMISSION_DENIED there too); a directory
   * source refuses a non-directory destination with NOT_A_DIRECTORY and a non-empty directory
   * destination with DIRECTORY_NOT_EMPTY; an empty directory destination is replaced — in one
   * step where the platform's own rename honours these rules, and on Windows in two, where the
   * node adapter removes the empty destination and then renames, recreating it (with default,
   * parent-inherited permissions) on a best-effort basis if that rename then fails. Every refusal
   * above carries `data.path === src`; renaming
   * a directory onto a destination inside itself is refused with UNSUPPORTED_OPERATION, a
   * variant that carries no `path`; a regular file, or a symlink that does not resolve to a
   * directory, at the destination's immediate parent refuses with FILE_EXISTS carrying `src` on
   * the node adapter (memory: NOT_A_DIRECTORY
   * carrying that parent); higher up the destination's ancestor chain it refuses with
   * NOT_A_DIRECTORY carrying an adapter- and platform-chosen path (node: `dst` on POSIX and
   * `src` on Windows; memory: the blocking ancestor) — changing nothing in either case. On
   * Windows a regular file on the source's ancestor chain reports FILE_NOT_FOUND rather than
   * NOT_A_DIRECTORY, because a different resolution step fails first. The browser adapter's
   * emulation moves files only: a directory source reports
   * FILE_NOT_FOUND (a directory `src === dst` included), a directory destination reports
   * PERMISSION_DENIED carrying `dst`, and no directory is replaced.
   */
  readonly rename: (src: string, dst: string) => Promise<void>;

  /**
   * Rename `src` over `dst` as a single atomic replace. OPTIONAL: present only
   * where the platform can guarantee that no observer ever sees an intermediate
   * state. Node (`rename(2)`) and memory (synchronous map surgery inside one
   * event-loop turn) provide it; OPFS has no rename and no atomic replace, so the
   * browser adapter omits it. Omission is a documented answer, not an oversight:
   * a lock-file protocol that finds this absent must take its own degraded path
   * rather than assuming `rename` is safe to commit through.
   * Inherits every `rename` refusal above by delegation. Atomic for every arrangement on a
   * platform whose own rename honours the kind rules, and for every non-replacing arrangement
   * everywhere: the guard only inspects, and the single entry-moving mutation is the `rename`
   * (the destination's parent chain is created first, as it is for every write surface). The one
   * exception is the emulated empty-directory replacement on Windows, which is a removal
   * followed by a rename; a destination filled before the removal runs makes the removal fail
   * and the caller sees DIRECTORY_NOT_EMPTY — the refusal the arrangement would have produced
   * anyway — and a rename that fails after the removal has the empty destination recreated on
   * a best-effort basis.
   */
  readonly atomicRename?: (src: string, dst: string) => Promise<void>;

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
   *  fall back to a plain `read`/`write` because the no-follow guarantee holds vacuously).
   *
   * Throws `FILE_NOT_FOUND` if the leaf does not exist (in `read` mode).
   * Throws `PERMISSION_DENIED` if the leaf is a symlink.
   */
  readonly openWithNoFollow: (path: string, mode: 'read' | 'write') => Promise<FileHandle>;

  /**
   * Absolute path to the current user's home directory.
   *
   * - Node: `os.homedir()`.
   * - Memory: a fixed value injected via constructor options (default `'/home/user'`).
   * - Browser: throws `UNSUPPORTED_OPERATION` (no concept of a home directory).
   */
  readonly homedir: () => string;

  /**
   * Absolute path to the user's XDG config home — `$XDG_CONFIG_HOME` when set
   * and non-empty, otherwise `<homedir>/.config`.
   *
   * - Node: reads `process.env.XDG_CONFIG_HOME`, falls back to `<homedir>/.config`.
   * - Memory: fixed value injected via constructor options.
   * - Browser: throws `UNSUPPORTED_OPERATION`.
   */
  readonly xdgConfigHome: () => string;

  /**
   * Absolute path to the platform's system git config file.
   *
   * - Node POSIX: `/etc/gitconfig`.
   * - Node Windows: `<ProgramData>\Git\config` (ProgramData from env, default `C:\ProgramData`).
   * - Memory: fixed value injected via constructor options.
   * - Browser: throws `UNSUPPORTED_OPERATION`.
   */
  readonly systemConfigPath: () => string;
}

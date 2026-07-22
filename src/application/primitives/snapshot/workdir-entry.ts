import { unsupportedOperation, workdirRace } from '../../../domain/error.js';
import type { FileMode } from '../../../domain/objects/file-mode.js';
import { ObjectId } from '../../../domain/objects/object-id.js';
import type { WorkdirEntryRow, WorkdirStat } from '../../../domain/snapshot/index.js';
import type { Context, FileStat } from '../../../ports/index.js';
import { joinPath } from '../internal/join-working-tree-path.js';

/**
 * Application-tier wrapper around `WorkdirEntryRow`. Inherits the sync
 * data fields (path/mode/kind/stat) and adds four named I/O methods:
 *
 * - `hash()`  — reads the file, computes its blob-hash (`blob <size>\0` +
 *               bytes hashed by `ctx.hash`). For a symlink, hashes the
 *               link target bytes (git's convention).
 * - `read()`  — raw file bytes (no hash). For a symlink, returns the
 *               target as UTF-8 bytes.
 * - `readLink()` — symlink target string. Throws `UNSUPPORTED_OPERATION`
 *               when `kind !== 'symlink'`.
 * - `verify()` — re-`lstat`s the entry; throws `WORKDIR_RACE` if any
 *               of `(mode, size, mtimeMs)` differs from the row's
 *               original stat. The opt-in race-detection hook for
 *               `add -p` / `checkout --detect-races` style callers.
 *
 * Each entry binds to the `Context` it was created with; the absolute
 * workdir path is computed once at creation and shared by every method.
 */
export interface WorkdirEntry extends WorkdirEntryRow {
  hash(): Promise<ObjectId>;
  read(): Promise<Uint8Array>;
  readLink(): Promise<string>;
  verify(): Promise<void>;
}

const BLOB_HEADER_ENCODER = new TextEncoder();

const computeBlobHash = async (ctx: Context, bytes: Uint8Array): Promise<ObjectId> => {
  const header = BLOB_HEADER_ENCODER.encode(`blob ${bytes.length}\0`);
  const combined = new Uint8Array(header.length + bytes.length);
  combined.set(header, 0);
  combined.set(bytes, header.length);
  const hex = await ctx.hash.hashHex(combined);
  return ObjectId.from(hex);
};

const readSymlinkBytes = async (ctx: Context, absPath: string): Promise<Uint8Array> => {
  const target = await ctx.fs.readlink(absPath);
  return BLOB_HEADER_ENCODER.encode(target);
};

const statMatches = (observed: WorkdirStat, current: WorkdirStat): boolean =>
  observed.mode === current.mode &&
  observed.size === current.size &&
  observed.mtimeMs === current.mtimeMs;

// Map a POSIX-style stat to git's `FileMode` discriminator. Symlinks first,
// then the executable bit (`0o111`), then regular. Same recipe used by
// `commands/add.ts:347` — extract into a shared helper when 20.2 lands.
const deriveFileMode = (stat: FileStat): FileMode =>
  stat.isSymbolicLink ? '120000' : (stat.mode & 0o111) !== 0 ? '100755' : '100644';

const liveStat = async (ctx: Context, absPath: string): Promise<WorkdirStat> => {
  const stat = await ctx.fs.lstat(absPath);
  return {
    mode: deriveFileMode(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ...(stat.mtimeNs === undefined ? {} : { mtimeNs: stat.mtimeNs }),
    ino: BigInt(stat.ino),
  };
};

/**
 * Wrap a domain `WorkdirEntryRow` with the I/O surface that consumers
 * expect. Methods bind to `ctx` + the row's `path` via the workdir root.
 */
export const createWorkdirEntry = (ctx: Context, row: WorkdirEntryRow): WorkdirEntry => {
  const absPath = joinPath(ctx.layout.workDir, row.path);

  const read = async (): Promise<Uint8Array> =>
    row.kind === 'symlink' ? readSymlinkBytes(ctx, absPath) : ctx.fs.read(absPath);

  const hash = async (): Promise<ObjectId> => computeBlobHash(ctx, await read());

  const readLink = async (): Promise<string> => {
    if (row.kind !== 'symlink') {
      throw unsupportedOperation('readLink', `entry is not a symlink (kind=${row.kind})`);
    }
    return ctx.fs.readlink(absPath);
  };

  const verify = async (): Promise<void> => {
    const current = await liveStat(ctx, absPath);
    if (!statMatches(row.stat, current)) {
      throw workdirRace(row.path, row.stat, current);
    }
  };

  return { ...row, hash, read, readLink, verify };
};

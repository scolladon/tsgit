/**
 * Fakes shared by the `NodeFileSystem` dependency-injection test suites.
 *
 * Every test that uses these injects a fake directly into the
 * `NodeFileSystem` constructor, through the `fsOps` / `syncIo` members of
 * the options object. NO `vi.mock` — the dependencies are explicit, the
 * tests are cross-platform by construction, and there's no module-system
 * magic.
 */
import type * as fs from 'node:fs';
import { vi } from 'vitest';
import type {
  FsOperations,
  SyncFsOperations,
} from '../../../../src/adapters/node/fs-operations.js';
import type { SyncIoPolicy, TurnBudget } from '../../../../src/adapters/node/sync-io-budget.js';

/** `maxSyncReadBytes` for a fake policy — no test in this suite reads bytes through it yet. */
const FAKE_MAX_SYNC_READ_BYTES = 64 * 1024;

export const enoent = (msg = 'not found'): NodeJS.ErrnoException =>
  Object.assign(new Error(msg), { code: 'ENOENT' });

export const eacces = (): NodeJS.ErrnoException =>
  Object.assign(new Error('access'), { code: 'EACCES' });

export const enotdir = (): NodeJS.ErrnoException =>
  Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });

export const eloop = (): NodeJS.ErrnoException =>
  Object.assign(new Error('symlink loop'), { code: 'ELOOP' });

export const eexist = (): NodeJS.ErrnoException =>
  Object.assign(new Error('exists'), { code: 'EEXIST' });

export const einval = (): NodeJS.ErrnoException =>
  Object.assign(new Error('invalid argument'), { code: 'EINVAL' });

export const enotempty = (): NodeJS.ErrnoException =>
  Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });

type EntryStats = Pick<fs.BigIntStats, 'isDirectory' | 'isSymbolicLink' | 'ino' | 'dev'>;

/** A fabricated bigint `lstat` answer: the kind, plus the entry identity a real `BigIntStats` carries. */
export const entry = (
  kind: 'directory' | 'file' | 'symlink',
  ino: number,
  dev = 1,
): EntryStats => ({
  isDirectory: () => kind === 'directory',
  isSymbolicLink: () => kind === 'symlink',
  ino: BigInt(ino),
  dev: BigInt(dev),
});

/**
 * Builds a fake `FsOperations` whose every method rejects with ENOENT by
 * default. Tests override only the methods they exercise — keeps each
 * test arrange-block tight and the unused surface unambiguously "not
 * called".
 */
export const fakeFsOps = (overrides: Partial<FsOperations> = {}): FsOperations =>
  ({
    realpath: vi.fn().mockRejectedValue(enoent()),
    open: vi.fn().mockRejectedValue(enoent()),
    lstat: vi.fn().mockRejectedValue(enoent()),
    stat: vi.fn().mockRejectedValue(enoent()),
    readdir: vi.fn().mockRejectedValue(enoent()),
    readFile: vi.fn().mockRejectedValue(enoent()),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    readlink: vi.fn().mockRejectedValue(enoent()),
    symlink: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as FsOperations;

const throwEnoentSync = (): never => {
  throw enoent();
};

/**
 * Builds a fake `SyncFsOperations` whose every member throws `ENOENT` by
 * default — the synchronous twin of `fakeFsOps`. Tests override only the
 * members they exercise.
 */
export const fakeSyncFsOps = (overrides: Partial<SyncFsOperations> = {}): SyncFsOperations =>
  ({
    statSync: vi.fn(throwEnoentSync),
    lstatSync: vi.fn(throwEnoentSync),
    readlinkSync: vi.fn(throwEnoentSync),
    openSync: vi.fn(throwEnoentSync),
    fstatSync: vi.fn(throwEnoentSync),
    readSync: vi.fn(throwEnoentSync),
    closeSync: vi.fn(throwEnoentSync),
    realpathSync: { native: vi.fn(throwEnoentSync) },
    ...overrides,
  }) as unknown as SyncFsOperations;

/** A `TurnBudget` that always admits immediately — no yields, `charge` is a spy. */
const alwaysAdmitBudget = (): TurnBudget => ({
  admit: () => undefined,
  charge: vi.fn(),
  now: () => 0,
});

/** Builds a fake `SyncIoPolicy` around a `SyncFsOperations` fake, budget default always-admitting. */
export const fakeSyncIoPolicy = (
  ops: SyncFsOperations,
  budget: TurnBudget = alwaysAdmitBudget(),
): SyncIoPolicy => ({ ops, budget, maxSyncReadBytes: FAKE_MAX_SYNC_READ_BYTES });

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCompressor } from '../../../src/adapters/memory/memory-compressor.js';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { MemoryHashService } from '../../../src/adapters/memory/memory-hash-service.js';
import { MemoryHttpTransport } from '../../../src/adapters/memory/memory-http-transport.js';
import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { nativePolicy } from '../../../src/adapters/node/path-policy.js';
import { objectSources } from '../../../src/application/primitives/object-store.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import type { ObjectContent } from '../../../src/domain/objects/index.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { openRepository, type RuntimeFallback } from '../../../src/repository.js';

const REPO = '/repo';
const ALTERNATES_LIST = `${REPO}/.git/objects/info/alternates`;
const WORKTREE = '/repo-wt';
const DRIVE_OBJECTS = 'C:\\host\\objects';
/** A POSIX memory fs reads a drive path relative to its root, so this root stands in for drive C:. */
const DRIVE_C = '/volume';
/** A POSIX directory whose name holds a backslash: a name to a POSIX reader, a separator to a Windows one. */
const BACKSLASH_OBJECTS = `${REPO}/alt\\objects`;

/** git holds an alternate by its real path, every separator spelt `/` — git for Windows' form too. */
const heldForm = (hostPath: string): string => hostPath.split(path.sep).join('/');

/**
 * How the caller's POSIX memory fs refuses a host path, read the POSIX way whatever the host:
 * outside its root on POSIX; on Windows a drive path is one relative name under the objects dir,
 * where nothing is.
 */
const callerFsRefusalOf = (hostPath: string) =>
  nativePolicy.windowsSyntax
    ? { reason: 'not-a-directory', path: `${REPO}/.git/objects/${hostPath}` }
    : { reason: 'unreachable', path: hostPath, code: 'PERMISSION_DENIED' };

interface HostHooks {
  readonly makeConfinedFs: ReturnType<typeof vi.fn<(roots: ReadonlyArray<string>) => FileSystem>>;
  readonly makeWorktreeFs: ReturnType<typeof vi.fn<(roots: ReadonlyArray<string>) => FileSystem>>;
  readonly filenameProbe: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
}

const hostHooks = (): HostHooks => ({
  makeConfinedFs: vi.fn(
    (roots: ReadonlyArray<string>): FileSystem => new NodeFileSystem([...roots]),
  ),
  makeWorktreeFs: vi.fn(
    (roots: ReadonlyArray<string>): FileSystem => new NodeFileSystem([...roots]),
  ),
  filenameProbe: vi.fn(async () => true),
});

const nodeFallback = (hooks: HostHooks): RuntimeFallback => ({
  fs: new MemoryFileSystem({ rootDir: REPO }),
  hash: new MemoryHashService('sha1'),
  compressor: new MemoryCompressor(),
  transport: new MemoryHttpTransport(),
  runtime: 'node',
  layout: { workDir: REPO, gitDir: `${REPO}/.git`, bare: false, refStorage: 'files' },
  hashConfig: SHA1_CONFIG,
  deltaCache: createLruCache<ObjectContent>(1024),
  windowsPathSyntax: nativePolicy.windowsSyntax,
  ...hooks,
});

const userFsListing = async (alternate: string): Promise<MemoryFileSystem> => {
  const fs = new MemoryFileSystem({ rootDir: REPO });
  await fs.writeUtf8(`${REPO}/.git/HEAD`, 'ref: refs/heads/main\n');
  await fs.writeUtf8(ALTERNATES_LIST, `${alternate}\n`);
  return fs;
};

/** A caller fs listing an alternate it also holds, as a directory. */
const userFsHolding = async (alternate: string): Promise<MemoryFileSystem> => {
  const fs = await userFsListing(alternate);
  await fs.mkdir(alternate);
  return fs;
};

describe('openRepository host hooks', () => {
  let hostDir: string;
  let hostObjects: string;

  beforeEach(async () => {
    hostDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-host-hooks-')));
    hostObjects = path.join(hostDir, 'objects');
    await mkdir(hostObjects);
  });

  afterEach(async () => {
    await rm(hostDir, { recursive: true, force: true });
  });

  describe('Given a node runtime opened over a caller-supplied fs whose alternates name a host directory', () => {
    describe('When the object store resolves the alternate', () => {
      it('Then the alternate is unreachable and no host fs is built', async () => {
        // Arrange
        const hooks = hostHooks();
        const repo = await openRepository(
          { cwd: REPO, fs: await userFsListing(hostObjects) },
          nodeFallback(hooks),
        );
        const sut = objectSources;

        // Act
        const result = await sut(repo.ctx);

        // Assert
        expect(result.unusable).toMatchObject([callerFsRefusalOf(hostObjects)]);
        expect(result.sources).toEqual([{ objectsDir: `${REPO}/.git/objects`, local: true }]);
        expect(hooks.makeConfinedFs).not.toHaveBeenCalled();
        await repo.dispose();
      });
    });

    describe('When a worktree-scoped fs is built', () => {
      it('Then it reads through the caller fs and no host worktree fs is built', async () => {
        // Arrange
        const hooks = hostHooks();
        const userFs = await userFsListing(hostObjects);
        await userFs.writeUtf8(`${REPO}/inside.txt`, 'user content');
        const repo = await openRepository({ cwd: REPO, fs: userFs }, nodeFallback(hooks));
        const sut = repo.ctx.worktreeFs;

        // Act
        const result = await sut?.(WORKTREE).readUtf8(`${REPO}/inside.txt`);

        // Assert
        expect(result).toBe('user content');
        expect(hooks.makeWorktreeFs).not.toHaveBeenCalled();
        await repo.dispose();
      });
    });

    describe('When the filename probe is read', () => {
      it('Then the context carries none, so every name answers absent', async () => {
        // Arrange
        const hooks = hostHooks();
        const sut = openRepository;

        // Act
        const repo = await sut(
          { cwd: REPO, fs: await userFsListing(hostObjects) },
          nodeFallback(hooks),
        );

        // Assert
        expect(repo.ctx.filenameProbe).toBeUndefined();
        await repo.dispose();
      });
    });
  });

  describe('Given a node runtime opened over its own fs', () => {
    describe('When the object store resolves its sources', () => {
      it('Then the host alternate is resolved and read through the host hooks', async () => {
        // Arrange
        const hooks = hostHooks();
        const fallback = { ...nodeFallback(hooks), fs: await userFsListing(hostObjects) };
        const repo = await openRepository({ cwd: REPO }, fallback);
        const sut = objectSources;

        // Act
        const result = await sut(repo.ctx);

        // Assert
        expect(result.sources).toEqual([
          { objectsDir: `${REPO}/.git/objects`, local: true },
          { objectsDir: heldForm(hostObjects), local: false },
        ]);
        expect(hooks.makeConfinedFs).toHaveBeenCalledWith([heldForm(hostObjects)]);
        expect(repo.ctx.filenameProbe).toBe(hooks.filenameProbe);
        await repo.dispose();
      });
    });
  });

  describe('Given a Windows node runtime opened over a caller-supplied fs whose alternates name a drive path', () => {
    describe('When the object store resolves the alternate', () => {
      it('Then the path reads as one POSIX name under the objects dir, nothing is there and no host fs is built', async () => {
        // Arrange
        const hooks = hostHooks();
        const fallback = { ...nodeFallback(hooks), windowsPathSyntax: true };
        const repo = await openRepository(
          { cwd: REPO, fs: await userFsListing(DRIVE_OBJECTS) },
          fallback,
        );
        const sut = objectSources;

        // Act
        const result = await sut(repo.ctx);

        // Assert
        expect(result.unusable).toMatchObject([
          { reason: 'not-a-directory', path: `${REPO}/.git/objects/${DRIVE_OBJECTS}` },
        ]);
        expect(result.sources).toEqual([{ objectsDir: `${REPO}/.git/objects`, local: true }]);
        expect(hooks.makeConfinedFs).not.toHaveBeenCalled();
        await repo.dispose();
      });
    });
  });

  describe('Given a caller-supplied POSIX fs whose alternates name a directory with a backslash in its name', () => {
    describe('When the object store resolves the alternate on a POSIX node runtime', () => {
      it('Then the directory is linked as a source', async () => {
        // Arrange
        const fallback = { ...nodeFallback(hostHooks()), windowsPathSyntax: false };
        const repo = await openRepository(
          { cwd: REPO, fs: await userFsHolding(BACKSLASH_OBJECTS) },
          fallback,
        );
        const sut = objectSources;

        // Act
        const result = await sut(repo.ctx);

        // Assert
        expect(result.unusable).toEqual([]);
        expect(result.sources).toEqual([
          { objectsDir: `${REPO}/.git/objects`, local: true },
          { objectsDir: BACKSLASH_OBJECTS, local: false },
        ]);
        await repo.dispose();
      });
    });

    describe('When the object store resolves the alternate on a Windows node runtime', () => {
      it('Then the directory is linked the same way, the caller fs reading its paths the POSIX way', async () => {
        // Arrange
        const fallback = { ...nodeFallback(hostHooks()), windowsPathSyntax: true };
        const repo = await openRepository(
          { cwd: REPO, fs: await userFsHolding(BACKSLASH_OBJECTS) },
          fallback,
        );
        const sut = objectSources;

        // Act
        const result = await sut(repo.ctx);

        // Assert
        expect(result.unusable).toEqual([]);
        expect(result.sources).toEqual([
          { objectsDir: `${REPO}/.git/objects`, local: true },
          { objectsDir: BACKSLASH_OBJECTS, local: false },
        ]);
        await repo.dispose();
      });
    });
  });

  describe('Given a Windows node runtime opened over its own fs whose alternates name a drive path', () => {
    describe('When the object store resolves its sources', () => {
      it('Then the alternate is read through the host hooks and held with slash separators', async () => {
        // Arrange
        const driveC = new MemoryFileSystem({ rootDir: DRIVE_C });
        await driveC.mkdir('C:/host/objects');
        const hooks = { ...hostHooks(), makeConfinedFs: vi.fn(() => driveC) };
        const fallback = {
          ...nodeFallback(hooks),
          fs: await userFsListing(DRIVE_OBJECTS),
          windowsPathSyntax: true,
        };
        const repo = await openRepository({ cwd: REPO }, fallback);
        const sut = objectSources;

        // Act
        const result = await sut(repo.ctx);

        // Assert
        expect(result.sources).toEqual([
          { objectsDir: `${REPO}/.git/objects`, local: true },
          { objectsDir: 'C:/host/objects', local: false },
        ]);
        expect(hooks.makeConfinedFs).toHaveBeenCalledWith(['C:/host/objects']);
        await repo.dispose();
      });
    });
  });
});

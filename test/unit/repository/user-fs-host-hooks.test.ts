import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCompressor } from '../../../src/adapters/memory/memory-compressor.js';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { MemoryHashService } from '../../../src/adapters/memory/memory-hash-service.js';
import { MemoryHttpTransport } from '../../../src/adapters/memory/memory-http-transport.js';
import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { objectSources } from '../../../src/application/primitives/object-store.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import type { ObjectContent } from '../../../src/domain/objects/index.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { openRepository, type RuntimeFallback } from '../../../src/repository.js';

const REPO = '/repo';
const ALTERNATES_LIST = `${REPO}/.git/objects/info/alternates`;
const WORKTREE = '/repo-wt';

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
  ...hooks,
});

const userFsListing = async (alternate: string): Promise<MemoryFileSystem> => {
  const fs = new MemoryFileSystem({ rootDir: REPO });
  await fs.writeUtf8(`${REPO}/.git/HEAD`, 'ref: refs/heads/main\n');
  await fs.writeUtf8(ALTERNATES_LIST, `${alternate}\n`);
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
        expect(result.unusable).toMatchObject([
          { reason: 'unreachable', path: hostObjects, code: 'PERMISSION_DENIED' },
        ]);
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
          { objectsDir: hostObjects, local: false },
        ]);
        expect(hooks.makeConfinedFs).toHaveBeenCalledWith([hostObjects]);
        expect(repo.ctx.filenameProbe).toBe(hooks.filenameProbe);
        await repo.dispose();
      });
    });
  });
});

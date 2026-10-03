import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFilenameProbe } from '../../../src/adapters/node/node-filename-probe.js';
import { nativePolicy } from '../../../src/adapters/node/path-policy.js';
import {
  posixGitPathSyntax,
  windowsGitPathSyntax,
} from '../../../src/application/primitives/internal/git-path-syntax.js';
import { objectSources } from '../../../src/application/primitives/object-store.js';
import { openRepository as openMemoryRepository } from '../../../src/index.default.js';
import { openRepository } from '../../../src/index.node.js';
import type { ObjectSourceAccess } from '../../../src/ports/object-source-access.js';
import { filesystemRootOf } from '../../../src/repository/filesystem-root.js';

const ACCESS_MEMBERS: ReadonlyArray<keyof ObjectSourceAccess> = [
  'exists',
  'lstat',
  'openWithNoFollow',
  'read',
  'readSlice',
  'readUtf8',
  'readdir',
  'readlink',
  'stat',
  'utimeNow',
];

const encode = (content: string): Uint8Array => new TextEncoder().encode(content);

describe('Context.objectSourceAccess (node)', () => {
  let root: string;
  let workDir: string;
  let alternateObjects: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-osa-')));
    workDir = path.join(root, 'work');
    alternateObjects = path.join(root, 'elsewhere', 'objects');
    await mkdir(path.join(workDir, '.git', 'objects'), { recursive: true });
    await mkdir(path.join(workDir, '.git', 'refs'), { recursive: true });
    await writeFile(path.join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(alternateObjects, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('Given a node repository', () => {
    describe('When ctx.objectSourceAccess(dir) is built', () => {
      it('Then its own keys are exactly the ObjectSourceAccess members', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });

        // Act
        const sut = repo.ctx.objectSourceAccess?.(alternateObjects);

        // Assert
        expect(Object.keys(sut ?? {}).sort()).toEqual([...ACCESS_MEMBERS].sort());
        await repo.dispose();
      });

      it('Then a write-mode open is refused with PERMISSION_DENIED', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });
        const sut = repo.ctx.objectSourceAccess?.(alternateObjects);
        const target = path.join(alternateObjects, 'pwned');

        // Act
        const attempt = sut?.openWithNoFollow(target, 'write');

        // Assert
        await expect(attempt).rejects.toMatchObject({ data: { code: 'PERMISSION_DENIED' } });
        await repo.dispose();
      });

      it('Then it is memoised per objectsDir', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });
        const build = repo.ctx.objectSourceAccess;

        // Act
        const first = build?.(alternateObjects);
        const second = build?.(alternateObjects);
        const other = build?.(path.join(root, 'other', 'objects'));

        // Assert
        expect(second).toBe(first);
        expect(other).not.toBe(first);
        await repo.dispose();
      });
    });
  });

  describe('Given a node repository and an alternate objects dir outside the work tree', () => {
    describe('When utimeNow targets a file', () => {
      it('Then a sibling outside that objects dir is refused with PERMISSION_DENIED', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });
        const sut = repo.ctx.objectSourceAccess?.(alternateObjects);
        const sibling = path.join(root, 'elsewhere', 'sibling');
        await writeFile(sibling, 'x');

        // Act
        const attempt = sut?.utimeNow?.(sibling);

        // Assert
        await expect(attempt).rejects.toMatchObject({ data: { code: 'PERMISSION_DENIED' } });
        await repo.dispose();
      });

      it('Then a file inside advances its mtime', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });
        const sut = repo.ctx.objectSourceAccess?.(alternateObjects);
        const inside = path.join(alternateObjects, 'obj');
        await writeFile(inside, 'x');
        await utimes(inside, new Date(1_000_000), new Date(1_000_000));

        // Act
        await sut?.utimeNow?.(inside);

        // Assert
        expect((await stat(inside)).mtimeMs).toBeGreaterThan(1_000_000_000);
        await repo.dispose();
      });
    });
  });

  describe('Given a node repository', () => {
    describe('When ctx.alternatePathProbe(path) is built', () => {
      it('Then it exposes lstat, readlink and stat only', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });

        // Act
        const sut = repo.ctx.alternatePathProbe?.(alternateObjects);

        // Assert
        expect(Object.keys(sut ?? {}).sort()).toEqual(['lstat', 'readlink', 'stat']);
        await repo.dispose();
      });

      it('Then it reaches a path outside the work tree', async () => {
        // Arrange
        const repo = await openRepository({ cwd: workDir });
        const sut = repo.ctx.alternatePathProbe?.(alternateObjects);

        // Act
        const result = await sut?.stat(alternateObjects);

        // Assert
        expect(result?.isDirectory).toBe(true);
        await repo.dispose();
      });
    });
  });

  describe('Given a node repository', () => {
    describe('When its context is built', () => {
      it('Then windowsPathSyntax mirrors the native path policy', async () => {
        // Arrange
        const sut = openRepository;

        // Act
        const repo = await sut({ cwd: workDir });

        // Assert
        expect(repo.ctx.windowsPathSyntax).toBe(nativePolicy.windowsSyntax);
        await repo.dispose();
      });

      it('Then filenameProbe is the node lstat existence probe', async () => {
        // Arrange
        const sut = openRepository;

        // Act
        const repo = await sut({ cwd: workDir });

        // Assert
        expect(repo.ctx.filenameProbe).toBe(nodeFilenameProbe);
        await repo.dispose();
      });
    });
  });

  describe('Given a memory repository', () => {
    describe('When its context is built', () => {
      it('Then windowsPathSyntax is absent', async () => {
        // Arrange
        const sut = openMemoryRepository;

        // Act
        const repo = await sut({
          cwd: '/repo',
          files: { '/repo/.git/HEAD': encode('ref: refs/heads/main\n') },
        });

        // Assert
        expect(repo.ctx.windowsPathSyntax).toBeUndefined();
        await repo.dispose();
      });

      it('Then filenameProbe is absent', async () => {
        // Arrange
        const sut = openMemoryRepository;

        // Act
        const repo = await sut({
          cwd: '/repo',
          files: { '/repo/.git/HEAD': encode('ref: refs/heads/main\n') },
        });

        // Assert
        expect(repo.ctx.filenameProbe).toBeUndefined();
        await repo.dispose();
      });
    });
  });

  describe('Given a memory repository', () => {
    describe('When the store resolves an out-of-root alternate', () => {
      it('Then objectSources().unusable reports it unreachable', async () => {
        // Arrange
        const repo = await openMemoryRepository({
          cwd: '/repo',
          files: {
            '/repo/.git/HEAD': encode('ref: refs/heads/main\n'),
            '/repo/.git/objects/info/alternates': encode('/outside/objects\n'),
          },
        });

        // Act
        const result = await objectSources(repo.ctx);

        // Assert
        expect(result.unusable).toMatchObject([{ reason: 'unreachable' }]);
        await repo.dispose();
      });
    });
  });
});

describe('filesystemRootOf', () => {
  describe.each([
    ['/x/y', '/'],
    ['/', '/'],
    ['/:x/y', '/'],
  ])('Given the POSIX path %s', (input, expected) => {
    describe('When the filesystem root is derived', () => {
      it(`Then the root is ${expected}`, () => {
        // Arrange
        const sut = filesystemRootOf;

        // Act
        const result = sut(posixGitPathSyntax, input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each([
    ['/x/y', '/'],
    ['C:\\x', 'C:\\'],
    ['C:/x/y', 'C:\\'],
    ['C:x', 'C:\\'],
    ['1:\\x', '1:\\'],
    ['\u00e4:\\x', '\u00e4:\\'],
    ['\u{1F600}:\\x', '\u{1F600}:\\'],
    ['\u00e4\u00e4\u00e4:\\x', '/'],
    ['\\\\srv\\share\\x', '\\\\srv\\share\\'],
    ['//srv/share', '\\\\srv\\share\\'],
  ])('Given the Windows path %s', (input, expected) => {
    describe('When the filesystem root is derived', () => {
      it(`Then the root is ${expected}`, () => {
        // Arrange
        const sut = filesystemRootOf;

        // Act
        const result = sut(windowsGitPathSyntax, input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

/**
 * Cross-tool interop for the receive path's already-present tolerance:
 * re-receiving a byte-identical, real git-produced pack must succeed and
 * leave the existing `.pack`/`.idx`/`.rev` untouched — same bytes, same
 * inode, same mtime — exactly as canonical git's own `index-pack --stdin
 * --fix-thin` behaves on a second identical run. Each tool is measured
 * against itself across two runs, never against the other's file names:
 * git and tsgit derive a pack's stem differently and no claim here depends
 * on them agreeing.
 *
 * @proves
 *   surface:        fetchPack.receive
 *   bucket:         cross-tool-interop
 *   unique:         re-receiving a byte-identical pack leaves the existing pack, idx and rev untouched, as git does
 *   interopSurface: packfile
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { fetchPack, type NegotiatePackBytes } from '../../src/application/primitives/fetch-pack.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const COMMIT_COUNT = 3;

describe.skipIf(!GIT_AVAILABLE)('pack-receive-idempotence interop', () => {
  let pair: PeerPair;
  let packBytes: Uint8Array;

  beforeAll(async () => {
    pair = await makePeerPair('pack-receive-idempotence');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
    runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
    runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);
    disableAutoMaintenance(pair.peer);

    for (let i = 0; i < COMMIT_COUNT; i += 1) {
      await writeFile(path.join(pair.peer, `file-${i}.txt`), `content ${i}\n`);
      runGit(['-C', pair.peer, 'add', `file-${i}.txt`]);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', `commit ${i}`]);
    }
    runGit(['-C', pair.peer, '-c', 'pack.threads=1', 'repack', '-a', '-d']);

    const packDir = path.join(pair.peer, '.git', 'objects', 'pack');
    const packName = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
    if (packName === undefined) {
      throw new Error('pack-receive-idempotence interop: no pack survived repack -a -d');
    }
    packBytes = await readFile(path.join(packDir, packName));
  }, 60_000);

  afterAll(async () => {
    await pair.dispose();
  });

  describe('Given a real git-produced pack and a fresh tsgit repository', () => {
    describe('When fetchPack receives that pack twice', () => {
      it('Then the second receive returns the same artefacts, byte-identical and with an unchanged inode and mtime, and leaves no quarantine file', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-idempotence-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          const ctx = createNodeContext({ workDir: dir });
          const negotiator: NegotiatePackBytes = async () => ({
            packBody: (async function* singleChunk() {
              yield packBytes;
            })(),
            shallow: [],
            unshallow: [],
          });
          const input = {
            wants: ['a'.repeat(40) as ObjectId],
            haves: [],
            capabilities: [],
            progressOp: 'test:write-objects',
          };

          const first = await fetchPack(ctx, negotiator, input);
          const revPath = `${path.dirname(first.idxPath)}/pack-${first.packSha}.rev`;
          const packBytesAfterFirst = await ctx.fs.read(first.packPath);
          const idxBytesAfterFirst = await ctx.fs.read(first.idxPath);
          const revBytesAfterFirst = await ctx.fs.read(revPath);
          const packStatAfterFirst = await ctx.fs.stat(first.packPath);
          const idxStatAfterFirst = await ctx.fs.stat(first.idxPath);
          const revStatAfterFirst = await ctx.fs.stat(revPath);

          // Act
          const second = await fetchPack(ctx, negotiator, input);

          // Assert — same artefacts, same identity.
          expect(second.packPath).toBe(first.packPath);
          expect(second.idxPath).toBe(first.idxPath);
          expect(second.packSha).toBe(first.packSha);
          expect(second.objectCount).toBe(first.objectCount);
          expect(second.objectCount).toBeGreaterThan(0);

          // Assert — byte-identical across the two calls.
          expect(await ctx.fs.read(second.packPath)).toEqual(packBytesAfterFirst);
          expect(await ctx.fs.read(second.idxPath)).toEqual(idxBytesAfterFirst);
          expect(await ctx.fs.read(revPath)).toEqual(revBytesAfterFirst);

          // Assert — same inode, same mtime: nothing was rewritten.
          const packStatAfterSecond = await ctx.fs.stat(second.packPath);
          const idxStatAfterSecond = await ctx.fs.stat(second.idxPath);
          const revStatAfterSecond = await ctx.fs.stat(revPath);
          expect(packStatAfterSecond.ino).toBe(packStatAfterFirst.ino);
          expect(packStatAfterSecond.mtimeMs).toBe(packStatAfterFirst.mtimeMs);
          expect(idxStatAfterSecond.ino).toBe(idxStatAfterFirst.ino);
          expect(idxStatAfterSecond.mtimeMs).toBe(idxStatAfterFirst.mtimeMs);
          expect(revStatAfterSecond.ino).toBe(revStatAfterFirst.ino);
          expect(revStatAfterSecond.mtimeMs).toBe(revStatAfterFirst.mtimeMs);

          // Assert — no leftover quarantine file.
          const packDirEntries = await ctx.fs.readdir(path.dirname(first.packPath));
          expect(packDirEntries.some((entry) => entry.name.startsWith('tmp_pack_'))).toBe(false);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });
  });

  describe('Given the same real git-produced pack and a fresh repository', () => {
    describe('When git index-pack --stdin --fix-thin receives it twice', () => {
      it('Then both runs exit 0 with empty stderr, and the artefacts stay byte-identical with an unchanged inode and mtime', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-idempotence-git-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);

          // Act
          const first = tryRunGitWithExit(['-C', dir, 'index-pack', '--stdin', '--fix-thin'], {
            input: packBytes,
          });
          const packDir = path.join(dir, '.git', 'objects', 'pack');
          const packName = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
          if (packName === undefined) {
            throw new Error('pack-receive-idempotence interop: git row produced no pack');
          }
          const stem = packName.slice(0, -'.pack'.length);
          const packPath = path.join(packDir, `${stem}.pack`);
          const idxPath = path.join(packDir, `${stem}.idx`);
          const revPath = path.join(packDir, `${stem}.rev`);
          const packBytesAfterFirst = await readFile(packPath);
          const idxBytesAfterFirst = await readFile(idxPath);
          const revBytesAfterFirst = await readFile(revPath);
          const packStatAfterFirst = await stat(packPath);
          const idxStatAfterFirst = await stat(idxPath);
          const revStatAfterFirst = await stat(revPath);

          const second = tryRunGitWithExit(['-C', dir, 'index-pack', '--stdin', '--fix-thin'], {
            input: packBytes,
          });

          // Assert — both runs succeed silently.
          expect(first.exitCode).toBe(0);
          expect(first.stderr).toBe('');
          expect(second.exitCode).toBe(0);
          expect(second.stderr).toBe('');

          // Assert — byte-identical across the two runs.
          expect(await readFile(packPath)).toEqual(packBytesAfterFirst);
          expect(await readFile(idxPath)).toEqual(idxBytesAfterFirst);
          expect(await readFile(revPath)).toEqual(revBytesAfterFirst);

          // Assert — same inode, same mtime: nothing was rewritten.
          const packStatAfterSecond = await stat(packPath);
          const idxStatAfterSecond = await stat(idxPath);
          const revStatAfterSecond = await stat(revPath);
          expect(packStatAfterSecond.ino).toBe(packStatAfterFirst.ino);
          expect(packStatAfterSecond.mtimeMs).toBe(packStatAfterFirst.mtimeMs);
          expect(idxStatAfterSecond.ino).toBe(idxStatAfterFirst.ino);
          expect(idxStatAfterSecond.mtimeMs).toBe(idxStatAfterFirst.mtimeMs);
          expect(revStatAfterSecond.ino).toBe(revStatAfterFirst.ino);
          expect(revStatAfterSecond.mtimeMs).toBe(revStatAfterFirst.mtimeMs);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });
  });
});

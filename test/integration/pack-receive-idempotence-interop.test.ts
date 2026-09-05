/**
 * Cross-tool interop for the receive path's already-present tolerance,
 * per artefact and exactly as canonical git's own `index-pack --stdin
 * --fix-thin` behaves: a second identical run keeps every existing artefact
 * untouched (same bytes, same inode, same mtime), recreates a sibling that
 * went missing, and refuses when an artefact on disk differs in contents. Each tool is measured
 * against itself across two runs, never against the other's file names:
 * git and tsgit derive a pack's stem differently and no claim here depends
 * on them agreeing.
 *
 * @proves
 *   surface:        fetchPack.receive
 *   bucket:         cross-tool-interop
 *   unique:         re-receiving a pack keeps identical artefacts, recreates missing siblings and refuses differing bytes, as git does
 *   interopSurface: packfile
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { fetchPack, type NegotiatePackBytes } from '../../src/application/primitives/fetch-pack.js';
import { TsgitError } from '../../src/domain/error.js';
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
const PLANTED = new TextEncoder().encode('planted bytes, not a real pack');
const TRAILER_BYTES = 20;

/** git's own `index-pack` invocation, with the reverse-index write pinned
 *  explicitly rather than inherited from the runner's git default. */
const indexPackArgs = (dir: string): string[] => [
  '-C',
  dir,
  '-c',
  'pack.writeReverseIndex=true',
  'index-pack',
  '--stdin',
  '--fix-thin',
];

const RECEIVE_INPUT = {
  wants: ['a'.repeat(40) as ObjectId],
  haves: [],
  capabilities: [],
  progressOp: 'test:write-objects',
};

const singleChunk =
  (bytes: Uint8Array): NegotiatePackBytes =>
  async () => ({
    packBody: (async function* chunk() {
      yield bytes;
    })(),
    shallow: [],
    unshallow: [],
  });

const gitPackDir = (dir: string): string => path.join(dir, '.git', 'objects', 'pack');

/** git names a received pack after its trailer checksum. */
const gitPackStem = (bytes: Uint8Array): string =>
  `pack-${Buffer.from(bytes.subarray(bytes.length - TRAILER_BYTES)).toString('hex')}`;

const expectMismatch = (caught: unknown, artefactPath: string): void => {
  expect(caught).toBeInstanceOf(TsgitError);
  if (!(caught instanceof TsgitError)) expect.unreachable();
  expect(caught.data.code).toBe('PACK_ARTIFACT_MISMATCH');
  if (caught.data.code !== 'PACK_ARTIFACT_MISMATCH') expect.unreachable();
  expect(caught.data.path).toBe(artefactPath);
};

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
          const first = tryRunGitWithExit(indexPackArgs(dir), {
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

          const second = tryRunGitWithExit(indexPackArgs(dir), {
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
  describe('Given a foreign file planted at the pack content-addressed name', () => {
    describe('When git index-pack receives the real pack', () => {
      it('Then it refuses with exit 128 naming a contents mismatch and leaves the planted bytes untouched', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-planted-git-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          const planted = path.join(gitPackDir(dir), `${gitPackStem(packBytes)}.pack`);
          await writeFile(planted, PLANTED);

          // Act
          const run = tryRunGitWithExit(indexPackArgs(dir), { input: packBytes });

          // Assert
          expect(run.exitCode).toBe(128);
          expect(run.stderr).toContain('differ in contents');
          expect(new Uint8Array(await readFile(planted))).toEqual(PLANTED);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });

    describe('When fetchPack receives the real pack', () => {
      it('Then it refuses naming the destination, leaves the planted bytes untouched and leaves no quarantine file', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-planted-tsgit-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          const ctx = createNodeContext({ workDir: dir });
          const packSha = await ctx.hash.hashHex(packBytes.subarray(0, -TRAILER_BYTES));
          const destination = `${gitPackDir(dir)}/pack-${packSha}.pack`;
          await ctx.fs.writeExclusive(destination, PLANTED);
          const sut = fetchPack;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, singleChunk(packBytes), RECEIVE_INPUT);
          } catch (err) {
            caught = err;
          }

          // Assert
          expectMismatch(caught, destination);
          expect(await ctx.fs.read(destination)).toEqual(PLANTED);
          const entries = await ctx.fs.readdir(gitPackDir(dir));
          expect(entries.some((entry) => entry.name.startsWith('tmp_pack_'))).toBe(false);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });
  });

  describe('Given the pack present and its index and reverse index removed', () => {
    describe('When git index-pack receives the identical pack again', () => {
      it('Then it exits 0 and recreates both siblings', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-siblings-git-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          tryRunGitWithExit(indexPackArgs(dir), { input: packBytes });
          const stem = path.join(gitPackDir(dir), gitPackStem(packBytes));
          await rm(`${stem}.idx`);
          await rm(`${stem}.rev`);

          // Act
          const run = tryRunGitWithExit(indexPackArgs(dir), { input: packBytes });

          // Assert
          expect(run.exitCode).toBe(0);
          expect((await stat(`${stem}.idx`)).isFile()).toBe(true);
          expect((await stat(`${stem}.rev`)).isFile()).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });

    describe('When fetchPack receives the identical pack again', () => {
      it('Then it succeeds and recreates both siblings', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-siblings-tsgit-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          const ctx = createNodeContext({ workDir: dir });
          const sut = fetchPack;
          const first = await sut(ctx, singleChunk(packBytes), RECEIVE_INPUT);
          const revPath = `${gitPackDir(dir)}/pack-${first.packSha}.rev`;
          await ctx.fs.rm(first.idxPath);
          await ctx.fs.rm(revPath);

          // Act
          const second = await sut(ctx, singleChunk(packBytes), RECEIVE_INPUT);

          // Assert
          expect(second.packSha).toBe(first.packSha);
          expect(await ctx.fs.exists(second.idxPath)).toBe(true);
          expect(await ctx.fs.exists(revPath)).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });
  });

  describe('Given a zero-byte index beside the pack', () => {
    describe('When git index-pack receives the identical pack again', () => {
      it('Then it refuses with exit 128 naming a contents mismatch', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-corrupt-idx-git-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          tryRunGitWithExit(indexPackArgs(dir), { input: packBytes });
          const idxPath = path.join(gitPackDir(dir), `${gitPackStem(packBytes)}.idx`);
          // git leaves its pack artefacts read-only; replace the file rather than truncating it.
          await rm(idxPath);
          await writeFile(idxPath, new Uint8Array(0));

          // Act
          const run = tryRunGitWithExit(indexPackArgs(dir), { input: packBytes });

          // Assert
          expect(run.exitCode).toBe(128);
          expect(run.stderr).toContain('differ in contents');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });

    describe('When fetchPack receives the identical pack again', () => {
      it('Then it refuses naming the index', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-receive-corrupt-idx-tsgit-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          const ctx = createNodeContext({ workDir: dir });
          const sut = fetchPack;
          const first = await sut(ctx, singleChunk(packBytes), RECEIVE_INPUT);
          await ctx.fs.rm(first.idxPath);
          await ctx.fs.writeExclusive(first.idxPath, new Uint8Array(0));

          // Act
          let caught: unknown;
          try {
            await sut(ctx, singleChunk(packBytes), RECEIVE_INPUT);
          } catch (err) {
            caught = err;
          }

          // Assert
          expectMismatch(caught, first.idxPath);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 30_000);
    });
  });
});

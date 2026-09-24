/**
 * Cross-tool interop — object-store precedence for buffered reads. Canonical
 * git answers info queries and every buffered content read from the PACK
 * first once an object is packed (`do_oid_object_info_extended`); only the
 * streaming blob reader (`stream_blob_to_fd`) stays loose-first. Pins tsgit's
 * buffered resolver (`readObject`/`readBlob`/`readTree`/`readObjectMetadata`)
 * against real git 2.55.0 for a loose "impostor" object planted at the same
 * oid as its packed twin, and confirms `streamBlob` keeps answering loose
 * first, matching git's own split.
 *
 * @proves
 *   surface:        readObject, readBlob, readTree, readObjectMetadata, streamBlob
 *   bucket:         cross-tool-interop
 *   unique:         pack-first precedence for buffered reads, loose-first for the streaming path — pinned against git 2.55.0
 *   interopSurface: readObject, readBlob, readTree, streamBlob
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readBlob } from '../../src/application/primitives/read-blob.js';
import { readObject, readObjectMetadata } from '../../src/application/primitives/read-object.js';
import { readTree } from '../../src/application/primitives/read-tree.js';
import { streamBlob } from '../../src/application/primitives/stream-blob.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Blob, Commit, ObjectId, Tree } from '../../src/domain/objects/index.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const HELLO = Buffer.from('hello\n');

const loosePathFor = (dir: string, oid: string): string =>
  path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));

/** Plants a loose object at `oid` with `node:zlib`'s `deflateSync` directly —
 *  bypassing every domain compressor, so the bytes on disk are exactly what a
 *  stale or hostile loose file would hold, honestly declaring `body`'s length. */
async function plantLoose(dir: string, oid: string, type: string, body: Buffer): Promise<void> {
  await plantLooseDeclaring(dir, oid, type, body.byteLength, body);
}

/** Like {@link plantLoose}, but the header's size claim (`declaredSize`) may
 *  disagree with `body`'s real length — a size-lying loose object. */
async function plantLooseDeclaring(
  dir: string,
  oid: string,
  type: string,
  declaredSize: number,
  body: Buffer,
): Promise<void> {
  const header = Buffer.from(`${type} ${declaredSize}\0`);
  await mkdir(path.dirname(loosePathFor(dir, oid)), { recursive: true });
  await writeFile(loosePathFor(dir, oid), deflateSync(Buffer.concat([header, body])));
}

/** Plants non-zlib garbage at `oid` — a loose file that fails to inflate at all. */
async function plantGarbageLoose(dir: string, oid: string): Promise<void> {
  await mkdir(path.dirname(loosePathFor(dir, oid)), { recursive: true });
  await writeFile(loosePathFor(dir, oid), Buffer.from('not-a-zlib-stream'));
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

describe.skipIf(!GIT_AVAILABLE)(
  'object-store precedence interop (pack-first buffered reads)',
  () => {
    let dir = '';
    let blobId = '';
    let treeId = '';
    let commitId = '';

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-object-precedence-'));
      runGit(['init', '-q', '-b', 'main', dir]);
      git(dir, 'config', 'user.name', 'Ada');
      git(dir, 'config', 'user.email', 'ada@example.com');
      git(dir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(dir);
      await writeFile(path.join(dir, 'a.txt'), HELLO);
      git(dir, 'add', 'a.txt');
      git(dir, 'commit', '-q', '-m', 'c1');
      blobId = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
      treeId = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
      commitId = git(dir, 'rev-parse', 'HEAD').trim();
      // 0 loose objects remain — every row below plants its OWN loose file back
      // at one of these three oids, shadowing (or trying to shadow) the pack.
      git(dir, 'gc', '-q');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    describe('Given a blob impostor planted loose at the packed blob oid (O1), When both git and tsgit read it', () => {
      it('Then git serves the impostor only on the streaming class, and the pack everywhere else — tsgit matches: readBlob/readObject pack-first, streamBlob loose-first', async () => {
        // Arrange
        const impostor = Buffer.from('LOOSE!\n');
        await plantLoose(dir, blobId, 'blob', impostor);
        const ctx = createNodeContext({ workDir: dir });
        const id = blobId as ObjectId;

        // Act — git side: info + buffered-class surfaces vs. the streaming class
        const gitSize = git(dir, 'cat-file', '-s', blobId).trim();
        const gitBufferedBody = runGit([
          '-C',
          dir,
          '-c',
          'core.bigFileThreshold=1',
          'cat-file',
          '-p',
          blobId,
        ]);
        const gitStreamedBody = runGit(['-C', dir, 'cat-file', '-p', blobId]);

        // Act — tsgit side
        const object = await readObject(ctx, id);
        const blob = await readBlob(ctx, id);
        const streamed = await collect(await streamBlob(ctx, id));

        // Assert — git's observed answer
        expect(gitSize).toBe('6');
        expect(Buffer.from(gitBufferedBody, 'utf8')).toEqual(HELLO);
        expect(Buffer.from(gitStreamedBody, 'utf8')).toEqual(impostor);

        // Assert — tsgit's observed answer: buffered reads serve the pack
        expect(object.type).toBe('blob');
        expect((object as Blob).content).toEqual(new Uint8Array(HELLO));
        expect(blob.content).toEqual(new Uint8Array(HELLO));
        // streamBlob stays loose-first, matching git's streaming class
        expect(streamed).toEqual(impostor);
      });
    });

    describe("Given a commit impostor planted loose at the HEAD commit oid (O2), When both git log and tsgit's readObject read it", () => {
      it("Then both git log and tsgit's readObject report the packed commit's own subject, never the impostor's", async () => {
        // Arrange
        const impostorBody = Buffer.from(
          'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n' +
            'author Impostor <impostor@example.com> 1000000000 +0000\n' +
            'committer Impostor <impostor@example.com> 1000000000 +0000\n\n' +
            'IMPOSTOR\n',
        );
        await plantLoose(dir, commitId, 'commit', impostorBody);
        const ctx = createNodeContext({ workDir: dir });
        const id = commitId as ObjectId;

        // Act — git side
        const gitSubject = git(dir, 'log', '-1', '--format=%s', commitId).trim();

        // Act — tsgit side
        const object = await readObject(ctx, id);

        // Assert
        expect(gitSubject).toBe('c1');
        expect(object.type).toBe('commit');
        expect((object as Commit).data.message).toBe('c1\n');
      });
    });

    describe("Given a tree impostor planted loose at the HEAD tree oid (O3), When both git ls-tree and tsgit's readTree read it", () => {
      it("Then both git ls-tree and tsgit's readTree report the original entries, never the impostor's (empty)", async () => {
        // Arrange — the impostor is a well-formed, but EMPTY, tree — the
        // original has exactly one entry (a.txt), so serving the impostor is
        // observably distinct from serving the pack.
        await plantLoose(dir, treeId, 'tree', Buffer.alloc(0));
        const ctx = createNodeContext({ workDir: dir });
        const id = treeId as ObjectId;

        // Act — git side
        const gitLsTree = git(dir, 'ls-tree', treeId);

        // Act — tsgit side
        const tree = await readTree(ctx, id);

        // Assert
        expect(gitLsTree).toContain('a.txt');
        expect((tree as Tree).entries).toHaveLength(1);
        expect((tree as Tree).entries[0]?.name).toBe('a.txt');
      });
    });

    describe('Given non-zlib garbage planted loose at the packed blob oid (P1), When both git and tsgit read it', () => {
      it('Then git prints an inflate error but still serves the pack content, and tsgit resolves the pack content without throwing', async () => {
        // Arrange
        await plantGarbageLoose(dir, blobId);
        const ctx = createNodeContext({ workDir: dir });
        const id = blobId as ObjectId;

        // Act — git side
        const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', blobId]);

        // Act — tsgit side
        const object = await readObject(ctx, id);

        // Assert — git's observed answer: an error line, then the pack content, exit 0
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toContain('inflate');
        expect(Buffer.from(gitResult.stdout, 'utf8')).toEqual(HELLO);

        // Assert — tsgit's observed answer: the corrupt loose copy is shadowed
        expect(object.type).toBe('blob');
        expect((object as Blob).content).toEqual(new Uint8Array(HELLO));
      });
    });

    describe("Given non-zlib garbage planted loose at the packed blob oid (P1), on the streamed path, When git's streaming reader and tsgit's streamBlob read it", () => {
      it("Then git's streaming reader also falls back to the pack, but tsgit's streamBlob still refuses — a pre-existing divergence, recorded not fixed", async () => {
        // Arrange — git's own `cat-file blob` (the streaming class, per O1
        // above) tries loose first; on a genuinely unreadable loose copy it
        // falls back to the pack too, unlike the O1 impostor (a validly
        // zlib-decodable loose file, which streaming serves as-is).
        await plantGarbageLoose(dir, blobId);
        const ctx = createNodeContext({ workDir: dir });
        const id = blobId as ObjectId;

        // Act — git side
        const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', 'blob', blobId]);

        // Act — tsgit side
        let caught: unknown;
        try {
          await collect(await streamBlob(ctx, id));
        } catch (error) {
          caught = error;
        }

        // Assert — git's observed answer: falls back to the pack, exit 0
        expect(gitResult.exitCode).toBe(0);
        expect(Buffer.from(gitResult.stdout, 'utf8')).toEqual(HELLO);

        // Assert — tsgit's observed answer: `openBlobSource` stays loose-first
        // with no pack-fallback on a corrupt loose read, so it refuses instead
        // of serving the pack — a pre-existing divergence from git, recorded
        // here rather than fixed (openBlobSource is out of this part's scope).
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      });
    });

    describe('Given non-zlib garbage planted loose at an oid with no packed twin (P2), When both git and tsgit attempt to read it', () => {
      it('Then git refuses with exit 128 ("Not a valid object name"), and tsgit refuses too — its exact code recorded as a pre-existing divergence if not OBJECT_NOT_FOUND', async () => {
        // Arrange
        const unpackedId = 'd'.repeat(40);
        await plantGarbageLoose(dir, unpackedId);
        const ctx = createNodeContext({ workDir: dir });
        const id = unpackedId as ObjectId;

        // Act — git side
        const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', unpackedId]);

        // Act — tsgit side
        let caught: unknown;
        try {
          await readObject(ctx, id);
        } catch (error) {
          caught = error;
        }

        // Assert — git's observed answer
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain('Not a valid object name');

        // Assert — tsgit refuses too; the exact code is recorded rather than
        // asserted to be OBJECT_NOT_FOUND — a pre-existing divergence when it
        // differs (tsgit's inflate failure surfaces as DECOMPRESS_FAILED here,
        // since the object was never packed, so the loose arm's own decode
        // error is the only fault there is to report).
        expect(caught).toBeInstanceOf(TsgitError);
        const code = (caught as TsgitError).data.code;
        expect(code).toBe('DECOMPRESS_FAILED');
      });
    });

    describe('Given a size-lying loose object planted at the packed blob oid (P3), When both git and tsgit read it', () => {
      it('Then both git and tsgit report the pack content and its true 6-byte size, never the claimed 99', async () => {
        // Arrange
        await plantLooseDeclaring(dir, blobId, 'blob', 99, HELLO);
        const ctx = createNodeContext({ workDir: dir });
        const id = blobId as ObjectId;

        // Act — git side
        const gitSize = git(dir, 'cat-file', '-s', blobId).trim();
        const gitBody = runGit(['-C', dir, 'cat-file', '-p', blobId]);

        // Act — tsgit side
        const object = await readObject(ctx, id);
        const metadata = await readObjectMetadata(ctx, id);

        // Assert
        expect(gitSize).toBe('6');
        expect(Buffer.from(gitBody, 'utf8')).toEqual(HELLO);
        expect(object.type).toBe('blob');
        expect((object as Blob).content).toEqual(new Uint8Array(HELLO));
        expect(metadata.type).toBe('blob');
        expect(metadata.uncompressedSize).toBe(6);
      });
    });
  },
);

const PACK_DIR_FAULTS_SKIPPED = process.platform === 'win32' || process.getuid?.() === 0;

describe.skipIf(!GIT_AVAILABLE || PACK_DIR_FAULTS_SKIPPED)(
  'object-store precedence interop — unusable objects/pack (D1-D3)',
  () => {
    describe('Given a loose-only repository whose objects/pack directory is chmod 000 (D1), When both git and tsgit read the loose blob', () => {
      let dir = '';
      let blobId = '';

      beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-object-precedence-d1-'));
        runGit(['init', '-q', '-b', 'main', dir]);
        git(dir, 'config', 'user.name', 'Ada');
        git(dir, 'config', 'user.email', 'ada@example.com');
        git(dir, 'config', 'commit.gpgsign', 'false');
        disableAutoMaintenance(dir);
        await writeFile(path.join(dir, 'a.txt'), HELLO);
        git(dir, 'add', 'a.txt');
        git(dir, 'commit', '-q', '-m', 'c1');
        blobId = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
        await chmod(path.join(dir, '.git', 'objects', 'pack'), 0o000);
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await chmod(path.join(dir, '.git', 'objects', 'pack'), 0o755);
        await rm(dir, { recursive: true, force: true });
      });

      it('Then git serves the loose blob after an error line, and tsgit serves it too', async () => {
        // Arrange
        const ctx = createNodeContext({ workDir: dir });
        const id = blobId as ObjectId;

        // Act — git side
        const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', blobId]);

        // Act — tsgit side
        const object = await readObject(ctx, id);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toContain('Permission denied');
        expect(Buffer.from(gitResult.stdout, 'utf8')).toEqual(HELLO);
        expect(object.type).toBe('blob');
        expect((object as Blob).content).toEqual(new Uint8Array(HELLO));
      });
    });

    describe('Given a packed repository (plus one extra loose object) whose objects/pack directory is chmod 000 (D2)', () => {
      let dir = '';
      let packedBlobId = '';
      let looseBlobId = '';

      beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-object-precedence-d2-'));
        runGit(['init', '-q', '-b', 'main', dir]);
        git(dir, 'config', 'user.name', 'Ada');
        git(dir, 'config', 'user.email', 'ada@example.com');
        git(dir, 'config', 'commit.gpgsign', 'false');
        git(dir, 'config', 'gc.auto', '0');
        disableAutoMaintenance(dir);
        await writeFile(path.join(dir, 'a.txt'), HELLO);
        git(dir, 'add', 'a.txt');
        git(dir, 'commit', '-q', '-m', 'c1');
        packedBlobId = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
        git(dir, 'gc', '-q');
        looseBlobId = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
          input: 'world\n',
        }).trim();
        await chmod(path.join(dir, '.git', 'objects', 'pack'), 0o000);
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await chmod(path.join(dir, '.git', 'objects', 'pack'), 0o755);
        await rm(dir, { recursive: true, force: true });
      });

      describe('When reading the packed blob', () => {
        it('Then git refuses the packed blob with exit 128, and tsgit refuses it with OBJECT_NOT_FOUND', async () => {
          // Arrange
          const ctx = createNodeContext({ workDir: dir });
          const id = packedBlobId as ObjectId;

          // Act — git side
          const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', packedBlobId]);

          // Act — tsgit side
          let caught: unknown;
          try {
            await readObject(ctx, id);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain('Not a valid object name');
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        });
      });

      describe('When reading the loose blob', () => {
        it('Then git still serves the loose blob after an error line, and tsgit serves it too', async () => {
          // Arrange
          const ctx = createNodeContext({ workDir: dir });
          const id = looseBlobId as ObjectId;

          // Act — git side
          const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', looseBlobId]);

          // Act — tsgit side
          const object = await readObject(ctx, id);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toContain('Permission denied');
          expect(object.type).toBe('blob');
        });
      });
    });

    describe('Given a repository whose objects/pack path is a regular file (D3), When both git and tsgit read the loose blob', () => {
      let dir = '';
      let blobId = '';

      beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-object-precedence-d3-'));
        runGit(['init', '-q', '-b', 'main', dir]);
        git(dir, 'config', 'user.name', 'Ada');
        git(dir, 'config', 'user.email', 'ada@example.com');
        git(dir, 'config', 'commit.gpgsign', 'false');
        disableAutoMaintenance(dir);
        await writeFile(path.join(dir, 'a.txt'), HELLO);
        git(dir, 'add', 'a.txt');
        git(dir, 'commit', '-q', '-m', 'c1');
        blobId = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
        await rm(path.join(dir, '.git', 'objects', 'pack'), { recursive: true, force: true });
        await writeFile(path.join(dir, '.git', 'objects', 'pack'), 'not-a-directory');
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      it('Then git serves the loose blob after an error line, and tsgit serves it too', async () => {
        // Arrange
        const ctx = createNodeContext({ workDir: dir });
        const id = blobId as ObjectId;

        // Act — git side
        const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', blobId]);

        // Act — tsgit side
        const object = await readObject(ctx, id);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toContain('Not a directory');
        expect(object.type).toBe('blob');
        expect((object as Blob).content).toEqual(new Uint8Array(HELLO));
      });
    });

    describe('Given an external repack+prune-packed after a Context already memoised the pack registry (R1), When tsgit reads the now-formerly-loose HEAD commit', () => {
      let dir = '';
      let firstCommitId = '';
      let headCommitId = '';

      beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-object-precedence-r1-'));
        runGit(['init', '-q', '-b', 'main', dir]);
        git(dir, 'config', 'user.name', 'Ada');
        git(dir, 'config', 'user.email', 'ada@example.com');
        git(dir, 'config', 'commit.gpgsign', 'false');
        disableAutoMaintenance(dir);
        await writeFile(path.join(dir, 'a.txt'), HELLO);
        git(dir, 'add', 'a.txt');
        git(dir, 'commit', '-q', '-m', 'c1');
        firstCommitId = git(dir, 'rev-parse', 'HEAD').trim();
        // Packs c1 — gives tsgit a PACKED object to read first, below.
        git(dir, 'gc', '-q');
        await writeFile(path.join(dir, 'b.txt'), Buffer.from('world\n'));
        git(dir, 'add', 'b.txt');
        git(dir, 'commit', '-q', '-m', 'c2');
        // No gc since c2 — HEAD's commit/tree/blob are still loose.
        headCommitId = git(dir, 'rev-parse', 'HEAD').trim();
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      it('Then git cat-file -t reports commit, and tsgit resolves it too via one re-scan retry (reprepare_packed_git)', async () => {
        // Arrange — a long-lived Context: reading the earlier PACKED commit
        // memoises the pack registry's directory listing before the repack.
        const ctx = createNodeContext({ workDir: dir });
        await readObject(ctx, firstCommitId as ObjectId);

        // Act — external repack+prune: HEAD's own commit (and its tree and
        // blob) move from loose into a NEW consolidated pack, and their
        // loose copies are pruned — exactly as a concurrent `git gc` would
        // do behind tsgit's memoised registry's back.
        git(dir, 'repack', '-a', '-d', '-q');
        git(dir, 'prune-packed', '-q');
        const gitType = git(dir, 'cat-file', '-t', headCommitId).trim();

        // Act — tsgit side, through the SAME memoised Context/registry
        const object = await readObject(ctx, headCommitId as ObjectId);

        // Assert — git and tsgit agree: tsgit's re-scan-on-miss (mirroring
        // git's own `reprepare_packed_git` retry) finds the object in its
        // new pack instead of refusing OBJECT_NOT_FOUND against the stale
        // (pre-repack) generation.
        expect(gitType).toBe('commit');
        expect(object.type).toBe('commit');
      });
    });
  },
);

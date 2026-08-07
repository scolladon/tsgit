/**
 * Cross-tool interop — pack header version accept-set (2 and 3) and per-pack
 * degradation, pinned against real git.
 *
 * A single seeded repo is repacked once; the resulting pack + idx bytes are
 * mutated per row (version field restamped, header object count rewritten,
 * or the idx corrupted/omitted) and dropped into a fresh, cheap-to-create
 * repo. Every row asserts both git's observable outcome and tsgit's
 * structured outcome from the identical on-disk state, so a divergence in
 * either direction fails the row.
 *
 * @proves
 *   surface:        pack.readVersion
 *   bucket:         cross-tool-interop
 *   unique:         pack header version 2|3 accept-set and per-pack degradation match canonical git
 *   interopSurface: packfile
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { bundleVerify } from '../../src/application/commands/bundle-verify.js';
import { enumerateObjects } from '../../src/application/primitives/enumerate-objects.js';
import { walkPackEntries } from '../../src/application/primitives/fetch-pack.js';
import { getPackRegistry, readObject } from '../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { GitObject, ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

// ---------------------------------------------------------------------------
// Crafting helpers — restamp/corrupt pack and idx bytes so the only thing
// wrong with a fixture is exactly what a row asks for. The pack subsystem is
// SHA-1-only end to end (the idx reader and writer both fix a 20-byte digest),
// so these helpers hard-code SHA-1 rather than imply a genericity they lack.
// ---------------------------------------------------------------------------

const DIGEST_LENGTH = 20;

function sha1(bytes: Uint8Array): Buffer {
  return createHash('sha1').update(bytes).digest();
}

/**
 * Rewrite the pack-version field (u32 BE at `origin + 4`) and re-fix the pack
 * trailer over `[origin, len - DIGEST_LENGTH)`. `origin` defaults to 0 for a
 * standalone pack file; a pack embedded further into a larger byte stream
 * (a bundle) passes the offset of its own signature instead.
 */
function restampPackVersion(packBytes: Uint8Array, version: number, origin = 0): Buffer {
  const buf = Buffer.from(packBytes);
  buf.writeUInt32BE(version, origin + 4);
  const trailerStart = buf.length - DIGEST_LENGTH;
  sha1(buf.subarray(origin, trailerStart)).copy(buf, trailerStart);
  return buf;
}

/**
 * Re-stamp a `.idx`'s recorded pack-checksum to match `packTrailer`, then
 * re-fix the idx's own trailer over its own bytes. Needed when a pack is
 * mutated after its `.idx` was already built and the mutation makes the pack
 * impossible to re-index normally (e.g. an unsupported header version).
 */
function restampIdxForPack(idxBytes: Uint8Array, packTrailer: Uint8Array): Buffer {
  const buf = Buffer.from(idxBytes);
  const packChecksumOffset = buf.length - 2 * DIGEST_LENGTH;
  Buffer.from(packTrailer).copy(buf, packChecksumOffset);
  const idxTrailerStart = buf.length - DIGEST_LENGTH;
  sha1(buf.subarray(0, idxTrailerStart)).copy(buf, idxTrailerStart);
  return buf;
}

/**
 * Overwrite a `.idx` with a deterministic byte ramp of the same length — the
 * shape that survives a naive length-only validity check and forces the
 * parser itself to reject the file, reproducibly on every run.
 */
function corruptIdxSameLength(idxBytes: Uint8Array): Buffer {
  return Buffer.from(Uint8Array.from({ length: idxBytes.length }, (_, i) => i % 256));
}

/** Rewrite the pack header's object-count field (u32 BE at offset 8) and re-fix the trailer. */
function setHeaderObjectCount(packBytes: Uint8Array, count: number): Buffer {
  const buf = Buffer.from(packBytes);
  buf.writeUInt32BE(count, 8);
  const trailerStart = buf.length - DIGEST_LENGTH;
  sha1(buf.subarray(0, trailerStart)).copy(buf, trailerStart);
  return buf;
}

function trailerOf(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(bytes.length - DIGEST_LENGTH);
}

// ---------------------------------------------------------------------------
// git-invocation + output-parsing helpers
// ---------------------------------------------------------------------------

/** Binary-safe `git cat-file -p`: returns a raw Buffer so payload bytes are never mangled. */
function catFileRaw(dir: string, oid: string): Buffer {
  return execFileSync('git', ['-C', dir, 'cat-file', '-p', oid], { env: runGitEnv() });
}

/** `git cat-file --batch-check`, feeding the oid over stdin (the interop helpers don't pipe input). */
function batchCheck(
  dir: string,
  oid: string,
): { readonly stdout: string; readonly stderr: string; readonly exitCode: number } {
  const result = spawnSync('git', ['-C', dir, 'cat-file', '--batch-check'], {
    input: `${oid}\n`,
    env: runGitEnv(),
    encoding: 'utf8',
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

/** Packed object ids only — enumeration minus the loose-only enumeration. */
async function collectPackedIds(ctx: Context): Promise<ReadonlyArray<ObjectId>> {
  const all = await enumerateObjects(ctx);
  const loose = new Set(await enumerateObjects(ctx, { includePacks: false }));
  return all.filter((id) => !loose.has(id));
}

interface PackCounts {
  readonly packs: number;
  readonly inPack: number;
  readonly garbage: number;
}

/** Parses the `label: N` lines out of `git count-objects -v` — git's observable pack-set size. */
function countObjects(dir: string): PackCounts {
  const stdout = git(dir, 'count-objects', '-v');
  const field = (label: string): number => {
    const match = new RegExp(`^${label}: (\\d+)$`, 'm').exec(stdout);
    return match === null ? 0 : Number(match[1]);
  };
  return { packs: field('packs'), inPack: field('in-pack'), garbage: field('garbage') };
}

const PACK_SIGNATURE = Buffer.from('PACK');

/** Locates a pack's own signature inside a larger byte stream (a bundle carries header text first). */
function findPackSignature(bytes: Uint8Array): number {
  const offset = Buffer.from(bytes).indexOf(PACK_SIGNATURE);
  if (offset === -1) throw new Error('PACK signature not found in the given bytes');
  return offset;
}

// ---------------------------------------------------------------------------
// Filesystem crafting helpers
// ---------------------------------------------------------------------------

function packStemPaths(
  dir: string,
  stem: string,
): { readonly packPath: string; readonly idxPath: string } {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  return {
    packPath: path.join(packDir, `pack-${stem}.pack`),
    idxPath: path.join(packDir, `pack-${stem}.idx`),
  };
}

async function ensurePackDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.git', 'objects', 'pack'), { recursive: true });
}

async function writePack(
  dir: string,
  stem: string,
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
): Promise<{ readonly packPath: string; readonly idxPath: string }> {
  await ensurePackDir(dir);
  const paths = packStemPaths(dir, stem);
  await writeFile(paths.packPath, packBytes);
  await writeFile(paths.idxPath, idxBytes);
  return paths;
}

async function writePackOnly(
  dir: string,
  stem: string,
  packBytes: Uint8Array,
): Promise<{ readonly packPath: string; readonly idxPath: string }> {
  await ensurePackDir(dir);
  const paths = packStemPaths(dir, stem);
  await writeFile(paths.packPath, packBytes);
  return paths;
}

async function writeIdxOnly(dir: string, stem: string, idxBytes: Uint8Array): Promise<void> {
  await ensurePackDir(dir);
  const { idxPath } = packStemPaths(dir, stem);
  await writeFile(idxPath, idxBytes);
}

async function writeLooseObject(dir: string, oid: string, raw: Uint8Array): Promise<void> {
  const objDir = path.join(dir, '.git', 'objects', oid.slice(0, 2));
  await mkdir(objDir, { recursive: true });
  await writeFile(path.join(objDir, oid.slice(2)), raw);
}

/** Reads the single `.pack`/`.idx` pair a `git repack` produced under a repo's pack directory. */
async function readSolePackPair(
  dir: string,
): Promise<{ readonly packBytes: Buffer; readonly idxBytes: Buffer }> {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const entries = await readdir(packDir);
  const packName = entries.find((entry) => entry.endsWith('.pack'));
  if (packName === undefined) throw new Error(`no .pack file found under ${packDir}`);
  const stem = packName.slice(0, -'.pack'.length);
  const packBytes = await readFile(path.join(packDir, packName));
  const idxBytes = await readFile(path.join(packDir, `${stem}.idx`));
  return { packBytes, idxBytes };
}

// ---------------------------------------------------------------------------
// tsgit-side helpers
// ---------------------------------------------------------------------------

function blobContent(object: GitObject): Uint8Array {
  if (object.type !== 'blob') throw new Error(`expected a blob, got ${object.type}`);
  return object.content;
}

// ---------------------------------------------------------------------------
// Fixture-repo factory
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

/** mkdtemps and git-inits a fresh, cheap repo; identity + signing are configured unconditionally. */
async function freshRepo(slug: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-pack-version-${slug}-`));
  tmpDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

const SEED_FILES: ReadonlyArray<readonly [name: string, content: string]> = [
  ['a.txt', 'alpha\n'],
  ['b.txt', 'bravo\n'],
  ['c.txt', 'charlie\n'],
  ['d.txt', 'delta\n'],
  ['e.txt', 'echo\n'],
];
const PACKED_FILE = 'a.txt';

describe.skipIf(!GIT_AVAILABLE)(
  'pack header version 2 and 3 acceptance, and per-pack degradation, against real git',
  () => {
    let base = '';
    let basePackBytes: Buffer = Buffer.alloc(0);
    let baseIdxBytes: Buffer = Buffer.alloc(0);
    let objectCount = 0;
    let packedOid: ObjectId = '' as ObjectId;
    let looseOid: ObjectId = '' as ObjectId;
    let looseRawBytes: Buffer = Buffer.alloc(0);

    beforeAll(async () => {
      base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-version-interop-base-'));
      git(base, 'init', '-q', '-b', 'main');
      git(base, 'config', 'user.name', 'Ada');
      git(base, 'config', 'user.email', 'ada@example.com');
      git(base, 'config', 'commit.gpgsign', 'false');

      for (const [name, content] of SEED_FILES) {
        await writeFile(path.join(base, name), content);
      }
      git(base, 'add', '-A');
      git(base, 'commit', '-m', 'seed');
      git(base, 'repack', '-adq');

      const solePack = await readSolePackPair(base);
      basePackBytes = solePack.packBytes;
      baseIdxBytes = solePack.idxBytes;
      objectCount = basePackBytes.readUInt32BE(8);

      packedOid = git(base, 'rev-parse', `HEAD:${PACKED_FILE}`).trim() as ObjectId;

      looseOid = runGit(['-C', base, 'hash-object', '-w', '--stdin'], {
        input: 'loose object written after repack\n',
      }).trim() as ObjectId;
      const loosePath = path.join(base, '.git', 'objects', looseOid.slice(0, 2), looseOid.slice(2));
      looseRawBytes = await readFile(loosePath);
    }, 60_000);

    afterAll(async () => {
      await rm(base, { recursive: true, force: true });
      await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    describe('Given a git-produced pack restamped to header version 3, When git ingests it via index-pack and tsgit walks its entries', () => {
      it('Then both accept it: git exits 0 and walkPackEntries resolves the same object count', async () => {
        // Arrange
        const v3PackBytes = restampPackVersion(basePackBytes, 3);
        const dir = await freshRepo('v3-ingest');
        const { packPath, idxPath } = await writePackOnly(dir, 'v3', v3PackBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'index-pack', '-o', idxPath, packPath]);
        const entries = await walkPackEntries(sut, v3PackBytes);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(entries.length).toBe(objectCount);
      });
    });

    describe('Given a git-produced pack restamped to header version 99, When git ingests it via index-pack and tsgit walks its entries', () => {
      it('Then both refuse it: git exits 128 with the unsupported-version refusal and walkPackEntries rejects INVALID_PACK_HEADER', async () => {
        // Arrange
        const v99PackBytes = restampPackVersion(basePackBytes, 99);
        const dir = await freshRepo('v99-ingest');
        const { packPath, idxPath } = await writePackOnly(dir, 'v99', v99PackBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'index-pack', '-o', idxPath, packPath]);
        let caught: unknown;
        try {
          await walkPackEntries(sut, v99PackBytes);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain('pack version 99 unsupported');
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_PACK_HEADER',
          reason: 'unsupported version: expected 2 or 3, got 99',
        });
      });
    });

    describe('Given a fresh repo holding only a version-3 pack (its .idx built by git index-pack), When both git and tsgit read the packed blob', () => {
      it('Then git cat-file -p and readObject return byte-identical content', async () => {
        // Arrange
        const v3PackBytes = restampPackVersion(basePackBytes, 3);
        const dir = await freshRepo('v3-local-read');
        const { packPath, idxPath } = await writePackOnly(dir, 'v3', v3PackBytes);
        git(dir, 'index-pack', '-o', idxPath, packPath);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitPayload = catFileRaw(dir, packedOid);
        const object = await readObject(sut, packedOid);

        // Assert
        expect(object.type).toBe('blob');
        expect(Buffer.compare(gitPayload, Buffer.from(blobContent(object)))).toBe(0);
      });
    });

    describe('Given a fresh repo holding only a version-99 pack, with the packed object absent from every other source, When both git and tsgit look it up', () => {
      it('Then git reports it missing at exit 0 and readObject rejects OBJECT_NOT_FOUND', async () => {
        // Arrange
        const v99PackBytes = restampPackVersion(basePackBytes, 99);
        const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
        const dir = await freshRepo('v99-object-missing-elsewhere');
        await writePack(dir, 'v99', v99PackBytes, v99IdxBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitResult = batchCheck(dir, packedOid);
        let caught: unknown;
        try {
          await readObject(sut, packedOid);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout).toContain(`${packedOid} missing`);
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: packedOid });
      });
    });

    describe('Given a fresh repo holding a version-99 pack and a good sibling pack, both containing the same object, When both git and tsgit read it', () => {
      it('Then git cat-file -p and readObject return byte-identical content', async () => {
        // Arrange
        const v99PackBytes = restampPackVersion(basePackBytes, 99);
        const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
        const dir = await freshRepo('v99-with-good-sibling');
        await writePack(dir, 'bad', v99PackBytes, v99IdxBytes);
        await writePack(dir, 'good', basePackBytes, baseIdxBytes);
        const warn = vi.fn();
        const baseCtx = createNodeContext({ workDir: dir });
        // Raw readdir order is filesystem-dependent; sorting pins the bad pack
        // first so the skip arm provably fires on every host.
        const sut: Context = {
          ...baseCtx,
          logger: { warn },
          fs: {
            ...baseCtx.fs,
            readdir: async (path: string) =>
              [...(await baseCtx.fs.readdir(path))].sort((a, b) => a.name.localeCompare(b.name)),
          },
        };

        // Act
        const gitPayload = catFileRaw(dir, packedOid);
        const object = await readObject(sut, packedOid);

        // Assert
        expect(object.type).toBe('blob');
        expect(Buffer.compare(gitPayload, Buffer.from(blobContent(object)))).toBe(0);
        // Scan order follows the sorted listing above, so the bad pack is
        // always consulted first — this pin proves the skip arm fired rather
        // than the good pack simply winning the race.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          'packRegistry: skipping unusable pack',
          expect.objectContaining({ pack: 'pack-bad' }),
        );
      });
    });

    describe('Given a version-99 pack whose index never claims the requested object, alongside a good sibling pack that does, When both git and tsgit read the object', () => {
      it('Then git succeeds with no stderr at all and readObject succeeds too — the bad pack is never opened', async () => {
        // Arrange — a decoy repo produces a version-99 pack whose own .idx has
        // no knowledge of the base repo's objects, so a lookup never opens it.
        const decoyDir = await freshRepo('decoy-object-set');
        await writeFile(path.join(decoyDir, 'decoy.txt'), 'unrelated decoy content\n');
        git(decoyDir, 'add', '-A');
        git(decoyDir, 'commit', '-m', 'decoy');
        git(decoyDir, 'repack', '-adq');
        const decoy = await readSolePackPair(decoyDir);
        const decoyBadPackBytes = restampPackVersion(decoy.packBytes, 99);
        const decoyBadIdxBytes = restampIdxForPack(decoy.idxBytes, trailerOf(decoyBadPackBytes));

        const dir = await freshRepo('v99-unclaimed-with-sibling');
        await writePack(dir, 'bad', decoyBadPackBytes, decoyBadIdxBytes);
        await writePack(dir, 'good', basePackBytes, baseIdxBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', packedOid]);
        const object = await readObject(sut, packedOid);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toBe('');
        expect(object.type).toBe('blob');
        expect(new TextDecoder().decode(blobContent(object))).toBe(gitResult.stdout);
      });
    });

    describe('Given a git bundle whose embedded pack is restamped to header version 3, When both git and tsgit verify it', () => {
      it('Then git bundle verify reports the bundle okay at exit 0 and bundleVerify resolves with prerequisites satisfied', async () => {
        // Arrange
        const dir = await freshRepo('bundle-v3');
        const bundlePath = path.join(dir, 'all.bundle');
        git(base, 'bundle', 'create', bundlePath, '--all');
        const bundleBytes = await readFile(bundlePath);
        const packStart = findPackSignature(bundleBytes);
        const v3BundleBytes = restampPackVersion(bundleBytes, 3, packStart);
        const v3BundlePath = path.join(dir, 'v3.bundle');
        await writeFile(v3BundlePath, v3BundleBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'bundle', 'verify', v3BundlePath]);
        const result = await bundleVerify(sut, { path: v3BundlePath });

        // Assert — git's "is okay" summary line lands on stdout or stderr
        // depending on git's version; check both, per the interop precedent.
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout + gitResult.stderr).toContain('is okay');
        expect(result.prerequisitesPresent).toBe(true);
      });
    });

    describe('Given one version-3 pack byte array, When it drives both a tsgit ingest and a local open in the same repo that git also reads', () => {
      it('Then walkPackEntries accepts it and readObject reads the same oid git cat-file -p reads from that repo', async () => {
        // Arrange
        const v3PackBytes = restampPackVersion(basePackBytes, 3);
        const dir = await freshRepo('v3-roundtrip');
        const { packPath, idxPath } = await writePackOnly(dir, 'v3', v3PackBytes);
        git(dir, 'index-pack', '-o', idxPath, packPath);
        const sut = createNodeContext({ workDir: dir });

        // Act — the same byte array drives ingest…
        const entries = await walkPackEntries(sut, v3PackBytes);
        // …and local open, read out of the very repo that byte array was written into
        const gitPayload = catFileRaw(dir, packedOid);
        const object = await readObject(sut, packedOid);

        // Assert
        expect(entries.length).toBe(objectCount);
        expect(object.type).toBe('blob');
        expect(Buffer.compare(gitPayload, Buffer.from(blobContent(object)))).toBe(0);
      });
    });

    describe('Given a fresh repo whose only pack has a corrupt .idx, with the packed object nowhere else, When both git and tsgit look it up', () => {
      it('Then git reports it missing with an empty pack set, and readObject rejects OBJECT_NOT_FOUND while the registry lists no packs', async () => {
        // Arrange
        const corruptIdxBytes = corruptIdxSameLength(baseIdxBytes);
        const dir = await freshRepo('corrupt-idx-alone');
        await writePack(dir, 'corrupt', basePackBytes, corruptIdxBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitBatch = batchCheck(dir, packedOid);
        const gitCount = countObjects(dir);
        let caught: unknown;
        try {
          await readObject(sut, packedOid);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        const packs = await getPackRegistry(sut).all();

        // Assert
        expect(gitBatch.exitCode).toBe(0);
        expect(gitBatch.stdout).toContain(`${packedOid} missing`);
        expect(gitCount.packs).toBe(0);
        expect(gitCount.inPack).toBe(0);
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: packedOid });
        expect(packs).toEqual([]);
      });
    });

    describe('Given a fresh repo whose only pack has a corrupt .idx, plus a loose copy of a different object, When both git and tsgit read the loose object', () => {
      it('Then git cat-file -p and readObject return byte-identical content, and enumerateObjects still lists it', async () => {
        // Arrange
        const corruptIdxBytes = corruptIdxSameLength(baseIdxBytes);
        const dir = await freshRepo('corrupt-idx-with-loose');
        await writePack(dir, 'corrupt', basePackBytes, corruptIdxBytes);
        await writeLooseObject(dir, looseOid, looseRawBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitPayload = catFileRaw(dir, looseOid);
        const object = await readObject(sut, looseOid);
        const enumerated = await enumerateObjects(sut);

        // Assert
        expect(object.type).toBe('blob');
        expect(Buffer.compare(gitPayload, Buffer.from(blobContent(object)))).toBe(0);
        expect(enumerated).toContain(looseOid);
      });
    });

    describe('Given a fresh repo whose only pack has a corrupt .idx, plus a good sibling pack holding the object, When both git and tsgit read it', () => {
      it('Then git cat-file -p and readObject return byte-identical content, and the registry lists exactly the good pack', async () => {
        // Arrange
        const corruptIdxBytes = corruptIdxSameLength(baseIdxBytes);
        const dir = await freshRepo('corrupt-idx-with-sibling');
        await writePack(dir, 'corrupt', basePackBytes, corruptIdxBytes);
        await writePack(dir, 'good', basePackBytes, baseIdxBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitPayload = catFileRaw(dir, packedOid);
        const object = await readObject(sut, packedOid);
        const packs = await getPackRegistry(sut).all();

        // Assert
        expect(object.type).toBe('blob');
        expect(Buffer.compare(gitPayload, Buffer.from(blobContent(object)))).toBe(0);
        expect(packs).toHaveLength(1);
      });
    });

    describe('Given a fresh repo holding an orphaned .idx whose .pack was never written, plus a loose object, When both git and tsgit look up the packed and loose objects', () => {
      it('Then git reports the packed object missing with an empty pack set and one garbage entry, readObject rejects OBJECT_NOT_FOUND with an empty registry, and the loose object still reads', async () => {
        // Arrange
        const dir = await freshRepo('orphaned-idx');
        await writeIdxOnly(dir, 'orphan', baseIdxBytes);
        await writeLooseObject(dir, looseOid, looseRawBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitBatch = batchCheck(dir, packedOid);
        const gitCount = countObjects(dir);
        let caught: unknown;
        try {
          await readObject(sut, packedOid);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        const packs = await getPackRegistry(sut).all();
        const looseObject = await readObject(sut, looseOid);

        // Assert
        expect(gitBatch.exitCode).toBe(0);
        expect(gitBatch.stdout).toContain(`${packedOid} missing`);
        expect(gitCount.packs).toBe(0);
        expect(gitCount.garbage).toBe(1);
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: packedOid });
        expect(packs).toEqual([]);
        expect(looseObject.type).toBe('blob');
      });
    });

    describe('Given a fresh repo whose only pack disagrees with its own .idx on object count, When both git and tsgit look up an object', () => {
      it('Then git reports it missing while count-objects still counts the pack off the idx, and readObject rejects OBJECT_NOT_FOUND while the registry still lists the pack', async () => {
        // Arrange
        const mismatchedPackBytes = setHeaderObjectCount(basePackBytes, objectCount + 1);
        const dir = await freshRepo('header-count-mismatch');
        await writePack(dir, 'mismatch', mismatchedPackBytes, baseIdxBytes);
        const sut = createNodeContext({ workDir: dir });

        // Act
        const gitBatch = batchCheck(dir, packedOid);
        const gitCount = countObjects(dir);
        let caught: unknown;
        try {
          await readObject(sut, packedOid);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        const packs = await getPackRegistry(sut).all();

        // Assert
        expect(gitBatch.exitCode).toBe(0);
        expect(gitBatch.stdout).toContain(`${packedOid} missing`);
        // The count disagreement — not the stale idx checksum — must be the
        // fault git trips on, or the fixture is not testing what it claims.
        expect(gitBatch.stderr).toContain('claims to have');
        expect(gitCount.packs).toBe(1);
        expect(gitCount.inPack).toBe(objectCount);
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: packedOid });
        expect(packs).toHaveLength(1);
      });
    });

    describe('Given one repo with a version-99 pack (a lookup-layer fault) and another with a corrupt-.idx pack (a scan-layer fault), When git and tsgit each enumerate the pack set of both repos', () => {
      it('Then count-objects and the registry agree: the version-99 repo still counts its pack, the corrupt-idx repo counts none', async () => {
        // Arrange
        const v99PackBytes = restampPackVersion(basePackBytes, 99);
        const v99IdxBytes = restampIdxForPack(baseIdxBytes, trailerOf(v99PackBytes));
        const lookupFaultDir = await freshRepo('enum-lookup-fault');
        await writePack(lookupFaultDir, 'v99', v99PackBytes, v99IdxBytes);
        const lookupFaultCtx = createNodeContext({ workDir: lookupFaultDir });

        const corruptIdxBytes = corruptIdxSameLength(baseIdxBytes);
        const scanFaultDir = await freshRepo('enum-scan-fault');
        await writePack(scanFaultDir, 'corrupt', basePackBytes, corruptIdxBytes);
        const scanFaultCtx = createNodeContext({ workDir: scanFaultDir });

        // Act
        const lookupFaultCount = countObjects(lookupFaultDir);
        const scanFaultCount = countObjects(scanFaultDir);
        const lookupFaultPacks = await getPackRegistry(lookupFaultCtx).all();
        const scanFaultPacks = await getPackRegistry(scanFaultCtx).all();
        const lookupFaultEnumerated = await collectPackedIds(lookupFaultCtx);
        const scanFaultEnumerated = await collectPackedIds(scanFaultCtx);

        // Assert
        expect(lookupFaultCount.packs).toBe(1);
        expect(lookupFaultCount.inPack).toBe(objectCount);
        expect(scanFaultCount.packs).toBe(0);
        expect(scanFaultCount.inPack).toBe(0);
        expect(lookupFaultPacks).toHaveLength(1);
        expect(scanFaultPacks).toHaveLength(0);
        // Enumeration mirrors count-objects on both sides: the v99 pack's
        // objects stay listed (counted off the still-readable idx), the
        // corrupt-idx pack's objects vanish with it.
        expect(lookupFaultEnumerated).toHaveLength(objectCount);
        expect(scanFaultEnumerated).toHaveLength(0);
      });
    });
  },
);

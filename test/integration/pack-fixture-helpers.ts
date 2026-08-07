/**
 * Shared pack/idx crafting + filesystem helpers for the pack-axis interop
 * suites (`pack-version-interop.test.ts`, `fsck-pack-accessibility-interop.test.ts`).
 * Lifted out of `pack-version-interop.test.ts` so the two suites cannot drift
 * on the one recipe that must stay identical: copying instead of sharing would
 * let a byte-level tweak in one suite silently stop matching the other's
 * fixtures.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped) — these
 * helpers write on-disk pack/idx bytes and belong with their integration
 * peers, same rationale as `interop-helpers.ts`.
 *
 * The pack subsystem is SHA-1-only end to end (the idx reader and writer both
 * fix a 20-byte digest — `IDX_SHA_LENGTH = 20` in
 * `src/domain/storage/pack-index.ts` and `pack-writer.ts`), so these helpers
 * hard-code SHA-1 rather than imply a genericity they lack.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { git } from './interop-helpers.js';

// ---------------------------------------------------------------------------
// Crafting helpers — restamp/corrupt pack and idx bytes so the only thing
// wrong with a fixture is exactly what a row asks for. The pack subsystem is
// SHA-1-only end to end (the idx reader and writer both fix a 20-byte digest),
// so these helpers hard-code SHA-1 rather than imply a genericity they lack.
// ---------------------------------------------------------------------------

export const DIGEST_LENGTH = 20;

export function sha1(bytes: Uint8Array): Buffer {
  return createHash('sha1').update(bytes).digest();
}

/**
 * Rewrite the pack-version field (u32 BE at `origin + 4`) and re-fix the pack
 * trailer over `[origin, len - DIGEST_LENGTH)`. `origin` defaults to 0 for a
 * standalone pack file; a pack embedded further into a larger byte stream
 * (a bundle) passes the offset of its own signature instead.
 */
export function restampPackVersion(packBytes: Uint8Array, version: number, origin = 0): Buffer {
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
export function restampIdxForPack(idxBytes: Uint8Array, packTrailer: Uint8Array): Buffer {
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
export function corruptIdxSameLength(idxBytes: Uint8Array): Buffer {
  return Buffer.from(Uint8Array.from({ length: idxBytes.length }, (_, i) => i % 256));
}

/** Rewrite the pack header's object-count field (u32 BE at offset 8) and re-fix the trailer. */
export function setHeaderObjectCount(packBytes: Uint8Array, count: number): Buffer {
  const buf = Buffer.from(packBytes);
  buf.writeUInt32BE(count, 8);
  const trailerStart = buf.length - DIGEST_LENGTH;
  sha1(buf.subarray(0, trailerStart)).copy(buf, trailerStart);
  return buf;
}

export function trailerOf(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(bytes.length - DIGEST_LENGTH);
}

// ---------------------------------------------------------------------------
// git count-objects parsing
// ---------------------------------------------------------------------------

export interface PackCounts {
  readonly packs: number;
  readonly inPack: number;
  readonly garbage: number;
}

/** Parses the `label: N` lines out of `git count-objects -v` — git's observable pack-set size. */
export function countObjects(dir: string): PackCounts {
  const stdout = git(dir, 'count-objects', '-v');
  const field = (label: string): number => {
    const match = new RegExp(`^${label}: (\\d+)$`, 'm').exec(stdout);
    return match === null ? 0 : Number(match[1]);
  };
  return { packs: field('packs'), inPack: field('in-pack'), garbage: field('garbage') };
}

// ---------------------------------------------------------------------------
// Filesystem crafting helpers
// ---------------------------------------------------------------------------

export function packStemPaths(
  dir: string,
  stem: string,
): { readonly packPath: string; readonly idxPath: string } {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  return {
    packPath: path.join(packDir, `pack-${stem}.pack`),
    idxPath: path.join(packDir, `pack-${stem}.idx`),
  };
}

export async function ensurePackDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.git', 'objects', 'pack'), { recursive: true });
}

export async function writePack(
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

export async function writePackOnly(
  dir: string,
  stem: string,
  packBytes: Uint8Array,
): Promise<{ readonly packPath: string; readonly idxPath: string }> {
  await ensurePackDir(dir);
  const paths = packStemPaths(dir, stem);
  await writeFile(paths.packPath, packBytes);
  return paths;
}

export async function writeIdxOnly(dir: string, stem: string, idxBytes: Uint8Array): Promise<void> {
  await ensurePackDir(dir);
  const { idxPath } = packStemPaths(dir, stem);
  await writeFile(idxPath, idxBytes);
}

export async function writeLooseObject(dir: string, oid: string, raw: Uint8Array): Promise<void> {
  const objDir = path.join(dir, '.git', 'objects', oid.slice(0, 2));
  await mkdir(objDir, { recursive: true });
  await writeFile(path.join(objDir, oid.slice(2)), raw);
}

/** Reads the single `.pack`/`.idx` pair a `git repack` produced under a repo's pack directory. */
export async function readSolePackPair(
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

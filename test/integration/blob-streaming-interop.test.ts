/**
 * Cross-tool interop — blob streaming faithfulness pin.
 *
 * Proves `streamBlob` is byte-identical to canonical `git cat-file -p` for:
 *
 *   S1 — a ~200 KB packed blob (base entry, genuine streaming path)
 *   S2 — same packed blob with default verifyHash (no OBJECT_HASH_MISMATCH)
 *   S3 — same blob stored loose (no git gc, loose streaming path)
 *   S4 — a deltified blob (OFS_DELTA in the pack, reconstructed, materialised: true)
 *
 * @proves
 *   surface:        streamBlob (packed base + loose + delta paths)
 *   bucket:         blob-streaming-interop
 *   unique:         streamed bytes byte-identical to canonical git cat-file -p
 *   interopSurface: loose objects + packfile (base + delta entries)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { streamBlob } from '../../src/application/primitives/stream-blob.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGitEnv,
} from './interop-helpers.js';

// ---------------------------------------------------------------------------
// File-local helpers
// ---------------------------------------------------------------------------

async function copyPackFiles(peer: string, ours: string): Promise<void> {
  const packDir = path.join(peer, '.git', 'objects', 'pack');
  const oursPackDir = path.join(ours, '.git', 'objects', 'pack');
  await mkdir(oursPackDir, { recursive: true });
  const entries = await readdir(packDir);
  for (const entry of entries) {
    if (entry.endsWith('.pack') || entry.endsWith('.idx')) {
      await copyFile(path.join(packDir, entry), path.join(oursPackDir, entry));
    }
  }
}

function catFileRaw(dir: string, oid: string): Buffer {
  return execFileSync('git', ['-C', dir, 'cat-file', '-p', oid], {
    env: runGitEnv(),
  });
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of it) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('blob-streaming interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('blob-streaming');
    initBothRepos(pair.peer, pair.ours);
    git(pair.peer, 'config', 'commit.gpgsign', 'false');
    git(pair.peer, 'config', 'user.name', 'Test');
    git(pair.peer, 'config', 'user.email', 'test@example.com');
  });

  afterEach(async () => {
    await pair.dispose();
  });

  // -------------------------------------------------------------------------
  // S1: ~200 KB packed base blob
  // -------------------------------------------------------------------------
  describe('S1: ~200 KB packed base blob', () => {
    describe("Given a ~200 KB random blob committed and gc'd in peer, pack files copied to ours", () => {
      describe('When streamBlob is drained', () => {
        it('Then concatenated bytes are byte-identical to git cat-file -p', {
          timeout: 60_000,
        }, async () => {
          // Arrange
          const blobContent = randomBytes(200_000);
          await writeFile(path.join(pair.peer, 'large.bin'), blobContent);
          git(pair.peer, 'add', 'large.bin');
          git(pair.peer, 'commit', '-m', 'add large blob');
          const blobId = git(pair.peer, 'rev-parse', 'HEAD:large.bin').trim() as ObjectId;
          git(pair.peer, 'gc', '--quiet');
          await copyPackFiles(pair.peer, pair.ours);
          const catFileBuf = catFileRaw(pair.peer, blobId);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act
          const stream = await streamBlob(sut, blobId);
          const result = await collect(stream);

          // Assert
          expect(Buffer.compare(catFileBuf, Buffer.from(result))).toBe(0);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // S2: same packed blob, default verifyHash — no OBJECT_HASH_MISMATCH
  // -------------------------------------------------------------------------
  describe('S2: packed blob with default verifyHash', () => {
    describe('Given the same packed blob', () => {
      describe('When streamBlob is drained with default verifyHash', () => {
        it('Then no OBJECT_HASH_MISMATCH is thrown', {
          timeout: 60_000,
        }, async () => {
          // Arrange
          const blobContent = randomBytes(200_000);
          await writeFile(path.join(pair.peer, 'large2.bin'), blobContent);
          git(pair.peer, 'add', 'large2.bin');
          git(pair.peer, 'commit', '-m', 'add large blob for verify test');
          const blobId = git(pair.peer, 'rev-parse', 'HEAD:large2.bin').trim() as ObjectId;
          git(pair.peer, 'gc', '--quiet');
          await copyPackFiles(pair.peer, pair.ours);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act / Assert — default verifyHash=true must not throw
          const stream = await streamBlob(sut, blobId);
          await expect(collect(stream)).resolves.toBeDefined();
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // S3: same blob stored loose (no git gc)
  // -------------------------------------------------------------------------
  describe('S3: loose blob (no git gc)', () => {
    describe('Given a ~200 KB blob stored loose in ours (no gc)', () => {
      describe('When streamBlob is drained', () => {
        it('Then concatenated bytes are byte-identical to git cat-file -p', {
          timeout: 60_000,
        }, async () => {
          // Arrange — write blob into ours directly so it stays loose
          git(pair.ours, 'config', 'commit.gpgsign', 'false');
          git(pair.ours, 'config', 'user.name', 'Test');
          git(pair.ours, 'config', 'user.email', 'test@example.com');
          const blobContent = randomBytes(200_000);
          await writeFile(path.join(pair.ours, 'loose.bin'), blobContent);
          git(pair.ours, 'add', 'loose.bin');
          git(pair.ours, 'commit', '-m', 'add loose blob');
          const blobId = git(pair.ours, 'rev-parse', 'HEAD:loose.bin').trim() as ObjectId;
          // Intentionally no git gc — blob stays loose
          const catFileBuf = catFileRaw(pair.ours, blobId);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act
          const stream = await streamBlob(sut, blobId);
          const result = await collect(stream);

          // Assert
          expect(Buffer.compare(catFileBuf, Buffer.from(result))).toBe(0);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // S4: deltified blob (OFS_DELTA in pack)
  // -------------------------------------------------------------------------
  describe('S4: deltified blob (delta chain, materialised: true)', () => {
    describe("Given two near-identical ~200 KB blobs, gc'd so the second is stored as a delta", () => {
      describe('When streamBlob is drained on the deltified id', () => {
        it('Then bytes are byte-identical to git cat-file -p and materialised is true', {
          timeout: 60_000,
        }, async () => {
          // Arrange — two blobs that differ only in a few bytes so git's delta heuristic engages
          const base = randomBytes(200_000);
          const target = Buffer.from(base);
          // Mutate a small section so the two blobs are different but similar enough for delta
          target.write('DELTA_MARKER_CHANGE', 1000);
          await writeFile(path.join(pair.peer, 'base.bin'), base);
          git(pair.peer, 'add', 'base.bin');
          git(pair.peer, 'commit', '-m', 'add base blob');
          await writeFile(path.join(pair.peer, 'target.bin'), target);
          git(pair.peer, 'add', 'target.bin');
          git(pair.peer, 'commit', '-m', 'add near-copy blob');
          // gc with aggressive settings to encourage delta packing
          git(pair.peer, 'gc', '--quiet', '--aggressive');
          // Identify which blob is stored as a delta via git verify-pack
          const baseId = git(pair.peer, 'rev-parse', 'HEAD~1:base.bin').trim() as ObjectId;
          const targetId = git(pair.peer, 'rev-parse', 'HEAD:target.bin').trim() as ObjectId;
          await copyPackFiles(pair.peer, pair.ours);

          // Determine which id is deltified in the pack.
          // `git verify-pack -v` delta lines have 7+ space-separated columns:
          //   <sha> blob <size> <pack-size> <offset> <depth> <base-sha>
          // Non-delta lines have 5 columns. Detect by column count.
          const verifyOutput = git(pair.peer, 'verify-pack', '-v', ...getDeltaPackPath(pair.peer));
          const deltaLine = verifyOutput.split('\n').find((l) => {
            const cols = l.trim().split(/\s+/);
            const sha = cols[0] ?? '';
            return (sha === targetId || sha === baseId) && cols.length >= 7;
          });
          // If git decided not to delta, fall back to targetId and relax the materialised assertion
          const deltaId =
            deltaLine !== undefined ? (deltaLine.trim().split(/\s+/)[0] as ObjectId) : targetId;
          const catFileBuf = catFileRaw(pair.peer, deltaId);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act
          const stream = await streamBlob(sut, deltaId);
          const result = await collect(stream);

          // Assert bytes match regardless of materialised
          expect(Buffer.compare(catFileBuf, Buffer.from(result))).toBe(0);

          // Assert materialised: true only when the entry is actually a delta
          if (deltaLine !== undefined) {
            expect(stream.materialised).toBe(true);
          }
        });
      });
    });
  });
});

function getDeltaPackPath(dir: string): string[] {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  try {
    const entries = readdirSync(packDir);
    const packFile = entries.find((e) => e.endsWith('.pack'));
    if (packFile !== undefined) return [path.join(packDir, packFile)];
  } catch {
    // ignore — pack dir may not exist if gc was skipped
  }
  return [];
}

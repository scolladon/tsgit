/**
 * Cross-tool interop — large (>64 KiB) packed blob faithfulness pin.
 *
 * Exercises the exact-slice pack-read path introduced to fix the 64 KiB
 * truncation bug. Four fixtures prove:
 *
 *   P1 — a 140 000-byte blob packed via `git gc` is readable via tsgit's
 *        `readBlob` and byte-identical to `git cat-file -p`.
 *   P2 — the same packed blob passes hash-verification (verifyHash=true)
 *        without triggering OBJECT_HASH_MISMATCH.
 *   P3 — two distinct blobs (140 KB + 80 KB) packed together are both
 *        readable and byte-identical; exercises the non-last-entry
 *        next-offset boundary on a real pack.
 *   P4 — the same 140 KB blob stored LOOSE (no gc) is readable via tsgit;
 *        regression guard proving the loose path is unaffected.
 *
 * @proves
 *   surface:        readBlob / readObject (packed path)
 *   bucket:         large-object-interop
 *   unique:         packed blobs >64 KiB readable byte-identical to canonical git
 *   interopSurface: packfile
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readBlob } from '../../src/application/primitives/read-blob.js';
import { readObject } from '../../src/application/primitives/read-object.js';
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
// Shared helpers (file-local)
// ---------------------------------------------------------------------------

/**
 * Copy all .pack and .idx files from peer's pack dir into ours.
 * Creates the destination directory if it does not exist.
 */
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

/**
 * Binary-safe cat-file: returns a raw Buffer (no .toString()) so arbitrary
 * binary bytes are not corrupted.
 */
function catFileRaw(dir: string, oid: string): Buffer {
  return execFileSync('git', ['-C', dir, 'cat-file', '-p', oid], {
    env: runGitEnv(),
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('large-object pack interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('large-pack');
    initBothRepos(pair.peer, pair.ours);
    // Disable signing so golden commits are deterministic across machines.
    git(pair.peer, 'config', 'commit.gpgsign', 'false');
    git(pair.peer, 'config', 'user.name', 'Test');
    git(pair.peer, 'config', 'user.email', 'test@example.com');
  });

  afterEach(async () => {
    await pair.dispose();
  });

  // -------------------------------------------------------------------------
  // P1: single large packed blob (140 KB)
  // -------------------------------------------------------------------------
  describe('P1: single large packed blob (140 KB)', () => {
    describe('Given a 140 KB random blob packed via git gc', () => {
      describe('When readBlob is called via tsgit', () => {
        it('Then returns 140 000 bytes byte-identical to git cat-file -p', {
          timeout: 60_000,
        }, async () => {
          // Arrange
          const blobContent = randomBytes(140_000);
          await writeFile(path.join(pair.peer, 'big.bin'), blobContent);
          git(pair.peer, 'add', 'big.bin');
          git(pair.peer, 'commit', '-m', 'add big.bin');
          const blobId = git(pair.peer, 'rev-parse', 'HEAD:big.bin').trim() as ObjectId;
          git(pair.peer, 'gc', '--quiet');
          await copyPackFiles(pair.peer, pair.ours);
          const catFileBuf = catFileRaw(pair.peer, blobId);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act
          const result = await readBlob(sut, blobId);

          // Assert
          expect(result.content.length).toBe(140_000);
          expect(Buffer.compare(catFileBuf, Buffer.from(result.content))).toBe(0);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // P2: hash verification on large packed blob
  // -------------------------------------------------------------------------
  describe('P2: hash verification on large packed blob', () => {
    describe('Given the same 140 KB packed blob', () => {
      describe('When readObject is called with verifyHash=true', () => {
        it('Then succeeds without OBJECT_HASH_MISMATCH', { timeout: 60_000 }, async () => {
          // Arrange
          const blobContent = randomBytes(140_000);
          await writeFile(path.join(pair.peer, 'big.bin'), blobContent);
          git(pair.peer, 'add', 'big.bin');
          git(pair.peer, 'commit', '-m', 'add big.bin');
          const blobId = git(pair.peer, 'rev-parse', 'HEAD:big.bin').trim() as ObjectId;
          git(pair.peer, 'gc', '--quiet');
          await copyPackFiles(pair.peer, pair.ours);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act + Assert — must not throw OBJECT_HASH_MISMATCH
          const result = await readObject(sut, blobId, { verifyHash: true });

          expect(result.type).toBe('blob');
          expect(result.id).toBe(blobId);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // P3: two adjacent large blobs — next-offset boundary
  // -------------------------------------------------------------------------
  describe('P3: two adjacent large blobs — next-offset boundary', () => {
    describe('Given a 140 KB blob and an 80 KB blob packed together via git gc', () => {
      describe('When both blobs are read via tsgit', () => {
        it('Then both return byte-identical content to git cat-file -p', {
          timeout: 60_000,
        }, async () => {
          // Arrange — two distinct random payloads → guaranteed different OIDs
          const blob1 = randomBytes(140_000);
          const blob2 = randomBytes(80_000);
          await writeFile(path.join(pair.peer, 'big1.bin'), blob1);
          await writeFile(path.join(pair.peer, 'big2.bin'), blob2);
          git(pair.peer, 'add', 'big1.bin', 'big2.bin');
          git(pair.peer, 'commit', '-m', 'add two large blobs');
          const blobId1 = git(pair.peer, 'rev-parse', 'HEAD:big1.bin').trim() as ObjectId;
          const blobId2 = git(pair.peer, 'rev-parse', 'HEAD:big2.bin').trim() as ObjectId;
          git(pair.peer, 'gc', '--quiet');
          await copyPackFiles(pair.peer, pair.ours);
          const catFile1 = catFileRaw(pair.peer, blobId1);
          const catFile2 = catFileRaw(pair.peer, blobId2);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act
          const result1 = await readBlob(sut, blobId1);
          const result2 = await readBlob(sut, blobId2);

          // Assert — both sizes and byte content match git's readback
          expect(result1.content.length).toBe(140_000);
          expect(result2.content.length).toBe(80_000);
          expect(Buffer.compare(catFile1, Buffer.from(result1.content))).toBe(0);
          expect(Buffer.compare(catFile2, Buffer.from(result2.content))).toBe(0);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // P4: loose large blob regression guard
  // -------------------------------------------------------------------------
  describe('P4: loose large blob regression guard', () => {
    describe('Given a 140 KB blob NOT packed (no gc)', () => {
      describe('When readBlob is called via tsgit', () => {
        it('Then returns 140 000 bytes (loose path unaffected)', { timeout: 60_000 }, async () => {
          // Arrange — write blob directly into ours (not peer) so it stays loose
          const blobContent = randomBytes(140_000);
          await writeFile(path.join(pair.ours, 'big.bin'), blobContent);
          git(pair.ours, 'config', 'commit.gpgsign', 'false');
          git(pair.ours, 'config', 'user.name', 'Test');
          git(pair.ours, 'config', 'user.email', 'test@example.com');
          git(pair.ours, 'add', 'big.bin');
          git(pair.ours, 'commit', '-m', 'add big.bin loose');
          const blobId = git(pair.ours, 'rev-parse', 'HEAD:big.bin').trim() as ObjectId;
          // Intentionally NO git gc — blob stays loose
          const catFileBuf = catFileRaw(pair.ours, blobId);
          const sut = createNodeContext({ workDir: pair.ours });

          // Act
          const result = await readBlob(sut, blobId);

          // Assert
          expect(result.content.length).toBe(140_000);
          expect(Buffer.compare(catFileBuf, Buffer.from(result.content))).toBe(0);
        });
      });
    });
  });
});

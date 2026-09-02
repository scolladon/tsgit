/**
 * Cross-tool interop — v2 packfile + pack-index. We serialize a small set
 * of blobs into a self-contained v2 packfile + matching .idx using tsgit's
 * domain writers, drop the pair into a peer repo's `.git/objects/pack/`,
 * and ask canonical `git fsck --strict` to accept it. Then we read every
 * object back via `git cat-file -p`. Packfile bytes are not bit-exact
 * across writers (deflate level + delta heuristics are implementation-
 * defined); the contract is acceptance + readback.
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         pack + idx accepted by git fsck and readable via cat-file
 *   interopSurface: packfile
 */
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { bytesToHex, hexToBytes } from '../../src/domain/objects/encoding.js';
import { type ObjectId, serializeObject } from '../../src/domain/objects/index.js';
import { crc32 } from '../../src/domain/storage/crc32.js';
import { encodeDelta } from '../../src/domain/storage/delta-encode.js';
import { encodePackEntryHeader, PACK_ENTRY_TYPE } from '../../src/domain/storage/pack-entry.js';
import { sortPackIndexEntries } from '../../src/domain/storage/pack-order.js';
import {
  type PackWriterBaseEntry,
  type PackWriterEntry,
  serializePackfile,
  serializePackIndex,
} from '../../src/domain/storage/pack-writer.js';
import { packIndexEntriesOf } from '../fixtures/storage/pack-index-entries.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('packfile + pack-index interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('packfile');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given three blobs packed by tsgit', () => {
    describe('When the .pack and .idx are dropped into a clean repo', () => {
      it('Then git fsck accepts the pack and cat-file reads every object', async () => {
        // Arrange — write the blobs into ours so we can read their bytes
        // back to build the pack entries.
        const ctx = createNodeContext({ workDir: pair.ours });
        const payloads = ['alpha\n', 'bravo\n', 'charlie\n'];
        const ids: ObjectId[] = [];
        for (const payload of payloads) {
          const id = await writeObject(ctx, {
            type: 'blob',
            id: '' as ObjectId,
            content: new TextEncoder().encode(payload),
          });
          ids.push(id);
        }

        // Act — assemble pack + idx in lockstep so per-entry crc/offset
        // metadata feeds the idx writer directly.
        const writerEntries: PackWriterBaseEntry[] = [];
        const indexEntries: Array<{ id: string; crc32: number; offset: number }> = [];
        for (const id of ids) {
          const blob = {
            type: 'blob' as const,
            id,
            content: new TextEncoder().encode(payloads[ids.indexOf(id)] as string),
          };
          const loose = serializeObject(blob, ctx.hashConfig);
          const nul = loose.indexOf(0);
          const content = loose.subarray(nul + 1);
          const compressed = await ctx.compressor.deflate(content);
          writerEntries.push({
            type: PACK_ENTRY_TYPE.BLOB,
            uncompressedSize: content.length,
            compressedData: compressed,
          });
        }
        const packResult = serializePackfile(writerEntries);
        const packTrailer = await ctx.hash.hash(packResult.data);
        const packBytes = new Uint8Array(packResult.data.length + packTrailer.length);
        packBytes.set(packResult.data, 0);
        packBytes.set(packTrailer, packResult.data.length);
        const packSha = bytesToHex(packTrailer);
        for (let i = 0; i < ids.length; i += 1) {
          indexEntries.push({
            id: ids[i] as string,
            crc32: packResult.entries[i]?.crc32 ?? 0,
            offset: packResult.entries[i]?.offset ?? 0,
          });
        }
        const idxBody = serializePackIndex(
          sortPackIndexEntries(packIndexEntriesOf(indexEntries, packTrailer.length)),
          packTrailer,
        );
        const idxTrailerBytes = await ctx.hash.hash(idxBody);
        const idxBytes = new Uint8Array(idxBody.length + idxTrailerBytes.length);
        idxBytes.set(idxBody, 0);
        idxBytes.set(idxTrailerBytes, idxBody.length);

        // Drop both into peer and validate.
        runGit(['-C', pair.peer, 'config', 'gc.auto', '0']);
        const packDir = path.join(pair.peer, '.git/objects/pack');
        await writeFile(path.join(packDir, `pack-${packSha}.pack`), packBytes);
        await writeFile(path.join(packDir, `pack-${packSha}.idx`), idxBytes);

        // Assert
        runGit(['-C', pair.peer, 'fsck', '--strict']);
        for (let i = 0; i < ids.length; i += 1) {
          const out = runGit(['-C', pair.peer, 'cat-file', '-p', ids[i] as string]);
          expect(out).toBe(payloads[i]);
        }
        // crc32 is exercised implicitly via fsck; keep an explicit reference
        // so the imports survive code-cleanup passes.
        expect(typeof crc32).toBe('function');
        expect(typeof hexToBytes).toBe('function');
        expect(typeof encodePackEntryHeader).toBe('function');
      });
    });
  });

  describe('Given a base blob and an OFS_DELTA entry derived from it', () => {
    describe('When the .pack and .idx are dropped into a clean repo', () => {
      it('Then git fsck accepts the pack and cat-file reconstructs the delta target', async () => {
        // Arrange — a base blob and a longer target blob that shares most
        // of the base's bytes, so encodeDelta emits a real COPY, not just
        // literal INSERTs.
        const ctx = createNodeContext({ workDir: pair.ours });
        const baseText = 'The quick brown fox jumps over the lazy dog\n';
        const targetText = `${baseText}Now with an extra sentence appended after.\n`;
        const baseBytes = new TextEncoder().encode(baseText);
        const targetBytes = new TextEncoder().encode(targetText);
        const baseId = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: baseBytes,
        });
        const targetId = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: targetBytes,
        });

        // Act — a base entry plus an OFS_DELTA entry whose payload is the
        // deflated delta instruction stream against the base's raw content.
        const baseCompressed = await ctx.compressor.deflate(baseBytes);
        const deltaInstructions = encodeDelta(baseBytes, targetBytes)!;
        const deltaCompressed = await ctx.compressor.deflate(deltaInstructions);
        const writerEntries: PackWriterEntry[] = [
          {
            type: PACK_ENTRY_TYPE.BLOB,
            uncompressedSize: baseBytes.length,
            compressedData: baseCompressed,
          },
          {
            type: PACK_ENTRY_TYPE.OFS_DELTA,
            uncompressedSize: deltaInstructions.length,
            compressedData: deltaCompressed,
            baseIndex: 0,
          },
        ];
        const packResult = serializePackfile(writerEntries);
        const packTrailer = await ctx.hash.hash(packResult.data);
        const packBytes = new Uint8Array(packResult.data.length + packTrailer.length);
        packBytes.set(packResult.data, 0);
        packBytes.set(packTrailer, packResult.data.length);
        const packSha = bytesToHex(packTrailer);
        const indexEntries = [
          {
            id: baseId as string,
            crc32: packResult.entries[0]!.crc32,
            offset: packResult.entries[0]!.offset,
          },
          {
            id: targetId as string,
            crc32: packResult.entries[1]!.crc32,
            offset: packResult.entries[1]!.offset,
          },
        ];
        const idxBody = serializePackIndex(
          sortPackIndexEntries(packIndexEntriesOf(indexEntries, packTrailer.length)),
          packTrailer,
        );
        const idxTrailerBytes = await ctx.hash.hash(idxBody);
        const idxBytes = new Uint8Array(idxBody.length + idxTrailerBytes.length);
        idxBytes.set(idxBody, 0);
        idxBytes.set(idxTrailerBytes, idxBody.length);

        // Drop both into peer and validate.
        runGit(['-C', pair.peer, 'config', 'gc.auto', '0']);
        const packDir = path.join(pair.peer, '.git/objects/pack');
        await writeFile(path.join(packDir, `pack-${packSha}.pack`), packBytes);
        await writeFile(path.join(packDir, `pack-${packSha}.idx`), idxBytes);

        // Assert
        runGit(['-C', pair.peer, 'fsck', '--strict']);
        const out = runGit(['-C', pair.peer, 'cat-file', '-p', targetId as string]);
        expect(out).toBe(targetText);
      });
    });
  });
});

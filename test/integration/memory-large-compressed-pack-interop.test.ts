/**
 * Cross-tool interop — memory-adapter pack-walk faithfulness pin across the
 * >64 KiB-compressed member boundary.
 *
 * The memory adapter's `streamInflate` used to progressive-prefix-scan the
 * compressed bytes with a 64 KiB safety cap; it now delegates to the
 * zero-dependency inflate decoder. A wrong inflation, or a wrong
 * `bytesConsumed` for an entry whose compressed form crosses that old
 * boundary, desyncs `walkPackEntries`'s offset cursor for every following
 * entry — so a decoded object-id set that matches real git's is a strict
 * byte-for-byte faithfulness proof, not just a size check.
 *
 * @proves
 *   surface:        fetch-pack.walkPackEntries (memory adapter)
 *   bucket:         memory-large-compressed-pack-interop
 *   unique:         memory streamInflate decodes a >64 KiB-compressed pack entry, matching git's object ids
 *   interopSurface: packfile
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { walkPackEntries } from '../../src/application/primitives/fetch-pack.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
} from './interop-helpers.js';

// Random content compresses poorly, so a 100 000-byte blob's packed entry
// reliably exceeds the old 64 KiB memory-adapter safety cap.
const LARGE_BLOB_BYTES = 100_000;

async function findPackFile(packDir: string): Promise<string> {
  const entries = await readdir(packDir);
  const packFile = entries.find((entry) => entry.endsWith('.pack'));
  if (packFile === undefined) throw new Error('expected a .pack file after git gc');
  return path.join(packDir, packFile);
}

describe.skipIf(!GIT_AVAILABLE)('memory-adapter large-compressed-pack interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('memory-large-pack');
    initBothRepos(pair.peer, pair.ours);
    // Disable signing so golden commits are deterministic across machines.
    git(pair.peer, 'config', 'commit.gpgsign', 'false');
    git(pair.peer, 'config', 'user.name', 'Test');
    git(pair.peer, 'config', 'user.email', 'test@example.com');
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a repo with a blob whose compressed form exceeds 64 KiB, packed via git gc', () => {
    describe('When the memory adapter walks the resulting pack via walkPackEntries', () => {
      it('Then the decoded object ids include the blob, tree and commit ids from real git', {
        timeout: 60_000,
      }, async () => {
        // Arrange
        const blobContent = randomBytes(LARGE_BLOB_BYTES);
        await writeFile(path.join(pair.peer, 'big.bin'), blobContent);
        git(pair.peer, 'add', 'big.bin');
        git(pair.peer, 'commit', '-m', 'add big.bin');
        const blobId = git(pair.peer, 'rev-parse', 'HEAD:big.bin').trim() as ObjectId;
        const treeId = git(pair.peer, 'rev-parse', 'HEAD^{tree}').trim() as ObjectId;
        const commitId = git(pair.peer, 'rev-parse', 'HEAD').trim() as ObjectId;
        git(pair.peer, 'gc', '--quiet');
        const packDir = path.join(pair.peer, '.git', 'objects', 'pack');
        const packPath = await findPackFile(packDir);
        const packBytes = new Uint8Array(await readFile(packPath));
        const ctx = createMemoryContext();

        // Act
        const walked = await walkPackEntries(ctx, packBytes);

        // Assert — random blob content compresses poorly, so its packed entry
        // exceeds the old memory-adapter cap; a correct OID here proves the
        // decoder handled that entry (and every entry after it) faithfully.
        const walkedIds = walked.map((entry) => entry.id);
        expect(walkedIds).toContain(blobId);
        expect(walkedIds).toContain(treeId);
        expect(walkedIds).toContain(commitId);
      });
    });
  });
});

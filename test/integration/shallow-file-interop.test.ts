/**
 * Cross-tool interop — `.git/shallow` byte equality. The file is only
 * populated by a shallow fetch, so the test stands up a bare repo + a
 * shallow clone to get a known-good `peer/.git/shallow`, then asks tsgit's
 * `updateShallow` to write the same SHA set in a peer tmpdir and diffs
 * bytes.
 *
 * @proves
 *   surface:        shallowFile
 *   bucket:         cross-tool-interop
 *   unique:         .git/shallow byte-identical to git --depth N clone output
 *   interopSurface: shallowFile
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readShallow, updateShallow } from '../../src/application/primitives/shallow-file.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('shallow-file interop', () => {
  let bare: string;
  let peer: string;
  let ours: string;

  beforeEach(async () => {
    bare = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-shallow-bare-'));
    peer = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-shallow-peer-'));
    ours = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-shallow-ours-'));
  });

  afterEach(async () => {
    for (const dir of [bare, peer, ours]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('Given a bare repo with several commits', () => {
    describe('When canonical git shallow-clones and tsgit writes the same SHA set', () => {
      it('Then both `.git/shallow` files are byte-identical', async () => {
        // Arrange — build a small source repo and push to bare
        const source = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-shallow-source-'));
        try {
          const env = {
            ...process.env,
            GIT_AUTHOR_NAME: 'Ada',
            GIT_AUTHOR_EMAIL: 'ada@example.com',
            GIT_AUTHOR_DATE: '1700000000 +0000',
            GIT_COMMITTER_NAME: 'Ada',
            GIT_COMMITTER_EMAIL: 'ada@example.com',
            GIT_COMMITTER_DATE: '1700000000 +0000',
          };
          execFileSync('git', ['init', '-q', '-b', 'main', '--bare', bare]);
          execFileSync('git', ['init', '-q', '-b', 'main', source]);
          for (let i = 0; i < 5; i += 1) {
            await writeFile(path.join(source, `f${i}.txt`), `${i}\n`);
            execFileSync('git', ['-C', source, 'add', '.']);
            execFileSync('git', ['-C', source, 'commit', '-q', '-m', `c${i}`], { env });
          }
          execFileSync('git', ['-C', source, 'remote', 'add', 'origin', bare]);
          execFileSync('git', ['-C', source, 'push', '-q', 'origin', 'main']);
          // Shallow-clone into peer (depth 2 should leave two cut-points)
          execFileSync('git', ['clone', '-q', '--depth', '2', `file://${bare}`, peer]);
          const peerBytes = await readFile(path.join(peer, '.git/shallow'));
          // Build an ours repo with the same SHAs in .git/shallow via tsgit
          execFileSync('git', ['init', '-q', '-b', 'main', ours]);
          const peerShas = peerBytes
            .toString()
            .split('\n')
            .filter((s) => s.length > 0) as unknown as ReadonlyArray<ObjectId>;
          const sut = createNodeContext({ workDir: ours });

          // Act
          await updateShallow(sut, { shallow: peerShas, unshallow: [] });

          // Assert — bytes match
          const oursBytes = await readFile(path.join(ours, '.git/shallow'));
          expect(oursBytes).toEqual(peerBytes);
          // And tsgit can read its own write back
          const readBack = await readShallow(sut);
          expect(readBack.size).toBe(peerShas.length);
        } finally {
          await rm(source, { recursive: true, force: true });
        }
      });
    });
  });
});

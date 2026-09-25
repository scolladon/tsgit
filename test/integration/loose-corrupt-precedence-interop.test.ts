/**
 * Cross-tool interop — object-store precedence. Canonical git consults the
 * PACK store first for a buffered read once an object is packed, even when a
 * corrupt loose copy of the same object exists: it prints the loose copy's
 * inflate error to stderr but still serves the pack content, exit 0. The
 * per-fanout-dir loose-oid membership cache that amortises the loose probe
 * never changes this — a membership HIT is only ever consulted on a PACK
 * miss (see `object-precedence-interop.test.ts`'s P1/P3 rows for the fuller
 * pinned matrix).
 *
 * @proves
 *   surface:        readObject
 *   bucket:         cross-tool-interop
 *   unique:         pack-first precedence — a corrupt loose copy never shadows a valid pack copy
 *   interopSurface: readObject
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import type { Blob, ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, runGitAsync, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const PAYLOAD = 'hello-precedence-probe-content\n';

let dir = '';

/**
 * Commits one file, then `git repack -a` (no `-d`) — this packs the blob
 * into `objects/pack/` while deliberately LEAVING the loose copy in place,
 * reproducing git's genuine both-stores state without needing to pipe an
 * object list through stdin.
 */
async function buildBothStoresRepo(targetDir: string): Promise<ObjectId> {
  const env = { ...runGitEnv(), ...IDENTITY };
  await runGitAsync(['init', '-q', '-b', 'main', targetDir], { env });
  await writeFile(path.join(targetDir, 'f.txt'), PAYLOAD);
  await runGitAsync(['-C', targetDir, 'add', 'f.txt'], { env });
  await runGitAsync(['-C', targetDir, 'commit', '-q', '-m', 'add f'], { env });
  const oid = (
    await runGitAsync(['-C', targetDir, 'rev-parse', 'HEAD:f.txt'], { env })
  ).trim() as ObjectId;
  await runGitAsync(['-C', targetDir, 'repack', '-a', '-q'], { env });
  return oid;
}

function loosePathFor(targetDir: string, oid: ObjectId): string {
  return path.join(targetDir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
}

describe.skipIf(!GIT_AVAILABLE)('loose-corrupt precedence interop', () => {
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-loose-corrupt-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given an object present only in a pack (no loose copy)', () => {
    describe('When tsgit resolves it via readObject', () => {
      it('Then it returns the pack content (control fixture proving the pack alone is genuinely readable)', async () => {
        // Arrange
        const oid = await buildBothStoresRepo(dir);
        await rm(loosePathFor(dir, oid), { force: true });
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const result = await readObject(ctx, oid);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(new TextEncoder().encode(PAYLOAD));
      });
    });
  });

  describe('Given an object present in a valid pack AND a corrupted loose copy', () => {
    describe('When tsgit resolves it via readObject', () => {
      it('Then it serves the pack content, matching git — the corrupt loose copy never shadows it', async () => {
        // Arrange — object exists in both stores; corrupt the loose copy with
        // non-zlib bytes while the pack copy stays intact. Loose objects are
        // written read-only by git, so the stale copy must be removed before
        // the corrupt replacement can be written.
        const oid = await buildBothStoresRepo(dir);
        const loosePath = loosePathFor(dir, oid);
        await rm(loosePath, { force: true });
        await writeFile(loosePath, new TextEncoder().encode('not-a-zlib-stream'));
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const result = await readObject(ctx, oid);
        const gitCat = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', oid], {
          env: runGitEnv(),
        });

        // Assert — matching git: it serves the pack content at exit 0 despite
        // the corrupt loose copy (it only complains on stderr).
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(new TextEncoder().encode(PAYLOAD));
        expect(gitCat.exitCode).toBe(0);
        expect(gitCat.stdout).toBe(PAYLOAD);
      });
    });
  });
});

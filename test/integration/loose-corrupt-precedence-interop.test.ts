/**
 * Cross-tool interop — object-store precedence. Canonical git consults the
 * LOOSE store even when a valid pack copy of the same object exists, and
 * surfaces the loose copy's inflate error rather than silently falling back
 * to the pack. The per-fanout-dir loose-oid membership cache that amortises
 * the loose probe must preserve this precedence exactly: a membership HIT
 * still routes through a real file read + inflate, so a corrupt loose file
 * is never silently shadowed by a valid pack copy.
 *
 * @proves
 *   surface:        readObject
 *   bucket:         cross-tool-interop
 *   unique:         loose-first precedence — a corrupt loose copy surfaces its inflate error even when a valid pack copy is present
 *   interopSurface: readObject
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Blob, ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, runGitAsync, runGitEnv } from './interop-helpers.js';

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
      it('Then it surfaces the loose inflate error, matching git — NOT a silent pack serve', async () => {
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
        let caught: unknown;
        try {
          await readObject(ctx, oid);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      });
    });
  });
});

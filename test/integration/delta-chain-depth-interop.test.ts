/**
 * Cross-tool interop for hostile delta chains: a crafted pack whose OFS_DELTA
 * names its own offset (base distance zero) must be refused by tsgit exactly
 * where canonical git refuses it, while the otherwise sound base entry stays
 * readable by both.
 *
 * @proves
 *   surface:        readObject
 *   bucket:         cross-tool-interop
 *   unique:         a zero-distance OFS_DELTA is refused by tsgit and git alike (git exits 128)
 *   interopSurface: packfile
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { disposePackRegistry, readObject } from '../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { buildSyntheticPack } from '../unit/application/primitives/pack-fixture.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const GIT_REFUSAL_EXIT_CODE = 128;

interface InstalledPack {
  readonly dir: string;
  readonly dispose: () => Promise<void>;
}

const installCraftedPack = async (
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
): Promise<InstalledPack> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-delta-depth-'));
  runGit(['init', '-q', '--bare', '-b', 'main', dir]);
  const packDir = path.join(dir, 'objects', 'pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, 'pack-crafted.pack'), packBytes);
  await writeFile(path.join(packDir, 'pack-crafted.idx'), idxBytes);
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};

describe.skipIf(!GIT_AVAILABLE)('delta chain depth interop', () => {
  describe('Given a pack whose OFS_DELTA has a base distance of zero', () => {
    describe('When git and tsgit read the delta and its base', () => {
      it('Then both refuse the delta and still read the base', async () => {
        // Arrange
        const encoder = new TextEncoder();
        const { packBytes, idxBytes, ids } = await buildSyntheticPack(createMemoryContext(), [
          { kind: 'base', type: 'blob', content: encoder.encode('zero-distance base') },
          {
            kind: 'ofs-delta',
            baseIndex: 0,
            targetContent: encoder.encode('zero-distance target'),
            distanceOverride: 0,
          },
        ]);
        const deltaId = ids[1] as ObjectId;
        const baseId = ids[0] as ObjectId;
        const { dir, dispose } = await installCraftedPack(packBytes, idxBytes);
        const ctx = createNodeContext({ workDir: dir, gitDir: dir, bare: true });

        try {
          // Act
          const gitType = tryRunGitWithExit(['-C', dir, 'cat-file', '-t', deltaId]);
          const gitContent = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', deltaId]);
          const gitBaseType = tryRunGitWithExit(['-C', dir, 'cat-file', '-t', baseId]);
          const caught = await readObject(ctx, deltaId).then(
            () => undefined,
            (error: unknown) => (error as TsgitError).data,
          );

          // Assert
          expect(gitType.exitCode).toBe(GIT_REFUSAL_EXIT_CODE);
          expect(gitContent.exitCode).toBe(GIT_REFUSAL_EXIT_CODE);
          expect(gitBaseType.exitCode).toBe(0);
          expect(gitBaseType.stdout).toBe('blob\n');
          expect(caught?.code).toBe('OBJECT_NOT_FOUND');
          if (caught?.code !== 'OBJECT_NOT_FOUND') {
            expect.fail(`expected OBJECT_NOT_FOUND, got ${String(caught?.code)}`);
          }
          expect(caught.id).toBe(deltaId);
        } finally {
          await disposePackRegistry(ctx);
          await dispose();
        }
      });
    });
  });
});

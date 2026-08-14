/**
 * Cross-tool interop — the object-store gate is exactly the multi-pack-index
 * load. A structurally self-inconsistent midx (Tier A) denies every read,
 * loose included, ahead of any loose-vs-pack branch. Every OTHER
 * pack-store fault — a merely-unusable midx (Tier B), a pack directory whose
 * listing is refused, or the pack directory missing outright — must still
 * serve a loose read exactly as git does, because git's own object-store
 * setup never depends on listing `objects/pack` for a loose object.
 *
 * Rows A1/A3 anchor that the Tier-A denial still applies to THIS suite's own
 * loose oid — they are deliberately NOT new coverage: `midx-interop.test.ts`
 * already asserts both refusals exhaustively (`TIER_A_ROWS`, walked over
 * every packed AND loose oid). They stay here, reduced to one loose-oid
 * assertion each, so a reader can see the "the deferral is safe because
 * Tier-A still denies a loose read" anchor without leaving this file. Rows
 * A4, E3, C4/E5, C5 and E6 are the genuinely new coverage: a scan that can no
 * longer list `objects/pack` at all must still serve the loose read. Row
 * C4/E5 is the divergence closure — it fails on `main` and passes here.
 *
 * @proves
 *   surface:        objectStore.storeGate
 *   bucket:         cross-tool-interop
 *   unique:         a loose read is denied only by a structurally self-inconsistent multi-pack-index, never by the pack directory
 *   interopSurface: objects/pack
 */
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { disposePackRegistry, readObject } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { GitObject } from '../../src/domain/objects/index.js';
import { parseMultiPackIndex } from '../../src/domain/storage/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import {
  type BaseFixture,
  buildBaseFixture,
  DIGEST_LENGTH,
  midxPaths,
  mutateMidxOrThrow,
} from './midx-fixture-helpers.js';

const SETUP_TIMEOUT = 60_000;

function blobContent(object: GitObject): Uint8Array {
  if (object.type !== 'blob') throw new Error(`expected a blob, got ${object.type}`);
  return object.content;
}

/** Both tools serve the same loose blob: git at exit 0, tsgit with matching bytes. */
async function expectLooseServed(dir: string, ctx: Context, oid: string): Promise<void> {
  const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', oid], { env: runGitEnv() });
  expect(gitResult.exitCode).toBe(0);
  const object = await readObject(ctx, oid as never);
  expect(new TextDecoder().decode(blobContent(object))).toBe(gitResult.stdout);
}

/** A Tier-A midx fault denies the loose read on both tools. */
async function expectLooseDenied(
  dir: string,
  ctx: Context,
  oid: string,
  check: string,
): Promise<void> {
  const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', oid], { env: runGitEnv() });
  expect(gitResult.exitCode).toBe(128);
  let caught: unknown;
  try {
    await readObject(ctx, oid as never);
    expect.unreachable('expected readObject to reject');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data;
  expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
  expect((data as { readonly check: string }).check).toBe(check);
}

describe.skipIf(!GIT_AVAILABLE)(
  'a loose read survives when the pack directory cannot be listed, against real git',
  () => {
    let base: BaseFixture;
    let baseRoot: string;
    const rowRoots: string[] = [];

    beforeAll(async () => {
      baseRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-loose-store-gate-'));
      base = await buildBaseFixture(baseRoot, 'base');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseRoot, { recursive: true, force: true });
      await Promise.all(rowRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    /** Every row gets its OWN copy of the shared base repo — no row ever
     *  mutates a shared tree, and no row pays another `git` spawn. */
    async function copyRow(slug: string): Promise<string> {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-loose-store-gate-${slug}-`));
      rowRoots.push(root);
      const target = path.join(root, 'repo');
      await cp(base.dir, target, { recursive: true });
      return target;
    }

    // Every context a row builds is disposed after the row — an undisposed
    // registry surfaces as the GC-close warning the handle-lifecycle work
    // treats as its leak oracle.
    const liveContexts: Context[] = [];
    function trackedNodeContext(workDir: string): Context {
      const ctx = createNodeContext({ workDir });
      liveContexts.push(ctx);
      return ctx;
    }
    afterEach(async () => {
      await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
    });

    describe('Given the flat midx signature byte flipped (Tier A, row A1 — anchor, exhaustive matrix lives in midx-interop.test.ts), When both tools attempt the loose read', () => {
      it('Then git dies at exit 128 and tsgit rejects the loose read with the signature check', async () => {
        // Arrange
        const dir = await copyRow('a1');
        mutateMidxOrThrow(midxPaths(dir).flat, (bytes) => {
          bytes[3] = (bytes[3] ?? 0) ^ 0x01;
          return bytes;
        });
        const sut = trackedNodeContext(dir);

        // Act + Assert
        await expectLooseDenied(dir, sut, base.looseOid, 'signature');
      });
    });

    describe('Given the flat midx OIDF fanout made non-monotonic (Tier A, row A3 — anchor, proves the gate is not signature-specific), When both tools attempt the loose read', () => {
      it('Then git dies at exit 128 and tsgit rejects the loose read with the fanout check', async () => {
        // Arrange
        const dir = await copyRow('a3');
        mutateMidxOrThrow(midxPaths(dir).flat, (bytes) => {
          const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
          bytes.writeUInt32BE(0xffff, parsed.oidFanoutOffset);
          return bytes;
        });
        const sut = trackedNodeContext(dir);

        // Act + Assert
        await expectLooseDenied(dir, sut, base.looseOid, 'fanout');
      });
    });

    describe('Given the flat midx truncated to 40 bytes (Tier B, row A4), When both tools read the loose object', () => {
      it('Then git exits 0 with content, tsgit serves the same bytes and warns discarding unusable multi-pack-index', async () => {
        // Arrange
        const dir = await copyRow('a4');
        mutateMidxOrThrow(midxPaths(dir).flat, (bytes) => bytes.subarray(0, 40));
        const warn = vi.fn();
        const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: { warn } };
        liveContexts.push(ctx);

        // Act + Assert
        await expectLooseServed(dir, ctx, base.looseOid);
        expect(warn).toHaveBeenCalledWith(
          'packRegistry: discarding unusable multi-pack-index',
          expect.objectContaining({ artefact: 'multi-pack-index' }),
        );
      });
    });

    describe('Given the flat midx removed and the chain manifest naming a nonexistent layer (Tier B, row E3), When both tools read the loose object', () => {
      it('Then git exits 0 with content, tsgit serves the same bytes and warns discarding unusable multi-pack-index', async () => {
        // Arrange
        const dir = await copyRow('e3');
        const { flat, chainDir, chainFile } = midxPaths(dir);
        await rm(flat, { force: true });
        await mkdir(chainDir, { recursive: true });
        const danglingDigest = 'b'.repeat(DIGEST_LENGTH * 2);
        await writeFile(chainFile, `${danglingDigest}\n`);
        const warn = vi.fn();
        const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: { warn } };
        liveContexts.push(ctx);

        // Act + Assert
        await expectLooseServed(dir, ctx, base.looseOid);
        expect(warn).toHaveBeenCalledWith(
          'packRegistry: discarding unusable multi-pack-index',
          expect.objectContaining({ artefact: `multi-pack-index-${danglingDigest}.midx` }),
        );
      });
    });

    describe('Given the pack directory made unreadable via chmod 000 (row C4/E5 — the divergence closure), When both tools read the loose object', () => {
      it.skipIf(os.userInfo().uid === 0 || process.platform === 'win32')(
        'Then git exits 0 with content and tsgit returns the same blob bytes',
        async () => {
          // Arrange
          const dir = await copyRow('c4-e5');
          const packDir = path.join(dir, '.git', 'objects', 'pack');
          await chmod(packDir, 0o000);
          try {
            const sut = trackedNodeContext(dir);

            // Act + Assert
            await expectLooseServed(dir, sut, base.looseOid);
          } finally {
            await chmod(packDir, 0o755);
          }
        },
      );
    });

    describe('Given the flat midx removed and every .pack deleted, leaving orphaned .idx files (row C5), When both tools read the loose object', () => {
      it('Then git is silent at exit 0, tsgit serves the same bytes and emits no logger warn', async () => {
        // Arrange — the midx must go first: with it present this is design row
        // E1 (a healthy midx naming a deleted pack), a different row.
        const dir = await copyRow('c5');
        await rm(midxPaths(dir).flat, { force: true });
        const packDir = path.join(dir, '.git', 'objects', 'pack');
        const entries = await readdir(packDir);
        await Promise.all(
          entries
            .filter((entry) => entry.endsWith('.pack'))
            .map((entry) => rm(path.join(packDir, entry), { force: true })),
        );
        const warn = vi.fn();
        const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: { warn } };
        liveContexts.push(ctx);

        // Act + Assert
        await expectLooseServed(dir, ctx, base.looseOid);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    describe('Given the pack directory removed entirely (row E6), When both tools read the loose object', () => {
      it('Then git exits 0 and tsgit serves the same bytes', async () => {
        // Arrange
        const dir = await copyRow('e6');
        await rm(path.join(dir, '.git', 'objects', 'pack'), { recursive: true, force: true });
        const sut = trackedNodeContext(dir);

        // Act + Assert
        await expectLooseServed(dir, sut, base.looseOid);
      });
    });

    describe('Given the pack directory replaced by a regular file (row E7), When both tools read the loose object', () => {
      it('Then git exits 0 and tsgit serves the same bytes', async () => {
        // Arrange — git prints `error: unable to open object pack directory:
        // …: Not a directory` and still serves the loose object at exit 0. The
        // store setup it dies on is the multi-pack-index, never the listing.
        const dir = await copyRow('e7');
        const packDir = path.join(dir, '.git', 'objects', 'pack');
        await rm(packDir, { recursive: true, force: true });
        await writeFile(packDir, 'not a directory');
        const sut = trackedNodeContext(dir);

        // Act + Assert
        await expectLooseServed(dir, sut, base.looseOid);
      });
    });
  },
);

/**
 * Cross-tool interop — a loose object whose own COMPRESSED bytes are cut
 * short (a crashed write, a `readSlice`-bounded probe of a larger on-disk
 * file), unlike `loose-header-size-interop.test.ts`'s always-complete,
 * merely size-lying streams — against real git.
 *
 * @proves
 *   surface:        readDeclaredObjectSize
 *   bucket:         cross-tool-interop
 *   unique:         a loose object whose compressed bytes are truncated mid-stream, against git 2.55.0
 *   interopSurface: catFile
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readDeclaredObjectSize } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ID = 'f'.repeat(40);

const loosePath = (dir: string, id: string): string =>
  path.join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2));

/** `<type> <size>\0<content>` for `blob 5\0hello`, zlib-deflated once — the
 *  same 20-byte member both truncation variants below slice a prefix from. */
const COMPRESSED = deflateSync(Buffer.from('blob 5\0hello', 'binary'));

const writeTruncatedLoose = async (dir: string, bytes: Uint8Array): Promise<void> => {
  const target = loosePath(dir, ID);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
};

// Every mkdtemp root this file creates (caseDir) is tracked here and removed
// in the module-level afterAll below — a body that throws before its own
// inline cleanup would otherwise leak the dir.
const createdDirs: string[] = [];

afterAll(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!GIT_AVAILABLE)(
  "a loose object whose compressed bytes are cut short, against real git's cat-file",
  () => {
    const caseDir = async (slug: string): Promise<string> => {
      const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-loose-truncated-${slug}-`));
      createdDirs.push(dir);
      tryRunGitWithExit(['init', '-q', dir], { env: runGitEnv() });
      return dir;
    };

    describe('Given the header itself is not fully decodable (5 of 20 compressed bytes present), When git cat-file and tsgit readDeclaredObjectSize both read it', () => {
      it('Then git cat-file -s/-t/-p all refuse ("header … too long, exceeds 32 bytes") and tsgit readDeclaredObjectSize refuses INVALID_OBJECT_HEADER too', async () => {
        // Arrange
        const dir = await caseDir('mid-header');
        await writeTruncatedLoose(dir, COMPRESSED.subarray(0, 5));
        const ctx = createNodeContext({ workDir: dir });

        // Act — git side
        const gitSize = tryRunGitWithExit(['-C', dir, 'cat-file', '-s', ID], { env: runGitEnv() });
        const gitType = tryRunGitWithExit(['-C', dir, 'cat-file', '-t', ID], { env: runGitEnv() });
        const gitBody = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', ID], { env: runGitEnv() });

        // Act — tsgit side
        let caught: unknown;
        try {
          await readDeclaredObjectSize(ctx, ID as ObjectId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — git refuses every surface, header-only and content alike
        expect(gitSize.exitCode).toBe(128);
        expect(gitSize.stderr).toContain('header for');
        expect(gitSize.stderr).toContain('too long, exceeds 32 bytes');
        expect(gitType.exitCode).toBe(128);
        expect(gitBody.exitCode).toBe(128);

        // Assert — git failing here means tsgit refuses too
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OBJECT_HEADER');
        if (data.code === 'INVALID_OBJECT_HEADER') {
          expect(data.reason).toBe(`no NUL terminator found in inflated object ${ID}`);
        }
      });
    });

    describe('Given the header decodes fully but the body never starts (10 of 20 compressed bytes present), When git cat-file and tsgit readDeclaredObjectSize both read it', () => {
      it('Then git cat-file -s/-t both succeed reporting the claim while -p refuses, and tsgit readDeclaredObjectSize succeeds with the same size', async () => {
        // Arrange
        const dir = await caseDir('post-header');
        await writeTruncatedLoose(dir, COMPRESSED.subarray(0, 10));
        const ctx = createNodeContext({ workDir: dir });

        // Act — git side
        const gitSize = tryRunGitWithExit(['-C', dir, 'cat-file', '-s', ID], { env: runGitEnv() });
        const gitType = tryRunGitWithExit(['-C', dir, 'cat-file', '-t', ID], { env: runGitEnv() });
        const gitBody = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', ID], { env: runGitEnv() });

        // Act — tsgit side
        const size = await readDeclaredObjectSize(ctx, ID as ObjectId);

        // Assert — git's header-only surfaces succeed on the claim; only -p,
        // which needs the (missing) body, refuses.
        expect(gitSize.exitCode).toBe(0);
        expect(gitSize.stdout.trim()).toBe('5');
        expect(gitType.exitCode).toBe(0);
        expect(gitType.stdout.trim()).toBe('blob');
        expect(gitBody.exitCode).toBe(128);

        // Assert — git succeeding here means tsgit returns too, same value
        expect(size).toBe(5);
      });
    });
  },
);

/**
 * Cross-tool interop — SHA-256 object format, `.git/index` framing.
 * Builds a `git init --object-format=sha256` repository via real git, then
 * proves tsgit's `add` writes an index git itself can read back. Regression
 * pin for the shipped index-corruption bug: `index-writer.ts` framed the
 * flags word and entry name at the SHA-1-width `offset+60`/`offset+62`
 * regardless of the repository's own oid width, corrupting the last 12
 * bytes of a 32-byte SHA-256 oid.
 *
 * @proves
 *   surface: add
 *   bucket: cross-tool-interop
 *   unique: SHA-256 index entry framing survives tsgit add and reads back identically to git's own add
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { NodeHashService } from '../../src/adapters/node/node-hash-service.js';
import { add } from '../../src/application/commands/add.js';
import { log } from '../../src/application/commands/log.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { SHA256_CONFIG } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  lsStage,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

/** A Node-backed `Context` rooted at `dir`, rehashing at SHA-256 — the width
 *  `createNodeContext` does not yet expose as a public option (that threads
 *  through `HashConfig.algorithm` in a later part); overriding `hash` and
 *  `hashConfig` here is the same technique other interop suites use to
 *  exercise a Context field the public entry points don't surface yet. */
const sha256Context = (dir: string): Context => ({
  ...createNodeContext({ workDir: dir }),
  hash: new NodeHashService('sha256'),
  hashConfig: SHA256_CONFIG,
});

describe.skipIf(!GIT_AVAILABLE)('sha256 object format — .git/index interop', () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-index-base-'));
    const env = runGitEnv();
    runGit(['init', '-q', '-b', 'main', '--object-format=sha256', baseDir], { env });
    runGit(['-C', baseDir, 'config', 'user.name', 'Ada'], { env });
    runGit(['-C', baseDir, 'config', 'user.email', 'ada@example.com'], { env });
    disableAutoMaintenance(baseDir);
    await writeFile(path.join(baseDir, 'base.txt'), 'base\n');
    runGit(['-C', baseDir, 'add', 'base.txt'], { env });
    runGit(['-C', baseDir, 'commit', '-q', '-m', 'base'], { env });
    runGit(['-C', baseDir, 'tag', 'v1'], { env });
    runGit(['-C', baseDir, 'repack', '-adq'], { env });
  }, 60_000);

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  describe('Given a SHA-256 repository and a new working-tree file, staged once by tsgit add and once by git add (each on its own copy)', () => {
    describe('When both sides run', () => {
      it("Then git ls-files --stage reads back tsgit's index with the full 64-hex oid, matching git's own add exactly", async () => {
        // Arrange — two independent copies of the same base repo, one for
        // each side, so the destructive `add` on one cannot affect the other.
        const oursDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-index-ours-'));
        const theirsDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-index-theirs-'));
        await cp(baseDir, oursDir, { recursive: true });
        await cp(baseDir, theirsDir, { recursive: true });
        await writeFile(path.join(oursDir, 'a.txt'), 'hello\n');
        await writeFile(path.join(theirsDir, 'a.txt'), 'hello\n');

        try {
          // Act
          await add(sha256Context(oursDir), ['a.txt']);
          runGit(['-C', theirsDir, 'add', 'a.txt'], { env: runGitEnv() });
          const ours = lsStage(oursDir);
          const theirs = lsStage(theirsDir);

          // Assert — git itself accepts and reads back tsgit's index, and the
          // two staged listings (mode, full oid, stage, path) are identical.
          expect(ours).toContain(
            '100644 2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4 0\ta.txt',
          );
          expect(ours).toBe(theirs);
        } finally {
          await rm(oursDir, { recursive: true, force: true });
          await rm(theirsDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('Given a SHA-256 repository, When tsgit packObjects writes a fresh .pack + .idx into it', () => {
    it("Then git verify-pack -v accepts tsgit's own .idx (exit 0)", async () => {
      // Arrange — a copy of the base repo, so packObjects' write cannot
      // disturb the shared fixture other tests in this file read from.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-packobjects-'));
      await cp(baseDir, dir, { recursive: true });

      try {
        // Act
        const written = await packObjects(sha256Context(dir), { wants: ['HEAD'] });
        const idxPath = path.join(dir, '.git', 'objects', 'pack', `pack-${written.packId}.idx`);
        const verifyResult = tryRunGitWithExit(['-C', dir, 'verify-pack', '-v', idxPath]);

        // Assert — a plain (repo-less) verify-pack cannot infer a SHA-256
        // pack's 32-byte oid stride, so `-C dir` is load-bearing: it lets
        // git discover the repo's own `extensions.objectFormat=sha256`.
        expect(verifyResult.exitCode).toBe(0);
        expect(written.objectCount).toBeGreaterThan(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Given a SHA-256 repository git itself packed, When tsgit log walks it', () => {
    it("Then the returned commit ids match git log's own listing", async () => {
      // Arrange — baseDir's sole commit lives entirely inside the pack
      // `repack -adq` wrote in the shared beforeAll; reading it back proves
      // tsgit's pack-index parsing round-trips a git-produced SHA-256 pack.
      const expectedHead = runGit(['-C', baseDir, 'rev-parse', 'HEAD'], {
        env: runGitEnv(),
      }).trim();

      // Act
      const entries = await log(sha256Context(baseDir));

      // Assert
      expect(entries.map((entry) => entry.id)).toEqual([expectedHead]);
    });
  });
});

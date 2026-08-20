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
import { SHA256_CONFIG } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  lsStage,
  runGit,
  runGitEnv,
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
});

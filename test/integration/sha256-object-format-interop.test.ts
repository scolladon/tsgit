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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { NodeFileSystem } from '../../src/adapters/node/node-file-system.js';
import { NodeHashService } from '../../src/adapters/node/node-hash-service.js';
import { nativePolicy } from '../../src/adapters/node/path-policy.js';
import { add } from '../../src/application/commands/add.js';
import { archive } from '../../src/application/commands/archive.js';
import { catFile } from '../../src/application/commands/cat-file.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { clone } from '../../src/application/commands/clone.js';
import { commit } from '../../src/application/commands/commit.js';
import { fetch as fetchCommand } from '../../src/application/commands/fetch.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { init } from '../../src/application/commands/init.js';
import { log } from '../../src/application/commands/log.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { push } from '../../src/application/commands/push.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { submoduleAdd } from '../../src/application/commands/submodule.js';
import { tarArchive } from '../../src/domain/archive/tar.js';
import { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { parsePackIndex } from '../../src/domain/storage/pack-index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import type { HttpTransport } from '../../src/ports/http-transport.js';
import { fileSystemLayoutProbe } from '../../src/repository/file-system-layout-probe.js';
import { readRepositoryFormat } from '../../src/repository/read-repository-format.js';
import { findGitHttpBackend, startGitHttpBackend } from '../bench/support/http-backend-server.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  lsStage,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** Collect an AsyncIterable<Uint8Array> into one concatenated Uint8Array. */
async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A Node-backed `Context` rooted at `dir`, rehashing at SHA-256 via the
 * `algorithm` option `createNodeContext` now exposes. Deliberately NOT the
 * full async `openRepository` — a real `git init --object-format=sha256`
 * repository's `extensions.objectFormat` config entry unconditionally trips
 * `assertExtensionBacked`'s point-of-use refusal (`UNBACKED_EXTENSIONS` — out
 * of this part's scope; its removal is Part 13's job), so `openRepository`
 * cannot open one yet. The sync factory builds a `Context` lexically, without
 * reading the repository's config at all, so it bypasses that gate.
 */
const sha256Context = (dir: string): Context =>
  createNodeContext({ workDir: dir, algorithm: 'sha256' });

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
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-pack-objects-'));
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

  describe('Given a SHA-256 repository, When a tsgit commit writes a HEAD reflog entry', () => {
    it('Then git reflog show exits 0 and prints the tsgit-written entry', async () => {
      // Arrange — a copy of the base repo, so this write cannot disturb the
      // shared fixture other tests in this file read from. A round trip
      // through tsgit's own reader proves nothing (symmetrically wrong offsets
      // agree with themselves); real git reading tsgit's bytes is the oracle.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-reflog-'));
      await cp(baseDir, dir, { recursive: true });

      try {
        // Act — appendReflog → serializeReflogLine(entry, ctx.hashConfig.hexLength)
        await writeFile(path.join(dir, 'reflog.txt'), 'reflog\n');
        await add(sha256Context(dir), ['reflog.txt']);
        await commit(sha256Context(dir), { message: 'tsgit reflog entry', author: AUTHOR });
        const result = tryRunGitWithExit(['-C', dir, 'reflog', 'show']);

        // Assert — a git-faithful 64-hex reflog line parses cleanly; the
        // pre-fix 40-char offsets would misplace the field separator and git
        // would refuse or truncate the entry.
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('tsgit reflog entry');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Given a SHA-256 repository, When a tsgit commit writes new objects', () => {
    it('Then git fsck exits 0', async () => {
      // Arrange — a copy of the base repo, so this write cannot disturb the
      // shared fixture other tests in this file read from.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-fsck-'));
      await cp(baseDir, dir, { recursive: true });

      try {
        // Act
        await writeFile(path.join(dir, 'fsck.txt'), 'fsck\n');
        await add(sha256Context(dir), ['fsck.txt']);
        await commit(sha256Context(dir), { message: 'tsgit fsck object', author: AUTHOR });
        const result = tryRunGitWithExit(['-C', dir, 'fsck']);

        // Assert
        expect(result.exitCode).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Given a SHA-256 repository, When tsgit archive + tarArchive serialize HEAD', () => {
    it('Then tar accepts the bytes and git get-tar-commit-id reads back the exact HEAD oid', async () => {
      // Arrange — baseDir is read-only here (archive never writes), so reuse
      // the shared fixture, like the log/pack-index tests above.
      //
      // `tar -t` alone is a WEAK oracle for this bug: both the pre-fix 52-byte
      // and the correct 76-byte PAX declared sizes round up to the SAME single
      // 512-byte block, so `tar` locates the next header identically either
      // way (verified empirically against a hand-built corrupt tar). `git
      // get-tar-commit-id` reads the PAX comment payload itself and IS
      // corrupted by a wrong declared size — it silently truncates to the
      // declared byte count and exits 0 with the WRONG value — so its
      // returned value, not just its exit code, is the load-bearing assertion.
      const expectedHead = runGit(['-C', baseDir, 'rev-parse', 'HEAD'], {
        env: runGitEnv(),
      }).trim();

      // Act
      const result = await archive(sha256Context(baseDir), { treeish: 'HEAD' });
      const tarBytes = Buffer.from(
        await collectBytes(
          tarArchive(result, result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
        ),
      );
      const tarList = spawnSync('tar', ['-tf', '-'], { input: tarBytes });
      const commitId = spawnSync('git', ['get-tar-commit-id'], {
        input: tarBytes,
        env: runGitEnv(),
        encoding: 'utf8',
      });

      // Assert
      expect(tarList.status).toBe(0);
      expect(commitId.status).toBe(0);
      expect(commitId.stdout.trim()).toBe(expectedHead);
    });
  });

  describe('Given a SHA-256 repository, When a 40-hex prefix of HEAD is resolved', () => {
    it("Then both tsgit revParse and git rev-parse --verify resolve it to HEAD's full 64-hex oid", async () => {
      // Arrange — measured against real git: a 40-hex prefix of a SHA-256 oid
      // resolves to the full 64-hex oid; it is a prefix, not an algorithm signal.
      const env = runGitEnv();
      const fullHead = runGit(['-C', baseDir, 'rev-parse', 'HEAD'], { env }).trim();
      const prefix40 = fullHead.slice(0, 40);

      // Act
      const ours = await revParse(sha256Context(baseDir), prefix40);
      const theirs = runGit(['-C', baseDir, 'rev-parse', '--verify', prefix40], { env }).trim();

      // Assert
      expect(ours).toBe(fullHead);
      expect(theirs).toBe(fullHead);
    });
  });

  describe('Given a SHA-1 repository, When a full 64-hex string is resolved', () => {
    it('Then both tsgit revParse and git rev-parse --verify refuse it — a 64-hex oid never exists in a SHA-1 repo', async () => {
      // Arrange — a plain SHA-1 repository; the 64-hex string is well-formed
      // hex but the wrong width for this repo's own oid, never a valid prefix
      // (SHA-1 prefixes bottom out at 40 hex chars).
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha1-64hex-'));
      const env = runGitEnv();
      try {
        runGit(['init', '-q', '-b', 'main', dir], { env });
        runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
        runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
        await writeFile(path.join(dir, 'f.txt'), 'f\n');
        runGit(['-C', dir, 'add', 'f.txt'], { env });
        runGit(['-C', dir, 'commit', '-q', '-m', 'f'], { env });
        const fake64 = 'a'.repeat(64);

        // Act
        const theirs = tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', fake64], { env });
        let caught: TsgitError | undefined;
        try {
          await revParse(createNodeContext({ workDir: dir }), fake64);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — git's own refusal, pinned to the verb actually run
        // (`rev-parse --verify`): the message is command-specific, not a
        // fixed string every verb shares.
        expect(theirs.exitCode).toBe(128);
        expect(theirs.stderr).toContain('fatal: Needed a single revision');
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught?.data.code).toBe('OBJECT_NOT_FOUND');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Given a SHA-256 repository, When tsgit checkout is given the raw 64-hex HEAD oid', () => {
    it("Then it detaches HEAD at that oid, matching git's own checkout on the same oid", async () => {
      // Arrange — two independent copies, one for each side.
      const oursDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-checkout-ours-'));
      const theirsDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-checkout-theirs-'));
      await cp(baseDir, oursDir, { recursive: true });
      await cp(baseDir, theirsDir, { recursive: true });
      const env = runGitEnv();
      const fullHead = runGit(['-C', baseDir, 'rev-parse', 'HEAD'], { env }).trim();

      try {
        // Act — git resolves a raw oid to the object itself, never attempting
        // it as a branch name; tsgit's checkout must match.
        const result = await checkout(sha256Context(oursDir), { rev: fullHead });
        runGit(['-C', theirsDir, 'checkout', '-q', fullHead], { env });

        // Assert — both sides' on-disk HEAD hold the raw detached oid.
        const oursHead = await readFile(path.join(oursDir, '.git', 'HEAD'), 'utf8');
        const theirsHead = await readFile(path.join(theirsDir, '.git', 'HEAD'), 'utf8');
        expect(result.detached).toBe(true);
        expect(result.id).toBe(fullHead);
        expect(oursHead.trim()).toBe(fullHead);
        expect(theirsHead.trim()).toBe(fullHead);
      } finally {
        await rm(oursDir, { recursive: true, force: true });
        await rm(theirsDir, { recursive: true, force: true });
      }
    });
  });

  describe('Given a SHA-256 repository git itself packed, When tsgit catFile reads HEAD and HEAD^{tree}', () => {
    it("Then both entries resolve with git's exact 64-hex oids and object types", async () => {
      // Arrange
      const env = runGitEnv();
      const expectedHead = runGit(['-C', baseDir, 'rev-parse', 'HEAD'], { env }).trim();
      const expectedTree = runGit(['-C', baseDir, 'rev-parse', 'HEAD^{tree}'], { env }).trim();
      expect(expectedHead).toMatch(/^[0-9a-f]{64}$/);
      expect(expectedTree).toMatch(/^[0-9a-f]{64}$/);

      // Act
      const result = await catFile(sha256Context(baseDir), {
        ids: [expectedHead, expectedTree],
      });

      // Assert
      expect(result.entries).toEqual([
        expect.objectContaining({ ok: true, id: expectedHead, type: 'commit' }),
        expect.objectContaining({ ok: true, id: expectedTree, type: 'tree' }),
      ]);
    });
  });

  describe('Given a SHA-256 repository, When tsgit revParse resolves HEAD and HEAD^{tree}', () => {
    it("Then both resolve to git's exact 64-hex oids", async () => {
      // Arrange
      const env = runGitEnv();
      const expectedHead = runGit(['-C', baseDir, 'rev-parse', 'HEAD'], { env }).trim();
      const expectedTree = runGit(['-C', baseDir, 'rev-parse', 'HEAD^{tree}'], { env }).trim();

      // Act
      const ours = await revParse(sha256Context(baseDir), 'HEAD');
      const oursTree = await revParse(sha256Context(baseDir), 'HEAD^{tree}');

      // Assert
      expect(ours).toBe(expectedHead);
      expect(oursTree).toBe(expectedTree);
    });
  });

  describe("Given today's live desync — a caller-supplied sha256 hash service on a plain SHA-1 repository, opened through the real public Node entry point, When openRepository runs", () => {
    it('Then openRepository refuses with OBJECT_FORMAT_CONFLICT instead of silently pairing ctx.hash=sha256 with ctx.hashConfig=SHA1_CONFIG', async () => {
      // Arrange — a plain (SHA-1) repository, built the same way the
      // adjacent 64-hex-refusal test above builds one; before this part,
      // `openRepository({ hash: new NodeHashService('sha256') })` on the
      // Node entry silently paired ctx.hash.algorithm === 'sha256' with
      // ctx.hashConfig === SHA1_CONFIG and nothing refused it.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha1-desync-'));
      const env = runGitEnv();
      let caught: unknown;
      try {
        runGit(['init', '-q', '-b', 'main', dir], { env });
        runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
        runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
        await writeFile(path.join(dir, 'f.txt'), 'f\n');
        runGit(['-C', dir, 'add', 'f.txt'], { env });
        runGit(['-C', dir, 'commit', '-q', '-m', 'f'], { env });

        // Act
        try {
          await openRepository({ cwd: dir, hash: new NodeHashService('sha256') });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha256',
          declared: 'sha1',
          source: 'hash',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Given extensions.objectFormat set to each row of the measured value grammar', () => {
    /** `readRepositoryFormat` against a REAL disk-backed repo at `dir`. */
    const readObjectFormat = (dir: string) => {
      const gitDir = path.join(dir, '.git');
      return readRepositoryFormat(
        fileSystemLayoutProbe(new NodeFileSystem(dir)),
        gitDir,
        gitDir,
        nativePolicy,
      );
    };

    /**
     * Replaces `git init --object-format=sha256`'s single
     * `\tobjectformat = sha256` config line with `replacement` (verbatim,
     * tab included) — `''` plants nothing (used for the padded/last-wins
     * rows, which supply their own full replacement block).
     */
    const plantObjectFormatLine = async (dir: string, replacement: string): Promise<string> => {
      const configPath = path.join(dir, '.git', 'config');
      const text = await readFile(configPath, 'utf8');
      const updated = text.replace(/\n\tobjectformat[^\n]*\n/, `\n${replacement}\n`);
      await writeFile(configPath, updated);
      return configPath;
    };

    /** A fresh `git init --object-format=sha256` repo, cleaned up by the caller. */
    const initSha256Repo = async (prefix: string): Promise<string> => {
      const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
      runGit(['init', '-q', '-b', 'main', '--object-format=sha256', dir], { env: runGitEnv() });
      return dir;
    };

    /**
     * Drops `core.repositoryformatversion` from `dir`'s config entirely,
     * leaving `extensions.objectFormat` as the only relevant key. Isolates
     * the value-grammar layer this part adds from the UNCONDITIONAL
     * point-of-use refusal `assertExtensionBacked` still raises for
     * `objectformat` at version 1 (`UNBACKED_EXTENSIONS` — out of THIS
     * part's scope; its removal is the last step of the whole change, once
     * the algorithm is actually wired through). The same isolation the unit
     * tests use, here reproduced on a real, git-initialized repo. Called
     * only AFTER git's own verdict on the untouched (version 1) file has
     * already been captured.
     */
    const stripRepositoryFormatVersion = async (dir: string): Promise<void> => {
      const configPath = path.join(dir, '.git', 'config');
      const text = await readFile(configPath, 'utf8');
      const updated = text.replace(/\n\trepositoryformatversion = \d+\n/, '\n');
      await writeFile(configPath, updated);
    };

    describe('When the value is git-legal', () => {
      it.each([
        ['\tobjectformat = sha1', 'sha1'],
        ['\tobjectformat = sha256', 'sha256'],
        ['\tobjectformat =   sha256  ', 'sha256'],
        ['\tobjectformat = sha256\n\tobjectformat = sha1', 'sha1'],
        ['\tobjectformat = sha1\n\tobjectformat = sha256', 'sha256'],
      ] as const)(
        'Then git rev-parse --show-object-format and tsgit readRepositoryFormat agree on the grammar verdict: %j -> %s',
        async (line, expected) => {
          // Arrange
          const dir = await initSha256Repo('tsgit-objectformat-accept-');
          try {
            await plantObjectFormatLine(dir, line);

            // Act — git's verdict, on the real (version 1) file
            const theirs = tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format'], {
              env: runGitEnv(),
            });

            // Assert — git
            expect(theirs.exitCode).toBe(0);
            expect(theirs.stdout.trim()).toBe(expected);

            // Act — tsgit's verdict, with the unrelated refuse-set isolated
            await stripRepositoryFormatVersion(dir);
            const ours = await readObjectFormat(dir);

            // Assert — tsgit
            expect(ours.objectFormat).toBe(expected);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      );
    });

    describe('When the value is outside the case-sensitive grammar', () => {
      it.each([
        ['\tobjectformat = SHA256', 'SHA256'],
        ['\tobjectformat = Sha256', 'Sha256'],
        ['\tobjectformat = sha-256', 'sha-256'],
        ['\tobjectformat = sha256x', 'sha256x'],
        ['\tobjectformat =', ''],
      ] as const)(
        "Then both refuse: git with \"invalid value for 'extensions.objectformat': '%s'\", tsgit with CONFIG_INVALID_ENUM_VALUE",
        async (line, value) => {
          // Arrange
          const dir = await initSha256Repo('tsgit-objectformat-refuse-');
          try {
            const configPath = await plantObjectFormatLine(dir, line);

            // Act
            const theirs = tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format'], {
              env: runGitEnv(),
            });
            let caught: unknown;
            try {
              await readObjectFormat(dir);
            } catch (err) {
              caught = err;
            }

            // Assert — git
            expect(theirs.exitCode).toBe(128);
            expect(theirs.stderr).toContain(
              `invalid value for 'extensions.objectformat': '${value}'`,
            );
            // Assert — tsgit
            expect(caught).toBeInstanceOf(TsgitError);
            const data = (caught as TsgitError).data;
            expect(data).toEqual({
              code: 'CONFIG_INVALID_ENUM_VALUE',
              key: 'extensions.objectformat',
              source: configPath,
              value,
              line: expect.any(Number),
            });
            // Both of git's lines are reconstructed from the structured fields —
            // the library emits no rendered text, so the line number has to be
            // carried in the payload for this to be expressible at all.
            if (data.code !== 'CONFIG_INVALID_ENUM_VALUE') expect.unreachable();
            expect(theirs.stderr).toContain(
              `error: invalid value for '${data.key}': '${data.value}'`,
            );
            expect(theirs.stderr).toContain(`fatal: bad config line ${data.line} in file`);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      );
    });

    describe('When the value is valueless (no "=" at all)', () => {
      it('Then both refuse: git with "missing value for \'extensions.objectformat\'", tsgit with CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const dir = await initSha256Repo('tsgit-objectformat-valueless-');
        try {
          const configPath = await plantObjectFormatLine(dir, '\tobjectformat');

          // Act
          const theirs = tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format'], {
            env: runGitEnv(),
          });
          let caught: unknown;
          try {
            await readObjectFormat(dir);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(theirs.exitCode).toBe(128);
          expect(theirs.stderr).toContain("missing value for 'extensions.objectformat'");
          expect(theirs.stderr).toContain('fatal: bad config line');
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_MISSING_VALUE',
            key: 'extensions.objectformat',
            source: configPath,
            line: 2,
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'sha256 object format — per-format read symmetry (git writes, tsgit reads)',
  () => {
    let dir: string;
    let expectedLog: ReadonlyArray<string>;
    let revBytes: Uint8Array;
    let midxBytes: Uint8Array;
    let commitGraphBytes: Uint8Array;
    let idxBytes: Uint8Array;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-dual-format-'));
      const env = runGitEnv();
      runGit(['init', '-q', '-b', 'main', '--object-format=sha256', dir], { env });
      runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
      disableAutoMaintenance(dir);
      for (let i = 0; i < 3; i += 1) {
        await writeFile(path.join(dir, `f${i}.txt`), `${i}\n`);
        runGit(['-C', dir, 'add', `f${i}.txt`], { env });
        runGit(['-C', dir, 'commit', '-q', '-m', `c${i}`], { env });
      }
      // Coalesce into a SINGLE pack carrying a reverse index and a bitmap —
      // `.rev`, `.bitmap` and `multi-pack-index` all need exactly one pack to
      // keep the fixture's discovery (readdir + filename filter) unambiguous.
      runGit(['-C', dir, '-c', 'pack.writeReverseIndex=true', 'repack', '-a', '-d', '-b', '-q'], {
        env,
      });
      runGit(['-C', dir, 'multi-pack-index', 'write'], { env });
      runGit(['-C', dir, 'commit-graph', 'write', '--reachable'], { env });
      runGit(['-C', dir, 'pack-refs', '--all'], { env });
      expectedLog = runGit(['-C', dir, 'log', '--format=%H'], { env }).trim().split('\n');

      const packDir = path.join(dir, '.git', 'objects', 'pack');
      const packFiles = await readdir(packDir);
      const revFile = packFiles.find((f) => f.endsWith('.rev'));
      const idxFile = packFiles.find((f) => f.endsWith('.idx'));
      if (revFile === undefined || idxFile === undefined) {
        throw new Error('expected a .rev and .idx sibling after repack -b');
      }
      revBytes = await readFile(path.join(packDir, revFile));
      idxBytes = await readFile(path.join(packDir, idxFile));
      midxBytes = await readFile(path.join(packDir, 'multi-pack-index'));
      commitGraphBytes = await readFile(path.join(dir, '.git', 'objects', 'info', 'commit-graph'));
    }, 60_000);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    describe('Given the .rev file git wrote for a SHA-256 pack, When tsgit reads its header', () => {
      it('Then its hash id is 2', () => {
        // Arrange
        const view = new DataView(revBytes.buffer, revBytes.byteOffset, revBytes.byteLength);

        // Act
        const hashId = view.getUint32(8);

        // Assert
        expect(hashId).toBe(2);
      });
    });

    describe('Given the multi-pack-index git wrote, When tsgit reads its header', () => {
      it('Then its hash-version byte is 02', () => {
        // Arrange — byte 5 of the midx header is the hash-version field.
        const sut = midxBytes;

        // Act & Assert
        expect(sut[5]).toBe(2);
      });
    });

    describe('Given the commit-graph git wrote, When tsgit reads its header', () => {
      it('Then its hash-version byte is 02', () => {
        // Arrange — byte 5 of the commit-graph header is the hash-version field.
        const sut = commitGraphBytes;

        // Act & Assert
        expect(sut[5]).toBe(2);
      });
    });

    describe("Given the pack .idx v2 trailer git wrote, When tsgit's pack-index reader frames it", () => {
      it("Then tsgit's own pack-index reader frames it at 64 bytes (two 32-byte SHA-256 checksums)", () => {
        // Arrange & Act
        const parsed = parsePackIndex(idxBytes, 32);

        // Assert
        expect(idxBytes.length - parsed.trailerOffset).toBe(64);
      });
    });

    describe('Given git packed the refs, removing the loose refs/heads/main file, When tsgit resolves the branch', () => {
      it("Then tsgit's revParse still resolves main by reading only packed-refs", async () => {
        // Arrange
        const looseRefExists = existsSync(path.join(dir, '.git', 'refs', 'heads', 'main'));

        // Act
        const ours = await revParse(sha256Context(dir), 'main');

        // Assert
        expect(looseRefExists).toBe(false);
        expect(ours).toBe(expectedLog[0]);
      });
    });

    describe('Given the pack + .rev + multi-pack-index + commit-graph git wrote, When tsgit log walks the repository', () => {
      it("Then tsgit log walks it and reproduces git log's exact oid sequence", async () => {
        // Arrange
        const sut = log;

        // Act
        const entries = await sut(sha256Context(dir));

        // Assert
        expect(entries.map((entry) => entry.id)).toEqual(expectedLog);
      });
    });

    describe('Given the pack .bitmap git wrote, When tsgit runs fsck over it', () => {
      it('Then tsgit fsck reads it cleanly, matching git fsck exit 0', async () => {
        // Arrange
        const theirs = tryRunGitWithExit(['-C', dir, 'fsck'], { env: runGitEnv() });

        // Act
        const ours = await fsck(sha256Context(dir), {});

        // Assert
        expect(theirs.exitCode).toBe(0);
        expect(ours.exitCode).toBe(0);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'sha256 object format — SHA-1 invariance (R6, same battery on a plain SHA-1 repository)',
  () => {
    let dir: string;
    let expectedLog: ReadonlyArray<string>;
    let revBytes: Uint8Array;
    let idxBytes: Uint8Array;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha1-dual-format-'));
      const env = runGitEnv();
      runGit(['init', '-q', '-b', 'main', dir], { env });
      runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
      disableAutoMaintenance(dir);
      for (let i = 0; i < 3; i += 1) {
        await writeFile(path.join(dir, `f${i}.txt`), `${i}\n`);
        runGit(['-C', dir, 'add', `f${i}.txt`], { env });
        runGit(['-C', dir, 'commit', '-q', '-m', `c${i}`], { env });
      }
      runGit(['-C', dir, '-c', 'pack.writeReverseIndex=true', 'repack', '-a', '-d', '-q'], {
        env,
      });
      runGit(['-C', dir, 'pack-refs', '--all'], { env });
      expectedLog = runGit(['-C', dir, 'log', '--format=%H'], { env }).trim().split('\n');

      const packDir = path.join(dir, '.git', 'objects', 'pack');
      const packFiles = await readdir(packDir);
      const revFile = packFiles.find((f) => f.endsWith('.rev'));
      const idxFile = packFiles.find((f) => f.endsWith('.idx'));
      if (revFile === undefined || idxFile === undefined) {
        throw new Error('expected a .rev and .idx sibling after repack');
      }
      revBytes = await readFile(path.join(packDir, revFile));
      idxBytes = await readFile(path.join(packDir, idxFile));
    }, 60_000);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    describe('Given the .rev file git wrote for a SHA-1 pack, When tsgit reads its header', () => {
      it('Then its hash id is still 1', () => {
        // Arrange
        const view = new DataView(revBytes.buffer, revBytes.byteOffset, revBytes.byteLength);

        // Act
        const hashId = view.getUint32(8);

        // Assert
        expect(hashId).toBe(1);
      });
    });

    describe("Given the pack .idx v2 trailer git wrote, When tsgit's pack-index reader frames it", () => {
      it("Then tsgit's own pack-index reader still frames it at 40 bytes (two 20-byte SHA-1 checksums)", () => {
        // Arrange & Act
        const parsed = parsePackIndex(idxBytes, 20);

        // Assert
        expect(idxBytes.length - parsed.trailerOffset).toBe(40);
      });
    });

    describe("Given every commit tsgit reads back from this repository, When their oids are compared with git's", () => {
      it("Then every oid is still 40 hex characters, matching git log's own sequence", async () => {
        // Arrange
        const sut = log;

        // Act
        const entries = await sut(createNodeContext({ workDir: dir }));

        // Assert
        expect(entries.map((entry) => entry.id)).toEqual(expectedLog);
        for (const entry of entries) {
          expect(entry.id).toMatch(/^[0-9a-f]{40}$/);
        }
      });
    });

    describe('Given a new working-tree file, staged once by tsgit add and once by git add (each on its own copy), When both indexes are read back', () => {
      it("Then git ls-files --stage reads back tsgit's index with the full 40-hex oid at the unchanged 62-byte fixed entry header, matching git's own add exactly", async () => {
        // Arrange — two independent copies of the same base repo, one for
        // each side, so the destructive `add` on one cannot affect the other.
        const oursDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha1-index-ours-'));
        const theirsDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha1-index-theirs-'));
        await cp(dir, oursDir, { recursive: true });
        await cp(dir, theirsDir, { recursive: true });
        await writeFile(path.join(oursDir, 'a.txt'), 'hello\n');
        await writeFile(path.join(theirsDir, 'a.txt'), 'hello\n');

        try {
          // Act
          await add(createNodeContext({ workDir: oursDir }), ['a.txt']);
          runGit(['-C', theirsDir, 'add', 'a.txt'], { env: runGitEnv() });
          const ours = lsStage(oursDir);
          const theirs = lsStage(theirsDir);

          // Assert — the 62-byte fixed header (40 stat bytes + 20-byte oid +
          // 2-byte flags) is exactly what puts the name at this offset; a
          // regressed header size would misplace it and corrupt git's own read.
          expect(ours).toMatch(/^100644 [0-9a-f]{40} 0\ta\.txt$/m);
          expect(ours).toBe(theirs);
        } finally {
          await rm(oursDir, { recursive: true, force: true });
          await rm(theirsDir, { recursive: true, force: true });
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'sha256 object format — R13 cross-format meeting points inside one working tree',
  () => {
    describe('Given a linked worktree of a SHA-256 repository, When both tools operate inside it', () => {
      it("Then git reports sha256 from inside it, and tsgit's own add there writes a 32-byte-oid index — the format is inherited from the common dir, no worktree-specific branch needed", async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-lwt-base-'));
        const wtParent = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-lwt-wt-parent-'));
        const wtDir = path.join(wtParent, 'wt');
        const env = runGitEnv();
        try {
          runGit(['init', '-q', '-b', 'main', '--object-format=sha256', dir], { env });
          runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
          runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
          await writeFile(path.join(dir, 'base.txt'), 'base\n');
          runGit(['-C', dir, 'add', 'base.txt'], { env });
          runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env });
          runGit(['-C', dir, 'worktree', 'add', wtDir, '-b', 'wt'], { env });

          // Act — the real discovery path (not the `sha256Context` bypass):
          // `openRepository` must follow the worktree's `.git` gitfile and
          // read the format from the COMMON dir's config, with no per-worktree
          // config of its own.
          const shown = tryRunGitWithExit(['-C', wtDir, 'rev-parse', '--show-object-format']);
          await writeFile(path.join(wtDir, 'wt.txt'), 'wt\n');
          const repo = await openRepository({ cwd: wtDir });
          try {
            await repo.add(['wt.txt']);
          } finally {
            await repo.dispose();
          }
          const staged = runGit(['-C', wtDir, 'ls-files', '--stage']);
          const adminDir = path.join(dir, '.git', 'worktrees', path.basename(wtDir));

          // Assert
          expect(shown.exitCode).toBe(0);
          expect(shown.stdout.trim()).toBe('sha256');
          expect(staged).toMatch(/^100644 [0-9a-f]{64} 0\twt\.txt$/m);
          // The admin dir holds no config of its own, so the format read
          // needs no worktree-specific branch — inherited from the common dir.
          expect(existsSync(path.join(adminDir, 'config'))).toBe(false);
        } finally {
          await rm(dir, { recursive: true, force: true });
          await rm(wtParent, { recursive: true, force: true });
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'sha256 object format — compatObjectFormat (git itself refuses it at the point of use)',
  () => {
    describe('Given a SHA-256 repository with extensions.compatObjectFormat = sha1 planted, When both tools open it', () => {
      it("Then git refuses with 'compatibility hash algorithm support requires Rust' (exit 128), and tsgit's openRepository refuses with REPOSITORY_EXTENSION_UNSUPPORTED naming compatobjectformat", async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-compat-'));
        const env = runGitEnv();
        try {
          runGit(['init', '-q', '-b', 'main', '--object-format=sha256', dir], { env });
          runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env });
          runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env });
          await writeFile(path.join(dir, 'f.txt'), 'f\n');
          runGit(['-C', dir, 'add', 'f.txt'], { env });
          runGit(['-C', dir, 'commit', '-q', '-m', 'f'], { env });
          runGit(['-C', dir, 'config', 'extensions.compatObjectFormat', 'sha1'], { env });

          // Act
          const theirs = tryRunGitWithExit(['-C', dir, 'log'], { env });
          let caught: unknown;
          try {
            await openRepository({ cwd: dir });
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(theirs.exitCode).toBe(128);
          expect(theirs.stderr).toContain('compatibility hash algorithm support requires Rust');
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
            extension: 'compatobjectformat',
            value: 'sha1',
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('sha256 object format — init', () => {
  describe('Given a fresh directory', () => {
    describe('When tsgit init runs with objectFormat sha256', () => {
      it('Then real git reads the repository as sha256 and git log sees a tsgit-written commit', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha256-init-'));
        try {
          const ctx = createNodeContext({ workDir: dir, algorithm: 'sha256' });

          // Act
          await init(ctx, { objectFormat: 'sha256' });
          await writeFile(path.join(dir, 'init.txt'), 'init\n');
          await add(ctx, ['init.txt']);
          await commit(ctx, { message: 'tsgit sha256 init', author: AUTHOR });

          // Assert — real git reads the repository tsgit created from scratch.
          const config = await readFile(path.join(dir, '.git', 'config'), 'utf8');
          expect(config.indexOf('[extensions]')).toBe(0);
          expect(config.indexOf('[extensions]')).toBeLessThan(config.indexOf('[core]'));
          const shown = tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format']);
          expect(shown.exitCode).toBe(0);
          expect(shown.stdout.trim()).toBe('sha256');
          const logResult = tryRunGitWithExit(['-C', dir, 'log', '--format=%s']);
          expect(logResult.exitCode).toBe(0);
          expect(logResult.stdout).toContain('tsgit sha256 init');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('Given a fresh directory', () => {
    describe('When tsgit init runs with no objectFormat', () => {
      it('Then .git/config is byte-identical to the pre-existing default and real git agrees the format is sha1', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sha1-init-'));
        try {
          const ctx = createNodeContext({ workDir: dir });

          // Act
          await init(ctx);

          // Assert — no regression to the sha1 default path this PR must not touch.
          const config = await readFile(path.join(dir, '.git', 'config'), 'utf8');
          expect(config).toBe(
            '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
          );
          const shown = tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format']);
          expect(shown.exitCode).toBe(0);
          expect(shown.stdout.trim()).toBe('sha1');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    });
  });
});

// Stryker sets `STRYKER_MUTANT_ID` for every mutant run. The spawned
// `git-http-backend` CGI does not work reliably across the sandbox boundary;
// mutation kills for the negotiation logic live in the unit tests instead.
const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');
const GIT_HTTP_BACKEND = findGitHttpBackend();
const TRANSPORT_SKIP = RUNNING_UNDER_STRYKER || !GIT_AVAILABLE || GIT_HTTP_BACKEND === undefined;

const TRANSPORT_AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_100,
  timezoneOffset: '+0000',
};

interface TransportSource {
  readonly parentDir: string;
  readonly bareDir: string;
  readonly bareName: string;
  readonly headOid: string;
}

const gitInitArgs = (
  algorithm: 'sha1' | 'sha256',
  dir: string,
  bare: boolean,
): ReadonlyArray<string> => [
  'init',
  '-q',
  '-b',
  'main',
  ...(bare ? ['--bare'] : []),
  ...(algorithm === 'sha256' ? ['--object-format=sha256'] : []),
  dir,
];

/**
 * A real, bare git repository — served over HTTP by `startGitHttpBackend`
 * (via its parent dir) — holding one commit at `refs/heads/main`, of the
 * given hash algorithm. Seeding happens entirely on local disk (no HTTP
 * round trip), so the sync `runGit` helper is safe here.
 */
const createBareTransportSource = async (
  slug: string,
  algorithm: 'sha1' | 'sha256',
): Promise<TransportSource> => {
  const env = runGitEnv();
  const parentDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-transport-src-${slug}-`));
  const bareName = 'source.git';
  const bareDir = path.join(parentDir, bareName);
  runGit(gitInitArgs(algorithm, bareDir, true), { env });
  // git-http-backend refuses receive-pack (a WRITE service) unless the repo
  // opts in explicitly — GIT_HTTP_EXPORT_ALL only covers the read-only ones.
  runGit(['-C', bareDir, 'config', 'http.receivepack', 'true'], { env });
  const seedDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-transport-seed-${slug}-`));
  runGit(gitInitArgs(algorithm, seedDir, false), { env });
  runGit(['-C', seedDir, 'config', 'user.name', TRANSPORT_AUTHOR.name], { env });
  runGit(['-C', seedDir, 'config', 'user.email', TRANSPORT_AUTHOR.email], { env });
  await writeFile(path.join(seedDir, 'f.txt'), `${slug}\n`);
  runGit(['-C', seedDir, 'add', 'f.txt'], { env });
  runGit(['-C', seedDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', slug], { env });
  runGit(['-C', seedDir, 'remote', 'add', 'origin', bareDir], { env });
  runGit(['-C', seedDir, 'push', '-q', 'origin', 'main'], { env });
  const headOid = runGit(['-C', seedDir, 'rev-parse', 'HEAD'], { env }).trim();
  await rm(seedDir, { recursive: true, force: true });
  return { parentDir, bareDir, bareName, headOid };
};

interface TransportReceiver {
  readonly parentDir: string;
  readonly bareDir: string;
  readonly bareName: string;
}

/**
 * An EMPTY real, bare git receiver (no seeded commit) — used by the push
 * tests, distinct from `createBareTransportSource`: a receiver already
 * holding `refs/heads/main` would make the push a non-fast-forward against
 * unrelated history rather than exercising the object-format guard.
 */
const createBareTransportReceiver = async (
  slug: string,
  algorithm: 'sha1' | 'sha256',
): Promise<TransportReceiver> => {
  const env = runGitEnv();
  const parentDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-transport-recv-${slug}-`));
  const bareName = 'receiver.git';
  const bareDir = path.join(parentDir, bareName);
  runGit(gitInitArgs(algorithm, bareDir, true), { env });
  runGit(['-C', bareDir, 'config', 'http.receivepack', 'true'], { env });
  return { parentDir, bareDir, bareName };
};

/** A real (non-bare) local git repository of the given algorithm, no remote configured yet. */
const initLocalTransportRepo = async (
  slug: string,
  algorithm: 'sha1' | 'sha256',
): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-transport-local-${slug}-`));
  runGit(gitInitArgs(algorithm, dir, false), { env: runGitEnv() });
  return dir;
};

const localTransportContext = (dir: string, algorithm: 'sha1' | 'sha256'): Context =>
  algorithm === 'sha256'
    ? createNodeContext({ workDir: dir, algorithm: 'sha256', allowInsecureHttp: true })
    : createNodeContext({ workDir: dir, allowInsecureHttp: true });

/** Wraps `inner` to record every POSTed request body — the raw wire bytes tsgit sent. */
const recordingTransport = (
  inner: HttpTransport,
): { readonly transport: HttpTransport; readonly bodies: Uint8Array[] } => {
  const bodies: Uint8Array[] = [];
  return {
    bodies,
    transport: {
      request: async (req) => {
        if (req.method === 'POST' && req.body !== undefined) bodies.push(req.body);
        return inner.request(req);
      },
    },
  };
};

const anyRequestContains = (bodies: ReadonlyArray<Uint8Array>, needle: string): boolean => {
  const decoder = new TextDecoder();
  return bodies.some((body) => decoder.decode(body).includes(needle));
};

describe.skipIf(TRANSPORT_SKIP)('sha256 object format — transport negotiation and refusal', () => {
  describe.each([
    { legLabel: 'protocol v2', forwardGitProtocol: true },
    { legLabel: 'the v1 fallback', forwardGitProtocol: false },
  ])(
    'Given a sha256 local repository cloning a sha256 bare peer, over $legLabel, When clone runs',
    ({ forwardGitProtocol }) => {
      it("Then it succeeds, and the client's own request carries object-format=sha256 (its real algorithm, matching the real peer's own)", async () => {
        // Arrange — the peer is a REAL git repository, served by a REAL
        // git-http-backend; the request bytes are captured off the real wire.
        const source = await createBareTransportSource('clone-same-fmt', 'sha256');
        const server = await startGitHttpBackend({
          projectRoot: source.parentDir,
          forwardGitProtocol,
        });
        const cloneDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-transport-clone-dst-'));
        try {
          const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
          const baseCtx = createNodeContext({
            workDir: cloneDir,
            algorithm: 'sha256',
            allowInsecureHttp: true,
          });
          const recorded = recordingTransport(baseCtx.transport);
          const ctx = { ...baseCtx, transport: recorded.transport };

          // Act
          const result = await clone(ctx, { url });

          // Assert — the clone reaches the real peer's head, and our own
          // request echoed our own real algorithm.
          expect(result.fetchedRefs.some((r) => r.id === source.headOid)).toBe(true);
          expect(anyRequestContains(recorded.bodies, 'object-format=sha256')).toBe(true);
        } finally {
          await server.close();
          await rm(source.parentDir, { recursive: true, force: true });
          await rm(cloneDir, { recursive: true, force: true });
        }
      }, 60_000);
    },
  );

  describe('Given a sha1-default local repository (unconfigured) cloning a sha256 bare peer, When clone runs', () => {
    it("Then it adopts sha256 — the destination's config declares [extensions] before [core], every fetched ref is 64 hex, and real git reads the result", async () => {
      // Arrange — git's clone has no --object-format flag; the LOCAL context
      // is left at its library default (sha1, unconfigured) so the only way
      // it can end up sha256 is by learning it from the peer's advertisement.
      const source = await createBareTransportSource('clone-adopt', 'sha256');
      const server = await startGitHttpBackend({ projectRoot: source.parentDir });
      const cloneDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-transport-clone-adopt-'));
      try {
        const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
        const ctx = createNodeContext({ workDir: cloneDir, allowInsecureHttp: true });

        // Act
        const result = await clone(ctx, { url });

        // Assert — adopted format, on-disk block ordering, real git agrees.
        const config = await readFile(path.join(cloneDir, '.git', 'config'), 'utf8');
        expect(config.indexOf('[extensions]')).toBe(0);
        expect(config.indexOf('[extensions]')).toBeLessThan(config.indexOf('[core]'));
        expect(result.fetchedRefs.every((r) => r.id.length === 64)).toBe(true);
        const shown = tryRunGitWithExit(['-C', cloneDir, 'rev-parse', '--show-object-format']);
        expect(shown.exitCode).toBe(0);
        expect(shown.stdout.trim()).toBe('sha256');
        const fsckResult = tryRunGitWithExit(['-C', cloneDir, 'fsck']);
        expect(fsckResult.exitCode).toBe(0);
      } finally {
        await server.close();
        await rm(source.parentDir, { recursive: true, force: true });
        await rm(cloneDir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe('Given depth: 1 against a sha256 bare peer, When clone runs', () => {
    it('Then .git/shallow carries a 64-hex boundary line', async () => {
      // Arrange
      const source = await createBareTransportSource('clone-adopt-shallow', 'sha256');
      const server = await startGitHttpBackend({ projectRoot: source.parentDir });
      const cloneDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-transport-clone-shallow-'));
      try {
        const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
        const ctx = createNodeContext({ workDir: cloneDir, allowInsecureHttp: true });

        // Act
        await clone(ctx, { url, depth: 1 });

        // Assert
        const shallow = (await readFile(path.join(cloneDir, '.git', 'shallow'), 'utf8')).trim();
        expect(shallow).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await server.close();
        await rm(source.parentDir, { recursive: true, force: true });
        await rm(cloneDir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe('Given a sha256 local repository with a new commit and an EMPTY sha256 bare receiver, When push runs', () => {
    it('Then tsgit push succeeds over its v1-only wire and the receiver observes the new commit', async () => {
      // Arrange
      const receiver = await createBareTransportReceiver('push-same-fmt', 'sha256');
      const server = await startGitHttpBackend({ projectRoot: receiver.parentDir });
      const localDir = await initLocalTransportRepo('push-same-fmt', 'sha256');
      try {
        const url = `http://127.0.0.1:${server.port}/${receiver.bareName}`;
        // remote add BEFORE any command reads config — readConfig is cached
        // per-Context, so a later write would be invisible to `push`.
        runGit(['-C', localDir, 'remote', 'add', 'origin', url], { env: runGitEnv() });
        const ctx = localTransportContext(localDir, 'sha256');
        await writeFile(path.join(localDir, 'g.txt'), 'push\n');
        await add(ctx, ['g.txt']);
        await commit(ctx, { message: 'push commit', author: TRANSPORT_AUTHOR });

        // Act
        const result = await push(ctx, { remote: 'origin', refspecs: ['refs/heads/main'] });

        // Assert
        expect(result.pushedRefs[0]?.status).toBe('ok');
        const receiverHead = runGit(['-C', receiver.bareDir, 'rev-parse', 'refs/heads/main'], {
          env: runGitEnv(),
        }).trim();
        expect(receiverHead).toBe(result.pushedRefs[0]?.newId);
      } finally {
        await server.close();
        await rm(receiver.parentDir, { recursive: true, force: true });
        await rm(localDir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe.each([
    { legLabel: 'protocol v2', forwardGitProtocol: true },
    { legLabel: 'the v1 fallback', forwardGitProtocol: false },
  ])(
    'Given a sha1 local repository fetching from a sha256 bare peer, over $legLabel, When fetch negotiates',
    ({ forwardGitProtocol }) => {
      it("Then it refuses with UNSUPPORTED_OBJECT_FORMAT, format 'sha256' local 'sha1'", async () => {
        // Arrange
        const source = await createBareTransportSource('fetch-sha1-from-sha256', 'sha256');
        const server = await startGitHttpBackend({
          projectRoot: source.parentDir,
          forwardGitProtocol,
        });
        const localDir = await initLocalTransportRepo('fetch-sha1-from-sha256', 'sha1');
        try {
          const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
          runGit(['-C', localDir, 'remote', 'add', 'origin', url], { env: runGitEnv() });
          const ctx = localTransportContext(localDir, 'sha1');

          // Act
          let caught: unknown;
          try {
            await fetchCommand(ctx, { remote: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'UNSUPPORTED_OBJECT_FORMAT',
            format: 'sha256',
            local: 'sha1',
          });
        } finally {
          await server.close();
          await rm(source.parentDir, { recursive: true, force: true });
          await rm(localDir, { recursive: true, force: true });
        }
      }, 60_000);
    },
  );

  describe.each([
    { legLabel: 'protocol v2', forwardGitProtocol: true },
    { legLabel: 'the v1 fallback', forwardGitProtocol: false },
  ])(
    'Given a sha256 local repository fetching from a sha1 bare peer, over $legLabel, When fetch negotiates',
    ({ forwardGitProtocol }) => {
      it("Then it refuses with UNSUPPORTED_OBJECT_FORMAT, format 'sha1' local 'sha256'", async () => {
        // Arrange — the mirrored direction: local and peer swapped.
        const source = await createBareTransportSource('fetch-sha256-from-sha1', 'sha1');
        const server = await startGitHttpBackend({
          projectRoot: source.parentDir,
          forwardGitProtocol,
        });
        const localDir = await initLocalTransportRepo('fetch-sha256-from-sha1', 'sha256');
        try {
          const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
          runGit(['-C', localDir, 'remote', 'add', 'origin', url], { env: runGitEnv() });
          const ctx = localTransportContext(localDir, 'sha256');

          // Act
          let caught: unknown;
          try {
            await fetchCommand(ctx, { remote: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'UNSUPPORTED_OBJECT_FORMAT',
            format: 'sha1',
            local: 'sha256',
          });
        } finally {
          await server.close();
          await rm(source.parentDir, { recursive: true, force: true });
          await rm(localDir, { recursive: true, force: true });
        }
      }, 60_000);
    },
  );

  describe('Given a sha256 local repository with a new commit and an EMPTY sha1 bare receiver, When push runs', () => {
    it("Then tsgit push refuses with PUSH_OBJECT_FORMAT_UNSUPPORTED, local 'sha256' remote 'sha1' — the v1-only wire is the only leg push has, proving the refusal is reachable at all", async () => {
      // Arrange
      const receiver = await createBareTransportReceiver('push-mismatch', 'sha1');
      const server = await startGitHttpBackend({ projectRoot: receiver.parentDir });
      const localDir = await initLocalTransportRepo('push-mismatch', 'sha256');
      try {
        const url = `http://127.0.0.1:${server.port}/${receiver.bareName}`;
        // remote add BEFORE any command reads config — readConfig is cached
        // per-Context, so a later write would be invisible to `push`.
        runGit(['-C', localDir, 'remote', 'add', 'origin', url], { env: runGitEnv() });
        const ctx = localTransportContext(localDir, 'sha256');
        await writeFile(path.join(localDir, 'g.txt'), 'push\n');
        await add(ctx, ['g.txt']);
        await commit(ctx, { message: 'push commit', author: TRANSPORT_AUTHOR });

        // Act
        let caught: unknown;
        try {
          await push(ctx, { remote: 'origin', refspecs: ['refs/heads/main'] });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PUSH_OBJECT_FORMAT_UNSUPPORTED',
          local: 'sha256',
          remote: 'sha1',
        });
      } finally {
        await server.close();
        await rm(receiver.parentDir, { recursive: true, force: true });
        await rm(localDir, { recursive: true, force: true });
      }
    }, 60_000);
  });
});

const TRANSPORT_AUTHOR_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: TRANSPORT_AUTHOR.name,
  GIT_AUTHOR_EMAIL: TRANSPORT_AUTHOR.email,
  GIT_COMMITTER_NAME: TRANSPORT_AUTHOR.name,
  GIT_COMMITTER_EMAIL: TRANSPORT_AUTHOR.email,
};

/** A local, non-bare superproject with one empty commit, ready for `submoduleAdd`. */
const initLocalSuper = async (slug: string, algorithm: 'sha1' | 'sha256'): Promise<string> => {
  const dir = await initLocalTransportRepo(slug, algorithm);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'super seed'], {
    env: { ...runGitEnv(), ...TRANSPORT_AUTHOR_ENV },
  });
  return dir;
};

describe.skipIf(TRANSPORT_SKIP)(
  'sha256 object format — submodule add refuses across formats (R13)',
  () => {
    describe('Given a SHA-1 superproject adding a SHA-256 submodule remote, When submodule add runs', () => {
      it("Then it refuses SUBMODULE_OBJECT_FORMAT_MISMATCH (local 'sha1', remote 'sha256'), leaving the partial .git/modules/sub state behind — the clone has already happened", async () => {
        // Arrange
        const source = await createBareTransportSource('submodule-sha1-super', 'sha256');
        const server = await startGitHttpBackend({ projectRoot: source.parentDir });
        const superDir = await initLocalSuper('submodule-sha1-super', 'sha1');
        try {
          const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
          const ctx = localTransportContext(superDir, 'sha1');

          // Act
          let caught: unknown;
          try {
            await submoduleAdd(ctx, { url, path: 'sub' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH',
            local: 'sha1',
            remote: 'sha256',
          });
          expect(existsSync(path.join(superDir, '.git', 'modules', 'sub'))).toBe(true);
        } finally {
          await server.close();
          await rm(source.parentDir, { recursive: true, force: true });
          await rm(superDir, { recursive: true, force: true });
        }
      }, 60_000);
    });

    describe('Given a SHA-256 superproject adding a SHA-1 submodule remote, When submodule add runs', () => {
      it("Then it refuses SUBMODULE_OBJECT_FORMAT_MISMATCH (local 'sha256', remote 'sha1'), leaving the partial .git/modules/sub state behind — the mirrored direction", async () => {
        // Arrange
        const source = await createBareTransportSource('submodule-sha256-super', 'sha1');
        const server = await startGitHttpBackend({ projectRoot: source.parentDir });
        const superDir = await initLocalSuper('submodule-sha256-super', 'sha256');
        try {
          const url = `http://127.0.0.1:${server.port}/${source.bareName}`;
          const ctx = localTransportContext(superDir, 'sha256');

          // Act
          let caught: unknown;
          try {
            await submoduleAdd(ctx, { url, path: 'sub' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH',
            local: 'sha256',
            remote: 'sha1',
          });
          expect(existsSync(path.join(superDir, '.git', 'modules', 'sub'))).toBe(true);
        } finally {
          await server.close();
          await rm(source.parentDir, { recursive: true, force: true });
          await rm(superDir, { recursive: true, force: true });
        }
      }, 60_000);
    });
  },
);

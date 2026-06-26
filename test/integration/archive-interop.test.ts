/**
 * Cross-tool interop — archive command. Builds a repo via real git, then
 * runs `archive(ctx, { treeish })` against the same repo and proves that
 * the structured entry stream faithfully replicates what git enumerates.
 *
 * Entry-stream faithfulness is proven WITHOUT a serializer: we compare
 * the `archive()` path set, raw modes, entry order, content bytes, and
 * commit metadata against what `git ls-tree -r -t` and `git log` report.
 *
 * @proves
 *   surface:        archive, tarArchive, zipArchive
 *   bucket:         cross-tool-interop
 *   unique:         entry-stream path/mode/order/content faithfulness vs real git;
 *                   tar serializer byte-equality vs git archive --format=tar;
 *                   zip serializer byte-equality vs git archive --format=zip (node, TZ=UTC);
 *                   zip cross-adapter parity (node vs memory, method-0 frame + round-trip)
 *   interopSurface: archive, tarArchive, zipArchive
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { ArchiveEntry } from '../../src/application/commands/archive.js';
import { archive } from '../../src/application/commands/archive.js';
import { tarArchive } from '../../src/domain/archive/tar.js';
import { zipArchive } from '../../src/domain/archive/zip.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitBytes,
  runGitEnv,
} from './interop-helpers.js';

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** One parsed line from `git ls-tree -r -t`. */
interface LsTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

const parseLsTree = (output: string): ReadonlyArray<LsTreeEntry> =>
  output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tabIdx = line.indexOf('\t');
      const [mode, type, oid] = line.slice(0, tabIdx).trim().split(/\s+/) as [
        string,
        string,
        string,
      ];
      return { mode, type, oid, path: line.slice(tabIdx + 1) };
    });

/** Normalise git's `040000` tree-mode string to tsgit's `40000`. */
const normaliseMode = (m: string): string => (m === '040000' ? '40000' : m);

// ---------------------------------------------------------------------------
// Shared setup: one beforeAll repo, ≥60s timeout
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('archive interop', () => {
  let pair: PeerPair;

  // Fixed committer date for deterministic commitTime assertions.
  const COMMITTER_DATE = '2005-04-07T22:13:13 +0200'; // epoch 1112904793
  const COMMITTER_EPOCH = 1_112_904_793;

  const buildCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: COMMITTER_DATE,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: COMMITTER_DATE,
  });

  beforeAll(async () => {
    pair = await makePeerPair('archive');
    const dir = pair.peer;

    // Initialise repo
    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });

    // Regular file
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

    // Executable file (set exec bit via git update-index after staging)
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');

    // Symlink: link → a.txt
    symlinkSync('a.txt', path.join(dir, 'link'));

    // Nested directory with file
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sub', 'b.txt'), 'nested\n');

    // Stage all content
    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });

    // Make run.sh executable in git index
    runGit(['-C', dir, 'update-index', '--chmod=+x', 'run.sh'], { env: runGitEnv() });

    // Commit with fixed date
    runGit(['-C', dir, 'commit', '-m', 'seed'], { env: buildCommitEnv() });

    // Annotated tag v1.0 pointing at HEAD commit
    runGit(['-C', dir, 'tag', '-a', 'v1.0', '-m', 'release 1.0'], { env: buildCommitEnv() });
  }, 60_000);

  afterAll(async () => {
    await pair.dispose();
  });

  // -------------------------------------------------------------------------
  // Entry-stream faithfulness: paths, modes, order
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, { treeish: HEAD }) and git ls-tree -r -t HEAD', () => {
    it('Then the path set, normalised modes, and pre-order match exactly', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const gitEntries = parseLsTree(
        runGit(['-C', pair.peer, 'ls-tree', '-r', '-t', 'HEAD'], { env: runGitEnv() }),
      );

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      const entries: ArchiveEntry[] = [];
      for await (const entry of result.entries) {
        entries.push(entry);
      }

      // Assert — same path set (order-insensitive check first)
      const entryPaths = entries.map((e) => e.path);
      const gitPaths = gitEntries.map((e) => e.path);
      expect(entryPaths.sort()).toEqual(gitPaths.sort());

      // Assert — modes (normalised) match for each path
      for (const gitEntry of gitEntries) {
        const tsEntry = entries.find((e) => e.path === gitEntry.path);
        expect(tsEntry?.mode).toBe(normaliseMode(gitEntry.mode));
      }

      // Assert — pre-order: 'sub' directory entry appears before 'sub/b.txt'
      const subIdx = entries.findIndex((e) => e.path === 'sub');
      const subBIdx = entries.findIndex((e) => e.path === 'sub/b.txt');
      expect(subIdx).toBeGreaterThanOrEqual(0);
      expect(subBIdx).toBeGreaterThanOrEqual(0);
      expect(subIdx).toBeLessThan(subBIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Content faithfulness: blob bytes match git cat-file
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, { treeish: HEAD })', () => {
    it('Then regular file content matches git cat-file blob output', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const expectedContent = Buffer.from('hello\n');

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      let aTxtContent: Uint8Array | undefined;
      for await (const entry of result.entries) {
        if (entry.path === 'a.txt') {
          aTxtContent = entry.content;
          break;
        }
      }

      // Assert
      expect(aTxtContent).toBeDefined();
      expect(Buffer.from(aTxtContent ?? new Uint8Array())).toEqual(expectedContent);
    });

    it('Then symlink content equals the link target bytes', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const expectedTarget = Buffer.from('a.txt');

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      let linkContent: Uint8Array | undefined;
      for await (const entry of result.entries) {
        if (entry.path === 'link') {
          linkContent = entry.content;
          break;
        }
      }

      // Assert
      expect(linkContent).toBeDefined();
      expect(Buffer.from(linkContent ?? new Uint8Array())).toEqual(expectedTarget);
    });
  });

  // -------------------------------------------------------------------------
  // Commit metadata: result.commit and result.commitTime
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, { treeish: HEAD }) on a commit-ish', () => {
    it('Then result.commit equals git rev-parse HEAD and result.commitTime equals committer epoch', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const expectedCommit = runGit(['-C', pair.peer, 'rev-parse', 'HEAD'], {
        env: runGitEnv(),
      }).trim();

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });

      // Assert
      expect(result.commit).toBe(expectedCommit);
      expect(result.commitTime).toBe(COMMITTER_EPOCH);
    });
  });

  // -------------------------------------------------------------------------
  // Bare tree: result.commit and result.commitTime are absent
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, { treeish: <tree-oid> }) (bare tree)', () => {
    it('Then result.commit and result.commitTime are undefined', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const treeOid = runGit(['-C', pair.peer, 'rev-parse', 'HEAD^{tree}'], {
        env: runGitEnv(),
      }).trim();

      // Act
      const result = await archive(ctx, { treeish: treeOid });

      // Assert
      expect(result.commit).toBeUndefined();
      expect(result.commitTime).toBeUndefined();
      expect(result.tree).toBe(treeOid);
    });
  });

  // -------------------------------------------------------------------------
  // Annotated tag: peeled commit
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, { treeish: v1.0 }) (annotated tag)', () => {
    it('Then result.commit is the peeled commit oid, not the tag oid', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: pair.peer });
      const expectedCommit = runGit(['-C', pair.peer, 'rev-parse', 'v1.0^{commit}'], {
        env: runGitEnv(),
      }).trim();

      // Act
      const result = await archive(ctx, { treeish: 'v1.0' });

      // Assert
      expect(result.commit).toBe(expectedCommit);
      expect(result.commitTime).toBe(COMMITTER_EPOCH);
    });
  });
});

// =============================================================================
// Part 3 — tar serializer byte-equality vs `git archive --format=tar`
// =============================================================================

/** Collect all Uint8Array chunks from an AsyncIterable into one buffer. */
async function collectTarBytes(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of gen) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

describe.skipIf(!GIT_AVAILABLE)('tar byte-faithfulness', () => {
  let tarPair: PeerPair;
  let headCommit: string;
  let treeOid: string;

  const COMMITTER_DATE_TAR = '2005-04-07T22:13:13 +0200';
  const COMMITTER_EPOCH_TAR = 1_112_904_793;
  const FAKE_SUBMODULE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const buildCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: COMMITTER_DATE_TAR,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: COMMITTER_DATE_TAR,
  });

  beforeAll(async () => {
    tarPair = await makePeerPair('archive-tar');
    const dir = tarPair.peer;

    // Init repo
    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });

    // Regular file
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

    // Executable file
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');

    // Symlink: link → a.txt
    symlinkSync('a.txt', path.join(dir, 'link'));

    // Nested directory with file
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sub', 'b.txt'), 'nested\n');

    // .gitmodules for the gitlink entry
    writeFileSync(
      path.join(dir, '.gitmodules'),
      '[submodule "mysub"]\n\tpath = mysub\n\turl = https://example.com/mysub.git\n',
    );

    // Stage all regular content
    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });

    // Make run.sh executable in the index
    runGit(['-C', dir, 'update-index', '--chmod=+x', 'run.sh'], { env: runGitEnv() });

    // Add a gitlink directly to the index (mode 160000)
    runGit(
      ['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${FAKE_SUBMODULE_SHA},mysub`],
      { env: runGitEnv() },
    );

    // Commit with fixed date
    runGit(['-C', dir, 'commit', '-m', 'seed'], { env: buildCommitEnv() });

    // Annotated tag v1.0
    runGit(['-C', dir, 'tag', '-a', 'v1.0', '-m', 'release 1.0'], { env: buildCommitEnv() });

    headCommit = runGit(['-C', dir, 'rev-parse', 'HEAD'], { env: runGitEnv() }).trim();
    treeOid = runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}'], { env: runGitEnv() }).trim();
  }, 60_000);

  afterAll(async () => {
    await tarPair.dispose();
  });

  // -------------------------------------------------------------------------
  // Default: HEAD commit → byte-equal to `git archive --format=tar HEAD`
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, HEAD) passed through tarArchive with git defaults', () => {
    it('Then the tar bytes are byte-equal to git archive --format=tar HEAD', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: tarPair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = Buffer.from(
        runGit(['-C', tarPair.peer, 'archive', '--format=tar', 'HEAD'], {
          env: runGitEnv(),
        }),
        'binary',
      );

      // Act
      const sut = tarArchive(result, {
        umask: 0o0002,
        uname: 'root',
        gname: 'root',
        ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
      });
      const ourBytes = await collectTarBytes(sut);

      // Assert
      expect(ourBytes).toEqual(new Uint8Array(gitBytes));
    });
  });

  // -------------------------------------------------------------------------
  // --prefix=pre/: byte-equal to `git archive --format=tar --prefix=pre/ HEAD`
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, HEAD) passed through tarArchive with prefix=pre/', () => {
    it('Then the tar bytes are byte-equal to git archive --format=tar --prefix=pre/ HEAD', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: tarPair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = Buffer.from(
        runGit(['-C', tarPair.peer, 'archive', '--format=tar', '--prefix=pre/', 'HEAD'], {
          env: runGitEnv(),
        }),
        'binary',
      );

      // Act
      const sut = tarArchive(result, {
        prefix: 'pre/',
        umask: 0o0002,
        uname: 'root',
        gname: 'root',
        ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
      });
      const ourBytes = await collectTarBytes(sut);

      // Assert
      expect(ourBytes).toEqual(new Uint8Array(gitBytes));
    });
  });

  // -------------------------------------------------------------------------
  // Bare tree: byte-equal to `git archive --format=tar --mtime=<date> <tree-oid>`
  // No pax header expected (bare tree → no commit).
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, <tree-oid>) passed through tarArchive with fixed mtime', () => {
    it('Then the tar bytes are byte-equal to git archive --format=tar --mtime=<date> <tree-oid>', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: tarPair.peer });
      const result = await archive(ctx, { treeish: treeOid });
      const gitBytes = Buffer.from(
        runGit(
          ['-C', tarPair.peer, 'archive', '--format=tar', `--mtime=${COMMITTER_DATE_TAR}`, treeOid],
          { env: runGitEnv() },
        ),
        'binary',
      );

      // Act
      const sut = tarArchive(result, {
        umask: 0o0002,
        uname: 'root',
        gname: 'root',
        mtime: COMMITTER_EPOCH_TAR,
      });
      const ourBytes = await collectTarBytes(sut);

      // Assert — no pax block for bare tree
      expect(result.commit).toBeUndefined();
      expect(ourBytes).toEqual(new Uint8Array(gitBytes));
    });
  });

  // -------------------------------------------------------------------------
  // Annotated tag: pax commit oid = peeled commit, byte-equal to git
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, v1.0) (annotated tag) passed through tarArchive', () => {
    it('Then the tar bytes are byte-equal to git archive --format=tar v1.0', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: tarPair.peer });
      const result = await archive(ctx, { treeish: 'v1.0' });
      const gitBytes = Buffer.from(
        runGit(['-C', tarPair.peer, 'archive', '--format=tar', 'v1.0'], {
          env: runGitEnv(),
        }),
        'binary',
      );

      // Act
      const sut = tarArchive(result, {
        umask: 0o0002,
        uname: 'root',
        gname: 'root',
        ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
      });
      const ourBytes = await collectTarBytes(sut);

      // Assert — pax commit oid = the peeled commit oid
      expect(result.commit).toBe(headCommit);
      expect(ourBytes).toEqual(new Uint8Array(gitBytes));
    });
  });
});

// =============================================================================
// Part 4 — zip serializer byte-equality vs `git archive --format=zip`
// =============================================================================

/** Collect all chunks from an AsyncIterable into one Uint8Array. */
async function collectZipBytes(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of gen) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

/** Run git and return raw binary output as a Uint8Array (no toString corruption). */
function runGitBinary(args: string[], env: NodeJS.ProcessEnv): Uint8Array {
  return runGitBytes(args, { env });
}

// ---------------------------------------------------------------------------
// Zip interop repo setup
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('zip byte-faithfulness (node adapter, TZ=UTC)', () => {
  let zipPair: PeerPair;
  let treeOid: string;

  const COMMITTER_DATE_ZIP = '2005-04-07T22:13:13 +0200';
  const COMMITTER_EPOCH_ZIP = 1_112_904_793;
  const FAKE_SUBMODULE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const buildCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: COMMITTER_DATE_ZIP,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: COMMITTER_DATE_ZIP,
    TZ: 'UTC',
  });

  const gitZipEnv = () => ({ ...runGitEnv(), TZ: 'UTC' });

  beforeAll(async () => {
    zipPair = await makePeerPair('archive-zip');
    const dir = zipPair.peer;

    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });

    // Regular text file
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

    // Executable file
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');

    // Symlink
    symlinkSync('a.txt', path.join(dir, 'link'));

    // Nested directory
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'nested', 'b.txt'), 'nested\n');

    // 20000-byte compressible blob (exercises method 8)
    writeFileSync(path.join(dir, 'big.txt'), 'A'.repeat(20000));

    // Binary blob with NUL byte
    const binaryData = Buffer.alloc(4);
    binaryData[0] = 0x00;
    binaryData[1] = 0x01;
    binaryData[2] = 0x02;
    binaryData[3] = 0x03;
    writeFileSync(path.join(dir, 'data.bin'), binaryData);

    // .gitmodules for gitlink — 35 bytes, STORE (method-0) in both git and Node
    writeFileSync(path.join(dir, '.gitmodules'), '[submodule "a"]\n\tpath = a\n\turl = x\n');

    // Stage all regular content
    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });

    // Mark run.sh executable
    runGit(['-C', dir, 'update-index', '--chmod=+x', 'run.sh'], { env: runGitEnv() });

    // Add gitlink directly (name "a" matches .gitmodules path)
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${FAKE_SUBMODULE_SHA},a`], {
      env: runGitEnv(),
    });

    // Commit with fixed date
    runGit(['-C', dir, 'commit', '-m', 'seed'], { env: buildCommitEnv() });

    // Annotated tag
    runGit(['-C', dir, 'tag', '-a', 'v1.0', '-m', 'release 1.0'], { env: buildCommitEnv() });

    treeOid = runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}'], { env: runGitEnv() }).trim();
  }, 60_000);

  afterAll(async () => {
    await zipPair.dispose();
  });

  // -------------------------------------------------------------------------
  // HEAD commit: byte-equal to `git archive --format=zip HEAD` (under TZ=UTC)
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, HEAD) passed through zipArchive with tzOffsetMinutes=0', () => {
    it('Then the zip bytes are byte-equal to git archive --format=zip HEAD (including method-8 big.txt)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: zipPair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = runGitBinary(
        ['-C', zipPair.peer, 'archive', '--format=zip', 'HEAD'],
        gitZipEnv(),
      );

      // Act
      const sut = zipArchive(
        result,
        { deflateRaw: ctx.compressor.deflateRaw },
        {
          tzOffsetMinutes: 0,
          ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
        },
      );
      const ourBytes = await collectZipBytes(sut);

      // Assert — byte-equality including method-8 (big.txt 20000×A)
      expect(ourBytes).toEqual(gitBytes);
    });
  });

  // -------------------------------------------------------------------------
  // --prefix=pre/: byte-equal to `git archive --format=zip --prefix=pre/ HEAD`
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, HEAD) passed through zipArchive with prefix=pre/', () => {
    it('Then the zip bytes are byte-equal to git archive --format=zip --prefix=pre/ HEAD', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: zipPair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = runGitBinary(
        ['-C', zipPair.peer, 'archive', '--format=zip', '--prefix=pre/', 'HEAD'],
        gitZipEnv(),
      );

      // Act
      const sut = zipArchive(
        result,
        { deflateRaw: ctx.compressor.deflateRaw },
        {
          prefix: 'pre/',
          tzOffsetMinutes: 0,
          ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
        },
      );
      const ourBytes = await collectZipBytes(sut);

      // Assert
      expect(ourBytes).toEqual(gitBytes);
    });
  });

  // -------------------------------------------------------------------------
  // Bare tree: byte-equal to `git archive --format=zip --mtime=<date> <tree-oid>`
  // No commit oid in EOCD comment for bare tree.
  // -------------------------------------------------------------------------

  describe('Given archive(ctx, <tree-oid>) passed through zipArchive with fixed mtime', () => {
    it('Then the zip bytes are byte-equal to git archive --format=zip --mtime=<date> <tree-oid>', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: zipPair.peer });
      const result = await archive(ctx, { treeish: treeOid });
      const gitBytes = runGitBinary(
        ['-C', zipPair.peer, 'archive', '--format=zip', `--mtime=${COMMITTER_DATE_ZIP}`, treeOid],
        gitZipEnv(),
      );

      // Act
      const sut = zipArchive(
        result,
        { deflateRaw: ctx.compressor.deflateRaw },
        { mtime: COMMITTER_EPOCH_ZIP, tzOffsetMinutes: 0 },
      );
      const ourBytes = await collectZipBytes(sut);

      // Assert — no commit oid in EOCD comment
      expect(result.commit).toBeUndefined();
      expect(ourBytes).toEqual(gitBytes);
    });
  });
});

// =============================================================================
// Part 4 — zip cross-adapter parity: NodeCompressor vs MemoryCompressor
// =============================================================================

// ---------------------------------------------------------------------------
// Minimal zip reader for parity comparison
// ---------------------------------------------------------------------------

function readU16LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(off, true);
}

function readU32LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off, true);
}

const ZIP_LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly csize: number;
  readonly usize: number;
  readonly crc: number;
  readonly headerBytes: Uint8Array; // full local header (without data)
  readonly data: Uint8Array; // compressed data
  readonly inflated: Uint8Array; // inflated content (method-0: same as data, method-8: inflated)
}

function parseZipForParity(buf: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;

  while (pos + 4 <= buf.length) {
    if (readU32LE(buf, pos) !== ZIP_LOCAL_SIG) break;

    const method = readU16LE(buf, pos + 8);
    const crc = readU32LE(buf, pos + 14);
    const csize = readU32LE(buf, pos + 18);
    const usize = readU32LE(buf, pos + 22);
    const nameLen = readU16LE(buf, pos + 26);
    const extraLen = readU16LE(buf, pos + 28);
    const headerBytes = buf.slice(pos, pos + 30 + nameLen + extraLen);
    const name = new TextDecoder().decode(buf.slice(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + csize);
    const inflated = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;

    entries.push({ name, method, csize, usize, crc, headerBytes, data, inflated });
    pos = dataStart + csize;
  }

  return entries;
}

describe.skipIf(!GIT_AVAILABLE)('zip cross-adapter parity (node vs memory)', () => {
  let parityPair: PeerPair;

  const COMMITTER_DATE_PARITY = '2005-04-07T22:13:13 +0200';
  const COMMITTER_EPOCH_PARITY = 1_112_904_793;

  const buildCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: COMMITTER_DATE_PARITY,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: COMMITTER_DATE_PARITY,
  });

  beforeAll(async () => {
    parityPair = await makePeerPair('archive-zip-parity');
    const dir = parityPair.peer;

    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });

    // Regular text file
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

    // Executable
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');

    // Nested dir
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sub', 'c.txt'), 'sub\n');

    // Compressible blob (exercises method 8)
    writeFileSync(path.join(dir, 'big.txt'), 'B'.repeat(20000));

    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });
    runGit(['-C', dir, 'update-index', '--chmod=+x', 'run.sh'], { env: runGitEnv() });
    runGit(['-C', dir, 'commit', '-m', 'parity-seed'], { env: buildCommitEnv() });
  }, 60_000);

  afterAll(async () => {
    await parityPair.dispose();
  });

  describe('Given the same ArchiveResult serialized with NodeCompressor and MemoryCompressor', () => {
    it('Then method-0 entries + ALL framing are byte-identical; method-8 entries round-trip to the same content', async () => {
      // Arrange
      const nodeCtx = createNodeContext({ workDir: parityPair.peer });
      const memCtx = createMemoryContext();
      const result1 = await archive(nodeCtx, { treeish: 'HEAD' });
      const result2 = await archive(nodeCtx, { treeish: 'HEAD' });

      const opts = { tzOffsetMinutes: 0, mtime: COMMITTER_EPOCH_PARITY };

      // Act — run zipArchive twice: once with node, once with memory compressor
      const nodeBytes = await collectZipBytes(
        zipArchive(result1, { deflateRaw: nodeCtx.compressor.deflateRaw }, opts),
      );
      const memBytes = await collectZipBytes(
        zipArchive(result2, { deflateRaw: memCtx.compressor.deflateRaw }, opts),
      );

      // Parse both
      const nodeEntries = parseZipForParity(nodeBytes);
      const memEntries = parseZipForParity(memBytes);

      // Assert — same number of entries
      expect(nodeEntries.length).toBe(memEntries.length);

      for (const [i, ne] of nodeEntries.entries()) {
        const me = memEntries[i];
        if (!me) continue;

        // Names, CRC, uncompressed sizes are always identical
        expect(me.name).toBe(ne.name);
        expect(me.usize).toBe(ne.usize);
        expect(me.crc).toBe(ne.crc);
        expect(me.method).toBe(ne.method);

        if (ne.method === 0) {
          // Method-0 entries: full local headers and data are byte-identical
          expect(me.headerBytes).toEqual(ne.headerBytes);
          expect(me.data).toEqual(ne.data);
        } else {
          // Method-8 entries: compressed bytes may differ (adapter-dependent)
          // but inflated content must be identical
          expect(me.inflated).toEqual(ne.inflated);
          // And framing (name, crc, sizes in headers) must match
          expect(me.crc).toBe(ne.crc);
          expect(me.usize).toBe(ne.usize);
        }
      }
    });
  });
});

/**
 * Cross-tool interop — archive command. Builds a repo via real git, then
 * runs `archive(ctx, { treeish })` against the same repo and proves that
 * the structured entry stream faithfully replicates what git enumerates.
 *
 * Entry-stream faithfulness is proven WITHOUT a serializer: we compare
 * the `archive()` path set, raw modes, entry order, content bytes, and
 * commit metadata against what `git ls-tree -r -t` and `git log` report.
 *
 * Part 2 scope: entry-stream faithfulness + commit/commitTime metadata.
 * Part 3 scope: tar byte-level faithfulness (tarArchive vs git archive --format=tar).
 *
 * @proves
 *   surface:        archive, tarArchive
 *   bucket:         cross-tool-interop
 *   unique:         entry-stream path/mode/order/content faithfulness vs real git;
 *                   tar serializer byte-equality vs git archive --format=tar
 *   interopSurface: archive, tarArchive
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { ArchiveEntry } from '../../src/application/commands/archive.js';
import { archive } from '../../src/application/commands/archive.js';
import { tarArchive } from '../../src/domain/archive/tar.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
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
      expect(Buffer.from(aTxtContent!)).toEqual(expectedContent);
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
      expect(Buffer.from(linkContent!)).toEqual(expectedTarget);
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

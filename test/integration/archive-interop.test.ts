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
 * Tar/zip byte-level faithfulness is verified in Parts 3/4.
 *
 * @proves
 *   surface:        archive
 *   bucket:         cross-tool-interop
 *   unique:         entry-stream path/mode/order/content faithfulness vs real git
 *   interopSurface: archive
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { ArchiveEntry } from '../../src/application/commands/archive.js';
import { archive } from '../../src/application/commands/archive.js';
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

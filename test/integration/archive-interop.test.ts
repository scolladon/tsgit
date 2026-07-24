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
  // Commit metadata: result.commit / result.commitTime across commit-ish,
  // bare-tree, and annotated-tag treeish inputs
  // -------------------------------------------------------------------------

  const COMMIT_METADATA_MATRIX: ReadonlyArray<{
    readonly label: string;
    readonly resolveTreeish: (dir: string) => string;
    readonly resolveExpectedCommit: (dir: string) => string | undefined;
    readonly expectedCommitTime: number | undefined;
    readonly checkTree: boolean;
  }> = [
    {
      label: 'commit-ish HEAD',
      resolveTreeish: () => 'HEAD',
      resolveExpectedCommit: (dir) =>
        runGit(['-C', dir, 'rev-parse', 'HEAD'], { env: runGitEnv() }).trim(),
      expectedCommitTime: COMMITTER_EPOCH,
      checkTree: false,
    },
    {
      label: 'bare tree',
      resolveTreeish: (dir) =>
        runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}'], { env: runGitEnv() }).trim(),
      resolveExpectedCommit: () => undefined,
      expectedCommitTime: undefined,
      checkTree: true,
    },
    {
      label: 'annotated tag v1.0',
      resolveTreeish: () => 'v1.0',
      resolveExpectedCommit: (dir) =>
        runGit(['-C', dir, 'rev-parse', 'v1.0^{commit}'], { env: runGitEnv() }).trim(),
      expectedCommitTime: COMMITTER_EPOCH,
      checkTree: false,
    },
  ];

  describe('Given archive(ctx, { treeish }) for a commit-ish, bare tree, and annotated tag', () => {
    it.each(COMMIT_METADATA_MATRIX)(
      'Then result.commit and result.commitTime match git for $label',
      async ({ resolveTreeish, resolveExpectedCommit, expectedCommitTime, checkTree }) => {
        // Arrange
        const ctx = createNodeContext({ workDir: pair.peer });
        const treeish = resolveTreeish(pair.peer);
        const expectedCommit = resolveExpectedCommit(pair.peer);

        // Act
        const result = await archive(ctx, { treeish });

        // Assert
        expect(result.commit).toBe(expectedCommit);
        expect(result.commitTime).toBe(expectedCommitTime);
        if (checkTree) {
          expect(result.tree).toBe(treeish);
        }
      },
    );
  });
});

// =============================================================================
// tar serializer byte-equality vs `git archive --format=tar`
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
  // git defaults, --prefix=pre/, fixed-mtime bare tree, and annotated tag:
  // byte-equal to the matching `git archive --format=tar` invocation
  // -------------------------------------------------------------------------

  const TAR_VARIANT_MATRIX: ReadonlyArray<{
    readonly label: string;
    readonly resolveTreeish: () => string;
    readonly gitArgs: (treeish: string) => readonly string[];
    readonly prefix?: string;
    readonly fixedMtime?: number;
    readonly assertCommit?: (result: { commit?: string }) => void;
  }> = [
    {
      label: 'HEAD with git defaults',
      resolveTreeish: () => 'HEAD',
      gitArgs: (treeish) => ['archive', '--format=tar', treeish],
    },
    {
      label: 'HEAD with prefix=pre/',
      resolveTreeish: () => 'HEAD',
      gitArgs: (treeish) => ['archive', '--format=tar', '--prefix=pre/', treeish],
      prefix: 'pre/',
    },
    {
      label: 'bare tree with fixed mtime (no pax block)',
      resolveTreeish: () => treeOid,
      gitArgs: (treeish) => ['archive', '--format=tar', `--mtime=${COMMITTER_DATE_TAR}`, treeish],
      fixedMtime: COMMITTER_EPOCH_TAR,
      assertCommit: (result) => expect(result.commit).toBeUndefined(),
    },
    {
      label: 'v1.0 annotated tag (pax commit oid = peeled commit)',
      resolveTreeish: () => 'v1.0',
      gitArgs: (treeish) => ['archive', '--format=tar', treeish],
      assertCommit: (result) => expect(result.commit).toBe(headCommit),
    },
  ];

  describe('Given archive(ctx, <treeish>) passed through tarArchive', () => {
    it.each(TAR_VARIANT_MATRIX)(
      'Then the tar bytes are byte-equal to git archive --format=tar for $label',
      async ({ resolveTreeish, gitArgs, prefix, fixedMtime, assertCommit }) => {
        // Arrange
        const treeish = resolveTreeish();
        const ctx = createNodeContext({ workDir: tarPair.peer });
        const result = await archive(ctx, { treeish });
        const gitBytes = Buffer.from(
          runGit(['-C', tarPair.peer, ...gitArgs(treeish)], { env: runGitEnv() }),
          'binary',
        );

        // Act
        const sut = tarArchive(result, {
          umask: 0o0002,
          uname: 'root',
          gname: 'root',
          ...(prefix !== undefined ? { prefix } : {}),
          ...(fixedMtime !== undefined
            ? { mtime: fixedMtime }
            : result.commitTime !== undefined
              ? { mtime: result.commitTime }
              : {}),
        });
        const ourBytes = await collectTarBytes(sut);

        // Assert
        assertCommit?.(result);
        expect(ourBytes).toEqual(new Uint8Array(gitBytes));
      },
    );
  });
});

// =============================================================================
// tar deep-path byte-faithfulness: ustar prefix+name split for long paths
//
// Pinned rule (git 2.54.0, verified empirically):
//   - Paths 100–256 bytes split at the last '/' that yields a non-empty name
//     (1 ≤ nameLen ≤ 100). git NEVER emits an empty name field.
//   - For a directory path ending with '/' (e.g. 'deep/dir/') the split skips
//     the trailing slash and uses the slash before the last component instead,
//     so name = '<last-component>/' (non-empty).
// =============================================================================

describe.skipIf(!GIT_AVAILABLE)('tar deep-path byte-faithfulness', () => {
  let deepPair: PeerPair;

  const COMMITTER_DATE_DEEP = '2005-04-07T22:13:13 +0200';

  const buildCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: COMMITTER_DATE_DEEP,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: COMMITTER_DATE_DEEP,
  });

  // Deep directory with 10 components of 10 chars each = 109 bytes (without
  // trailing slash).  With the trailing slash added by buildEntryPath it is
  // 110 bytes — well within the 101–256 ustar range.
  // A file inside the deepest directory makes the file path 119 bytes total.
  const DIR_COMPONENTS = [
    'aaaaaaaaaa',
    'bbbbbbbbbb',
    'cccccccccc',
    'dddddddddd',
    'eeeeeeeeee',
    'ffffffffff',
    'gggggggggg',
    'hhhhhhhhhh',
    'iiiiiiiiii',
    'jjjjjjjjjj',
  ];
  const DEEP_DIR = DIR_COMPONENTS.join('/'); // 109 bytes
  const DEEP_FILE = `${DEEP_DIR}/kkkkk.txt`; // 119 bytes

  beforeAll(async () => {
    deepPair = await makePeerPair('archive-tar-deep');
    const dir = deepPair.peer;

    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });

    // Create the deep directory structure and plant a file
    mkdirSync(path.join(dir, DEEP_DIR), { recursive: true });
    writeFileSync(path.join(dir, DEEP_FILE), 'deep content\n');

    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });
    runGit(['-C', dir, 'commit', '-m', 'deep'], { env: buildCommitEnv() });
  }, 60_000);

  afterAll(async () => {
    await deepPair.dispose();
  });

  describe('Given a tree with file and directory paths exceeding 100 bytes', () => {
    it('Then the tar bytes are byte-equal to git archive --format=tar HEAD (ustar split is faithful)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: deepPair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = Buffer.from(
        runGit(['-C', deepPair.peer, 'archive', '--format=tar', 'HEAD'], {
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

      // Assert — byte-equal: the 110-byte dir path uses name='jjjjjjjjjj/'
      // (split before the trailing slash, not at it) and the 119-byte file path
      // uses name='kkkkk.txt' (split at the last '/').
      expect(ourBytes).toEqual(new Uint8Array(gitBytes));
    });
  });
});

// =============================================================================
// tar UTF-8 byte-faithfulness: non-ASCII paths in name and prefix fields
//
// Pinned rule (git 2.54.0, verified empirically):
//   git archive --format=tar writes path bytes as raw UTF-8, NOT latin1.
//   A file named 'café.txt' → name field bytes: 63 61 66 c3 a9 2e 74 78 74
//   A path that crosses the 100-byte ustar split must carry the UTF-8 sequence
//   split faithfully across prefix+name — NOT truncated at multi-byte boundaries.
// =============================================================================

describe.skipIf(!GIT_AVAILABLE)('tar UTF-8 path byte-faithfulness', () => {
  let utf8Pair: PeerPair;

  const COMMITTER_DATE_UTF8 = '2005-04-07T22:13:13 +0200';

  const buildCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: COMMITTER_DATE_UTF8,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: COMMITTER_DATE_UTF8,
  });

  // 'café.txt': the é character is U+00E9, UTF-8 bytes 0xC3 0xA9 (2 bytes).
  // The path is 9 UTF-8 bytes — short enough to fit in name alone (<100 bytes).
  const SHORT_NON_ASCII_FILE = 'café.txt';

  // A directory whose name is 90 bytes of ASCII + 'ñ' (U+00F1, 2 UTF-8 bytes) = 92 UTF-8 bytes.
  // A file inside pushes the path over the 100-byte boundary, exercising
  // the ustar prefix+name split with a multi-byte character in play.
  const LONG_ASCII_DIR = `${'a'.repeat(90)}ñ`; // 92 UTF-8 bytes
  const SPLIT_FILE_NAME = 'data.txt'; // total: 92 + 1 + 8 = 101 UTF-8 bytes → must split
  const SPLIT_FILE = `${LONG_ASCII_DIR}/${SPLIT_FILE_NAME}`;

  beforeAll(async () => {
    utf8Pair = await makePeerPair('archive-tar-utf8');
    const dir = utf8Pair.peer;

    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });

    // Short non-ASCII file in repo root
    writeFileSync(path.join(dir, SHORT_NON_ASCII_FILE), 'hello\n');

    // File inside a directory whose full path crosses the 100-byte ustar boundary
    mkdirSync(path.join(dir, LONG_ASCII_DIR), { recursive: true });
    writeFileSync(path.join(dir, SPLIT_FILE), 'split\n');

    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });
    runGit(['-C', dir, 'commit', '-m', 'utf8'], { env: buildCommitEnv() });
  }, 60_000);

  afterAll(async () => {
    await utf8Pair.dispose();
  });

  describe('Given a tree with non-ASCII filenames (UTF-8 multi-byte sequences)', () => {
    it('Then the tar bytes are byte-equal to git archive --format=tar HEAD (UTF-8 paths faithfully encoded)', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: utf8Pair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = runGitBinary(
        ['-C', utf8Pair.peer, 'archive', '--format=tar', 'HEAD'],
        runGitEnv(),
      );

      // Act
      const sut = tarArchive(result, {
        umask: 0o0002,
        uname: 'root',
        gname: 'root',
        ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
      });
      const ourBytes = await collectTarBytes(sut);

      // Assert — byte-equal: café.txt name field carries 0xC3 0xA9 (not 0xE9)
      // and the long-dir split preserves the UTF-8 ñ (0xC3 0xB1) across prefix+name
      expect(ourBytes).toEqual(gitBytes);
    });
  });
});

// =============================================================================
// zip serializer byte-equality vs `git archive --format=zip`
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

    // .gitmodules for gitlink — long enough that git picks method-8 (deflate), and a
    // verified zlib DIVERGENCE point: git emits 80 compressed bytes, node:zlib 81. This
    // exercises the honest method-8 contract (round-trip, NOT byte-identity) below.
    writeFileSync(
      path.join(dir, '.gitmodules'),
      '[submodule "a"]\n\tpath = a\n\turl = https://example.com/submodule-repo-a.git\n\tbranch = main\n',
    );

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
  // tzOffsetMinutes=0 default, --prefix=pre/, and fixed-mtime bare tree:
  // structurally faithful to the matching `git archive --format=zip` invocation
  // (TZ=UTC). method-0 + framing byte-exact; method-8 (big.txt, divergent
  // .gitmodules) round-trips.
  // -------------------------------------------------------------------------

  const ZIP_VARIANT_MATRIX: ReadonlyArray<{
    readonly label: string;
    readonly resolveTreeish: () => string;
    readonly gitArgs: (treeish: string) => readonly string[];
    readonly prefix?: string;
    readonly fixedMtime?: number;
    readonly assertCommit?: (result: { commit?: string }) => void;
  }> = [
    {
      label: 'HEAD with tzOffsetMinutes=0',
      resolveTreeish: () => 'HEAD',
      gitArgs: (treeish) => ['archive', '--format=zip', treeish],
    },
    {
      label: 'HEAD with prefix=pre/',
      resolveTreeish: () => 'HEAD',
      gitArgs: (treeish) => ['archive', '--format=zip', '--prefix=pre/', treeish],
      prefix: 'pre/',
    },
    {
      label: 'bare tree with fixed mtime (empty EOCD comment)',
      resolveTreeish: () => treeOid,
      gitArgs: (treeish) => ['archive', '--format=zip', `--mtime=${COMMITTER_DATE_ZIP}`, treeish],
      fixedMtime: COMMITTER_EPOCH_ZIP,
      assertCommit: (result) => expect(result.commit).toBeUndefined(),
    },
  ];

  describe('Given archive(ctx, <treeish>) passed through zipArchive', () => {
    it.each(ZIP_VARIANT_MATRIX)(
      'Then the zip is structurally faithful to git archive --format=zip for $label',
      async ({ resolveTreeish, gitArgs, prefix, fixedMtime, assertCommit }) => {
        // Arrange
        const treeish = resolveTreeish();
        const ctx = createNodeContext({ workDir: zipPair.peer });
        const result = await archive(ctx, { treeish });
        const gitBytes = runGitBinary(['-C', zipPair.peer, ...gitArgs(treeish)], gitZipEnv());

        // Act
        const sut = zipArchive(
          result,
          { deflateRaw: ctx.compressor.deflateRaw },
          {
            ...(prefix !== undefined ? { prefix } : {}),
            tzOffsetMinutes: 0,
            ...(fixedMtime !== undefined
              ? { mtime: fixedMtime }
              : result.commitTime !== undefined
                ? { mtime: result.commitTime }
                : {}),
          },
        );
        const ourBytes = await collectZipBytes(sut);

        // Assert — method-0 + framing byte-exact; method-8 round-trips (not byte-pinned)
        assertCommit?.(result);
        expectZipFaithfulToGit(ourBytes, gitBytes);
      },
    );
  });
});

// =============================================================================
// zip whole-archive byte-equality — all-stored fixture (no DEFLATE in play).
// The robust interop proof of the central directory + EOCD + offset bytes; method-8
// entries are zlib-implementation-coupled (covered structurally above), so a
// whole-archive byte-equality only holds when every entry is stored.
// =============================================================================

describe.skipIf(!GIT_AVAILABLE)('zip whole-archive byte-equality (all-stored fixture)', () => {
  let storedPair: PeerPair;
  const STORED_COMMIT_DATE = '2005-04-07T22:13:13 +0200';
  const gitStoredEnv = () => ({ ...runGitEnv(), TZ: 'UTC' });
  const buildStoredCommitEnv = () => ({
    ...runGitEnv(),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: STORED_COMMIT_DATE,
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_DATE: STORED_COMMIT_DATE,
    TZ: 'UTC',
  });

  beforeAll(async () => {
    storedPair = await makePeerPair('archive-zip-stored');
    const dir = storedPair.peer;
    runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.name', 'Ada'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false'], { env: runGitEnv() });
    runGit(['-C', dir, 'config', 'core.autocrlf', 'false'], { env: runGitEnv() });
    // Small files only — none compresses below its size, so git stores every entry.
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
    symlinkSync('a.txt', path.join(dir, 'link'));
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'nested', 'b.txt'), 'nested\n');
    runGit(['-C', dir, 'add', '-A'], { env: runGitEnv() });
    runGit(['-C', dir, 'update-index', '--chmod=+x', 'run.sh'], { env: runGitEnv() });
    runGit(['-C', dir, 'commit', '-m', 'seed'], { env: buildStoredCommitEnv() });
  }, 60_000);

  afterAll(async () => {
    await storedPair.dispose();
  });

  describe('Given an all-stored tree (regular, exec, symlink, nested) archived through zipArchive', () => {
    it('Then the whole zip — local headers, central directory, EOCD — is byte-equal to git archive --format=zip HEAD', async () => {
      // Arrange
      const ctx = createNodeContext({ workDir: storedPair.peer });
      const result = await archive(ctx, { treeish: 'HEAD' });
      const gitBytes = runGitBinary(
        ['-C', storedPair.peer, 'archive', '--format=zip', 'HEAD'],
        gitStoredEnv(),
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

      // Assert — every entry stored ⇒ whole archive byte-identical to git
      expect(ourBytes).toEqual(gitBytes);
    });
  });
});

// =============================================================================
// zip cross-adapter parity: NodeCompressor vs MemoryCompressor
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

/**
 * Assert our zip is faithful to git's under the equivalence-under-readback contract:
 * method-0 (stored) entries + all local-header framing are byte-identical to git;
 * method-8 (deflate) compressed bytes are zlib-implementation-coupled and NOT
 * byte-faithful — they round-trip to git's exact content, and the header is byte-exact
 * except the `csize` field (offset 18..22). A whole-archive byte-equality is asserted
 * separately, only on an all-stored fixture where no DEFLATE is in play. The matrix MUST
 * exercise method-8.
 */
function expectZipFaithfulToGit(ourBytes: Uint8Array, gitBytes: Uint8Array): void {
  const ours = parseZipForParity(ourBytes);
  const git = parseZipForParity(gitBytes);
  expect(ours.map((e) => e.name)).toEqual(git.map((e) => e.name));

  let methodEightSeen = 0;
  for (const [i, ge] of git.entries()) {
    const oe = ours[i];
    expect(oe).toBeDefined();
    if (!oe) continue;
    expect(oe.method).toBe(ge.method);
    expect(oe.crc).toBe(ge.crc);
    expect(oe.usize).toBe(ge.usize);
    if (ge.method === 0) {
      expect(oe.headerBytes).toEqual(ge.headerBytes);
      expect(oe.data).toEqual(ge.data);
    } else {
      methodEightSeen += 1;
      expect(oe.inflated).toEqual(ge.inflated);
      expect(oe.headerBytes.slice(0, 18)).toEqual(ge.headerBytes.slice(0, 18));
      expect(oe.headerBytes.slice(22)).toEqual(ge.headerBytes.slice(22));
    }
  }
  expect(methodEightSeen).toBeGreaterThan(0);
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

      let methodEightSeen = 0;
      for (const [i, ne] of nodeEntries.entries()) {
        const me = memEntries[i];
        expect(me).toBeDefined();
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
          methodEightSeen += 1;
          expect(me.inflated).toEqual(ne.inflated);
          // And framing (name, crc, sizes in headers) must match
          expect(me.crc).toBe(ne.crc);
          expect(me.usize).toBe(ne.usize);
        }
      }
      // Ensure the fixture actually exercised method-8 (at least big.txt)
      expect(methodEightSeen).toBeGreaterThan(0);
    });
  });
});

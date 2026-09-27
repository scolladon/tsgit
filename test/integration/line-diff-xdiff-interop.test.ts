/**
 * Cross-tool interop — xdiff change compaction with the indent heuristic.
 *
 * Pins tsgit's `compactChanges` against real `git diff --no-ext-diff
 * --no-index` (indent heuristic explicitly on, git's own default) on the
 * design's smallest patch-slide row (L5) and its C-function-block variant
 * (L5', git's own `t4061-diff-indent.sh` fixture), then follows the same
 * hunk placement through blame, three-way merge (clean and conflicting) and
 * patch-id, each checked against the matching real-git command.
 *
 * @proves
 *   surface: diff.lineDiff
 *   bucket:  cross-tool-interop
 *   unique:  xdl_change_compact's slid hunk placement matches git across patch, blame, merge and patch-id
 *   interopSurface: diff
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { blame } from '../../src/application/commands/blame.js';
import { computePatchId } from '../../src/application/primitives/patch-id.js';
import { computeHunks, type OutputHunk } from '../../src/domain/diff/patch-serializer.js';
import { mergeContent } from '../../src/domain/merge/three-way-content.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CONTEXT_LINES = 3;

function hunkText(hunk: OutputHunk): string[] {
  const oldRange = hunk.oldLen === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLen}`;
  const newRange = hunk.newLen === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLen}`;
  const prefixOf = { context: ' ', delete: '-', insert: '+' } as const;
  const body = hunk.body.map((line) => `${prefixOf[line.kind]}${line.text}`);
  return [`@@ -${oldRange} +${newRange} @@`, ...body];
}

/** The `@@ ...` hunk lines onward from a real `git diff` invocation — drops
 *  the `diff --git`/`index`/`---`/`+++` header this test does not pin. */
function hunkLinesFromGitDiff(patch: string): string[] {
  const lines = patch.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@'));
  return lines.slice(start, lines.length - 1);
}

function tsgitHunkLines(oldBytes: Uint8Array, newBytes: Uint8Array): string[] {
  return computeHunks(oldBytes, newBytes, CONTEXT_LINES).flatMap(hunkText);
}

function gitDiffNoIndex(oldPath: string, newPath: string): string {
  const result = tryRunGitWithExit([
    '-c',
    'diff.indentHeuristic=true',
    'diff',
    '--no-ext-diff',
    '--no-index',
    `-U${CONTEXT_LINES}`,
    oldPath,
    newPath,
  ]);
  return result.stdout;
}

async function writePair(
  slug: string,
  oldText: string,
  newText: string,
): Promise<[string, string]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-xdl-compact-${slug}-`));
  const oldPath = path.join(dir, 'old.txt');
  const newPath = path.join(dir, 'new.txt');
  await writeFile(oldPath, oldText);
  await writeFile(newPath, newText);
  return [oldPath, newPath];
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function shasByFinalLine(porcelain: string): string[] {
  const shas: string[] = [];
  for (const line of porcelain.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header !== null) shas[Number(header[2]) - 1] = header[1]!;
  }
  return shas;
}

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

async function commitFile(
  dir: string,
  file: string,
  content: string,
  epoch: number,
): Promise<string> {
  await writeFile(path.join(dir, file), content);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', `edit ${file}`], { env: datedEnv(epoch) });
  return git(dir, 'rev-parse', 'HEAD').trim();
}

async function makeRepo(slug: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-xdl-compact-${slug}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  return dir;
}

async function gitMergeFile(
  slug: string,
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
): Promise<{ readonly stdout: string; readonly exitCode: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-xdl-compact-merge-${slug}-`));
  const basePath = path.join(dir, 'base.txt');
  const oursPath = path.join(dir, 'ours.txt');
  const theirsPath = path.join(dir, 'theirs.txt');
  await writeFile(basePath, base);
  await writeFile(oursPath, ours);
  await writeFile(theirsPath, theirs);
  return tryRunGitWithExit([
    'merge-file',
    '-p',
    '-L',
    'ours',
    '-L',
    'base',
    '-L',
    'theirs',
    oursPath,
    basePath,
    theirsPath,
  ]);
}

async function makePatchIdRepo(
  slug: string,
  unrelatedContent: string,
): Promise<{ readonly dir: string; readonly commit: string }> {
  const dir = await makeRepo(`patch-id-${slug}`);
  await writeFile(path.join(dir, 'keep.txt'), unrelatedContent);
  await commitFile(dir, 'file.txt', L5_OLD, 1_700_000_000);
  const commit = await commitFile(dir, 'file.txt', L5_NEW, 1_700_000_060);
  return { dir, commit };
}

function gitPatchId(dir: string, commit: string): string {
  const shown = git(dir, 'show', commit);
  const result = tryRunGitWithExit(['patch-id', '--stable'], { input: shown });
  return result.stdout.split(' ')[0] ?? '';
}

const L5_OLD = 'a\nb\nc\nd\ne\n';
const L5_NEW = 'a\nb\nc\nX\nd\nc\nd\ne\n';

const FUNCTIONS_OLD = '1\n2\n/* function */\nfoo() {\n    foo\n}\n\n3\n4\n';
const FUNCTIONS_NEW =
  '1\n2\n/* function */\nbar() {\n    foo\n}\n\n/* function */\nfoo() {\n    foo\n}\n\n3\n4\n';

describe.skipIf(!GIT_AVAILABLE)('xdiff compaction interop', () => {
  describe('Given the L5 patch-slide row (a b c d e / a b c X d c d e)', () => {
    describe('When computeHunks and git diff --no-index run on the same bytes', () => {
      it('Then the hunk body matches byte-for-byte', async () => {
        // Arrange
        const [oldPath, newPath] = await writePair('l5', L5_OLD, L5_NEW);

        // Act
        const gitLines = hunkLinesFromGitDiff(gitDiffNoIndex(oldPath, newPath));
        const tsgitLines = tsgitHunkLines(enc(L5_OLD), enc(L5_NEW));

        // Assert
        expect(tsgitLines).toEqual(gitLines);
        expect(tsgitLines).toEqual([
          '@@ -1,5 +1,8 @@',
          ' a',
          ' b',
          ' c',
          '+X',
          '+d',
          '+c',
          ' d',
          ' e',
        ]);
      });
    });
  });

  describe("Given the L5' C-function-block row (git's t4061 functions.c fixture)", () => {
    describe('When computeHunks and git diff --no-index run on the same bytes', () => {
      it('Then the indent-heuristic-slid hunk body matches byte-for-byte', async () => {
        // Arrange
        const [oldPath, newPath] = await writePair('l5-prime', FUNCTIONS_OLD, FUNCTIONS_NEW);

        // Act
        const gitLines = hunkLinesFromGitDiff(gitDiffNoIndex(oldPath, newPath));
        const tsgitLines = tsgitHunkLines(enc(FUNCTIONS_OLD), enc(FUNCTIONS_NEW));

        // Assert
        expect(tsgitLines).toEqual(gitLines);
      });
    });
  });

  describe('Given a repository whose HEAD introduces the L5 diff over one commit', () => {
    describe('When blame walks the two commits', () => {
      it('Then every final line is attributed to the same commit as git blame --porcelain', async () => {
        // Arrange
        const dir = await makeRepo('blame');
        const commit1 = await commitFile(dir, 'file.txt', L5_OLD, 1_700_000_000);
        const commit2 = await commitFile(dir, 'file.txt', L5_NEW, 1_700_000_060);

        // Act
        const ctx = createNodeContext({ workDir: dir });
        const result = await blame(ctx, 'file.txt');
        const tsgitShas = result.lines.map((line) => (line.committed ? line.commit : ''));
        const porcelain = git(dir, 'blame', '--porcelain', 'HEAD', '--', 'file.txt');
        const gitShas = shasByFinalLine(porcelain);

        // Assert
        expect(tsgitShas).toEqual(gitShas);
        // The compacted region (X, d, c) belongs to the second commit; the
        // rest (including the re-matched trailing d, e) stays with the first.
        expect(tsgitShas).toEqual([
          commit1,
          commit1,
          commit1,
          commit2,
          commit2,
          commit2,
          commit1,
          commit1,
        ]);
      });
    });
  });

  describe('Given a three-way merge whose ours side is the L5 diff', () => {
    describe('When theirs changes a disjoint line (the trailing e)', () => {
      it('Then the merge is clean and matches git merge-file -p byte-for-byte', async () => {
        // Arrange
        const base = enc(L5_OLD);
        const ours = enc(L5_NEW);
        const theirs = enc('a\nb\nc\nd\nE\n');

        // Act
        const result = mergeContent(base, ours, theirs);
        const gitResult = await gitMergeFile('clean', base, ours, theirs);

        // Assert
        expect(result.status).toBe('clean');
        expect(result.status === 'clean' ? decode(result.bytes) : '').toBe(gitResult.stdout);
        expect(gitResult.exitCode).toBe(0);
      });
    });

    describe('When theirs inserts a line touching the same region ours changed', () => {
      it('Then the merge conflicts and matches git merge-file -p byte-for-byte', async () => {
        // Arrange
        const base = enc(L5_OLD);
        const ours = enc(L5_NEW);
        const theirs = enc('a\nb\nc\nY\nd\ne\n');

        // Act
        const result = mergeContent(base, ours, theirs);
        const gitResult = await gitMergeFile('conflict', base, ours, theirs);

        // Assert
        expect(result.status).toBe('conflict');
        expect(result.status === 'conflict' ? decode(result.markedBytes) : '').toBe(
          gitResult.stdout,
        );
        expect(gitResult.exitCode).toBe(1);
      });
    });
  });

  describe('Given two commits that introduce the identical L5 diff over unrelated bases', () => {
    describe('When computePatchId runs on each', () => {
      it('Then both collide, matching git patch-id --stable’s own equivalence classing', async () => {
        // Arrange — patch-id is an internal equivalence key (never persisted
        // or hex-compared with git's own), so what is pinned here is that
        // the two commits fall in the same class under BOTH tools.
        const repoA = await makePatchIdRepo('a', '1');
        const repoB = await makePatchIdRepo('b', '2');
        const gitIdA = gitPatchId(repoA.dir, repoA.commit);
        const gitIdB = gitPatchId(repoB.dir, repoB.commit);

        // Act
        const ctxA = createNodeContext({ workDir: repoA.dir });
        const ctxB = createNodeContext({ workDir: repoB.dir });
        const idA = await computePatchId(ctxA, repoA.commit as ObjectId);
        const idB = await computePatchId(ctxB, repoB.commit as ObjectId);

        // Assert — git agrees the two commits are patch-id equivalent...
        expect(gitIdA).toBe(gitIdB);
        // ...and so does tsgit
        expect(idA).toBe(idB);
      });
    });
  });
});

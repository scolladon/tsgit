/**
 * Cross-tool interop — xdiff change compaction with the indent heuristic,
 * and (below) the divide-and-conquer split engine that replaced the bounded
 * Myers trace's whole-file bail.
 *
 * Pins tsgit's `compactChanges` against real `git diff --no-ext-diff
 * --no-index` (indent heuristic explicitly on, git's own default) on the
 * design's smallest patch-slide row (L5) and its C-function-block variant
 * (L5', git's own `t4061-diff-indent.sh` fixture), then follows the same
 * hunk placement through blame, three-way merge (clean and conflicting) and
 * patch-id, each checked against the matching real-git command.
 *
 * The split-engine rows below pin numstat, patch text, blame and merge on
 * inputs whose true edit distance sits past the old (now-removed) 10 000-edit
 * bail, so the engine that replaces it is checked against live git rather
 * than against tsgit's own former behaviour.
 *
 * @proves
 *   surface: diff.lineDiff
 *   bucket:  cross-tool-interop
 *   unique:  xdl_change_compact's slid hunk placement AND the xdiff split engine's counts/patch/blame/merge match git past the old edit-distance bail
 *   interopSurface: diff
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { blame } from '../../src/application/commands/blame.js';
import { diff } from '../../src/application/commands/diff.js';
import { computePatchId } from '../../src/application/primitives/patch-id.js';
import type { StatTreeDiff } from '../../src/domain/diff/index.js';
import { computeHunks, type OutputHunk } from '../../src/domain/diff/patch-serializer.js';
import { computeStatFields } from '../../src/domain/diff/stat-fields.js';
import { mergeContent } from '../../src/domain/merge/three-way-content.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CONTEXT_LINES = 3;

// Every mkdtemp root this file creates (writePair/makeRepo/gitMergeFile) is
// tracked here and removed in the module-level afterAll below.
const createdDirs: string[] = [];

function hunkText(hunk: OutputHunk): string[] {
  const oldRange = hunk.oldLen === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLen}`;
  const newRange = hunk.newLen === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLen}`;
  const prefixOf = { context: ' ', delete: '-', insert: '+' } as const;
  const body = hunk.body.map((line) => `${prefixOf[line.kind]}${line.text}`);
  return [`@@ -${oldRange} +${newRange} @@`, ...body];
}

/** git optionally appends a function-context hint after the closing `@@` on
 *  a hunk header (`@@ -a,b +c,d @@ funcname`) — display text tsgit's
 *  structured hunks never compute, so only the range portion is comparable. */
function stripHunkFuncContext(line: string): string {
  return line.startsWith('@@') ? line.replace(/^(@@ -\S+ \+\S+ @@).*$/, '$1') : line;
}

/** The `@@ ...` hunk lines onward from a real `git diff` invocation — drops
 *  the `diff --git`/`index`/`---`/`+++` header this test does not pin. */
function hunkLinesFromGitDiff(patch: string): string[] {
  const lines = patch.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@'));
  return lines.slice(start, lines.length - 1).map(stripHunkFuncContext);
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
  createdDirs.push(dir);
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
  createdDirs.push(dir);
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
  createdDirs.push(dir);
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

// FF (0x0c) rows: get_indent's XDL_ISSPACE class is SP/TAB/CR/LF only, so an
// FF-only line reports indent -1 (blank), same as an empty line — never a
// literal indent of 1. A get_indent that also counted FF as space would find
// FF at a *positive* index and stop there, misreporting the surrounding
// blank-run scan and sliding the group to the wrong line.
const FF_SLIDE_OLD = 'x\n  y\n\f\n  z\n';
const FF_SLIDE_NEW = 'x\n  y\n\f\n  q\n  y\n\f\n  z\n';
const FF_BRACE_OLD = '{\n\f\n}\n';
const FF_BRACE_NEW = '{\n\f\n  k\n\f\n}\n';

afterAll(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  describe('Given a form-feed line bracketing an insertion (get_indent’s XDL_ISSPACE class)', () => {
    describe('When computeHunks and git diff --no-index run on the same bytes', () => {
      it('Then the indent-heuristic-slid hunk body matches byte-for-byte', async () => {
        // Arrange
        const [oldPath, newPath] = await writePair('ff-slide', FF_SLIDE_OLD, FF_SLIDE_NEW);

        // Act
        const gitLines = hunkLinesFromGitDiff(gitDiffNoIndex(oldPath, newPath));
        const tsgitLines = tsgitHunkLines(enc(FF_SLIDE_OLD), enc(FF_SLIDE_NEW));

        // Assert
        expect(tsgitLines).toEqual(gitLines);
        expect(tsgitLines).toEqual([
          '@@ -1,4 +1,7 @@',
          ' x',
          '   y',
          '+\f',
          '+  q',
          '+  y',
          ' \f',
          '   z',
        ]);
      });
    });
  });

  describe('Given a form-feed line between two braces (get_indent’s XDL_ISSPACE class)', () => {
    describe('When computeHunks and git diff --no-index run on the same bytes', () => {
      it('Then the indent-heuristic-slid hunk body matches byte-for-byte', async () => {
        // Arrange
        const [oldPath, newPath] = await writePair('ff-brace', FF_BRACE_OLD, FF_BRACE_NEW);

        // Act
        const gitLines = hunkLinesFromGitDiff(gitDiffNoIndex(oldPath, newPath));
        const tsgitLines = tsgitHunkLines(enc(FF_BRACE_OLD), enc(FF_BRACE_NEW));

        // Assert
        expect(tsgitLines).toEqual(gitLines);
        expect(tsgitLines).toEqual(['@@ -1,3 +1,5 @@', ' {', '+\f', '+  k', ' \f', ' }']);
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

function parseNumstat(stdout: string): { readonly added: number; readonly deleted: number } {
  const [added, deleted] = stdout.split('\t');
  return { added: Number(added), deleted: Number(deleted) };
}

function gitNumstatNoIndex(
  oldPath: string,
  newPath: string,
): { readonly added: number; readonly deleted: number } {
  const result = tryRunGitWithExit([
    'diff',
    '--no-ext-diff',
    '--no-index',
    '--numstat',
    oldPath,
    newPath,
  ]);
  return parseNumstat(result.stdout);
}

function tsgitNumstat(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): { readonly added: number; readonly deleted: number } {
  const { added, deleted } = computeStatFields(oldBytes, newBytes);
  return { added, deleted };
}

function uniqueLines(prefix: string, count: number): ReadonlyArray<string> {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Deterministic, seed-only PRNG — no dependency, and identical across every
 *  call so a fixture built from it never drifts between test runs. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffledCopy(items: ReadonlyArray<string>, rng: () => number): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swapped = out[i]!;
    out[i] = out[j]!;
    out[j] = swapped;
  }
  return out;
}

describe.skipIf(!GIT_AVAILABLE)(
  'xdiff split engine interop — past the old edit-distance bail',
  () => {
    describe('Given 5001 unique lines plus one shared line on each side', () => {
      describe('When git diff --no-index --numstat and computeStatFields run on the same bytes', () => {
        it('Then the added/deleted counts match byte-for-byte', async () => {
          // Arrange — true edit distance 10 002, past the removed bail
          const oursText = `${[...uniqueLines('u', 5001), 'common'].join('\n')}\n`;
          const theirsText = `${[...uniqueLines('v', 5001), 'common'].join('\n')}\n`;
          const [oldPath, newPath] = await writePair('l2', oursText, theirsText);

          // Act
          const gitCounts = gitNumstatNoIndex(oldPath, newPath);
          const tsgitCounts = tsgitNumstat(enc(oursText), enc(theirsText));

          // Assert
          expect(tsgitCounts).toEqual(gitCounts);
          expect(gitCounts).toEqual({ added: 5001, deleted: 5001 });
        });
      });
    });

    describe('Given 10001 unique lines plus one shared line against just that shared line', () => {
      describe('When git diff --no-index --numstat and computeStatFields run on the same bytes', () => {
        it('Then the added/deleted counts match byte-for-byte', async () => {
          // Arrange — true edit distance 10 001, past the removed bail
          const oursText = `${[...uniqueLines('u', 10_001), 'common'].join('\n')}\n`;
          const theirsText = 'common\n';
          const [oldPath, newPath] = await writePair('l2-prime', oursText, theirsText);

          // Act
          const gitCounts = gitNumstatNoIndex(oldPath, newPath);
          const tsgitCounts = tsgitNumstat(enc(oursText), enc(theirsText));

          // Assert
          expect(tsgitCounts).toEqual(gitCounts);
          expect(gitCounts).toEqual({ added: 0, deleted: 10_001 });
        });
      });
    });

    describe('Given a seeded shuffle of 2000 distinct lines (past the split engine’s cost cap)', () => {
      describe('When git diff --no-index runs alongside computeStatFields and computeHunks on the same bytes', () => {
        it('Then numstat counts AND the patch hunk body match byte-for-byte', async () => {
          // Arrange — every line matches exactly once on the other side
          const base = Array.from({ length: 2000 }, (_, i) => `line${String(i).padStart(4, '0')}`);
          const oursText = `${base.join('\n')}\n`;
          const theirsText = `${shuffledCopy(base, mulberry32(1_234_567)).join('\n')}\n`;
          const [oldPath, newPath] = await writePair('shuffle', oursText, theirsText);

          // Act
          const gitCounts = gitNumstatNoIndex(oldPath, newPath);
          const tsgitCounts = tsgitNumstat(enc(oursText), enc(theirsText));
          const gitLines = hunkLinesFromGitDiff(gitDiffNoIndex(oldPath, newPath));
          const tsgitLines = tsgitHunkLines(enc(oursText), enc(theirsText));

          // Assert
          expect(tsgitCounts).toEqual(gitCounts);
          expect(gitCounts).toEqual({ added: 1931, deleted: 1931 });
          expect(tsgitLines).toEqual(gitLines);
        });
      });
    });

    // A 600-line block moved from the front to the back of a 1200-line file:
    // every line still matches exactly once on the other side (a pure
    // permutation), so — unlike a random rewrite with zero-match lines —
    // `cleanupRecords`'s no-match discard cannot change any of these four
    // rows' answers. The zero-match-heavy, cleanup-sensitive random-rewrite
    // rows live below, in the "xdiff record cleanup interop" suite.
    function buildBlockMovePair(): { readonly base: string; readonly moved: string } {
      const lines = Array.from({ length: 1200 }, (_, i) => `line${String(i).padStart(4, '0')}`);
      const moved = [...lines.slice(600), ...lines.slice(0, 600)];
      return { base: `${lines.join('\n')}\n`, moved: `${moved.join('\n')}\n` };
    }

    describe('Given a 600-line block moved from the front to the back of a 1200-line file (past the cost cap)', () => {
      describe('When git diff --no-index runs alongside computeStatFields and computeHunks on the same bytes', () => {
        it('Then numstat counts AND the patch hunk body match byte-for-byte', async () => {
          // Arrange
          const { base, moved } = buildBlockMovePair();
          const [oldPath, newPath] = await writePair('block-move', base, moved);

          // Act
          const gitCounts = gitNumstatNoIndex(oldPath, newPath);
          const tsgitCounts = tsgitNumstat(enc(base), enc(moved));
          const gitLines = hunkLinesFromGitDiff(gitDiffNoIndex(oldPath, newPath));
          const tsgitLines = tsgitHunkLines(enc(base), enc(moved));

          // Assert
          expect(tsgitCounts).toEqual(gitCounts);
          expect(gitCounts).toEqual({ added: 600, deleted: 600 });
          expect(tsgitLines).toEqual(gitLines);
        });
      });
    });

    describe('Given a repository whose HEAD moves that same 600-line block over one commit', () => {
      describe('When blame walks the two commits', () => {
        it('Then every final line is attributed to the same commit as git blame --porcelain', async () => {
          // Arrange
          const { base, moved } = buildBlockMovePair();
          const dir = await makeRepo('block-move-blame');
          const commit1 = await commitFile(dir, 'file.txt', base, 1_700_000_000);
          const commit2 = await commitFile(dir, 'file.txt', moved, 1_700_000_060);

          // Act
          const ctx = createNodeContext({ workDir: dir });
          const result = await blame(ctx, 'file.txt');
          const tsgitShas = result.lines.map((line) => (line.committed ? line.commit : ''));
          const porcelain = git(dir, 'blame', '--porcelain', 'HEAD', '--', 'file.txt');
          const gitShas = shasByFinalLine(porcelain);

          // Assert
          expect(tsgitShas).toEqual(gitShas);
          expect(new Set(tsgitShas)).toEqual(new Set([commit1, commit2]));
        });
      });
    });

    describe('Given a three-way merge whose ours side moves that block while theirs only appends', () => {
      describe('When mergeContent runs', () => {
        it('Then the result matches git merge-file -p byte-for-byte', async () => {
          // Arrange
          const { base, moved } = buildBlockMovePair();
          const baseBytes = enc(base);
          const oursBytes = enc(moved);
          const theirsBytes = enc(`${base}appended-theirs-line\n`);

          // Act
          const result = mergeContent(baseBytes, oursBytes, theirsBytes);
          const gitResult = await gitMergeFile('block-move', baseBytes, oursBytes, theirsBytes);

          // Assert
          expect(result.status).toBe(gitResult.exitCode === 0 ? 'clean' : 'conflict');
          const tsgitOutput =
            result.status === 'clean'
              ? decode(result.bytes)
              : decode(result.status === 'conflict' ? result.markedBytes : new Uint8Array(0));
          expect(tsgitOutput).toBe(gitResult.stdout);
        });
      });
    });
  },
);

// L4: the design's smallest row that only differs from git once record
// cleanup runs. `L4_B`'s lone 'f' occurs 4 times in `L4_A` — meeting
// bogosqrt(8) — so it is investigated, then discarded outright by the 7
// no-match ('u') lines surrounding it. Every 'u' line is unconditionally
// discarded (no match on the other side at all).
const L4_A = 'f\nf\nf\nf\n';
const L4_B = 'u1\nu2\nu3\nu4\nf\nu5\nu6\nu7\n';

function multiTestLines(n: number, multiplier: number, offset: number): string {
  return `${Array.from({ length: n }, (_, j) => String(j * multiplier + offset)).join('\n')}\n`;
}

const SEEDED_LINE_LENGTH = 20;
const SEEDED_LINE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function seededToken(rng: () => number): string {
  let token = '';
  for (let i = 0; i < SEEDED_LINE_LENGTH; i++) {
    token += SEEDED_LINE_ALPHABET[Math.floor(rng() * SEEDED_LINE_ALPHABET.length)];
  }
  return token;
}

function seededLines(count: number, seed: number): string[] {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, () => seededToken(rng));
}

const REWRITE_PROBABILITY = 0.5;

/** Replaces each line with a fresh seeded token independently at
 *  `REWRITE_PROBABILITY` — a ~90% line-replace shape once averaged over
 *  many lines is unlikely, but the true shape here is "roughly half
 *  rewritten, scattered", which is exactly what stresses cleanup's per-line
 *  no-match discard at scale (unlike the 600-line block-move rows above,
 *  where every line still matches exactly once). */
function rewriteLinesIndependently(lines: ReadonlyArray<string>, seed: number): string[] {
  const decideRng = mulberry32(seed);
  const freshRng = mulberry32(seed + 1);
  return lines.map((line) => (decideRng() < REWRITE_PROBABILITY ? seededToken(freshRng) : line));
}

const TEXT_REWRITE_LINE_COUNT = 50_000;
const TEXT_REWRITE_SEED = 0xc0ffee;
const TEXT_REWRITE_SECOND_SEED = 0xdecaf;

async function buildTextRewriteRepo(): Promise<string> {
  const dir = await makeRepo('l1-shrunk');
  const original = seededLines(TEXT_REWRITE_LINE_COUNT, TEXT_REWRITE_SEED);
  await commitFile(dir, 'big.txt', `${original.join('\n')}\n`, 1_700_000_000);
  const rewritten = rewriteLinesIndependently(original, TEXT_REWRITE_SECOND_SEED);
  await commitFile(dir, 'big.txt', `${rewritten.join('\n')}\n`, 1_700_000_060);
  return dir;
}

describe.skipIf(!GIT_AVAILABLE)(
  'xdiff record cleanup interop — past the split-only mismatch',
  () => {
    describe('Given the L4 shape (a: four "f" lines; b: seven unique lines plus one "f")', () => {
      describe('When git diff --no-index --numstat and computeStatFields run on the same bytes', () => {
        it('Then the added/deleted counts match byte-for-byte', async () => {
          // Arrange
          const [oldPath, newPath] = await writePair('l4', L4_A, L4_B);

          // Act
          const gitCounts = gitNumstatNoIndex(oldPath, newPath);
          const tsgitCounts = tsgitNumstat(enc(L4_A), enc(L4_B));

          // Assert
          expect(tsgitCounts).toEqual(gitCounts);
          expect(gitCounts).toEqual({ added: 8, deleted: 4 });
        });
      });
    });

    describe('Given a repository whose HEAD introduces the L4 shape over one commit', () => {
      describe('When blame walks the two commits', () => {
        it('Then every final line is attributed to the child commit, matching git blame --porcelain', async () => {
          // Arrange
          const dir = await makeRepo('l4-blame');
          const commit1 = await commitFile(dir, 'file.txt', L4_A, 1_700_000_000);
          const commit2 = await commitFile(dir, 'file.txt', L4_B, 1_700_000_060);

          // Act
          const ctx = createNodeContext({ workDir: dir });
          const result = await blame(ctx, 'file.txt');
          const tsgitShas = result.lines.map((line) => (line.committed ? line.commit : ''));
          const porcelain = git(dir, 'blame', '--porcelain', 'HEAD', '--', 'file.txt');
          const gitShas = shasByFinalLine(porcelain);

          // Assert
          expect(tsgitShas).toEqual(gitShas);
          // The lone 'f' is discarded before the search ever runs, so nothing
          // survives from the parent commit.
          expect(tsgitShas.every((sha) => sha === commit2)).toBe(true);
          expect(tsgitShas.some((sha) => sha === commit1)).toBe(false);
        });
      });
    });

    describe('Given a three-way merge whose ours side is the L4 "b" shape and theirs appends a line to "a"', () => {
      describe('When mergeContent runs', () => {
        it('Then the result matches git merge-file -p byte-for-byte', async () => {
          // Arrange
          const base = enc(L4_A);
          const ours = enc(L4_B);
          const theirs = enc('f\nf\nf\nf\ng\n');

          // Act
          const result = mergeContent(base, ours, theirs);
          const gitResult = await gitMergeFile('l4', base, ours, theirs);

          // Assert
          expect(result.status).toBe(gitResult.exitCode === 0 ? 'clean' : 'conflict');
          const tsgitOutput =
            result.status === 'clean'
              ? decode(result.bytes)
              : decode(result.status === 'conflict' ? result.markedBytes : new Uint8Array(0));
          expect(tsgitOutput).toBe(gitResult.stdout);
        });
      });
    });

    describe('Given the mt8000 shape (lines j·7 against j·13+1, n = 8000, multi-match-heavy)', () => {
      describe('When git diff --no-index --numstat and computeStatFields run on the same bytes', () => {
        it('Then the added/deleted counts match byte-for-byte', async () => {
          // Arrange — most lines have no match at all on the other side; a
          // sparse subset (where 7j ≡ 13k+1) coincide, exercising cleanup's
          // no-match discard at a scale past the split engine's cost cap
          const oursText = multiTestLines(8000, 7, 0);
          const theirsText = multiTestLines(8000, 13, 1);
          const [oldPath, newPath] = await writePair('l3-mt8000', oursText, theirsText);

          // Act
          const gitCounts = gitNumstatNoIndex(oldPath, newPath);
          const tsgitCounts = tsgitNumstat(enc(oursText), enc(theirsText));

          // Assert
          expect(tsgitCounts).toEqual(gitCounts);
        });
      });
    });

    describe('Given two commits rewriting roughly half of 50 000 seeded lines independently (past the cost cap, cleanup-sensitive)', () => {
      describe('When git diff --numstat and tsgit diff({ withStat: true }) both compare HEAD~1..HEAD', () => {
        it('Then the added/deleted counts match byte-for-byte', async () => {
          // Arrange
          const dir = await buildTextRewriteRepo();
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitNumstat = git(
            dir,
            'diff',
            '--no-ext-diff',
            '--numstat',
            'HEAD~1',
            'HEAD',
          ).trim();
          const result = (await diff(ctx, {
            from: 'HEAD~1',
            to: 'HEAD',
            withStat: true,
          })) as StatTreeDiff;

          // Assert
          const [gitAddedText, gitDeletedText] = gitNumstat.split('\t');
          const change = result.changes.find((c) => 'path' in c && c.path === 'big.txt');
          expect(change).toMatchObject({
            type: 'modify',
            added: Number(gitAddedText),
            deleted: Number(gitDeletedText),
          });
        });
      });
    });
  },
);

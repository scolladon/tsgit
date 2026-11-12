/**
 * Cross-tool interop — `grep`. Builds a repository with canonical git
 * (deterministic dates, signing off), runs tsgit's `grep`, reconstructs
 * decisions from the structured `GrepResult`, and asserts the reconstruction
 * matches real `git grep` output.
 *
 * Grammar is intentionally NOT pinned against `git grep` — tsgit uses JS
 * `RegExp` while git uses POSIX BRE, and comparing V8 semantics against glibc
 * regexec proves nothing meaningful. All cells use a trivial literal pattern so
 * the test is grammar-independent and pins the faithful half only:
 * target selection, binary detection, and line numbering.
 *
 * @proves
 *   surface:        grep
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's grep data reconstructs canonical `git grep` target/binary/line decisions
 *   interopSurface: grep
 */
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type GrepBlobResult, type GrepResult, grep } from '../../src/application/commands/grep.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

/** Literal used across all cells — trivial substring, no regex metacharacters. */
const LIT = 'NEEDLE';

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

let clock = 1_700_000_000;

/**
 * Reconstruct git's per-path count for `-c`. git counts the returned lines of a
 * binary blob too; tsgit keeps `hits` empty for one and carries the count in
 * `binaryMatchCount`.
 */
const countOf = (match: GrepBlobResult): number =>
  match.binaryMatch ? match.binaryMatchCount : match.hits.length;

const deriveCount = (paths: GrepResult['paths']): Map<string, number> =>
  new Map(paths.map((p) => [p.path as string, countOf(p)]));

/**
 * Reconstruct git's name-only (`-l`) list. Binary blobs that matched appear in
 * git's `-l` output; tsgit reports them as binaryMatch:true entries. Include all
 * matching paths (text + binary) in the derivation.
 */
const deriveNameOnly = (paths: GrepResult['paths']): Set<string> =>
  new Set(paths.map((p) => p.path as string));

/**
 * Assert list + count parity between tsgit and `git grep` for a given treeish
 * target. Strips the "HEAD:" prefix from git's output. Binary blobs that
 * matched are included in both the list and the count (git counts their returned lines).
 */
const assertTargetParity = (
  result: GrepResult,
  gitListOutput: string,
  gitCountOutput: string,
): void => {
  const normalise = (line: string): string => line.replace(/^HEAD:/, '');

  const tsgitNames = deriveNameOnly(result.paths);
  const gitNames = new Set(gitListOutput.trim().split('\n').filter(Boolean).map(normalise));
  expect(tsgitNames).toEqual(gitNames);

  const tsgitCounts = deriveCount(result.paths);
  const gitCounts = gitCountOutput
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const colonIdx = line.lastIndexOf(':');
      return { path: normalise(line.slice(0, colonIdx)), count: Number(line.slice(colonIdx + 1)) };
    });
  for (const { path: gPath, count: gCount } of gitCounts) {
    expect(tsgitCounts.get(gPath)).toBe(gCount);
  }
};

const text = (line: Uint8Array): string => new TextDecoder().decode(line).replace(/\n$/, '');

/** git's `<rev>:<n>:<line>` rows, rebuilt from the structured blob result (the library renders nothing). */
const blobLines = (rev: string, r: GrepResult): string[] =>
  (r.blob?.hits ?? []).map((h) => `${rev}:${h.lineNumber}:${text(h.line)}`);

/** git's per-path `-n` rows, rebuilt from the structured result; a binary match is git's one-line notice. */
const pathLines = (pre: string, r: GrepResult): string[] =>
  r.paths.flatMap((p) =>
    p.binaryMatch
      ? [`Binary file ${pre}${p.path} matches`]
      : p.hits.map((h) => `${pre}${p.path}:${h.lineNumber}:${text(h.line)}`),
  );

/** git's per-path `-c` rows, rebuilt from the structured result. */
const countLines = (pre: string, r: GrepResult): string[] =>
  r.paths.map((p) => `${pre}${p.path}:${countOf(p)}`);

const lines = (out: string): string[] => out.split('\n').filter(Boolean);

/** The refusal's error data, or `undefined` when `run` resolves. */
const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (e) {
    return (e as { data: unknown }).data;
  }
  return undefined;
};

interface BlobRev {
  readonly label: string;
  readonly rev: () => string;
}

describe.skipIf(!GIT_AVAILABLE)('grep interop', () => {
  let dir: string;
  let ctx: Context;
  let blobOid: string;
  let looseOid: string;
  let wordOid: string;
  let emptyOid: string;
  let exeTree: string;
  let blobRootCommit: string;
  let tagBlobRootCommit: string;
  let missingTreeCommit: string;
  let missingTargetTag: string;
  let bare: string;
  let bareCtx: Context;

  const blobRevs: ReadonlyArray<BlobRev> = [
    { label: 'the full oid', rev: () => blobOid },
    { label: 'an abbreviated oid', rev: () => blobOid.slice(0, 7) },
    { label: 'HEAD:c.txt', rev: () => 'HEAD:c.txt' },
    { label: 'HEAD:./c.txt', rev: () => 'HEAD:./c.txt' },
    { label: 'HEAD:a.txt', rev: () => 'HEAD:a.txt' },
    { label: 'HEAD:nested/deep.txt', rev: () => 'HEAD:nested/deep.txt' },
    { label: 'HEAD^{tree}:c.txt', rev: () => 'HEAD^{tree}:c.txt' },
    { label: ':c.txt', rev: () => ':c.txt' },
    { label: ':0:c.txt', rev: () => ':0:c.txt' },
    { label: 'an annotated tag', rev: () => 'blob-tag' },
    { label: 'a tag of a tag', rev: () => 'tag-of-tag' },
    { label: 'a lightweight tag', rev: () => 'light' },
    { label: 'oid^{blob}', rev: () => `${blobOid}^{blob}` },
    { label: 'tag^{}', rev: () => 'blob-tag^{}' },
    { label: 'an unreachable loose blob', rev: () => looseOid },
  ];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-grep-interop-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'A U Thor');
    git(dir, 'config', 'user.email', 'author@example.com');

    // Committed content: multi-line blob with NEEDLE on line 12; 3 of 5 text
    // paths match, plus 1 binary path — pins #L1 and #M1.
    // Lines 1-11 are filler, line 12 carries NEEDLE.
    const multiline =
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nNEEDLE on line12\nline13\n';
    await writeFile(path.join(dir, 'a.txt'), multiline);
    await writeFile(path.join(dir, 'b.txt'), 'no match here\n');
    await writeFile(path.join(dir, 'c.txt'), 'has NEEDLE in c\n');
    await writeFile(path.join(dir, 'd.txt'), 'nothing\n');
    await writeFile(path.join(dir, 'e.txt'), 'also has NEEDLE in e\n');

    // Binary blob containing NEEDLE — pins #B1 (binary skip + binaryMatch datum).
    // A NUL byte triggers isBinary; NEEDLE present → binaryMatch: true.
    const binContent = Buffer.from([
      ...Buffer.from('NEEDLE match '),
      0x00,
      ...Buffer.from(' in binary'),
    ]);
    await writeFile(path.join(dir, 'b.bin'), binContent);

    // longline.txt: a single NUL-free line over MAX_LINE_BYTES, with NEEDLE embedded —
    // pins #LL1: the line-length cap no longer decides isBinary, so this is a text
    // hit with a real line number, not a binaryMatch. Controls against #B1 above.
    const longLine = `${'a'.repeat(35_000)}NEEDLE${'a'.repeat(34_994)}\n`;
    await writeFile(path.join(dir, 'longline.txt'), longLine);

    // wt_only_unstaged: a TRACKED file committed with no-match content, then
    // modified in the working tree (but NOT staged) to contain NEEDLE.
    // git grep (working tree) sees the modified working-tree bytes (#T1).
    // git grep --cached sees the committed index bytes — no match (#T3).
    await writeFile(path.join(dir, 'wt_only_unstaged.txt'), 'no match committed\n');

    // deleted_tracked: committed with NEEDLE, then deleted from the working tree.
    // git grep silently skips it (exit 0, no output). Pins the absent-from-worktree skip.
    await writeFile(path.join(dir, 'deleted_tracked.txt'), 'has NEEDLE committed\n');

    // symlink_tracked: a tracked symlink whose target contains NEEDLE.
    // git grep skips symlinks — they are not blob content.
    // The target file is untracked so git grep won't find it via the target either.
    await writeFile(path.join(dir, 'symlink_target.txt'), 'NEEDLE in symlink target\n');

    // Binary blobs whose verdict depends on line-wise matching (pins #J1/#J2).
    await writeFile(path.join(dir, 'all-match.dat'), Buffer.from('bin\0NEEDLE\n'));
    await writeFile(path.join(dir, 'mixed.dat'), Buffer.from('bin\0NEEDLE\nother\n'));
    await writeFile(path.join(dir, 'nomatch.dat'), Buffer.from('bin\0x\n'));
    await writeFile(path.join(dir, 'anchored.dat'), Buffer.from('bin\0x\nNEEDLE y\n'));
    // Two returned lines in one binary blob: git's -c prints 2, not 1.
    await writeFile(path.join(dir, 'twice.bin'), Buffer.from('bin\0NEEDLE\nNEEDLE\n'));
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'nested', 'deep.txt'), 'NEEDLE deep\n');

    git(dir, 'add', '-A');
    clock += 60;
    runGit(['-C', dir, 'commit', '-q', '-m', 'initial'], { env: datedEnv(clock) });

    // Delete deleted_tracked.txt from the working tree (leave it in the index).
    await unlink(path.join(dir, 'deleted_tracked.txt'));

    // Create a tracked symlink pointing at the target file and stage it.
    await symlink(path.join(dir, 'symlink_target.txt'), path.join(dir, 'tracked_symlink.txt'));
    git(dir, 'add', 'tracked_symlink.txt');
    clock += 60;
    runGit(['-C', dir, 'commit', '-q', '-m', 'add symlink'], { env: datedEnv(clock) });

    // Modify wt_only_unstaged.txt in the working tree without staging.
    await writeFile(path.join(dir, 'wt_only_unstaged.txt'), 'unstaged NEEDLE content\n');

    // gitignored_with_needle: on disk but covered by .gitignore.
    // git grep (any target) must NOT return it.
    // Commit .gitignore before staging staged_only so the gitignore commit
    // does not accidentally include the staged_only entry.
    await writeFile(path.join(dir, '.gitignore'), 'ignored_needle.txt\n');
    git(dir, 'add', '.gitignore');
    clock += 60;
    runGit(['-C', dir, 'commit', '-q', '-m', 'add gitignore'], { env: datedEnv(clock) });
    await writeFile(path.join(dir, 'ignored_needle.txt'), 'NEEDLE in ignored file\n');

    // staged_only: a new file staged but NOT yet committed — visible in --cached (#T2),
    // invisible in HEAD treeish (#T4). Staged AFTER the gitignore commit so it
    // is not swept into that commit.
    await writeFile(path.join(dir, 'staged_only.txt'), 'staged NEEDLE content\n');
    git(dir, 'add', 'staged_only.txt');

    // untracked_with_needle: exists only on disk, never staged.
    // git grep (any target) must NOT return it.
    await writeFile(path.join(dir, 'untracked_with_needle.txt'), 'NEEDLE in untracked file\n');

    // Blob-target fixtures: tags do not move HEAD, so the rows above are untouched.
    blobOid = git(dir, 'rev-parse', 'HEAD:c.txt').trim();
    runGit(['-C', dir, 'tag', '-a', '-m', 'm', 'blob-tag', blobOid], { env: datedEnv(clock) });
    runGit(
      ['-C', dir, '-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'm', 'tag-of-tag', 'blob-tag'],
      {
        env: datedEnv(clock),
      },
    );
    git(dir, 'tag', 'light', blobOid);
    const hashLoose = (s: string): string =>
      runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: s }).trim();
    looseOid = hashLoose('loose NEEDLE\n');
    wordOid = hashLoose('xNEEDLEx\n');
    emptyOid = hashLoose('');
    const exeOid = hashLoose('run NEEDLE\n');
    exeTree = runGit(['-C', dir, 'mktree'], { input: `100755 blob ${exeOid}\trun.sh\n` }).trim();
    const who = 'A <a@example.com> 1 +0000';
    const forge = (type: string, body: string): string =>
      runGit(['-C', dir, 'hash-object', '-t', type, '-w', '--literally', '--stdin'], {
        input: body,
      }).trim();
    const commitOver = (tree: string): string =>
      forge('commit', `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\nm\n`);
    blobRootCommit = commitOver(blobOid);
    tagBlobRootCommit = commitOver(git(dir, 'rev-parse', 'blob-tag').trim());
    missingTreeCommit = commitOver('1'.repeat(40));
    missingTargetTag = forge(
      'tag',
      `object ${'2'.repeat(40)}\ntype commit\ntag t\ntagger ${who}\n\nm\n`,
    );
    bare = `${dir}-bare.git`;
    runGit(['clone', '-q', '--bare', dir, bare]);
    bareCtx = createNodeContext({ workDir: bare, gitDir: bare, bare: true });

    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // #T1 — working-tree default sees an unstaged change on a tracked file
  // ---------------------------------------------------------------------------
  describe('Given the working-tree target (default)', () => {
    describe('When grepping for the literal in wt_only_unstaged.txt', () => {
      it('Then tsgit finds the path and git grep agrees', async () => {
        // Arrange & Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }] });
        const gitOutput = git(dir, 'grep', '-F', '-l', LIT);

        // Assert
        const tsgitPaths = result.paths.map((p) => p.path as string);
        const gitPaths = gitOutput.trim().split('\n').filter(Boolean);
        expect(tsgitPaths).toContain('wt_only_unstaged.txt');
        expect(gitPaths).toContain('wt_only_unstaged.txt');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // #T2 — --cached target sees a staged-only change
  // ---------------------------------------------------------------------------
  describe('Given the index (--cached) target', () => {
    describe('When grepping for the literal in staged_only.txt', () => {
      it('Then tsgit finds the path and git grep --cached agrees', async () => {
        // Arrange & Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }], target: 'index' });
        const gitOutput = git(dir, 'grep', '--cached', '-F', '-l', LIT);

        // Assert
        const tsgitPaths = result.paths.map((p) => p.path as string);
        const gitPaths = gitOutput.trim().split('\n').filter(Boolean);
        expect(tsgitPaths).toContain('staged_only.txt');
        expect(gitPaths).toContain('staged_only.txt');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Faithful exclusion family: a path class tsgit omits from its target
  // selection, matching git grep's silent skip — untracked, gitignored,
  // deleted-from-worktree, symlinked, unstaged-under---cached, and
  // staged-only-under-HEAD paths all resolve through the same omission
  // oracle with only the target/gitArgs and excluded path varying.
  // ---------------------------------------------------------------------------
  const OMIT_MATRIX: ReadonlyArray<{
    label: string;
    path: string;
    run: () => Promise<GrepResult>;
    gitArgs: readonly string[];
    stripHeadPrefix?: boolean;
  }> = [
    {
      label: 'an untracked file',
      path: 'untracked_with_needle.txt',
      run: () => grep(ctx, { patterns: [{ fixed: LIT }] }),
      gitArgs: ['-F', '-l', LIT],
    },
    {
      label: 'a gitignored file',
      path: 'ignored_needle.txt',
      run: () => grep(ctx, { patterns: [{ fixed: LIT }] }),
      gitArgs: ['-F', '-l', LIT],
    },
    {
      label: 'a tracked file absent from the working tree',
      path: 'deleted_tracked.txt',
      run: () => grep(ctx, { patterns: [{ fixed: LIT }] }),
      gitArgs: ['-F', '-l', LIT],
    },
    {
      label: 'a tracked symlink',
      path: 'tracked_symlink.txt',
      run: () => grep(ctx, { patterns: [{ fixed: LIT }] }),
      gitArgs: ['-F', '-l', LIT],
    },
    {
      label: 'an unstaged change under --cached',
      path: 'wt_only_unstaged.txt',
      run: () => grep(ctx, { patterns: [{ fixed: LIT }], target: 'index' }),
      gitArgs: ['--cached', '-F', '-l', LIT],
    },
    {
      label: 'a staged-only file under the HEAD treeish',
      path: 'staged_only.txt',
      run: () => grep(ctx, { patterns: [{ fixed: LIT }], target: { treeish: 'HEAD' } }),
      gitArgs: ['-F', '-l', LIT, 'HEAD'],
      stripHeadPrefix: true,
    },
  ];

  describe('Given a path tsgit excludes from a grep target', () => {
    describe('When grep runs against the excluded path', () => {
      it.each(OMIT_MATRIX)(
        'Then tsgit omits $label, does not throw, and git grep agrees',
        async ({ path: excludedPath, run, gitArgs, stripHeadPrefix }) => {
          // Arrange & Act — must not throw (git exits 0 when no match found due to absent files)
          let result: GrepResult | undefined;
          let caught: unknown;
          try {
            result = await run();
          } catch (e) {
            caught = e;
          }
          const gitOutput = git(dir, 'grep', ...gitArgs);

          // Assert
          expect(caught).toBeUndefined();
          const tsgitPaths = result!.paths.map((p) => p.path as string);
          const gitPaths = gitOutput
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((p) => (stripHeadPrefix ? p.replace(/^HEAD:/, '') : p));
          expect(tsgitPaths).not.toContain(excludedPath);
          expect(gitPaths).not.toContain(excludedPath);
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // #L1 — 1-based line numbering: NEEDLE is on line 12 of a.txt
  // ---------------------------------------------------------------------------
  describe('Given a multi-line blob with NEEDLE on line 12', () => {
    describe('When grepping the working tree for the literal', () => {
      it('Then tsgit reports lineNumber 12 and git grep -n agrees', async () => {
        // Arrange & Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }] });
        const gitLine = git(dir, 'grep', '-n', '-F', LIT, '--', 'a.txt').trim();

        // Assert
        const aResult = result.paths.find((p) => p.path === 'a.txt');
        expect(aResult).toBeDefined();
        const hit = aResult?.hits[0];
        expect(hit).toBeDefined();
        expect(hit?.lineNumber).toBe(12);

        // Reconstruct "path:lineNumber:" prefix and compare to git grep -n output
        expect(gitLine).toContain(`a.txt:${hit?.lineNumber}:`);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // #M1 — multi-path enumeration: 3 text + 1 binary of 5 paths contain NEEDLE.
  // The library emits no rendering mode; the caller derives both the name-only
  // list and the per-file count from the structured fields (paths[].path,
  // hits.length / binaryMatch) — assertTargetParity checks both derivations.
  // ---------------------------------------------------------------------------
  describe('Given the HEAD tree with text, nested and binary paths, one binary with two returned lines', () => {
    describe('When grepping the HEAD treeish for the literal', () => {
      it('Then tsgit derives the same matching paths and per-file counts as git grep -l/-c', async () => {
        // Arrange & Act
        const result = await grep(ctx, {
          patterns: [{ fixed: LIT }],
          target: { treeish: 'HEAD' },
        });
        const gitListOutput = git(dir, 'grep', '-F', '-l', LIT, 'HEAD');
        const gitCountOutput = git(dir, 'grep', '-F', '-c', LIT, 'HEAD');

        // Assert — compare as sets (walk order may differ from git's tree order).
        // Binary matches appear in git's -l output; derive from all paths including binaryMatch.
        assertTargetParity(result, gitListOutput, gitCountOutput);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // #B1 — binary blob: NUL-containing file with NEEDLE → binaryMatch: true, hits empty
  // ---------------------------------------------------------------------------
  describe('Given a binary blob that contains NEEDLE', () => {
    describe('When grepping the working tree for the literal', () => {
      it('Then tsgit sets binaryMatch true with empty hits, and git grep reports "Binary file matches"', async () => {
        // Arrange & Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }] });
        const gitOutput = git(dir, 'grep', '-F', LIT, '--', 'b.bin');

        // Assert tsgit structured data
        const binResult = result.paths.find((p) => p.path === 'b.bin');
        expect(binResult).toBeDefined();
        expect(binResult?.binaryMatch).toBe(true);
        expect(binResult?.hits).toHaveLength(0);

        // Reconstruct "Binary file X matches" text from the datum; compare to git output
        expect(gitOutput.trim()).toContain('Binary file b.bin matches');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // #LL1 — a single NUL-free line over MAX_LINE_BYTES: a text hit with a real
  // line number, not a binaryMatch (the line-length cap no longer decides).
  // ---------------------------------------------------------------------------
  describe('Given a NUL-free single line over MAX_LINE_BYTES that contains NEEDLE', () => {
    describe('When grepping the working tree for the literal', () => {
      it('Then tsgit reports a text hit with lineNumber 1, and git grep agrees', async () => {
        // Arrange & Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }] });
        const gitOutput = git(dir, 'grep', '-n', '-F', LIT, '--', 'longline.txt').trim();

        // Assert tsgit structured data
        const longResult = result.paths.find((p) => p.path === 'longline.txt');
        expect(longResult).toBeDefined();
        expect(longResult?.binaryMatch).toBe(false);
        expect(longResult?.hits).toHaveLength(1);
        expect(longResult?.hits[0]?.lineNumber).toBe(1);

        // Reconstruct "path:lineNumber:" prefix and compare to git grep -n output
        expect(gitOutput).toContain(`longline.txt:${longResult?.hits[0]?.lineNumber}:`);
      });
    });
  });

  describe('Given binary blobs under *.dat', () => {
    describe('When grepping HEAD with invert', () => {
      it("Then tsgit's binaryMatch paths equal git grep -v -l", async () => {
        // Arrange
        const gitOutput = git(dir, 'grep', '-v', '-l', '-F', LIT, 'HEAD', '--', '*.dat');

        // Act
        const result = await grep(ctx, {
          patterns: [{ fixed: LIT }],
          invert: true,
          target: { treeish: 'HEAD' },
          paths: ['*.dat'],
        });

        // Assert
        const gitNames = new Set(
          gitOutput
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => l.replace(/^HEAD:/, '')),
        );
        expect(deriveNameOnly(result.paths)).toEqual(gitNames);
        expect(gitNames).toEqual(new Set(['anchored.dat', 'mixed.dat', 'nomatch.dat']));
        expect(result.paths.every((p) => p.binaryMatch && p.hits.length === 0)).toBe(true);
      });
    });
  });

  describe('Given binary blobs under *.dat and a start-anchored pattern', () => {
    describe('When grepping HEAD', () => {
      it("Then tsgit's binaryMatch paths equal git grep -l -E", async () => {
        // Arrange — ^NEEDLE means the same in ERE and JS: this pins line splitting, not grammar
        const gitOutput = git(dir, 'grep', '-l', '-E', '^NEEDLE', 'HEAD', '--', '*.dat');

        // Act
        const result = await grep(ctx, {
          patterns: [/^NEEDLE/],
          target: { treeish: 'HEAD' },
          paths: ['*.dat'],
        });

        // Assert
        const gitNames = new Set(
          gitOutput
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => l.replace(/^HEAD:/, '')),
        );
        expect(deriveNameOnly(result.paths)).toEqual(gitNames);
        expect(gitNames).toEqual(new Set(['anchored.dat']));
      });
    });
  });
  describe('Given a blob target', () => {
    describe.each(blobRevs)('When the rev is $label', ({ rev }) => {
      it('Then the rebuilt lines equal git grep -n and paths is empty', async () => {
        // Arrange
        const target = rev();

        // Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }], target: { treeish: target } });

        // Assert
        expect(blobLines(target, result)).toEqual(lines(git(dir, 'grep', '-n', '-F', LIT, target)));
        expect(result.paths).toEqual([]);
      });
    });

    describe('When the blob is binary', () => {
      it('Then the Binary file line equals git', async () => {
        // Arrange
        const target = 'HEAD:b.bin';

        // Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }], target: { treeish: target } });

        // Assert
        const rebuilt = result.blob?.binaryMatch === true ? `Binary file ${target} matches` : '';
        expect(rebuilt).toBe(git(dir, 'grep', '-n', '-F', LIT, target).trim());
      });
    });

    describe('When -l or -c is projected', () => {
      const projected: ReadonlyArray<BlobRev> = [
        { label: 'an annotated tag', rev: () => 'blob-tag' },
        { label: 'the full oid', rev: () => blobOid },
        { label: 'a binary blob with two returned lines', rev: () => 'HEAD:twice.bin' },
      ];

      it.each(projected)('Then $label lists and counts as git does', async ({ rev }) => {
        // Arrange
        const target = rev();

        // Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }], target: { treeish: target } });

        // Assert
        const { blob } = result;
        expect(blob ? [target] : []).toEqual(lines(git(dir, 'grep', '-l', '-F', LIT, target)));
        const count = blob ? [`${target}:${countOf(blob)}`] : [];
        expect(count).toEqual(lines(git(dir, 'grep', '-c', '-F', LIT, target)));
      });
    });

    describe('When a commit reaches the blob through its tree header', () => {
      const forged: ReadonlyArray<BlobRev> = [
        { label: 'naming the blob', rev: () => blobRootCommit },
        { label: 'naming a tag of the blob', rev: () => tagBlobRootCommit },
      ];

      it.each(forged)(
        'Then git exits 128 and tsgit refuses OBJECT_NOT_FOUND on the commit $label',
        async ({ rev }) => {
          // Arrange
          const target = rev();
          const gitRun = tryRunGitWithExit(['-C', dir, 'grep', '-F', LIT, target]);

          // Act
          const data = await refusalOf(() =>
            grep(ctx, { patterns: [{ fixed: LIT }], target: { treeish: target } }),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(data).toEqual({ code: 'OBJECT_NOT_FOUND', id: target });
        },
      );
    });

    describe('When the rev names an object that fails only once peeled and the pathspec is outside the repository', () => {
      const peelFailures: ReadonlyArray<BlobRev> = [
        { label: 'a commit naming the blob as its tree', rev: () => blobRootCommit },
        { label: 'a commit with a missing tree', rev: () => missingTreeCommit },
        { label: 'a tag with a missing target', rev: () => missingTargetTag },
      ];

      it.each(peelFailures)(
        'Then $label refuses on the pathspec first, as git does',
        async ({ rev }) => {
          // Arrange
          const target = rev();
          const gitRun = tryRunGitWithExit([
            '-C',
            dir,
            'grep',
            '-F',
            LIT,
            target,
            '--',
            '../outside',
          ]);

          // Act
          const data = await refusalOf(() =>
            grep(ctx, {
              patterns: [{ fixed: LIT }],
              target: { treeish: target },
              paths: ['../outside'],
            }),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toContain('outside repository');
          expect(data).toMatchObject({ code: 'PATHSPEC_OUTSIDE_REPO' });
        },
      );
    });

    describe('When the rev is bad and the pathspec is outside the repository', () => {
      const badRevs = [
        { label: 'a missing path', rev: 'HEAD:nope', code: 'PATH_NOT_IN_TREE' },
        { label: 'a missing object', rev: '1'.repeat(40), code: 'OBJECT_NOT_FOUND' },
      ];

      it.each(badRevs)(
        'Then $label is refused before the pathspec, as git does',
        async ({ rev, code }) => {
          // Arrange
          const gitRun = tryRunGitWithExit(['-C', dir, 'grep', '-F', LIT, rev, '--', '../outside']);

          // Act
          const data = await refusalOf(() =>
            grep(ctx, {
              patterns: [{ fixed: LIT }],
              target: { treeish: rev },
              paths: ['../outside'],
            }),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).not.toContain('outside repository');
          expect(data).toMatchObject({ code });
        },
      );
    });

    describe('When the match is inverted', () => {
      it('Then the rebuilt lines equal git grep -n -v', async () => {
        // Arrange
        const target = 'HEAD:a.txt';

        // Act
        const result = await grep(ctx, {
          patterns: [{ fixed: LIT }],
          invert: true,
          target: { treeish: target },
        });

        // Assert
        expect(blobLines(target, result)).toHaveLength(12);
        expect(blobLines(target, result)).toEqual(
          lines(git(dir, 'grep', '-n', '-v', '-F', LIT, target)),
        );
      });
    });

    describe('When nothing matches', () => {
      const rows: ReadonlyArray<{ label: string; rev: () => string; wholeWord: boolean }> = [
        { label: 'a non-matching blob', rev: () => 'HEAD:b.txt', wholeWord: false },
        { label: 'the empty blob', rev: () => emptyOid, wholeWord: false },
        { label: 'an embedded word under -w', rev: () => wordOid, wholeWord: true },
      ];
      it.each(rows)('Then $label exits 1 and has no blob key', async ({ rev, wholeWord }) => {
        // Arrange
        const target = rev();
        const flags = wholeWord ? ['-w'] : [];

        // Act
        const result = await grep(ctx, {
          patterns: [{ fixed: LIT }],
          ...(wholeWord ? { wholeWord: true } : {}),
          target: { treeish: target },
        });

        // Assert
        const gitRun = tryRunGitWithExit(['-C', dir, 'grep', '-n', '-F', ...flags, LIT, target]);
        expect(gitRun.exitCode).toBe(1);
        expect(result).toStrictEqual({ paths: [] });
      });

      it('Then an embedded word matches on both sides without -w', async () => {
        // Arrange & Act
        const result = await grep(ctx, {
          patterns: [{ fixed: LIT }],
          target: { treeish: wordOid },
        });

        // Assert
        expect(blobLines(wordOid, result)).toEqual(
          lines(git(dir, 'grep', '-n', '-F', LIT, wordOid)),
        );
        expect(result.blob).toBeDefined();
      });
    });

    describe('When a non-matching pathspec is given', () => {
      it('Then the pathspec is not applied, as in git', async () => {
        // Arrange
        const target = 'HEAD:c.txt';

        // Act
        const result = await grep(ctx, {
          patterns: [{ fixed: LIT }],
          target: { treeish: target },
          paths: ['nomatch'],
        });

        // Assert
        const expected = lines(git(dir, 'grep', '-n', '-F', LIT, target, '--', 'nomatch'));
        expect(expected).toHaveLength(1);
        expect(blobLines(target, result)).toEqual(expected);
      });
    });

    describe('When the pathspec is outside the repository', () => {
      it('Then git exits 128 and tsgit refuses PATHSPEC_OUTSIDE_REPO', async () => {
        // Arrange
        const target = 'HEAD:c.txt';
        const gitRun = tryRunGitWithExit([
          '-C',
          dir,
          'grep',
          '-F',
          LIT,
          target,
          '--',
          '../outside',
        ]);

        // Act
        const data = await refusalOf(() =>
          grep(ctx, {
            patterns: [{ fixed: LIT }],
            target: { treeish: target },
            paths: ['../outside'],
          }),
        );

        // Assert
        expect(gitRun.exitCode).toBe(128);
        expect(data).toMatchObject({ code: 'PATHSPEC_OUTSIDE_REPO' });
      });
    });

    describe('When the blob is a symlink target string', () => {
      it('Then it is grepped like git does', async () => {
        // Arrange
        const target = 'HEAD:tracked_symlink.txt';

        // Act
        const result = await grep(ctx, {
          patterns: [{ fixed: 'symlink_target' }],
          target: { treeish: target },
        });

        // Assert
        const expected = lines(git(dir, 'grep', '-n', '-F', 'symlink_target', target));
        expect(expected).toHaveLength(1);
        expect(blobLines(target, result)).toEqual(expected);
      });
    });

    describe('When the blob is an executable', () => {
      it('Then it is grepped like git does', async () => {
        // Arrange
        const target = `${exeTree}:run.sh`;

        // Act
        const result = await grep(ctx, { patterns: [{ fixed: LIT }], target: { treeish: target } });

        // Assert
        const expected = lines(git(dir, 'grep', '-n', '-F', LIT, target));
        expect(expected).toEqual([`${target}:1:run NEEDLE`]);
        expect(blobLines(target, result)).toEqual(expected);
      });
    });

    describe('When the repository is bare', () => {
      it.each(['HEAD:c.txt', 'blob-tag'])('Then %s equals git grep -n', async (target) => {
        // Arrange & Act
        const result = await grep(bareCtx, {
          patterns: [{ fixed: LIT }],
          target: { treeish: target },
        });

        // Assert
        const expected = lines(git(bare, 'grep', '-n', '-F', LIT, target));
        expect(expected).toHaveLength(1);
        expect(blobLines(target, result)).toEqual(expected);
      });
    });
  });
});

const TEXT_LINES = 'a NEEDLE\nb\nNEEDLE c\n';
const NUL_LINES = Buffer.from('x NEEDLE\0y\n');

const initAttrRepo = (prefix: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), prefix)).then((repo) => {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'A U Thor');
    git(repo, 'config', 'user.email', 'author@example.com');
    return repo;
  });

const commitAttrRepo = (repo: string): void => {
  git(repo, 'add', '-A');
  clock += 60;
  runGit(['-C', repo, 'commit', '-q', '-m', 'initial'], { env: datedEnv(clock) });
};

describe.skipIf(!GIT_AVAILABLE)('Given a diff attribute', () => {
  let main: string;
  let defaultDriver: string;
  let indexOnly: string;
  let windowed: string;
  let bareClone: string;

  beforeAll(async () => {
    main = await initAttrRepo('tsgit-grep-attr-');
    await writeFile(
      path.join(main, '.gitattributes'),
      [
        '[attr]opaque -diff',
        'bin.txt binary',
        'neg.txt -diff',
        'diffed.dat diff',
        'macro.txt opaque',
        'unset.dat !diff',
        'strict.txt diff=strict',
        'loose.dat diff=loose',
        '',
      ].join('\n'),
    );
    await mkdir(path.join(main, 'sub'));
    await writeFile(path.join(main, 'sub', '.gitattributes'), 'nested.txt binary\n');
    for (const name of ['bin', 'neg', 'macro', 'strict', 'plain']) {
      await writeFile(path.join(main, `${name}.txt`), TEXT_LINES);
    }
    await writeFile(path.join(main, 'sub', 'nested.txt'), TEXT_LINES);
    for (const name of ['diffed', 'unset', 'loose', 'plain']) {
      await writeFile(path.join(main, `${name}.dat`), NUL_LINES);
    }
    git(main, 'config', 'diff.strict.binary', 'true');
    git(main, 'config', 'diff.loose.binary', 'false');
    commitAttrRepo(main);

    defaultDriver = await initAttrRepo('tsgit-grep-attr-default-');
    await writeFile(
      path.join(defaultDriver, '.gitattributes'),
      'ghost.txt diff=ghost\ncpp.txt diff=cpp\n',
    );
    for (const name of ['ghost', 'cpp', 'plain']) {
      await writeFile(path.join(defaultDriver, `${name}.txt`), TEXT_LINES);
    }
    git(defaultDriver, 'config', 'diff.default.binary', 'true');
    commitAttrRepo(defaultDriver);

    indexOnly = await initAttrRepo('tsgit-grep-attr-index-');
    await writeFile(path.join(indexOnly, '.gitattributes'), 'f1 binary\n');
    await writeFile(path.join(indexOnly, 'f1'), TEXT_LINES);
    commitAttrRepo(indexOnly);
    await unlink(path.join(indexOnly, '.gitattributes'));

    bareClone = `${indexOnly}-bare.git`;
    runGit(['clone', '-q', '--bare', indexOnly, bareClone]);
    runGit([`--git-dir=${bareClone}`, 'read-tree', 'HEAD']);

    windowed = await initAttrRepo('tsgit-grep-attr-window-');
    await writeFile(path.join(windowed, '.gitattributes'), 'big.txt binary\n');
    await writeFile(path.join(windowed, 'big.txt'), `${'x\n'.repeat(40_000)}NEEDLE\n`);
    commitAttrRepo(windowed);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const repo of [main, defaultDriver, indexOnly, windowed, bareClone]) {
      await rm(repo, { recursive: true, force: true });
    }
  });

  const targets: ReadonlyArray<{ label: string; flags: ReadonlyArray<string>; cached: boolean }> = [
    { label: 'the work tree', flags: [], cached: false },
    { label: '--cached', flags: ['--cached'], cached: true },
  ];

  const grepTarget = (repo: string, cached: boolean, invert = false): Promise<GrepResult> =>
    grep(createNodeContext({ workDir: repo }), {
      patterns: [{ fixed: LIT }],
      ...(cached ? { target: 'index' as const } : {}),
      ...(invert ? { invert: true } : {}),
    });

  describe.each(targets)('Given $label as the target', ({ flags, cached }) => {
    describe('When searching the main fixture', () => {
      it('Then -n rows equal git grep', async () => {
        // Arrange
        const sut = grepTarget;

        // Act
        const result = await sut(main, cached);

        // Assert
        const expected = lines(git(main, 'grep', '-n', '-F', ...flags, LIT));
        expect(pathLines('', result).sort()).toEqual(expected.sort());
      });

      it('Then -c rows equal git grep', async () => {
        // Arrange
        const sut = grepTarget;

        // Act
        const result = await sut(main, cached);

        // Assert
        const expected = lines(git(main, 'grep', '-c', '-F', ...flags, LIT));
        expect(countLines('', result).sort()).toEqual(expected.sort());
      });

      it('Then -v -c rows equal git grep', async () => {
        // Arrange
        const sut = grepTarget;

        // Act
        const result = await sut(main, cached, true);

        // Assert
        const expected = lines(git(main, 'grep', '-v', '-c', '-F', ...flags, LIT));
        expect(countLines('', result).sort()).toEqual(expected.sort());
      });
    });

    describe('When the .gitattributes exists only in the index', () => {
      it('Then -n rows equal git grep', async () => {
        // Arrange
        const sut = grepTarget;

        // Act
        const result = await sut(indexOnly, cached);

        // Assert
        const expected = lines(git(indexOnly, 'grep', '-n', '-F', ...flags, LIT));
        expect(pathLines('', result).sort()).toEqual(expected.sort());
      });
    });

    describe('When a forced-binary file matches only beyond 64 KiB', () => {
      it('Then -n and -c rows equal git grep', async () => {
        // Arrange
        const sut = grepTarget;

        // Act
        const result = await sut(windowed, cached);

        // Assert
        expect(pathLines('', result)).toEqual(
          lines(git(windowed, 'grep', '-n', '-F', ...flags, LIT)),
        );
        expect(countLines('', result)).toEqual(
          lines(git(windowed, 'grep', '-c', '-F', ...flags, LIT)),
        );
      });
    });
  });

  describe('Given --cached and diff.default.binary', () => {
    describe('When a path names an unknown driver, a builtin driver or none', () => {
      it('Then -n rows equal git grep', async () => {
        // Arrange
        const sut = grepTarget;

        // Act
        const result = await sut(defaultDriver, true);

        // Assert
        const expected = lines(git(defaultDriver, 'grep', '-n', '-F', '--cached', LIT));
        expect(pathLines('', result).sort()).toEqual(expected.sort());
      });
    });
  });

  describe('Given a bare repository whose index holds a .gitattributes', () => {
    describe('When grepping --cached', () => {
      it('Then the index copy is not read and the rows equal git grep', async () => {
        // Arrange
        const sut = grep;
        const bareCtx = createNodeContext({ workDir: bareClone, gitDir: bareClone, bare: true });

        // Act
        const result = await sut(bareCtx, { patterns: [{ fixed: LIT }], target: 'index' });

        // Assert
        const expected = lines(git(bareClone, 'grep', '-n', '-F', '--cached', LIT));
        expect(pathLines('', result)).toEqual(expected);
      });
    });
  });
});

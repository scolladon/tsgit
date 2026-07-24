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
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type GrepResult, grep } from '../../src/application/commands/grep.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

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
 * Reconstruct git's per-path count for `-c`. Binary blobs that matched report
 * count=1 in git's output; tsgit reports binaryMatch:true with hits:[]. The
 * caller derives the same count from the structured datum.
 */
const deriveCount = (paths: GrepResult['paths']): Map<string, number> =>
  new Map(paths.map((p) => [p.path as string, p.binaryMatch ? 1 : p.hits.length]));

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
 * matched are included in both the list and the count (git counts them as 1).
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

describe.skipIf(!GIT_AVAILABLE)('grep interop', () => {
  let dir: string;
  let ctx: Context;

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

    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // #T1 — working-tree default sees an unstaged change on a tracked file
  // ---------------------------------------------------------------------------
  describe('Given the working-tree target (default)', () => {
    describe('When grepping for the literal in wt_only_unstaged.txt', () => {
      it('Then tsgit finds the path and git grep agrees', async () => {
        // Arrange
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: LIT }] });
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
        // Arrange
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: LIT }], target: 'index' });
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
    it.each(OMIT_MATRIX)(
      'Then tsgit omits $label, does not throw, and git grep agrees',
      async ({ path: excludedPath, run, gitArgs, stripHeadPrefix }) => {
        // Act — must not throw (git exits 0 when no match found due to absent files)
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

  // ---------------------------------------------------------------------------
  // #L1 — 1-based line numbering: NEEDLE is on line 12 of a.txt
  // ---------------------------------------------------------------------------
  describe('Given a multi-line blob with NEEDLE on line 12', () => {
    describe('When grepping the working tree for the literal', () => {
      it('Then tsgit reports lineNumber 12 and git grep -n agrees', async () => {
        // Arrange
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: LIT }] });
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
  describe('Given 5 enumerated text paths and 1 binary path of which 3+1 contain NEEDLE', () => {
    describe('When grepping the HEAD treeish for the literal', () => {
      it('Then tsgit derives the same matching paths and per-file counts as git grep -l/-c', async () => {
        // Arrange
        const sut = grep;

        // Act
        const result = await sut(ctx, {
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
        // Arrange
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: LIT }] });
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
});

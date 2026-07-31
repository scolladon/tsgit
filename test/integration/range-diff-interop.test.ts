/**
 * Cross-tool interop — `range-diff`. Builds repositories with canonical git
 * (deterministic dates, signing off), runs real `git range-diff -s`, and
 * reconstructs that output byte-for-byte from tsgit's structured
 * `RangeDiffEntry[]` (positions, oids, status marker, subject). The assignment —
 * exact + min-cost matching, the integer-division creation threshold, and the
 * interleaved output order — is what is pinned; the library emits no line. The
 * structured `diffOfDiffs` is additionally checked present + non-trivial for a
 * changed pair (its rendered body is a caller projection, per ADR-279).
 *
 * @proves
 *   surface:        rangeDiff
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's range-diff data reconstructs canonical `git range-diff -s`
 *   interopSurface: rangeDiff
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type RangeDiffEntry,
  rangeDiff as rangeDiffCmd,
} from '../../src/application/commands/range-diff.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@x',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@x',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

let clock = 1_700_000_000;

const writeAndCommit = async (
  dir: string,
  file: string,
  content: string,
  message: string,
): Promise<void> => {
  clock += 60;
  await writeFile(path.join(dir, file), content);
  runGit(['-C', dir, 'add', '-A'], { env: datedEnv(clock) });
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: datedEnv(clock) });
};

const MARKER: Record<RangeDiffEntry['status'], string> = {
  unchanged: '=',
  changed: '!',
  'only-old': '<',
  'only-new': '>',
};

/** Reconstruct `git range-diff -s` from the structured entries. */
const reconstructS = (entries: ReadonlyArray<RangeDiffEntry>): string => {
  const oldCount = Math.max(0, ...entries.flatMap((e) => (e.old ? [e.old.position] : [])));
  const newCount = Math.max(0, ...entries.flatMap((e) => (e.new ? [e.new.position] : [])));
  const width = String(1 + Math.max(oldCount, newCount)).length;
  const dashes = '-'.repeat(7);
  const cell = (commit?: { position: number; id: string }): string =>
    commit
      ? `${String(commit.position).padStart(width)}:  ${commit.id.slice(0, 7)}`
      : `${'-'.padStart(width)}:  ${dashes}`;
  return `${entries
    .map((e) => `${cell(e.old)} ${MARKER[e.status]} ${cell(e.new)} ${e.subject}`)
    .join('\n')}\n`;
};

let root: string;
let ctx: Context;
let baseRev: string;

const range = (base: string, tip: string) => ({ base, tip });

const runs = GIT_AVAILABLE ? describe : describe.skip;

runs('range-diff interop', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rangediff-'));
    runGit(['-C', root, 'init', '-q', '-b', 'main'], { env: datedEnv(clock) });
    ctx = createNodeContext({ workDir: root });

    // base commit, then two diverging series (v1 "old", v2 "new").
    const big = (changed: string): string => {
      const lines: string[] = [];
      for (let n = 1; n <= 25; n++) lines.push(n === 13 ? changed : `line ${n}`);
      return `${lines.join('\n')}\n`;
    };
    await writeAndCommit(root, 'seed.txt', 'seed\n', 'seed');
    const base = git(root, 'rev-parse', 'HEAD').trim();

    // A function-bearing source file whose change sits inside `compute()`, so
    // git emits an `@@ src.c: int compute(int n)` heading — exercising the
    // funcname path in the cost / `=`/`!` decision the `-s` assertion pins.
    const src = (last: string): string =>
      `int compute(int n)\n{\n\tint total = 0;\n\tfor (int i = 0; i < n; i++)\n\t\ttotal += i;\n\t${last}\n}\n`;

    runGit(['-C', root, 'checkout', '-q', '-b', 'v1'], { env: datedEnv(clock) });
    await writeAndCommit(root, 'a.txt', big('thirteen'), 'feat A');
    await writeAndCommit(root, 'b.txt', 'just b\n', 'feat B');
    await writeAndCommit(root, 'c.txt', big('c-only-old'), 'feat C');
    await writeAndCommit(root, 'src.c', src('return total;'), 'feat S');

    runGit(['-C', root, 'checkout', '-q', base], { env: datedEnv(clock) });
    runGit(['-C', root, 'checkout', '-q', '-b', 'v2'], { env: datedEnv(clock) });
    await writeAndCommit(root, 'a.txt', big('thirteen'), 'feat A'); // identical → '='
    await writeAndCommit(root, 'c.txt', big('c-changed-new'), 'feat C'); // big, near-identical → '!'
    await writeAndCommit(root, 'e.txt', 'just e\n', 'feat E'); // new → '>'
    await writeAndCommit(root, 'src.c', src('return total + 1;'), 'feat S'); // funcname-bearing change

    baseRev = base;
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe('Given the base commit and diverging v1/v2 series built in beforeAll', () => {
    describe('When range-diff -s runs with default options', () => {
      it('Then range-diff -s reconstructs byte-for-byte', async () => {
        // Arrange
        const expected = git(root, 'range-diff', '-s', `${baseRev}..v1`, `${baseRev}..v2`);

        // Act
        const entries = await rangeDiffCmd(ctx, {
          old: range(baseRev, 'v1'),
          new: range(baseRev, 'v2'),
        });

        // Assert
        expect(reconstructS(entries)).toBe(expected);
      });
    });

    describe('When range-diff -s runs with --creation-factor=1', () => {
      it('Then --creation-factor=1 reconstructs byte-for-byte', async () => {
        // Arrange — a low factor forces creations/deletions over fuzzy matches
        const expected = git(
          root,
          'range-diff',
          '-s',
          '--creation-factor=1',
          `${baseRev}..v1`,
          `${baseRev}..v2`,
        );

        // Act
        const entries = await rangeDiffCmd(ctx, {
          old: range(baseRev, 'v1'),
          new: range(baseRev, 'v2'),
          creationFactor: 1,
        });

        // Assert
        expect(reconstructS(entries)).toBe(expected);
      });
    });

    describe('When range-diff -s runs with --left-only', () => {
      it('Then --left-only is the entries that touch the old range', async () => {
        // Arrange
        const expected = git(
          root,
          'range-diff',
          '-s',
          '--left-only',
          `${baseRev}..v1`,
          `${baseRev}..v2`,
        );

        // Act
        const entries = await rangeDiffCmd(ctx, {
          old: range(baseRev, 'v1'),
          new: range(baseRev, 'v2'),
        });
        const leftOnly = entries.filter((e) => e.old);

        // Assert
        expect(reconstructS(leftOnly)).toBe(expected);
      });
    });

    describe('When a changed pair is inspected for its diff-of-diffs', () => {
      it('Then a changed pair carries a diff-of-diffs over the ## patch texts', async () => {
        // Arrange & Act
        const entries = await rangeDiffCmd(ctx, {
          old: range(baseRev, 'v1'),
          new: range(baseRev, 'v2'),
        });
        const changed = entries.find((e) => e.status === 'changed');

        // Assert — the structured diff-of-diffs is present and non-trivial
        expect(changed?.diffOfDiffs).toBeDefined();
        expect(changed?.diffOfDiffs?.hunks.some((h) => h.kind !== 'common')).toBe(true);
      });
    });
  });

  // C8 — a NUL-free single line over MAX_LINE_BYTES: the line-length cap no longer
  // decides isBinary, so each commit's per-file diff carries full text hunks instead
  // of collapsing to an identical "Binary files … differ" line. Before the fix both
  // sides render that identical binary line regardless of content, so the pair looks
  // unchanged; after the fix the real content difference surfaces as `changed`, with a
  // non-trivial diff-of-diffs — matching git. Isolated repo/series: a huge single-line
  // file would otherwise disturb the funcname/cost matching pinned by the tests above.
  describe('Given a series introducing a NUL-free over-cap single line differently on each side', () => {
    let longRoot: string;
    let longCtx: Context;
    let longBase: string;

    beforeAll(async () => {
      longRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rangediff-longline-'));
      runGit(['-C', longRoot, 'init', '-q', '-b', 'main'], { env: datedEnv(clock) });
      longCtx = createNodeContext({ workDir: longRoot });

      await writeAndCommit(longRoot, 'seed.txt', 'seed\n', 'seed');
      longBase = git(longRoot, 'rev-parse', 'HEAD').trim();

      runGit(['-C', longRoot, 'checkout', '-q', '-b', 'lv1'], { env: datedEnv(clock) });
      await writeAndCommit(longRoot, 'longline.txt', `${'a'.repeat(69_999)}X\n`, 'feat long');

      runGit(['-C', longRoot, 'checkout', '-q', longBase], { env: datedEnv(clock) });
      runGit(['-C', longRoot, 'checkout', '-q', '-b', 'lv2'], { env: datedEnv(clock) });
      await writeAndCommit(longRoot, 'longline.txt', `${'a'.repeat(69_999)}Y\n`, 'feat long');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (longRoot) await rm(longRoot, { recursive: true, force: true });
    });

    describe('When range-diff -s runs with --creation-factor=999 (so the pair actually matches)', () => {
      it('Then the pair is reported changed, reconstructs byte-for-byte, and carries real hunks', async () => {
        // Arrange
        const expected = git(
          longRoot,
          'range-diff',
          '-s',
          '--creation-factor=999',
          `${longBase}..lv1`,
          `${longBase}..lv2`,
        );

        // Act
        const entries = await rangeDiffCmd(longCtx, {
          old: range(longBase, 'lv1'),
          new: range(longBase, 'lv2'),
          creationFactor: 999,
        });

        // Assert — status matches git's own verdict, and the matched pair's
        // diff-of-diffs is non-trivial: a collapsed "Binary files" line would be
        // byte-identical on both sides and never surface as a real difference.
        expect(reconstructS(entries)).toBe(expected);
        const changed = entries.find((e) => e.status === 'changed');
        expect(changed?.diffOfDiffs).toBeDefined();
        expect(changed?.diffOfDiffs?.hunks.some((h) => h.kind !== 'common')).toBe(true);
      });
    });
  });

  // C8/DC-16 — a NUL-free file with over MAX_LINES lines, differing by a single
  // line on each side: the edit distance from either parent to the shared base
  // is 2 (one delete, one insert), far under the cap, so each commit's per-file
  // diff carries full text hunks instead of collapsing into a whole-file
  // replace. Isolated repo/series, matching the longline series above.
  describe('Given a series introducing a many-line file with a single differing line on each side', () => {
    let manyRoot: string;
    let manyCtx: Context;
    let manyBase: string;

    beforeAll(async () => {
      manyRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rangediff-manylines-'));
      runGit(['-C', manyRoot, 'init', '-q', '-b', 'main'], { env: datedEnv(clock) });
      manyCtx = createNodeContext({ workDir: manyRoot });

      const count = 100_001;
      const baseLines = Array.from({ length: count }, (_, i) => `line-${i}`);
      const base = `${baseLines.join('\n')}\n`;
      await writeAndCommit(manyRoot, 'manylines.txt', base, 'seed');
      manyBase = git(manyRoot, 'rev-parse', 'HEAD').trim();

      runGit(['-C', manyRoot, 'checkout', '-q', '-b', 'mv1'], { env: datedEnv(clock) });
      const v1Lines = [...baseLines];
      v1Lines[5] = 'V1 CHANGE';
      await writeAndCommit(manyRoot, 'manylines.txt', `${v1Lines.join('\n')}\n`, 'feat many');

      runGit(['-C', manyRoot, 'checkout', '-q', manyBase], { env: datedEnv(clock) });
      runGit(['-C', manyRoot, 'checkout', '-q', '-b', 'mv2'], { env: datedEnv(clock) });
      const v2Lines = [...baseLines];
      v2Lines[5] = 'V2 CHANGE';
      await writeAndCommit(manyRoot, 'manylines.txt', `${v2Lines.join('\n')}\n`, 'feat many');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (manyRoot) await rm(manyRoot, { recursive: true, force: true });
    });

    describe('When range-diff -s runs', () => {
      it('Then the pair is reported changed, reconstructs byte-for-byte, and carries real hunks', async () => {
        // Arrange
        const expected = git(manyRoot, 'range-diff', '-s', `${manyBase}..mv1`, `${manyBase}..mv2`);

        // Act
        const entries = await rangeDiffCmd(manyCtx, {
          old: range(manyBase, 'mv1'),
          new: range(manyBase, 'mv2'),
        });

        // Assert — status matches git's own verdict, and the matched pair's
        // diff-of-diffs is non-trivial: a collapsed whole-file replace would
        // never surface the specific line-level difference.
        expect(reconstructS(entries)).toBe(expected);
        const changed = entries.find((e) => e.status === 'changed');
        expect(changed?.diffOfDiffs).toBeDefined();
        expect(changed?.diffOfDiffs?.hunks.some((h) => h.kind !== 'common')).toBe(true);
      });
    });
  });
});

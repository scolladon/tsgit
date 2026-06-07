/**
 * Cross-tool interop — `range-diff`. Builds repositories with canonical git
 * (deterministic dates, signing off), runs real `git range-diff -s`, and
 * reconstructs that output byte-for-byte from tsgit's structured
 * `RangeDiffEntry[]` (positions, oids, status marker, subject). The assignment —
 * exact + min-cost matching, the integer-division creation threshold, and the
 * interleaved output order — is what is pinned; the library emits no line. The
 * default-`-p` diff-of-diffs body is additionally reconstructed for a changed
 * pair from the structured `diffOfDiffs`.
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

    (globalThis as { __base?: string }).__base = base;
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const base = (): string => (globalThis as { __base?: string }).__base!;

  it('Then range-diff -s reconstructs byte-for-byte', async () => {
    // Arrange
    const expected = git(root, 'range-diff', '-s', `${base()}..v1`, `${base()}..v2`);

    // Act
    const entries = await rangeDiffCmd(ctx, {
      old: range(base(), 'v1'),
      new: range(base(), 'v2'),
    });

    // Assert
    expect(reconstructS(entries)).toBe(expected);
  });

  it('Then --creation-factor=1 reconstructs byte-for-byte', async () => {
    // Arrange — a low factor forces creations/deletions over fuzzy matches
    const expected = git(
      root,
      'range-diff',
      '-s',
      '--creation-factor=1',
      `${base()}..v1`,
      `${base()}..v2`,
    );

    // Act
    const entries = await rangeDiffCmd(ctx, {
      old: range(base(), 'v1'),
      new: range(base(), 'v2'),
      creationFactor: 1,
    });

    // Assert
    expect(reconstructS(entries)).toBe(expected);
  });

  it('Then --left-only is the entries that touch the old range', async () => {
    // Arrange
    const expected = git(root, 'range-diff', '-s', '--left-only', `${base()}..v1`, `${base()}..v2`);

    // Act
    const entries = await rangeDiffCmd(ctx, { old: range(base(), 'v1'), new: range(base(), 'v2') });
    const leftOnly = entries.filter((e) => e.old);

    // Assert
    expect(reconstructS(leftOnly)).toBe(expected);
  });

  it('Then a changed pair carries a diff-of-diffs over the ## patch texts', async () => {
    // Act
    const entries = await rangeDiffCmd(ctx, { old: range(base(), 'v1'), new: range(base(), 'v2') });
    const changed = entries.find((e) => e.status === 'changed');

    // Assert — the structured diff-of-diffs is present and non-trivial
    expect(changed?.diffOfDiffs).toBeDefined();
    expect(changed?.diffOfDiffs?.hunks.some((h) => h.kind !== 'common')).toBe(true);
  });
});

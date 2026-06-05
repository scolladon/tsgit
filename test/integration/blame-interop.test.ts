/**
 * Cross-tool interop — `blame`. Builds repositories with canonical git
 * (deterministic dates, signing off), runs tsgit's `blame`, reconstructs
 * `git blame --porcelain` from the structured `BlameResult`, and asserts the
 * reconstruction is byte-identical to real `git blame --porcelain`.
 *
 * Faithfulness is pinned on the DATA (per-line commit, original/final line
 * numbers, rename-aware source path, author/committer/summary, boundary,
 * previous) — the library emits no porcelain line of its own. Repos are built
 * once in `beforeAll` (mirroring `describe-interop`) to keep git spawns low.
 *
 * @proves
 *   surface:        blame
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's blame data reconstructs canonical `git blame --porcelain`
 *   interopSurface: blame
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type BlameLine, type BlameResult, blame } from '../../src/application/commands/blame.js';
import { ZERO_OID } from '../../src/domain/objects/object-id.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

/** Porcelain renders the zero oid for the "Not Committed Yet" pseudo-commit. */
const oidOf = (line: BlameLine): string => (line.committed ? line.commit : ZERO_OID);

const SETUP_TIMEOUT = 60_000;
const decoder = new TextDecoder();

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

const makeRepo = async (slug: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-blame-${slug}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
};

const commitContent = async (dir: string, file: string, content: string): Promise<void> => {
  clock += 60;
  await writeFile(path.join(dir, file), content);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', `edit ${file}`], { env: datedEnv(clock) });
};

/**
 * git's "Not Committed Yet" identity is fabricated at the current wall-clock time;
 * the library emits none of it, so the renderer supplies it. `author-time`/`-tz`
 * carry placeholders that `scrubNow` (below) normalises on both sides — every other
 * byte (oid, identity, summary, previous) stays pinned.
 */
const uncommittedBlock = (line: BlameLine): string => {
  const lines = [
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 0',
    'author-tz +0000',
    'committer Not Committed Yet',
    'committer-mail <not.committed.yet>',
    'committer-time 0',
    'committer-tz +0000',
    `summary Version of ${line.sourcePath} from ${line.sourcePath}`,
    ...(line.previous !== undefined
      ? [`previous ${line.previous.commit} ${line.previous.path}`]
      : []),
    `filename ${line.sourcePath}`,
  ];
  return `${lines.join('\n')}\n`;
};

const metadataBlock = (line: BlameLine): string => {
  if (!line.committed) return uncommittedBlock(line);
  const lines = [
    `author ${line.author.name}`,
    `author-mail <${line.author.email}>`,
    `author-time ${line.author.timestamp}`,
    `author-tz ${line.author.timezoneOffset}`,
    `committer ${line.committer.name}`,
    `committer-mail <${line.committer.email}>`,
    `committer-time ${line.committer.timestamp}`,
    `committer-tz ${line.committer.timezoneOffset}`,
    `summary ${line.summary}`,
    ...(line.boundary ? ['boundary'] : []),
    ...(line.previous !== undefined
      ? [`previous ${line.previous.commit} ${line.previous.path}`]
      : []),
    `filename ${line.sourcePath}`,
  ];
  return `${lines.join('\n')}\n`;
};

const isContiguous = (a: BlameLine, b: BlameLine): boolean =>
  oidOf(b) === oidOf(a) && b.finalLine === a.finalLine + 1 && b.sourceLine === a.sourceLine + 1;

/** Reconstruct `git blame --porcelain` output from tsgit's structured result. */
const renderPorcelain = (result: BlameResult): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  let i = 0;
  while (i < result.lines.length) {
    const start = i;
    while (i + 1 < result.lines.length && isContiguous(result.lines[i]!, result.lines[i + 1]!)) i++;
    const count = i - start + 1;
    for (let k = start; k <= i; k++) {
      const line = result.lines[k]!;
      const oid = oidOf(line);
      const header = `${oid} ${line.sourceLine} ${line.finalLine}`;
      out.push(k === start ? `${header} ${count}\n` : `${header}\n`);
      if (!seen.has(oid)) {
        seen.add(oid);
        out.push(metadataBlock(line));
      }
      out.push(`\t${decoder.decode(line.content)}`);
    }
    i++;
  }
  return out.join('');
};

const gitPorcelain = (dir: string, file: string, ...flags: string[]): string =>
  git(dir, 'blame', '--porcelain', ...flags, 'HEAD', '--', file);

/** Bare `git blame --porcelain <file>` — the working-tree pseudo-commit form (no rev). */
const gitPorcelainWorktree = (dir: string, file: string, ...flags: string[]): string =>
  git(dir, 'blame', '--porcelain', ...flags, file);

/**
 * git fabricates the pseudo-commit's author/committer time and tz at the current
 * wall-clock instant (the one byte sequence it cannot reproduce). Normalise both
 * sides' "Not Committed Yet" time/tz so every other byte stays pinned. Anchored on
 * `committer Not Committed Yet`, so committed lines' real times are untouched.
 */
const scrubNow = (porcelain: string): string =>
  porcelain.replace(
    /author-time \d+\nauthor-tz [+-]\d{4}\ncommitter Not Committed Yet\ncommitter-mail <not\.committed\.yet>\ncommitter-time \d+\ncommitter-tz [+-]\d{4}/g,
    'author-time 0\nauthor-tz +0000\ncommitter Not Committed Yet\ncommitter-mail <not.committed.yet>\ncommitter-time 0\ncommitter-tz +0000',
  );

describe.skipIf(!GIT_AVAILABLE)('blame interop', () => {
  let linear: { dir: string; ctx: Context };
  let prepend: { dir: string; ctx: Context };
  let merged: { dir: string; ctx: Context };
  let renamed: { dir: string; ctx: Context };
  let worktree: { dir: string; ctx: Context };

  beforeAll(async () => {
    const linearDir = await makeRepo('linear');
    await commitContent(linearDir, 'f.txt', 'line1\nline2\nline3\n');
    await commitContent(linearDir, 'f.txt', 'line1\nline2-mod\nline3\nline4\n');
    linear = { dir: linearDir, ctx: createNodeContext({ workDir: linearDir }) };

    const prependDir = await makeRepo('prepend');
    await commitContent(prependDir, 'f.txt', 'orig1\norig2\n');
    await commitContent(prependDir, 'f.txt', 'new1\nnew2\norig1\norig2\n');
    prepend = { dir: prependDir, ctx: createNodeContext({ workDir: prependDir }) };

    const mergeDir = await makeRepo('merge');
    await commitContent(mergeDir, 'f.txt', 'a\nb\nc\n');
    git(mergeDir, 'checkout', '-q', '-b', 'side');
    await commitContent(mergeDir, 'f.txt', 'a-side\nb\nc\n');
    git(mergeDir, 'checkout', '-q', 'main');
    await commitContent(mergeDir, 'f.txt', 'a\nb\nc-main\n');
    clock += 60;
    runGit(['-C', mergeDir, 'merge', '-q', '--no-edit', 'side'], { env: datedEnv(clock) });
    merged = { dir: mergeDir, ctx: createNodeContext({ workDir: mergeDir }) };

    const renameDir = await makeRepo('rename');
    await commitContent(renameDir, 'f.txt', 'l1\nl2\n');
    await commitContent(renameDir, 'f.txt', 'l1\nl2-mod\n');
    git(renameDir, 'mv', 'f.txt', 'renamed.txt');
    clock += 60;
    runGit(['-C', renameDir, 'commit', '-q', '-m', 'rename'], { env: datedEnv(clock) });
    renamed = { dir: renameDir, ctx: createNodeContext({ workDir: renameDir }) };

    // Worktree: commit a/b/c, then dirty line 2 + append a line (uncommitted), and
    // stage a never-committed new file — covers the modified, appended, and
    // staged-new pseudo-commit cases.
    const worktreeDir = await makeRepo('worktree');
    await commitContent(worktreeDir, 'f.txt', 'a\nb\nc\n');
    await writeFile(path.join(worktreeDir, 'f.txt'), 'a\nB\nc\nNEW\n');
    await writeFile(path.join(worktreeDir, 'staged.txt'), 'p\nq\n');
    git(worktreeDir, 'add', 'staged.txt');
    worktree = { dir: worktreeDir, ctx: createNodeContext({ workDir: worktreeDir }) };
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await Promise.all(
      [linear, prepend, merged, renamed, worktree].map((r) =>
        rm(r.dir, { recursive: true, force: true }),
      ),
    );
  });

  it('Then linear history reconstructs git blame --porcelain', async () => {
    expect(renderPorcelain(await blame(linear.ctx, 'f.txt'))).toBe(
      gitPorcelain(linear.dir, 'f.txt'),
    );
  });

  it('Then a prepend shift reconstructs git blame --porcelain', async () => {
    expect(renderPorcelain(await blame(prepend.ctx, 'f.txt'))).toBe(
      gitPorcelain(prepend.dir, 'f.txt'),
    );
  });

  it('Then a clean merge reconstructs git blame --porcelain', async () => {
    expect(renderPorcelain(await blame(merged.ctx, 'f.txt'))).toBe(
      gitPorcelain(merged.dir, 'f.txt'),
    );
  });

  it('Then a followed rename reconstructs git blame --porcelain', async () => {
    expect(renderPorcelain(await blame(renamed.ctx, 'renamed.txt'))).toBe(
      gitPorcelain(renamed.dir, 'renamed.txt'),
    );
  });

  it('Then an -L range reconstructs git blame --porcelain -L', async () => {
    const ours = renderPorcelain(await blame(linear.ctx, 'f.txt', { range: { start: 2, end: 3 } }));
    expect(ours).toBe(gitPorcelain(linear.dir, 'f.txt', '-L', '2,3'));
  });

  it('Then a dirty working tree reconstructs bare git blame --porcelain', async () => {
    const ours = renderPorcelain(await blame(worktree.ctx, 'f.txt', { worktree: true }));
    expect(scrubNow(ours)).toBe(scrubNow(gitPorcelainWorktree(worktree.dir, 'f.txt')));
  });

  it('Then a staged-new file reconstructs bare git blame --porcelain', async () => {
    const ours = renderPorcelain(await blame(worktree.ctx, 'staged.txt', { worktree: true }));
    expect(scrubNow(ours)).toBe(scrubNow(gitPorcelainWorktree(worktree.dir, 'staged.txt')));
  });

  it('Then a worktree -L range spanning committed and uncommitted lines reconstructs git blame', async () => {
    const ours = renderPorcelain(
      await blame(worktree.ctx, 'f.txt', { worktree: true, range: { start: 1, end: 2 } }),
    );
    expect(scrubNow(ours)).toBe(scrubNow(gitPorcelainWorktree(worktree.dir, 'f.txt', '-L', '1,2')));
  });
});

/**
 * Cross-tool interop — `describe`. Builds a small set of repositories with
 * canonical git (deterministic dates, signing off), then reconstructs git's
 * `describe` line from tsgit's structured `DescribeResult` and asserts it is
 * identical to real `git describe`. Faithfulness is pinned on the DATA (selected
 * tag, exact distance, refusal conditions) — the library emits no line of its own.
 *
 * Repos are built once in `beforeAll` (mirroring `show-interop`) to keep the git
 * subprocess count low; most assertions reuse the rich shared repo.
 *
 * @proves
 *   surface:        describe
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's describe data reconstructs canonical `git describe`
 *   interopSurface: describe
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type DescribeResult,
  describe as describeCmd,
} from '../../src/application/commands/describe.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

const ABBREV = 7;
const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

/** Reconstruct git's default `describe` line from tsgit's structured data. */
const render = (r: DescribeResult): string => {
  const core =
    r.tag === undefined
      ? r.oid.slice(0, ABBREV)
      : r.exact
        ? r.name
        : `${r.name}-${r.distance}-g${r.oid.slice(0, ABBREV)}`;
  return r.dirty ? `${core}-dirty` : core;
};

/** Reconstruct git's `--long` line (suffix always present). */
const renderLong = (r: DescribeResult): string =>
  `${r.name}-${r.distance}-g${r.oid.slice(0, ABBREV)}`;

let clock = 1_700_000_000;

const makeRepo = async (slug: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-describe-${slug}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  return dir;
};

const commitFile = async (dir: string, name: string): Promise<string> => {
  clock += 60;
  await writeFile(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', name], { env: datedEnv(clock) });
  return git(dir, 'rev-parse', 'HEAD').trim();
};

const annotate = (dir: string, name: string, epoch: number): void => {
  runGit(['-C', dir, 'tag', '-a', name, '-m', `tag ${name}`], { env: datedEnv(epoch) });
};

const gitDescribe = (dir: string, ...args: string[]): string =>
  git(dir, 'describe', ...args).trim();

describe.skipIf(!GIT_AVAILABLE)('describe interop', () => {
  // A single rich repo carries the common assertions: c1 has two annotated tags
  // with different tagger dates (dedup) plus a lightweight tag; c2 has v2.0 and a
  // branch; c3 (HEAD) is untagged.
  let rich = '';
  let richCtx: Context;
  let c1 = '';
  let c2 = '';

  beforeAll(async () => {
    rich = await makeRepo('rich');
    richCtx = createNodeContext({ workDir: rich });
    c1 = await commitFile(rich, 'c1');
    annotate(rich, 'older', 1_700_001_000);
    annotate(rich, 'newer', 1_700_009_000);
    git(rich, 'tag', 'lw1');
    c2 = await commitFile(rich, 'c2');
    annotate(rich, 'v2.0', clock + 30);
    git(rich, 'branch', 'feat');
    await commitFile(rich, 'c3');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(rich, { recursive: true, force: true });
  });

  const DESCRIBE_FLAG_MATRIX: ReadonlyArray<{
    label: string;
    run: () => Promise<DescribeResult>;
    gitArgs: () => readonly string[];
  }> = [
    { label: 'the nearest tag (no flags)', run: () => describeCmd(richCtx), gitArgs: () => [] },
    {
      label: 'a --match filter',
      run: () => describeCmd(richCtx, undefined, { match: 'v*' }),
      gitArgs: () => ['--match', 'v*'],
    },
    {
      label: '--tags',
      run: () => describeCmd(richCtx, undefined, { tags: true }),
      gitArgs: () => ['--tags'],
    },
    {
      label: '--all on a branch commit',
      run: () => describeCmd(richCtx, c2, { all: true }),
      gitArgs: () => ['--all', c2],
    },
  ];

  it.each(DESCRIBE_FLAG_MATRIX)('Then $label matches git describe', async ({ run, gitArgs }) => {
    expect(render(await run())).toBe(gitDescribe(rich, ...gitArgs()));
  });

  it('Then the --long line matches git describe --long', async () => {
    expect(renderLong(await describeCmd(richCtx))).toBe(gitDescribe(rich, '--long'));
  });

  it('Then an exact commit with two same-commit tags matches git (newer wins)', async () => {
    const sut = await describeCmd(richCtx, c1);
    expect(sut.exact).toBe(true);
    expect(render(sut)).toBe(gitDescribe(rich, c1));
  });

  it('Then exactMatch on an untagged HEAD co-refuses with git', async () => {
    const gitResult = tryRunGit(['-C', rich, 'describe', '--exact-match']);
    let threw = false;
    try {
      await describeCmd(richCtx, undefined, { exactMatch: true });
    } catch {
      threw = true;
    }
    expect(gitResult.ok).toBe(false);
    expect(threw).toBe(true);
  });

  describe('Given a merge whose parents each carry a tag', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('merge');
      ctx = createNodeContext({ workDir: dir });
      await commitFile(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'feat');
      await commitFile(dir, 'f1');
      annotate(dir, 'feat-tag', clock + 30);
      git(dir, 'checkout', '-q', 'main');
      await commitFile(dir, 'm1');
      annotate(dir, 'main-tag', clock + 30);
      clock += 60;
      runGit(['-C', dir, 'merge', '-q', '--no-ff', 'feat', '-m', 'merge feat'], {
        env: datedEnv(clock),
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then default and --first-parent both match git', async () => {
      expect(render(await describeCmd(ctx))).toBe(gitDescribe(dir));
      expect(render(await describeCmd(ctx, undefined, { firstParent: true }))).toBe(
        gitDescribe(dir, '--first-parent'),
      );
    });
  });

  // The candidate cap changes which tag is reported: `side` sits on a newer-dated
  // commit (so the date-ordered walk meets it first) but is structurally farther
  // from HEAD, while `near` is older-dated yet nearer. git freezes the candidate
  // set the moment every name is collected, sorts on the frozen partial depths (a
  // `side`/`near` tie), breaks the tie on found order (`side` first), then
  // finalises the winner's depth — so BOTH the default and `--candidates=1`
  // reconstruct `git describe` exactly, keeping the farther, first-met `side`.
  describe('Given a newer-dated tag farther than an older nearer tag', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('candidate-cap');
      ctx = createNodeContext({ workDir: dir });
      const base = await commitFile(dir, 'base');
      await commitFile(dir, 'n1');
      await commitFile(dir, 'n2');
      annotate(dir, 'near', clock + 30);
      git(dir, 'checkout', '-q', '-b', 'side', base);
      await commitFile(dir, 's1');
      annotate(dir, 'side', clock + 30);
      git(dir, 'checkout', '-q', 'main');
      clock += 60;
      runGit(['-C', dir, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side'], {
        env: datedEnv(clock),
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then default describe keeps the farther, first-met tag, matching git', async () => {
      expect(render(await describeCmd(ctx))).toBe(gitDescribe(dir));
    });

    it('Then --candidates=1 spends its slot on the farther (newer-found) tag, matching git', async () => {
      expect(render(await describeCmd(ctx, undefined, { candidates: 1 }))).toBe(
        gitDescribe(dir, '--candidates=1'),
      );
    });
  });

  // A tag behind a convergence: `ay` (newer) and `bee` (older) are equidistant
  // children of `p`; `old` sits two commits further back. git fires its
  // "covered path" early break at `p` and reports the first-met `ay` without ever
  // reaching `old`. tsgit omits that break (it cannot change the result), walking
  // the full set and even collecting `old` — yet still reports `ay` because `old`
  // is farther and never wins. This pins that omission against regression.
  describe('Given an annotated tag behind a merge convergence', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('convergence');
      ctx = createNodeContext({ workDir: dir });
      await commitFile(dir, 'base');
      await commitFile(dir, 'cold');
      annotate(dir, 'old', clock + 30);
      const p = await commitFile(dir, 'cp');
      await commitFile(dir, 'bee');
      annotate(dir, 'bee', clock + 30);
      git(dir, 'checkout', '-q', '-b', 'topic', p);
      await commitFile(dir, 'cay');
      annotate(dir, 'ay', clock + 30);
      git(dir, 'checkout', '-q', 'main');
      clock += 60;
      runGit(['-C', dir, 'merge', '-q', '--no-ff', 'topic', '-m', 'merge topic'], {
        env: datedEnv(clock),
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then default describe reports the nearest first-met tag, matching git', async () => {
      expect(render(await describeCmd(ctx))).toBe(gitDescribe(dir));
    });
  });

  // Three tags where the candidate budget changes the answer: `t2` is met first
  // (newest) but `t1` is structurally nearer. With the full budget every name is
  // collected and the frozen sort picks the nearer `t1`; with one slot the walk
  // keeps the first-met `t2`. Both reconstruct real git exactly — pinning that the
  // budget, not only the total-name count, is faithfully load-bearing.
  describe('Given three tags where the candidate budget changes the result', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('budget');
      ctx = createNodeContext({ workDir: dir });
      const base = await commitFile(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'br0', base);
      const b0 = await commitFile(dir, 'b0');
      annotate(dir, 't0', clock + 5);
      git(dir, 'checkout', '-q', '-b', 'br1', b0);
      await commitFile(dir, 'b1a');
      await commitFile(dir, 'b1b');
      annotate(dir, 't1', clock + 5);
      git(dir, 'checkout', '-q', '-b', 'br2', base);
      await commitFile(dir, 'b2a');
      await commitFile(dir, 'b2b');
      annotate(dir, 't2', clock + 5);
      git(dir, 'checkout', '-q', 'main');
      clock += 60;
      runGit(['-C', dir, 'merge', '-q', '--no-ff', 'br2', 'br1', '-m', 'merge'], {
        env: datedEnv(clock),
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then the full budget keeps the nearer later-met tag, matching git', async () => {
      expect(render(await describeCmd(ctx))).toBe(gitDescribe(dir));
    });

    it('Then a single slot keeps the first-met tag instead, matching git', async () => {
      expect(render(await describeCmd(ctx, undefined, { candidates: 1 }))).toBe(
        gitDescribe(dir, '--candidates=1'),
      );
    });
  });

  describe('Given a repository with no tags', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('no-tags');
      ctx = createNodeContext({ workDir: dir });
      await commitFile(dir, 'c1');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then --always reconstructs git describe --always', async () => {
      const sut = await describeCmd(ctx, undefined, { always: true });
      expect(sut.tag).toBeUndefined();
      expect(render(sut)).toBe(gitDescribe(dir, '--always'));
    });

    it('Then describe co-refuses with git (no --always)', async () => {
      const gitResult = tryRunGit(['-C', dir, 'describe']);
      let threw = false;
      try {
        await describeCmd(ctx);
      } catch {
        threw = true;
      }
      expect(gitResult.ok).toBe(false);
      expect(threw).toBe(true);
    });
  });

  interface DirtyStateFixture {
    readonly dir: string;
    readonly ctx: Context;
  }

  const DIRTY_STATE_MATRIX: ReadonlyArray<{
    label: string;
    expectedDirty: boolean;
    build: () => Promise<DirtyStateFixture>;
  }> = [
    {
      label: 'a clean tree has no dirty mark',
      expectedDirty: false,
      build: async () => {
        const dir = await makeRepo('dirty-clean');
        const ctx = createNodeContext({ workDir: dir });
        await commitFile(dir, 'c1');
        annotate(dir, 'v1.0', clock + 30);
        return { dir, ctx };
      },
    },
    {
      label: 'a tracked change reconstructs git describe --dirty',
      expectedDirty: true,
      build: async () => {
        const dir = await makeRepo('dirty-tracked');
        const ctx = createNodeContext({ workDir: dir });
        await commitFile(dir, 'c1');
        annotate(dir, 'v1.0', clock + 30);
        await writeFile(path.join(dir, 'c1.txt'), 'changed\n');
        return { dir, ctx };
      },
    },
    {
      // Stage (not just touch) the change — the working tree matches the index, so
      // only the staged column is dirty. git's `--dirty` (diff-index HEAD) agrees.
      label: 'a staged-only change reconstructs git describe --dirty',
      expectedDirty: true,
      build: async () => {
        const dir = await makeRepo('dirty-staged');
        const ctx = createNodeContext({ workDir: dir });
        await commitFile(dir, 'c1');
        annotate(dir, 'v1.0', clock + 30);
        await writeFile(path.join(dir, 'c1.txt'), 'changed\n');
        git(dir, 'add', 'c1.txt');
        return { dir, ctx };
      },
    },
    {
      // A mid-merge index (stage 1/2/3 entries) is dirty per git's diff-index HEAD,
      // even though no path appears in the staged or working-tree columns.
      label: 'a conflicted (mid-merge) index reconstructs git describe --dirty',
      expectedDirty: true,
      build: async () => {
        const dir = await makeRepo('dirty-conflict');
        const ctx = createNodeContext({ workDir: dir });
        await writeFile(path.join(dir, 'f.txt'), 'shared\n');
        git(dir, 'add', '-A');
        runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env: datedEnv(clock) });
        annotate(dir, 'v1.0', clock + 30);
        git(dir, 'checkout', '-q', '-b', 'feature');
        await writeFile(path.join(dir, 'f.txt'), 'theirs\n');
        git(dir, 'add', '-A');
        runGit(['-C', dir, 'commit', '-q', '-m', 'feature'], { env: datedEnv(clock + 60) });
        git(dir, 'checkout', '-q', 'main');
        await writeFile(path.join(dir, 'f.txt'), 'ours\n');
        git(dir, 'add', '-A');
        runGit(['-C', dir, 'commit', '-q', '-m', 'on-main'], { env: datedEnv(clock + 120) });
        tryRunGit(['-C', dir, 'merge', 'feature'], { env: datedEnv(clock + 180) });
        return { dir, ctx };
      },
    },
  ];

  describe('Given a repository state that determines the --dirty mark', () => {
    it.each(DIRTY_STATE_MATRIX)(
      'Then $label',
      async ({ expectedDirty, build }) => {
        // Arrange
        const { dir, ctx } = await build();
        try {
          // Act
          const sut = await describeCmd(ctx, undefined, { dirty: true });

          // Assert
          expect(sut.dirty).toBe(expectedDirty);
          expect(render(sut)).toBe(gitDescribe(dir, '--dirty'));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      SETUP_TIMEOUT,
    );
  });
});

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
  git(dir, 'config', 'commit.gpgsign', 'false');
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

  it('Then the nearest-tag line matches git describe', async () => {
    expect(render(await describeCmd(richCtx))).toBe(gitDescribe(rich));
  });

  it('Then the --long line matches git describe --long', async () => {
    expect(renderLong(await describeCmd(richCtx))).toBe(gitDescribe(rich, '--long'));
  });

  it('Then an exact commit with two same-commit tags matches git (newer wins)', async () => {
    const sut = await describeCmd(richCtx, c1);
    expect(sut.exact).toBe(true);
    expect(render(sut)).toBe(gitDescribe(rich, c1));
  });

  it('Then a --match filter matches git describe --match', async () => {
    expect(render(await describeCmd(richCtx, undefined, { match: 'v*' }))).toBe(
      gitDescribe(rich, '--match', 'v*'),
    );
  });

  it('Then --tags reconstructs git describe --tags', async () => {
    expect(render(await describeCmd(richCtx, undefined, { tags: true }))).toBe(
      gitDescribe(rich, '--tags'),
    );
  });

  it('Then --all on a branch commit matches git describe --all', async () => {
    expect(render(await describeCmd(richCtx, c2, { all: true }))).toBe(
      gitDescribe(rich, '--all', c2),
    );
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

  describe('Given a tagged HEAD with --dirty', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('dirty');
      ctx = createNodeContext({ workDir: dir });
      await commitFile(dir, 'c1');
      annotate(dir, 'v1.0', clock + 30);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then a clean tree has no dirty mark', async () => {
      expect(render(await describeCmd(ctx, undefined, { dirty: true }))).toBe(
        gitDescribe(dir, '--dirty'),
      );
    });

    it('Then a tracked change reconstructs git describe --dirty', async () => {
      await writeFile(path.join(dir, 'c1.txt'), 'changed\n');
      const sut = await describeCmd(ctx, undefined, { dirty: true });
      expect(sut.dirty).toBe(true);
      expect(render(sut)).toBe(gitDescribe(dir, '--dirty'));
    });
  });

  describe('Given a tagged HEAD with a staged-only change and --dirty', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('staged-dirty');
      ctx = createNodeContext({ workDir: dir });
      await commitFile(dir, 'c1');
      annotate(dir, 'v1.0', clock + 30);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then a staged change reconstructs git describe --dirty', async () => {
      // Stage (not just touch) the change — the working tree matches the index, so
      // only the staged column is dirty. git's `--dirty` (diff-index HEAD) agrees.
      await writeFile(path.join(dir, 'c1.txt'), 'changed\n');
      git(dir, 'add', 'c1.txt');
      const sut = await describeCmd(ctx, undefined, { dirty: true });
      expect(sut.dirty).toBe(true);
      expect(render(sut)).toBe(gitDescribe(dir, '--dirty'));
    });
  });

  describe('Given a conflicted index (mid-merge) with --dirty', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('conflict-dirty');
      ctx = createNodeContext({ workDir: dir });
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
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then the conflicted index reconstructs git describe --dirty', async () => {
      // A mid-merge index (stage 1/2/3 entries) is dirty per git's diff-index HEAD,
      // even though no path appears in the staged or working-tree columns.
      const sut = await describeCmd(ctx, undefined, { dirty: true });
      expect(sut.dirty).toBe(true);
      expect(render(sut)).toBe(gitDescribe(dir, '--dirty'));
    });
  });
});

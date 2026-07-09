/**
 * Cross-tool interop — `name-rev` + `describe --contains`. Builds repositories
 * with canonical git (deterministic dates, signing off), then reconstructs git's
 * `name-rev --name-only` / `describe --contains` line from tsgit's structured
 * `NameRevResult` and asserts it is identical to real git. Faithfulness is pinned
 * on the DATA (chosen ref, `~`/`^` path, refusal) — the library emits no line.
 *
 * @proves
 *   surface:        nameRev
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's name-rev data reconstructs canonical `git name-rev`
 *   interopSurface: nameRev
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { describe as describeCmd } from '../../src/application/commands/describe.js';
import {
  type NameRevResult,
  nameRev as nameRevCmd,
} from '../../src/application/commands/name-rev.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

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

const suffix = (r: NameRevResult): string =>
  r.steps.map((s) => (s.kind === 'ancestor' ? `~${s.count}` : `^${s.number}`)).join('');

/** Reconstruct `git name-rev --name-only` (strip `refs/heads/`, else `refs/`). */
const renderNameRev = (r: NameRevResult): string => {
  if (r.ref === undefined) return 'undefined';
  const base = r.ref.startsWith('refs/heads/')
    ? r.ref.slice('refs/heads/'.length)
    : r.ref.replace(/^refs\//, '');
  if (r.steps.length === 0) return r.tagDeref ? `${base}^0` : base;
  return base + suffix(r);
};

/** Reconstruct `git describe --contains` (rev-parse short name: strip `refs/tags/`). */
const renderContains = (r: NameRevResult): string => {
  const base = (r.ref as string).replace(/^refs\/tags\//, '').replace(/^refs\//, '');
  if (r.steps.length === 0) return r.tagDeref ? `${base}^0` : base;
  return base + suffix(r);
};

let clock = 1_700_000_000;

/** git's `CUTOFF_DATE_SLOP` (one day, in seconds) — local to keep the fixtures self-contained. */
const CUTOFF_DATE_SLOP = 86_400;

const makeRepo = async (slug: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-name-rev-${slug}-`));
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

const gitNameRev = (dir: string, sha: string, ...args: string[]): string =>
  git(dir, 'name-rev', '--name-only', ...args, sha).trim();

describe.skipIf(!GIT_AVAILABLE)('name-rev interop', () => {
  describe('Given a linear history with lightweight and annotated tags', () => {
    let dir = '';
    let ctx: Context;
    let c0 = '';
    let c1 = '';
    let c2 = '';

    beforeAll(async () => {
      dir = await makeRepo('linear');
      ctx = createNodeContext({ workDir: dir });
      c0 = await commitFile(dir, 'c0');
      c1 = await commitFile(dir, 'c1');
      git(dir, 'tag', 'light'); // lightweight on c1
      c2 = await commitFile(dir, 'c2');
      annotate(dir, 'rel', clock + 30); // annotated on c2 (HEAD)
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then the annotated tip renders with `^0`', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, c2))).toBe(gitNameRev(dir, c2));
    });

    it('Then a lightweight tag renders without `^0`', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, c1))).toBe(gitNameRev(dir, c1));
    });

    it('Then a first-parent ancestor renders with `~n`', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, c0))).toBe(gitNameRev(dir, c0));
    });

    it('Then a refs filter matches git name-rev --refs', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, c0, { refs: 'refs/tags/rel*' }))).toBe(
        gitNameRev(dir, c0, '--refs=refs/tags/rel*'),
      );
    });

    it('Then an exclude filter matches git name-rev --exclude', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, c0, { exclude: 'refs/tags/*' }))).toBe(
        gitNameRev(dir, c0, '--exclude=refs/tags/*'),
      );
    });

    it('Then describe --contains reconstructs git describe --contains', async () => {
      expect(renderContains(await describeCmd(ctx, c0, { contains: true }))).toBe(
        git(dir, 'describe', '--contains', c0).trim(),
      );
    });

    it('Then describe --contains --match reconstructs git', async () => {
      expect(renderContains(await describeCmd(ctx, c0, { contains: true, match: 'rel*' }))).toBe(
        git(dir, 'describe', '--contains', '--match', 'rel*', c0).trim(),
      );
    });
  });

  describe('Given a merge with a multi-commit side branch', () => {
    let dir = '';
    let ctx: Context;
    let base = '';
    let m1 = '';
    let merge = '';
    let f0 = '';
    let f1 = '';

    beforeAll(async () => {
      dir = await makeRepo('merge');
      ctx = createNodeContext({ workDir: dir });
      base = await commitFile(dir, 'base');
      git(dir, 'checkout', '-q', '-b', 'feat');
      f0 = await commitFile(dir, 'f0');
      f1 = await commitFile(dir, 'f1');
      git(dir, 'checkout', '-q', 'main');
      m1 = await commitFile(dir, 'm1');
      clock += 60;
      runGit(['-C', dir, 'merge', '-q', '--no-ff', 'feat', '-m', 'merge feat'], {
        env: datedEnv(clock),
      });
      merge = git(dir, 'rev-parse', 'HEAD').trim();
      await commitFile(dir, 'top');
      annotate(dir, 'rel', clock + 30);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then first-parent ancestors render with `~n`', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, merge))).toBe(gitNameRev(dir, merge));
      expect(renderNameRev(await nameRevCmd(ctx, m1))).toBe(gitNameRev(dir, m1));
      expect(renderNameRev(await nameRevCmd(ctx, base))).toBe(gitNameRev(dir, base));
    });

    it('Then a merged side commit threads `^2`', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, f1))).toBe(gitNameRev(dir, f1));
    });

    it('Then a deeper side commit renders the full `~m^2~k` path', async () => {
      expect(renderNameRev(await nameRevCmd(ctx, f0))).toBe(gitNameRev(dir, f0));
    });
  });

  describe('Given a repository with no tags', () => {
    let dir = '';
    let ctx: Context;
    let c0 = '';

    beforeAll(async () => {
      dir = await makeRepo('untagged');
      ctx = createNodeContext({ workDir: dir });
      c0 = await commitFile(dir, 'c0');
      await commitFile(dir, 'c1');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then tags-only naming is undefined, matching git name-rev --tags', async () => {
      const sut = await nameRevCmd(ctx, c0, { tags: true });
      expect(sut.ref).toBeUndefined();
      expect(renderNameRev(sut)).toBe(gitNameRev(dir, c0, '--tags'));
    });

    it('Then describe --contains co-refuses with git on an unnameable commit', async () => {
      const gitResult = tryRunGit(['-C', dir, 'describe', '--contains', c0]);
      let threw = false;
      try {
        await describeCmd(ctx, c0, { contains: true });
      } catch {
        threw = true;
      }
      expect(gitResult.ok).toBe(false);
      expect(threw).toBe(true);
    });
  });

  describe('Given a linear history with a far-older pruned ancestor', () => {
    let dir = '';
    let ctx: Context;
    let c1 = '';

    beforeAll(async () => {
      dir = await makeRepo('cutoff-ancestor');
      ctx = createNodeContext({ workDir: dir });
      await commitFile(dir, 'c0'); // date(c0) far below cutoff — pruned from the walk
      clock += CUTOFF_DATE_SLOP + 60; // advance clock > 1 day so the cutoff actually fires
      c1 = await commitFile(dir, 'c1');
      await commitFile(dir, 'c2');
      await commitFile(dir, 'c3');
      annotate(dir, 'rel', clock + 30); // annotated on c3 (HEAD)
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then the middle commit still resolves with the far-older ancestor pruned', async () => {
      const sut = await nameRevCmd(ctx, c1);
      expect(renderNameRev(sut)).toBe(gitNameRev(dir, c1));
    });
  });

  describe('Given two tagged refs where the older tip is more than a day before the newer', () => {
    let dir = '';
    let ctx: Context;
    let newCommit = '';

    beforeAll(async () => {
      dir = await makeRepo('cutoff-seed');
      ctx = createNodeContext({ workDir: dir });
      const oldCommit = await commitFile(dir, 'old');
      git(dir, 'tag', 'oldtag', oldCommit);
      clock += CUTOFF_DATE_SLOP + 60; // advance clock > 1 day so the seed-tip guard fires
      newCommit = await commitFile(dir, 'new');
      git(dir, 'tag', 'newtag', newCommit);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('Then the newer tag still names the newer commit with the older seed pruned', async () => {
      const sut = await nameRevCmd(ctx, newCommit);
      expect(renderNameRev(sut)).toBe(gitNameRev(dir, newCommit));
    });

    it('Then the --tags variant matches with the older seed pruned', async () => {
      const sut = await nameRevCmd(ctx, newCommit, { tags: true });
      // --tags queries only refs/tags/*, so git's short name drops the `tags/` prefix
      // it otherwise disambiguates with — renderNameRev's general reconstruction keeps it.
      const withoutTagsPrefix = renderNameRev(sut).replace(/^tags\//, '');
      expect(withoutTagsPrefix).toBe(gitNameRev(dir, newCommit, '--tags'));
    });
  });
});

/**
 * Cross-tool interop — `show`. Builds a repository with canonical git
 * (deterministic author/committer dates, signing off), then asserts that
 * `decode(show(ctx, rev).bytes)` is byte-identical to `git show <rev>` across
 * every object kind: root / modify / merge / rename commits, annotated and
 * lightweight tags, trees (by peel and by raw oid), a blob, a multi-rev
 * stream, and a custom `contextLines` patch.
 *
 * @proves
 *   surface:        show
 *   bucket:         cross-tool-interop
 *   unique:         `show` rendered bytes match canonical `git show`
 *   interopSurface: show
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type ShowOptions, show } from '../../src/application/commands/show.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const writeRepoFile = async (dir: string, rel: string, content: string): Promise<void> => {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
};

interface Built {
  readonly dir: string;
  readonly ctx: Context;
  readonly root: string;
  readonly modify: string;
  readonly merge: string;
  readonly rename: string;
  readonly tree: string;
  readonly blob: string;
  /** A merge that combines changes to different lines from both sides. */
  readonly combinedMerge: string;
  /** A three-parent octopus merge. */
  readonly octopus: string;
}

const buildRepo = async (dir: string): Promise<Built> => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // git with pinned author/committer dates (date-sensitive verbs only).
  const dated = (epoch: number, ...args: string[]): string =>
    runGit(['-C', dir, ...args], { env: dateEnv(epoch) });

  await writeRepoFile(dir, 'a.txt', 'hello\nworld\n');
  await writeRepoFile(dir, 'sub/b.txt', 'nested\n');
  git(dir, 'add', '-A');
  dated(1_700_000_000, 'commit', '-q', '-m', 'initial commit', '-m', 'second paragraph of body');
  const root = git(dir, 'rev-parse', 'HEAD').trim();

  await writeRepoFile(dir, 'a.txt', 'hello\nWORLD\nextra\n');
  git(dir, 'add', '-A');
  dated(1_700_000_100, 'commit', '-q', '-m', 'modify a.txt');
  const modify = git(dir, 'rev-parse', 'HEAD').trim();

  dated(1_700_000_100, 'tag', '-a', 'v1.0', '-m', 'release one');
  git(dir, 'tag', 'light', modify);

  git(dir, 'checkout', '-q', '-b', 'feature', root);
  await writeRepoFile(dir, 'c.txt', 'feature line\n');
  git(dir, 'add', '-A');
  dated(1_700_000_200, 'commit', '-q', '-m', 'feature commit');
  git(dir, 'checkout', '-q', 'main');
  dated(1_700_000_300, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  const merge = git(dir, 'rev-parse', 'HEAD').trim();

  git(dir, 'mv', 'a.txt', 'renamed.txt');
  dated(1_700_000_400, 'commit', '-q', '-m', 'rename a.txt');
  const rename = git(dir, 'rev-parse', 'HEAD').trim();

  // A non-trivial merge: each side edits a different line of m.txt, so the
  // combined diff differs from both parents (exercises -c/--cc and the default).
  await writeRepoFile(dir, 'm.txt', 'l1\nl2\nl3\nl4\nl5\n');
  git(dir, 'add', '-A');
  dated(1_700_000_500, 'commit', '-q', '-m', 'add m.txt');
  const mbase = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'side', mbase);
  await writeRepoFile(dir, 'm.txt', 'l1\nSIDE2\nl3\nl4\nl5\n');
  git(dir, 'add', '-A');
  dated(1_700_000_600, 'commit', '-q', '-m', 'side change l2');
  git(dir, 'checkout', '-q', 'main');
  await writeRepoFile(dir, 'm.txt', 'l1\nl2\nl3\nMAIN4\nl5\n');
  git(dir, 'add', '-A');
  dated(1_700_000_700, 'commit', '-q', '-m', 'main change l4');
  dated(1_700_000_800, 'merge', '--no-ff', 'side', '-m', 'combined merge');
  const combinedMerge = git(dir, 'rev-parse', 'HEAD').trim();

  // A three-parent octopus merge: each branch edits a distinct file (the octopus
  // strategy refuses overlapping edits to one file). Each file then differs from
  // two of the three parents, so the dense combined diff omits them all.
  await writeRepoFile(dir, 'o.txt', 'l1\nl2\n');
  await writeRepoFile(dir, 'p.txt', 'l1\nl2\n');
  await writeRepoFile(dir, 'q.txt', 'l1\nl2\n');
  git(dir, 'add', '-A');
  dated(1_700_000_900, 'commit', '-q', '-m', 'add octopus files');
  const obase = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'octoA', obase);
  await writeRepoFile(dir, 'o.txt', 'l1\nAAA\n');
  git(dir, 'add', '-A');
  dated(1_700_001_000, 'commit', '-q', '-m', 'octoA change o.txt');
  git(dir, 'checkout', '-q', '-b', 'octoB', obase);
  await writeRepoFile(dir, 'p.txt', 'l1\nBBB\n');
  git(dir, 'add', '-A');
  dated(1_700_001_100, 'commit', '-q', '-m', 'octoB change p.txt');
  git(dir, 'checkout', '-q', 'main');
  await writeRepoFile(dir, 'q.txt', 'l1\nCCC\n');
  git(dir, 'add', '-A');
  dated(1_700_001_200, 'commit', '-q', '-m', 'main change q.txt');
  dated(1_700_001_300, 'merge', '--no-ff', 'octoA', 'octoB', '-m', 'octopus merge');
  const octopus = git(dir, 'rev-parse', 'HEAD').trim();

  const tree = git(dir, 'rev-parse', `${modify}^{tree}`).trim();
  const blob = git(dir, 'rev-parse', `${modify}:a.txt`).trim();
  return {
    dir,
    ctx: createNodeContext({ workDir: dir }),
    root,
    modify,
    merge,
    rename,
    tree,
    blob,
    combinedMerge,
    octopus,
  };
};

describe.skipIf(!GIT_AVAILABLE)('show interop', () => {
  let dir: string;
  let built: Built;

  // `show` is read-only, so the fixture repo is built once and shared. The
  // generous timeout absorbs the ~dozen synchronous `git` spawns (incl. a
  // merge) under parallel integration load, where a per-test build times out.
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-show-'));
    built = await buildRepo(dir);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const expectMatch = async (rev: string): Promise<void> => {
    const expected = git(dir, 'show', '--no-color', rev);
    const result = await show(built.ctx, rev);
    expect(decode(result.bytes)).toBe(expected);
  };

  const expectMatchFlags = async (
    gitFlags: ReadonlyArray<string>,
    rev: string,
    opts: ShowOptions,
  ): Promise<void> => {
    const expected = git(dir, 'show', '--no-color', ...gitFlags, rev);
    const result = await show(built.ctx, rev, opts);
    expect(decode(result.bytes)).toBe(expected);
  };

  describe('Given a single revision', () => {
    it('Then a root commit matches git show', async () => {
      await expectMatch(built.root);
    });
    it('Then a non-root commit matches git show', async () => {
      await expectMatch(built.modify);
    });
    it('Then a merge commit (Merge line, no patch) matches git show', async () => {
      await expectMatch(built.merge);
    });
    it('Then a rename commit matches git show', async () => {
      await expectMatch(built.rename);
    });
    it('Then an annotated tag matches git show', async () => {
      await expectMatch('v1.0');
    });
    it('Then a lightweight tag renders as its commit, matching git show', async () => {
      await expectMatch('light');
    });
    it('Then a tree by peel echoes the input and matches git show', async () => {
      await expectMatch(`${built.modify}^{tree}`);
    });
    it('Then a tree by raw oid matches git show', async () => {
      await expectMatch(built.tree);
    });
    it('Then a blob matches git show', async () => {
      await expectMatch(built.blob);
    });
  });

  describe('Given multiple revisions', () => {
    it('Then the concatenated stream matches git show A B', async () => {
      // Arrange
      const expected = git(dir, 'show', '--no-color', built.modify, built.root);

      // Act
      const result = await show(built.ctx, [built.modify, built.root]);

      // Assert
      expect(decode(result.bytes)).toBe(expected);
    });
  });

  describe('Given a custom context-line count', () => {
    it('Then the commit patch matches git show -U1', async () => {
      // Arrange
      const expected = git(dir, 'show', '--no-color', '-U1', built.modify);

      // Act
      const result = await show(built.ctx, built.modify, { contextLines: 1 });

      // Assert
      expect(decode(result.bytes)).toBe(expected);
    });
  });

  describe('Given -s / --no-patch', () => {
    it('Then a non-merge commit shows the header + message only', async () => {
      await expectMatchFlags(['-s'], built.modify, { noPatch: true });
    });
    it('Then a merge commit drops the trailing-blank terminator too', async () => {
      await expectMatchFlags(['-s'], built.merge, { noPatch: true });
    });
  });

  describe('Given a <rev>:<path> tree lookup', () => {
    it('Then a blob path dumps the raw blob, matching git show', async () => {
      await expectMatch(`${built.modify}:a.txt`);
    });
    it('Then a nested blob path resolves through sub-trees', async () => {
      await expectMatch(`${built.modify}:sub/b.txt`);
    });
    it('Then an empty path lists the root tree, echoing the input', async () => {
      await expectMatch(`${built.modify}:`);
    });
    it('Then a sub-directory path lists that tree, echoing the input', async () => {
      await expectMatch(`${built.modify}:sub`);
    });
  });

  describe('Given an absolute --date= mode', () => {
    // `local` matches because git inherits the runner's TZ and tsgit reads the
    // same process zone; the rest use the identity's stored offset.
    const modes = ['iso', 'iso-strict', 'rfc', 'short', 'raw', 'unix', 'default', 'local'] as const;
    for (const mode of modes) {
      it(`Then --date=${mode} matches git show`, async () => {
        await expectMatchFlags([`--date=${mode}`], built.modify, { date: mode });
      });
    }
  });

  describe('Given a built-in pretty format', () => {
    const formats = [
      'oneline',
      'short',
      'full',
      'fuller',
      'raw',
      'reference',
      'email',
      'mboxrd',
    ] as const;
    for (const format of formats) {
      it(`Then --format=${format} matches git show on a body commit`, async () => {
        // `root` carries a subject + body, exercising %b / email body.
        await expectMatchFlags([`--format=${format}`], built.root, { format });
      });
      it(`Then --format=${format} matches git show on a no-body commit`, async () => {
        await expectMatchFlags([`--format=${format}`], built.modify, { format });
      });
    }
  });

  describe('Given a custom format: / tformat: template', () => {
    it('Then a hash/ident/message template matches git show', async () => {
      await expectMatchFlags(['--format=format:%H|%h|%an <%ae>|%s|%cn|%P|%p|%t|%T'], built.modify, {
        format: 'format:%H|%h|%an <%ae>|%s|%cn|%P|%p|%t|%T',
      });
    });
    it('Then a tformat: template (with body and literals) matches git show', async () => {
      // `%xXX` is byte-faithful for ASCII only (the string pipeline UTF-8-encodes
      // high bytes); `%x41` is the letter `A`.
      const tpl = 'tformat:%h %s%n[%b]%n%ai|%aI|%at|%aD|%as%x41%%';
      await expectMatchFlags([`--format=${tpl}`], built.root, { format: tpl });
    });
    it('Then an unknown placeholder is passed through verbatim', async () => {
      await expectMatchFlags(['--format=format:[%z]%H'], built.modify, {
        format: 'format:[%z]%H',
      });
    });
  });

  describe('Given decoration placeholders', () => {
    it('Then %D on a tagged commit matches git show', async () => {
      await expectMatchFlags(['--format=format:%D'], built.modify, { format: 'format:%D' });
    });
    it('Then %d on the HEAD branch tip matches git show', async () => {
      await expectMatchFlags(['--format=format:%d'], built.rename, { format: 'format:%d' });
    });
  });

  describe('Given --format with --date interplay', () => {
    it('Then %ad honours --date=iso while %aD stays rfc', async () => {
      await expectMatchFlags(['--date=iso', '--format=format:%ad|%aD'], built.modify, {
        date: 'iso',
        format: 'format:%ad|%aD',
      });
    });
  });

  describe('Given -m on a merge commit', () => {
    it('Then it shows one (from <parent>) block per parent, matching git show -m', async () => {
      await expectMatchFlags(['-m'], built.merge, { mergeDiff: 'separate' });
    });
  });

  describe('Given a combined merge diff', () => {
    it('Then the default merge render matches git (dense --cc)', async () => {
      await expectMatch(built.combinedMerge);
    });
    it('Then --cc matches git show --cc', async () => {
      await expectMatchFlags(['--cc'], built.combinedMerge, { mergeDiff: 'dense' });
    });
    it('Then -c matches git show -c', async () => {
      await expectMatchFlags(['-c'], built.combinedMerge, { mergeDiff: 'combined' });
    });
    it('Then a trivial merge still renders no patch (empty combined diff)', async () => {
      await expectMatch(built.merge);
    });
    it('Then an octopus (three-parent) merge matches git --cc', async () => {
      await expectMatch(built.octopus);
    });
  });

  describe('Given --stat / --numstat', () => {
    it('Then --stat on a single-file change matches git', async () => {
      await expectMatchFlags(['--stat'], built.modify, { stat: true });
    });
    it('Then --numstat on a single-file change matches git', async () => {
      await expectMatchFlags(['--numstat'], built.modify, { numstat: true });
    });
    it('Then --stat on the initial (add) commit matches git', async () => {
      await expectMatchFlags(['--stat'], built.root, { stat: true });
    });
    it('Then --numstat on the initial (add) commit matches git', async () => {
      await expectMatchFlags(['--numstat'], built.root, { numstat: true });
    });
    it('Then --stat on a rename commit shows old => new with zero changes', async () => {
      await expectMatchFlags(['--stat'], built.rename, { stat: true });
    });
    it('Then --numstat on a rename commit matches git', async () => {
      await expectMatchFlags(['--numstat'], built.rename, { numstat: true });
    });
  });
});

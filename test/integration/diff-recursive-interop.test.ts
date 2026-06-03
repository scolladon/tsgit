/**
 * Integration test — byte-parity between tsgit's recursive patch text and
 * `git diff` for histories that change files **inside sub-directories**.
 *
 * `repo.diff({ recursive: true })` flattens sub-trees, so a nested change
 * reconstructs (via the `renderPatch` domain serializer) as per-file hunks keyed
 * by the full path. Double-pinned: tsgit's bytes must equal both live `git diff`
 * and a frozen golden under
 * `fixtures/diff-patch/`, so a future git output change shows up as a golden
 * drift even when tsgit and the new git move together.
 *
 * Skips silently when `git` is absent.
 *
 * @proves
 *   surface: diff.patch
 *   bucket:  cross-tool-interop
 *   unique:  recursive (sub-directory) patch text matches upstream git + a frozen golden
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import { rm } from '../../src/application/commands/rm.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, git, makePeerPair, runGit, runGitEnv } from './interop-helpers.js';

const fixturesDir = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  'fixtures',
  'diff-patch',
);

const loadGolden = (name: string): Promise<string> =>
  readFile(path.join(fixturesDir, `${name}.golden.patch`), 'utf-8');

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const gitDeterministicEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

const writePeerFile = async (dir: string, rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
};

const writeCtxFile = (
  ctx: ReturnType<typeof createMemoryContext>,
  rel: string,
  content: string,
): Promise<void> => ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: gitDeterministicEnv() });
};

describe.skipIf(!GIT_AVAILABLE)('integration — recursive (sub-directory) diff git parity', () => {
  it('Given a file modified inside a sub-directory, When tsgit emits the patch, Then it matches `git diff` byte-for-byte AND the frozen golden', async () => {
    // Arrange — `a/b.txt` changes content across two commits.
    const pair = await makePeerPair('diff-recursive-modify');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      await writePeerFile(pair.peer, 'a/b.txt', 'b1\n');
      runGit(['-C', pair.peer, 'add', 'a/b.txt']);
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'a/b.txt', 'b2\n');
      runGit(['-C', pair.peer, 'add', 'a/b.txt']);
      gitCommit(pair.peer, 'second');
      const live = git(pair.peer, 'diff', '--no-ext-diff', '--no-color', 'HEAD~1', 'HEAD');
      const golden = await loadGolden('nested-modify');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'a/b.txt', 'b1\n');
      await add(ctx, ['a/b.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'a/b.txt', 'b2\n');
      await add(ctx, ['a/b.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, recursive: true });
      const sut = await reconstructPatch(ctx, treeDiff);

      // Assert — double pin.
      expect(sut).toBe(live);
      expect(sut).toBe(golden);
    } finally {
      await pair.dispose();
    }
  });

  it('Given nested add, modify, delete and a deep nest in one diff, When tsgit emits the patch, Then it matches `git diff` AND the frozen golden', async () => {
    // Arrange — first commit seeds `del/y.txt` + `mod/m.txt`; second adds
    // `add/new.txt` and `deep/a/b/c.txt`, modifies `mod/m.txt`, deletes
    // `del/y.txt`. The recursive diff must order files by full path.
    const pair = await makePeerPair('diff-recursive-mixed');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      await writePeerFile(pair.peer, 'del/y.txt', 'y\n');
      await writePeerFile(pair.peer, 'mod/m.txt', 'm1\n');
      runGit(['-C', pair.peer, 'add', '-A']);
      gitCommit(pair.peer, 'first');
      await writePeerFile(pair.peer, 'add/new.txt', 'new\n');
      await writePeerFile(pair.peer, 'deep/a/b/c.txt', 'deep\n');
      await writePeerFile(pair.peer, 'mod/m.txt', 'm2\n');
      runGit(['-C', pair.peer, 'rm', '-q', 'del/y.txt']);
      runGit(['-C', pair.peer, 'add', '-A']);
      gitCommit(pair.peer, 'second');
      const live = git(pair.peer, 'diff', '--no-ext-diff', '--no-color', 'HEAD~1', 'HEAD');
      const golden = await loadGolden('nested-mixed');

      const ctx = createMemoryContext();
      await init(ctx);
      await writeCtxFile(ctx, 'del/y.txt', 'y\n');
      await writeCtxFile(ctx, 'mod/m.txt', 'm1\n');
      await add(ctx, ['del/y.txt', 'mod/m.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await writeCtxFile(ctx, 'add/new.txt', 'new\n');
      await writeCtxFile(ctx, 'deep/a/b/c.txt', 'deep\n');
      await writeCtxFile(ctx, 'mod/m.txt', 'm2\n');
      await rm(ctx, ['del/y.txt']);
      await add(ctx, ['add/new.txt', 'deep/a/b/c.txt', 'mod/m.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const treeDiff = await diff(ctx, { from: c1.id, to: c2.id, recursive: true });
      const sut = await reconstructPatch(ctx, treeDiff);

      // Assert — double pin.
      expect(sut).toBe(live);
      expect(sut).toBe(golden);
    } finally {
      await pair.dispose();
    }
  });
});

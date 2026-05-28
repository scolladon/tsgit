/**
 * Integration test — byte-parity between tsgit's patch text and `git diff`.
 *
 * Spawns a real `git` to capture the canonical patch for a handful of
 * representative file-class scenarios, then asserts byte-equality with
 * `repo.diff({ format: 'patch' })`'s output. Skips silently when `git` is
 * not on PATH (CI always has git; local devs may not).
 *
 * @proves
 *   surface: diff:patch
 *   bucket:  cross-tool-interop
 *   unique:  patch-text serializer's byte-output matches upstream git's
 */
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import { rm } from '../../src/application/commands/rm.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, git, makePeerPair, runGit, runGitEnv } from './interop-helpers.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const writeFsFile = (dir: string, name: string, content: string): Promise<void> =>
  writeFile(`${dir}/${name}`, content);

const gitDeterministicEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

describe.skipIf(!GIT_AVAILABLE)('integration — diff patch git parity', () => {
  it('Given a single-line modify, When tsgit emits the patch, Then it matches `git diff` byte-for-byte', async () => {
    // Arrange — build the same history in a tmp `git` repo and in tsgit.
    const pair = await makePeerPair('diff-patch-modify');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      await writeFsFile(pair.peer, 'a.txt', 'old\n');
      runGit(['-C', pair.peer, 'add', 'a.txt']);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', 'first'], { env: gitDeterministicEnv() });
      await writeFsFile(pair.peer, 'a.txt', 'new\n');
      runGit(['-C', pair.peer, 'add', 'a.txt']);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', 'second'], { env: gitDeterministicEnv() });
      const expected = git(pair.peer, 'diff', '--no-ext-diff', '--no-color', 'HEAD~1', 'HEAD');

      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'old\n');
      await add(ctx, ['a.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'new\n');
      await add(ctx, ['a.txt']);
      const c2 = await commit(ctx, { message: 'second', author });

      // Act
      const sut = await diff(ctx, { from: c1.id, to: c2.id, format: 'patch' });

      // Assert
      expect(sut.text).toBe(expected);
    } finally {
      await pair.dispose();
    }
  });

  it('Given an added file then a deleted file, When tsgit emits the combined patch, Then headers match git', async () => {
    // Arrange — first commit adds two files; second deletes one.
    const pair = await makePeerPair('diff-patch-add-delete');
    try {
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      await writeFsFile(pair.peer, 'keep.txt', 'keep\n');
      runGit(['-C', pair.peer, 'add', 'keep.txt']);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', 'first'], { env: gitDeterministicEnv() });
      await writeFsFile(pair.peer, 'gone.txt', 'bye\n');
      await writeFsFile(pair.peer, 'fresh.txt', 'hello\n');
      runGit(['-C', pair.peer, 'add', 'gone.txt', 'fresh.txt']);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', 'second'], { env: gitDeterministicEnv() });
      runGit(['-C', pair.peer, 'rm', '-q', 'gone.txt']);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', 'third'], { env: gitDeterministicEnv() });
      const expected = git(pair.peer, 'diff', '--no-ext-diff', '--no-color', 'HEAD~2', 'HEAD');

      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/keep.txt`, 'keep\n');
      await add(ctx, ['keep.txt']);
      const c1 = await commit(ctx, { message: 'first', author });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/gone.txt`, 'bye\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/fresh.txt`, 'hello\n');
      await add(ctx, ['gone.txt', 'fresh.txt']);
      await commit(ctx, { message: 'second', author });
      await rm(ctx, ['gone.txt']);
      const c3 = await commit(ctx, { message: 'third', author });

      // Act
      const sut = await diff(ctx, { from: c1.id, to: c3.id, format: 'patch' });

      // Assert
      expect(sut.text).toBe(expected);
    } finally {
      await pair.dispose();
    }
  });
});

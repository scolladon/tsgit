/**
 * Integration — reflog writer wiring. Drives the real command surface end to
 * end through the memory adapter and asserts the `.git/logs/**` files that
 * `updateRef` / `recordRefUpdate` produce, then cross-checks the on-disk
 * format against canonical `git` where the binary is available.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { branch } from '../../src/application/commands/branch.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { commit } from '../../src/application/commands/commit.js';
import { init } from '../../src/application/commands/init.js';
import { merge } from '../../src/application/commands/merge.js';
import { reset } from '../../src/application/commands/reset.js';
import { tag } from '../../src/application/commands/tag.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { readReflog } from '../../src/application/primitives/reflog-store.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../src/domain/objects/index.js';
import { parseReflog, serializeReflogLine } from '../../src/domain/reflog/reflog-format.js';
import type { Context } from '../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MAIN = 'refs/heads/main' as RefName;
const HEAD = 'HEAD' as RefName;

const seed = async (
  tree: Readonly<Record<string, string>> = { 'a.txt': 'a' },
): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [name, content] of Object.entries(tree)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, content);
  }
  await add(ctx, Object.keys(tree));
  return ctx;
};

const stageFile = async (ctx: Context, name: string, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, content);
  await add(ctx, [name]);
};

afterEach(() => {
  __resetConfigCacheForTests();
});

describe('integration — reflog writers', () => {
  it('Given two commits on main, When committed, Then HEAD and the branch log both entries with catalogued messages', async () => {
    // Arrange
    const ctx = await seed();

    // Act
    const first = await commit(ctx, { message: 'first', author });
    await stageFile(ctx, 'b.txt', 'b');
    const second = await commit(ctx, { message: 'second', author });

    // Assert — branch log
    const branchLog = await readReflog(ctx, MAIN);
    expect(branchLog).toHaveLength(2);
    expect(branchLog[0]?.oldId).toBe('0'.repeat(40));
    expect(branchLog[0]?.newId).toBe(first.id);
    expect(branchLog[0]?.message).toBe('commit (initial): first');
    expect(branchLog[1]?.oldId).toBe(first.id);
    expect(branchLog[1]?.newId).toBe(second.id);
    expect(branchLog[1]?.message).toBe('commit: second');

    // Assert — HEAD log mirrors the branch (HEAD coupling)
    const headLog = await readReflog(ctx, HEAD);
    expect(headLog.map((e) => e.newId)).toEqual([first.id, second.id]);
    expect(headLog.map((e) => e.message)).toEqual(['commit (initial): first', 'commit: second']);
  });

  it('Given a branch created from a start point, When created, Then the new branch log records the creation', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });

    // Act
    await branch(ctx, { kind: 'create', name: 'feature', startPoint: 'main' });

    // Assert
    const log = await readReflog(ctx, 'refs/heads/feature' as RefName);
    expect(log).toHaveLength(1);
    expect(log[0]?.message).toBe('branch: Created from main');
  });

  it('Given a branch with history, When renamed, Then the moved log is preserved and a rename entry is appended', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await stageFile(ctx, 'b.txt', 'b');
    await commit(ctx, { message: 'second', author });
    const before = await readReflog(ctx, MAIN);
    expect(before).toHaveLength(2);

    // Act
    await branch(ctx, { kind: 'rename', from: 'main', to: 'trunk' });

    // Assert — source log is gone, history survived on the target
    expect(await readReflog(ctx, MAIN)).toEqual([]);
    const renamed = await readReflog(ctx, 'refs/heads/trunk' as RefName);
    expect(renamed.slice(0, 2).map((e) => e.message)).toEqual([
      'commit (initial): first',
      'commit: second',
    ]);
    expect(renamed.at(-1)?.message).toBe('branch: renamed refs/heads/main to refs/heads/trunk');
  });

  it('Given a branch with a reflog, When deleted, Then the reflog file is removed', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature', startPoint: 'main' });
    expect(await readReflog(ctx, 'refs/heads/feature' as RefName)).toHaveLength(1);

    // Act
    await branch(ctx, { kind: 'delete', name: 'feature' });

    // Assert
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/heads/feature`)).toBe(false);
  });

  it('Given a branch switch, When checkout moves HEAD, Then HEAD logs the move with both labels', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature', startPoint: 'main' });

    // Act
    await checkout(ctx, { target: 'feature' });

    // Assert
    const headLog = await readReflog(ctx, HEAD);
    expect(headLog.at(-1)?.message).toBe('checkout: moving from main to feature');
  });

  it('Given a detached checkout, When checkout moves HEAD to a commit, Then HEAD logs the move', async () => {
    // Arrange
    const ctx = await seed();
    const first = await commit(ctx, { message: 'first', author });

    // Act
    await checkout(ctx, { target: first.id, detach: true });

    // Assert
    const headLog = await readReflog(ctx, HEAD);
    expect(headLog.at(-1)?.message).toBe(`checkout: moving from main to ${first.id.slice(0, 7)}`);
    expect(headLog.at(-1)?.newId).toBe(first.id);
  });

  it('Given a reset to an earlier commit, When reset runs, Then the branch and HEAD log the move', async () => {
    // Arrange
    const ctx = await seed();
    const first = await commit(ctx, { message: 'first', author });
    await stageFile(ctx, 'b.txt', 'b');
    await commit(ctx, { message: 'second', author });

    // Act
    await reset(ctx, { mode: 'soft', target: first.id });

    // Assert
    const headLog = await readReflog(ctx, HEAD);
    expect(headLog.at(-1)?.message).toBe(`reset: moving to ${first.id}`);
    expect(headLog.at(-1)?.newId).toBe(first.id);
  });

  it('Given diverged branches resolvable by fast-forward, When merged, Then a fast-forward entry is logged', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature', startPoint: 'main' });
    await checkout(ctx, { target: 'feature' });
    await stageFile(ctx, 'b.txt', 'b');
    await commit(ctx, { message: 'on feature', author });
    await checkout(ctx, { target: 'main' });

    // Act
    await merge(ctx, { target: 'feature', author });

    // Assert
    const branchLog = await readReflog(ctx, MAIN);
    expect(branchLog.at(-1)?.message).toBe('merge feature: Fast-forward');
  });

  it('Given two diverged branches, When merged cleanly, Then a merge-commit entry is logged', async () => {
    // Arrange
    const ctx = await seed({ 'a.txt': 'a' });
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature', startPoint: 'main' });
    await checkout(ctx, { target: 'feature' });
    await stageFile(ctx, 'feature.txt', 'f');
    await commit(ctx, { message: 'on feature', author });
    await checkout(ctx, { target: 'main' });
    await stageFile(ctx, 'mainline.txt', 'm');
    await commit(ctx, { message: 'on main', author });

    // Act
    await merge(ctx, { target: 'feature', author });

    // Assert
    const branchLog = await readReflog(ctx, MAIN);
    expect(branchLog.at(-1)?.message).toBe("merge feature: Merge made by the 'tsgit' strategy.");
  });

  it('Given a tag created under the default config, When the tag is made, Then no reflog file is written', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });

    // Act
    await tag(ctx, { kind: 'create', name: 'v1' });

    // Assert — refs/tags/* is not default-loggable
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/tags/v1`)).toBe(false);
    expect(await readReflog(ctx, 'refs/tags/v1' as RefName)).toEqual([]);
  });
});

const findGit = (): string | undefined => {
  try {
    execFileSync('git', ['--version']);
    return 'git';
  } catch {
    return undefined;
  }
};

const GIT = findGit();

describe.skipIf(GIT === undefined)('integration — reflog interop with canonical git', () => {
  let tmpdir: string;

  beforeEach(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-'));
  });

  afterEach(async () => {
    await rm(tmpdir, { recursive: true, force: true });
  });

  it('Given a reflog tsgit writes, When git reflog reads it, Then git parses every entry', async () => {
    // Arrange — a real git repo with one commit, then a tsgit-formatted line
    execFileSync('git', ['init', '-q', '-b', 'main', tmpdir]);
    execFileSync('git', ['-C', tmpdir, 'config', 'user.name', 'Ada']);
    execFileSync('git', ['-C', tmpdir, 'config', 'user.email', 'ada@example.com']);
    execFileSync('git', ['-C', tmpdir, 'commit', '-q', '--allow-empty', '-m', 'seed']);
    const headOid = execFileSync('git', ['-C', tmpdir, 'rev-parse', 'HEAD'])
      .toString()
      .trim() as ObjectId;
    const line = serializeReflogLine({
      oldId: headOid,
      newId: headOid,
      identity: author,
      message: 'reset: moving to HEAD',
    });

    // Act — append the tsgit-serialized entry, then ask git to read the log
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path.join(tmpdir, '.git', 'logs', 'HEAD'), line);
    const reflog = execFileSync('git', ['-C', tmpdir, 'reflog', 'show', 'HEAD']).toString().trim();

    // Assert — git surfaces the tsgit-written entry
    expect(reflog).toContain('reset: moving to HEAD');
  });

  it('Given a reflog git wrote, When readReflog parses it, Then every entry round-trips', async () => {
    // Arrange — git produces a multi-entry HEAD reflog
    execFileSync('git', ['init', '-q', '-b', 'main', tmpdir]);
    execFileSync('git', ['-C', tmpdir, 'config', 'user.name', 'Ada']);
    execFileSync('git', ['-C', tmpdir, 'config', 'user.email', 'ada@example.com']);
    execFileSync('git', ['-C', tmpdir, 'commit', '-q', '--allow-empty', '-m', 'first']);
    execFileSync('git', ['-C', tmpdir, 'commit', '-q', '--allow-empty', '-m', 'second']);

    // Act
    const raw = await readFile(path.join(tmpdir, '.git', 'logs', 'HEAD'), 'utf8');
    const sut = parseReflog(raw);

    // Assert — both commit entries parsed, oldest-first
    expect(sut).toHaveLength(2);
    expect(sut[0]?.oldId).toBe('0'.repeat(40));
    expect(sut[0]?.message).toBe('commit (initial): first');
    expect(sut[1]?.oldId).toBe(sut[0]?.newId);
    expect(sut[1]?.message).toBe('commit: second');
  });
});

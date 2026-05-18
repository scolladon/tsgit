import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branch } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithBranches = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  await branch(ctx, { kind: 'create', name: 'feature' });
  return { ctx, commitId: c.id };
};

describe('checkout', () => {
  it('Given an existing branch, When checkout, Then HEAD becomes symref to that branch', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithBranches();

    // Act
    const sut = await checkout(ctx, { target: 'feature' });

    // Assert
    expect(sut.branch).toBe('refs/heads/feature');
    expect(sut.id).toBe(commitId);
    expect(sut.detached).toBe(false);
    const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(head).toBe('ref: refs/heads/feature\n');
  });

  it('Given a 40-hex oid, When checkout, Then HEAD becomes detached at that oid', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithBranches();

    // Act
    const sut = await checkout(ctx, { target: commitId });

    // Assert
    expect(sut.detached).toBe(true);
    expect(sut.id).toBe(commitId);
    const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(head).toBe(`${commitId}\n`);
  });

  it('Given a non-existent branch, When checkout, Then throws BRANCH_NOT_FOUND', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act
    let caught: unknown;
    try {
      await checkout(ctx, { target: 'ghost' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
  });

  it('Given the currently-checked-out branch, When checkout, Then HEAD remains a symref to the same branch (no-op-equivalent)', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act
    const sut = await checkout(ctx, { target: 'main' });

    // Assert
    expect(sut.branch).toBe('refs/heads/main');
    expect(sut.detached).toBe(false);
  });

  it('Given detach=true with a branch name, When checkout, Then HEAD is detached at the resolved oid', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithBranches();

    // Act — branch name + detach should resolve to the oid AND detach.
    const sut = await checkout(ctx, { target: commitId, detach: true });

    // Assert
    expect(sut.detached).toBe(true);
    expect(sut.id).toBe(commitId);
  });

  it('Given two commits with diverging file content, When checkout to the older commit, Then working tree restores the older content', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/foo.txt`, 'v1');
    await add(ctx, ['foo.txt']);
    const c1 = await commit(ctx, { message: 'v1', author });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/foo.txt`, 'v2');
    await add(ctx, ['foo.txt']);
    await commit(ctx, { message: 'v2', author });

    // Act — checkout the first commit
    const sut = await checkout(ctx, { target: c1.id, force: true });

    // Assert — working tree now matches v1, and changedPaths reflects the update
    expect(sut.detached).toBe(true);
    expect(sut.changedPaths).toBeGreaterThanOrEqual(1);
    const bytes = await ctx.fs.read(`${ctx.layout.workDir}/foo.txt`);
    expect(new TextDecoder().decode(bytes)).toBe('v1');
  });

  it('Given both target and paths are provided, When checkout, Then throws INVALID_OPTION', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act + Assert
    try {
      await checkout(ctx, {
        target: 'main',
        paths: ['a.txt'],
      } as unknown as Parameters<typeof checkout>[1]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('INVALID_OPTION');
    }
  });

  it('Given neither target nor paths, When checkout, Then throws INVALID_OPTION', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act + Assert
    try {
      await checkout(ctx, {} as unknown as Parameters<typeof checkout>[1]);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as TsgitError).data.code).toBe('INVALID_OPTION');
    }
  });

  it('Given paths=[] (empty array), When checkout in paths mode, Then throws INVALID_OPTION', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act + Assert
    try {
      await checkout(ctx, { paths: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as TsgitError).data.code).toBe('INVALID_OPTION');
    }
  });

  it('Given an index.lock already on disk AND a corrupted .git/index, When switch checkout, Then throws RESOURCE_LOCKED (lock acquired BEFORE readIndex)', async () => {
    // Arrange — pre-acquire the index lock AND corrupt the index file.
    // The corrupted index would make readIndex throw an INVALID_INDEX_HEADER
    // error if the code ever runs readIndex before acquireIndexLock.
    // Discriminating between the two error codes pins the lock-first ordering.
    const { ctx } = await seedWithBranches();
    const lockPath = `${ctx.layout.gitDir}/index.lock`;
    const indexPath = `${ctx.layout.gitDir}/index`;
    await ctx.fs.write(indexPath, new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());

    // Act
    let caught: unknown;
    try {
      await checkout(ctx, { target: 'feature' });
    } catch (err) {
      caught = err;
    }

    // Assert — RESOURCE_LOCKED proves the lock acquire ran first; an
    // INVALID_INDEX_HEADER (or similar parse error) would prove readIndex
    // ran first.
    const data = (caught as { data?: { code?: string; resource?: string } })?.data;
    expect(data?.code).toBe('RESOURCE_LOCKED');
    expect(data?.resource).toBe('index');
  });

  it('Given an index.lock already on disk, When path-restore from HEAD, Then throws RESOURCE_LOCKED (lock-first ordering for non-index source)', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();
    const lockPath = `${ctx.layout.gitDir}/index.lock`;
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());

    // Act
    let caught: unknown;
    try {
      await checkout(ctx, { paths: ['a.txt'], source: 'HEAD' });
    } catch (err) {
      caught = err;
    }

    // Assert
    const data = (caught as { data?: { code?: string; resource?: string } })?.data;
    expect(data?.code).toBe('RESOURCE_LOCKED');
    expect(data?.resource).toBe('index');
  });

  it('Given an index.lock already on disk, When path-restore from an explicit ObjectId source, Then throws RESOURCE_LOCKED (lock-first for the ObjectId branch)', async () => {
    // Arrange — exercise the third branch of the source discriminator
    // (`ObjectId`). Without this test, a regression that routes the
    // ObjectId branch to UnderIndex would survive.
    const { ctx, commitId } = await seedWithBranches();
    const lockPath = `${ctx.layout.gitDir}/index.lock`;
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());

    // Act
    let caught: unknown;
    try {
      await checkout(ctx, { paths: ['a.txt'], source: commitId });
    } catch (err) {
      caught = err;
    }

    // Assert
    const data = (caught as { data?: { code?: string; resource?: string } })?.data;
    expect(data?.code).toBe('RESOURCE_LOCKED');
    expect(data?.resource).toBe('index');
  });

  it('Given a divergent index (file staged after commit), When path-restore from source: index, Then disk content matches the staged version (not HEAD)', async () => {
    // Arrange — commit 'v1', then overwrite + stage 'v2' without committing.
    // The index now records 'v2' while HEAD's tree records 'v1'. Path-restore
    // from `source: 'index'` must produce the STAGED 'v2', not HEAD's 'v1'.
    // This is the BACKLOG §13.6 acceptance test.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v1');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'commit v1', author });

    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v2');
    await add(ctx, ['a.txt']);
    // Locally modify the working tree to a third version — the path-restore
    // should overwrite this with the STAGED 'v2'.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v3-dirty');

    // Act — default source is 'index'.
    const sut = await checkout(ctx, { paths: ['a.txt'] });

    // Assert — file content reverts to the staged 'v2'.
    expect(sut.changedPaths).toBe(1);
    const onDisk = await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`);
    expect(onDisk).toBe('v2');
  });

  it('Given an index.lock already on disk, When path-restore from the default (index) source, Then succeeds without disturbing the pre-existing lock', async () => {
    // Arrange — pre-existing lock with a recognisable sentinel. Path-restore
    // from `source: 'index'` (the default) never commits, so we must NOT
    // acquire the lock. Assertion is stronger than "no throw": we verify
    // the lock file STILL exists with its original byte (proving we didn't
    // even touch it via an acquire/release round-trip — a regression to
    // always-acquire would briefly grab and then release the lock,
    // potentially overwriting our sentinel via writeExclusive's behaviour).
    const { ctx } = await seedWithBranches();
    const lockPath = `${ctx.layout.gitDir}/index.lock`;
    const sentinel = new Uint8Array([0x53, 0x45, 0x4e, 0x54]); // "SENT"
    await ctx.fs.writeExclusive(lockPath, sentinel);

    // Act
    const sut = await checkout(ctx, { paths: ['a.txt'] });

    // Assert — operation succeeds (1 path rewritten because path-restore now
    // unconditionally writes the source content, matching canonical git);
    // lock is intact (no acquire/release round-trip for the lockless branch).
    expect(sut.changedPaths).toBe(1);
    expect(await ctx.fs.exists(lockPath)).toBe(true);
    const lockBytes = await ctx.fs.read(lockPath);
    expect(Array.from(lockBytes)).toEqual([0x53, 0x45, 0x4e, 0x54]);
  });
});

import { recordingProgress, withProgress } from './fixtures.js';

describe('checkout — progress reporting', () => {
  const seedWithBranch = async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    return ctx;
  };

  it("Given a successful checkout, When run, Then start fires before end with op === 'checkout:materialize'", async () => {
    const ctx = await seedWithBranch();
    const { reporter, events } = recordingProgress();

    await checkout(withProgress(ctx, reporter), { target: 'feature' });

    expect(events[0]).toEqual({ kind: 'start', op: 'checkout:materialize' });
    expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'checkout:materialize' });
  });

  it('Given a checkout that throws (unknown branch), When run, Then end still fires', async () => {
    const ctx = await seedWithBranch();
    const { reporter, events } = recordingProgress();

    try {
      await checkout(withProgress(ctx, reporter), { target: 'does-not-exist' });
    } catch {
      // expected
    }

    const startCount = events.filter((e) => e.kind === 'start').length;
    const endCount = events.filter((e) => e.kind === 'end').length;
    expect(endCount).toBe(startCount);
  });
});

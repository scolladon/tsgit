import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, RefName } from '../../../../src/domain/objects/index.js';

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
  await branchCreate(ctx, { name: 'feature' });
  return { ctx, commitId: c.id };
};

describe('checkout', () => {
  describe('Given an existing branch', () => {
    describe('When checkout', () => {
      it('Then HEAD becomes symref to that branch', async () => {
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
    });
  });

  describe('Given a 40-hex oid', () => {
    describe('When checkout', () => {
      it('Then HEAD becomes detached at that oid', async () => {
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
    });
  });

  describe('Given a symbolic HEAD pointing outside refs/heads/', () => {
    describe('When checkout', () => {
      it('Then the reflog label is the target basename (not a mangled prefix-strip)', async () => {
        // Arrange — point HEAD at refs/remotes/origin/main. A naive
        // slice(HEADS_PREFIX.length) would yield `gin/main`; the label must be the
        // last path segment, `main`.
        const { ctx, commitId } = await seedWithBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${commitId}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/remotes/origin/main\n');
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );

        // Act
        await checkout(ctx, { target: 'feature' });

        // Assert — the newest HEAD reflog entry records the move from `main`.
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog[headLog.length - 1]?.message).toBe('checkout: moving from main to feature');
      });
    });
  });

  describe('Given a symbolic HEAD on a nested branch under refs/heads/', () => {
    describe('When checkout', () => {
      it('Then the label keeps the full sub-path (prefix-strip, not basename)', async () => {
        // Arrange — prior HEAD on refs/heads/topic/sub. The label must strip only
        // the refs/heads/ prefix (`topic/sub`); a basename fallback (`sub`) is wrong.
        const { ctx, commitId } = await seedWithBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/topic/sub`, `${commitId}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/topic/sub\n');
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );

        // Act
        await checkout(ctx, { target: 'feature' });

        // Assert
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog[headLog.length - 1]?.message).toBe(
          'checkout: moving from topic/sub to feature',
        );
      });
    });
  });

  describe('Given a symbolic HEAD on a ref with no slash', () => {
    describe('When checkout', () => {
      it('Then the label is that ref verbatim', async () => {
        // Arrange — prior HEAD on a single-segment ref `legacy`. With no `/`, the
        // basename fallback must return the whole name untouched.
        const { ctx, commitId } = await seedWithBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/legacy`, `${commitId}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: legacy\n');
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );

        // Act
        await checkout(ctx, { target: 'feature' });

        // Assert
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog[headLog.length - 1]?.message).toBe(
          'checkout: moving from legacy to feature',
        );
      });
    });
  });

  describe('Given a symbolic HEAD on a two-segment ref outside refs/heads/', () => {
    describe('When checkout', () => {
      it('Then the label is the segment after the single slash', async () => {
        // Arrange — prior HEAD on `x/main`: the only `/` is at index 1, so the
        // basename is the part after it. Pins the `lastIndexOf('/') === -1` guard
        // against a `=== 1` mutation that would return the whole `x/main`.
        const { ctx, commitId } = await seedWithBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/x/main`, `${commitId}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: x/main\n');
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );

        // Act
        await checkout(ctx, { target: 'feature' });

        // Assert
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog[headLog.length - 1]?.message).toBe('checkout: moving from main to feature');
      });
    });
  });

  describe('Given a detached prior HEAD', () => {
    describe('When checkout', () => {
      it('Then the reflog label is the 7-char abbreviated oid (not the full oid)', async () => {
        // Arrange — detach HEAD onto the commit oid, then check out a branch. The
        // `from` label must be the commit abbreviated to 7 chars, not all 40.
        const { ctx, commitId } = await seedWithBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${commitId}\n`);
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );

        // Act
        await checkout(ctx, { target: 'feature' });

        // Assert — the label is exactly the first 7 hex chars of the detached oid.
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog[headLog.length - 1]?.message).toBe(
          `checkout: moving from ${commitId.slice(0, 7)} to feature`,
        );
      });
    });
  });

  describe('Given a non-existent branch', () => {
    describe('When checkout', () => {
      it('Then throws BRANCH_NOT_FOUND', async () => {
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
    });
  });

  describe('Given the currently-checked-out branch', () => {
    describe('When checkout', () => {
      it('Then HEAD remains a symref to the same branch (no-op-equivalent)', async () => {
        // Arrange
        const { ctx } = await seedWithBranches();

        // Act
        const sut = await checkout(ctx, { target: 'main' });

        // Assert
        expect(sut.branch).toBe('refs/heads/main');
        expect(sut.detached).toBe(false);
      });
    });
  });

  describe('Given detach=true with a branch name', () => {
    describe('When checkout', () => {
      it('Then HEAD is detached at the resolved oid', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithBranches();

        // Act — branch name + detach should resolve to the oid AND detach.
        const sut = await checkout(ctx, { target: commitId, detach: true });

        // Assert
        expect(sut.detached).toBe(true);
        expect(sut.id).toBe(commitId);
      });
    });
  });

  describe('Given two commits with diverging file content', () => {
    describe('When checkout to the older commit', () => {
      it('Then working tree restores the older content', async () => {
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
    });
  });

  describe('Given both target and paths are provided', () => {
    describe('When checkout', () => {
      it('Then throws INVALID_OPTION', async () => {
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
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('INVALID_OPTION');
        }
      });
    });
  });

  describe('Given neither target nor paths', () => {
    describe('When checkout', () => {
      it('Then throws INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedWithBranches();

        // Act + Assert
        try {
          await checkout(ctx, {} as unknown as Parameters<typeof checkout>[1]);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect((err as TsgitError).data.code).toBe('INVALID_OPTION');
        }
      });
    });
  });

  describe('Given paths=[] (empty array)', () => {
    describe('When checkout in paths mode', () => {
      it('Then throws INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedWithBranches();

        // Act + Assert
        try {
          await checkout(ctx, { paths: [] });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect((err as TsgitError).data.code).toBe('INVALID_OPTION');
        }
      });
    });
  });

  describe('Given an index.lock already on disk AND a corrupted.git/index', () => {
    describe('When switch checkout', () => {
      it('Then throws RESOURCE_LOCKED (lock acquired BEFORE readIndex)', async () => {
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
    });
  });

  describe('Given a switch-checkout that throws on a dirty collision', () => {
    describe('When checkout', () => {
      it('Then the index lock is released', async () => {
        // Regression — `switchBranch` acquires the index lock, then `materializeTree`
        // can throw (an untracked-file collision) BEFORE `lock.commit`. The `finally`
        // block must still release the lock, or the repository is left wedged.
        // Arrange — `feature` tracks `collide.txt`; `main` has an untracked file at
        // the same path.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'base');
        await add(ctx, ['base.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/collide.txt`, 'from-feature');
        await add(ctx, ['collide.txt']);
        await commit(ctx, { message: 'feature file', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/collide.txt`, 'untracked');

        // Act — the switch throws CHECKOUT_OVERWRITE_DIRTY from inside the lock.
        let caught: unknown;
        try {
          await checkout(ctx, { target: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — it threw, and the `finally` released the index lock.
        expect((caught as TsgitError).data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });

  describe('Given an index.lock already on disk', () => {
    describe('When path-restore from HEAD', () => {
      it('Then throws RESOURCE_LOCKED (lock-first ordering for non-index source)', async () => {
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
    });
    describe('When path-restore from an explicit ObjectId source', () => {
      it('Then throws RESOURCE_LOCKED (lock-first for the ObjectId branch)', async () => {
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
    });
  });

  describe('Given a divergent index (file staged after commit)', () => {
    describe('When path-restore from source: index', () => {
      it('Then disk content matches the staged version (not HEAD)', async () => {
        // Arrange — commit 'v1', then overwrite + stage 'v2' without committing.
        // The index now records 'v2' while HEAD's tree records 'v1'. Path-restore
        // from `source: 'index'` must produce the STAGED 'v2', not HEAD's 'v1'.
        // This is the acceptance test.
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

        // Capture HEAD's tree before the act so we can prove the synthesised
        // tree pointed at the STAGED blob, not HEAD's blob (the bug we fixed).
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const stagedIndex = await readIndex(ctx);
        const stagedBlobId = stagedIndex.entries.find((e) => e.path === 'a.txt')?.id;
        expect(stagedBlobId).toBeDefined();

        // Act — default source is 'index'.
        const sut = await checkout(ctx, { paths: ['a.txt'] });

        // Assert — file content reverts to the staged 'v2'.
        expect(sut.changedPaths).toBe(1);
        const onDisk = await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`);
        expect(onDisk).toBe('v2');

        // Stronger assertion: prove the synthesised tree's a.txt entry has the
        // STAGED blob's id. Without this, the test could pass spuriously if
        // synthesis silently returned HEAD's tree and forceRewriteAll lucked
        // into rewriting the file from a different source.
        const { synthesizeTreeFromIndex } = await import(
          '../../../../src/application/primitives/synthesize-tree-from-index.js'
        );
        const synthesisedRoot = await synthesizeTreeFromIndex(ctx, stagedIndex.entries);
        const { readObject } = await import(
          '../../../../src/application/primitives/read-object.js'
        );
        const root = (await readObject(ctx, synthesisedRoot)) as {
          readonly type: string;
          readonly entries: ReadonlyArray<{ readonly name: string; readonly id: string }>;
        };
        const synthesisedAEntry = root.entries.find((e) => e.name === 'a.txt');
        expect(synthesisedAEntry?.id).toBe(stagedBlobId);
      });
    });
  });

  describe('Given an index.lock already on disk', () => {
    describe('When path-restore from the default (index) source', () => {
      it('Then succeeds without disturbing the pre-existing lock', async () => {
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
  });
});

describe('checkout — mutation hardening', () => {
  describe('Given opts with target key set to undefined', () => {
    describe('When checkout', () => {
      it('Then throws INVALID_OPTION (target is not switch mode)', async () => {
        // Arrange — `'target' in opts` is true but `opts.target === undefined`.
        // isSwitch must be false; with the `!== undefined` guard mutated away,
        // switchMode would be true and route into switchBranch instead of throwing.
        const { ctx } = await seedWithBranches();

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { target: undefined } as unknown as Parameters<typeof checkout>[1]);
        } catch (err) {
          caught = err;
        }

        // Assert — neither switch nor paths mode → "either target or paths" branch.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('target');
          expect((caught as TsgitError).message).toBe(
            'INVALID_OPTION: invalid option: target — either target or paths must be provided',
          );
        }
      });
    });
  });

  describe('Given opts with paths key set to undefined', () => {
    describe('When checkout', () => {
      it('Then throws INVALID_OPTION (paths is not paths mode)', async () => {
        // Arrange — `'paths' in opts` is true but `opts.paths === undefined`.
        // isPaths must be false; mutating the `!== undefined` guard away would
        // make pathsMode true and route into pathRestore.
        const { ctx } = await seedWithBranches();

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { paths: undefined } as unknown as Parameters<typeof checkout>[1]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('target');
        }
      });
    });
  });

  describe('Given a non-hex branch name', () => {
    describe('When checkout', () => {
      it('Then it is resolved as a ref not as a raw oid', async () => {
        // Arrange — `feature` is not 40-hex; the L55 regex / L60 detach detector
        // must NOT classify it as a detached oid. A regex anchor mutation or a
        // ConditionalExpression→true would treat every target as a raw oid and
        // produce a detached HEAD instead of a symref.
        const { ctx } = await seedWithBranches();

        // Act
        const sut = await checkout(ctx, { target: 'feature' });

        // Assert — symref, not detached.
        expect(sut.detached).toBe(false);
        expect(sut.branch).toBe('refs/heads/feature');
      });
    });
  });

  describe('Given a 39-hex target (one short)', () => {
    describe('When checkout', () => {
      it('Then it is treated as a ref name not a raw oid', async () => {
        // Arrange — 39 hex chars must NOT match `/^[0-9a-f]{40}$/`. If the
        // trailing `$` anchor were stripped, a 39-hex prefix of a longer string
        // could match; here the value is exactly 39 chars so only the `{40}`
        // quantifier discriminates. Treated as a ref → branchNotFound.
        const { ctx } = await seedWithBranches();
        const thirtyNineHex = 'a'.repeat(39);

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { target: thirtyNineHex });
        } catch (err) {
          caught = err;
        }

        // Assert — resolved as a ref name → branch not found.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given a target with a trailing non-hex char after 40 hex', () => {
    describe('When checkout', () => {
      it('Then it is treated as a branch ref not a detached oid', async () => {
        // Arrange — `<40 hex>z` (41 chars) must NOT match `/^[0-9a-f]{40}$/`.
        // Without the `$` anchor (`/^[0-9a-f]{40}/`) the 40-hex prefix matches and
        // both the L60 detach detector and the L55 oid check would misfire,
        // routing the value through resolveSwitchOid as a detached oid. The
        // correct path treats it as a (non-existent) branch name.
        const { ctx } = await seedWithBranches();
        const fortyHexPlus = `${'a'.repeat(40)}z`;

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { target: fortyHexPlus });
        } catch (err) {
          caught = err;
        }

        // Assert — non-detached branch lookup → BRANCH_NOT_FOUND, not an oid path.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given a target with a non-hex char before 40 hex', () => {
    describe('When checkout', () => {
      it('Then it is treated as a branch ref not a detached oid', async () => {
        // Arrange — `z<40 hex>` (41 chars) must NOT match. Without the `^` anchor
        // (`/[0-9a-f]{40}$/`) the 40-hex suffix matches and the value is routed as
        // a detached oid instead of a branch name.
        const { ctx } = await seedWithBranches();
        const prefixedHex = `z${'a'.repeat(40)}`;

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { target: prefixedHex });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given detach=true with a full ref-path target', () => {
    describe('When checkout', () => {
      it('Then the ref is resolved to its commit oid (L55 ref resolution path)', async () => {
        // Arrange — detach:true forces the detached branch (L63), and the target
        // is a ref path, not a 40-hex oid. resolveSwitchOid must take the
        // L55-false path and resolveRef the ref into the commit oid. A
        // ConditionalExpression→true at L55 would skip resolveRef and return the
        // literal ref string as the oid; a regex anchor mutation could make the
        // ref string wrongly match and do the same.
        const { ctx, commitId } = await seedWithBranches();
        const refPath = 'refs/heads/feature';

        // Act
        const sut = await checkout(ctx, { target: refPath, detach: true });

        // Assert — HEAD detached at the RESOLVED commit oid, not the raw ref text.
        expect(sut.detached).toBe(true);
        expect(sut.id).toBe(commitId);
        expect(sut.id).not.toBe(refPath);
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe(`${commitId}\n`);
      });
    });
  });

  describe('Given detach=false with a branch name', () => {
    describe('When checkout', () => {
      it('Then HEAD is a symref (detach flag honoured)', async () => {
        // Arrange — explicit detach:false must keep the symref behaviour. A
        // BooleanLiteral mutant on `opts.detach === true` (→false) or the
        // `=== true` comparison still yields non-detached here, but pairing this
        // with the detach=true test pins the boolean exactly.
        const { ctx } = await seedWithBranches();

        // Act
        const sut = await checkout(ctx, { target: 'feature', detach: false });

        // Assert
        expect(sut.detached).toBe(false);
        expect(sut.branch).toBe('refs/heads/feature');
      });
    });
  });

  describe('Given force omitted and a dirty working tree the checkout would overwrite', () => {
    describe('When switch checkout', () => {
      it('Then throws CHECKOUT_OVERWRITE_DIRTY (force defaults to false)', async () => {
        // Arrange — two commits diverging `foo.txt`. Detach onto the first
        // commit, then locally modify `foo.txt` so the working tree is dirty.
        // Checking out the second commit without `force` must hit the dirty-tree
        // guard. `force: opts.force ?? false` (L88) — a BooleanLiteral mutant
        // flipping the default to `true` would skip the guard and succeed.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/foo.txt`, 'v1');
        await add(ctx, ['foo.txt']);
        const c1 = await commit(ctx, { message: 'v1', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/foo.txt`, 'v2');
        await add(ctx, ['foo.txt']);
        const c2 = await commit(ctx, { message: 'v2', author });
        await checkout(ctx, { target: c1.id, force: true });
        // Dirty the working tree without staging — the guard must catch this.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/foo.txt`, 'locally-edited');

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { target: c2.id });
        } catch (err) {
          caught = err;
        }

        // Assert — the dirty guard fired because force defaulted to false.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
        if (data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
          expect(data.paths).toContain('foo.txt');
        }
      });
    });
  });

  describe('Given a switch checkout that only deletes files', () => {
    describe('When run', () => {
      it('Then the index commit still runs (deleted>0 operand of L90)', async () => {
        // Arrange — first commit has two files, second removes one. Checking out
        // the second commit from the first deletes `gone.txt`: written===0,
        // deleted===1. The L90 guard `written > 0 || deleted > 0` must commit on
        // the deleted operand alone. A LogicalOperator mutant (|| → &&) or
        // dropping the deleted operand would skip the commit and leave changedPaths
        // wrong.
        const { rm } = await import('../../../../src/application/commands/rm.js');
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/keep.txt`, 'k');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/gone.txt`, 'g');
        await add(ctx, ['keep.txt', 'gone.txt']);
        const both = await commit(ctx, { message: 'both', author });
        await rm(ctx, ['gone.txt']);
        const fewer = await commit(ctx, { message: 'fewer', author });

        // Re-stage both then check out the older 'both' commit, then check out
        // 'fewer' to force a deletion-only transition.
        await checkout(ctx, { target: both.id, force: true });
        const sut = await checkout(ctx, { target: fewer.id, force: true });

        // Assert — exactly one path changed (the deletion) and it was committed.
        expect(sut.changedPaths).toBe(1);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/gone.txt`)).toBe(false);
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const idx = await readIndex(ctx);
        expect(idx.entries.some((e) => e.path === 'gone.txt')).toBe(false);
      });
    });
  });

  describe('Given a switch checkout that only writes files', () => {
    describe('When run', () => {
      it('Then changedPaths equals the written count (L90 written operand + L104/L112 sum)', async () => {
        // Arrange — checkout a commit that ADDS a file: written>0, deleted===0.
        // Pins the `written > 0` operand and the `written + deleted` sum: an
        // ArithmeticOperator mutant (+ → -) would yield 0 instead of 1.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'b');
        await add(ctx, ['base.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'origin-pt' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/extra.txt`, 'e');
        await add(ctx, ['extra.txt']);
        const withExtra = await commit(ctx, { message: 'with extra', author });

        // Detach onto origin-pt removing extra.txt, then check out withExtra by
        // oid (detached) so the result goes through the L98 detached branch.
        await checkout(ctx, { target: 'origin-pt', force: true });
        const sut = await checkout(ctx, { target: withExtra.id, force: true });

        // Assert — exactly one write, sum is exactly 1 (not -1 or other), and the
        // index commit ran (the L90 guard fired on the written>0 operand; a
        // LogicalOperator || → && or written>0 → written<=0 mutant would skip the
        // commit and leave the index without extra.txt).
        expect(sut.detached).toBe(true);
        expect(sut.changedPaths).toBe(1);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/extra.txt`)).toBe(true);
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const idx = await readIndex(ctx);
        expect(idx.entries.some((e) => e.path === 'extra.txt')).toBe(true);
      });
    });
  });

  describe('Given detach:true onto a ref name with a 40-hex PREFIX', () => {
    describe('When checkout', () => {
      it('Then resolveSwitchOid resolves it via resolveRef (L55 `^...{40}$` rejects the 41-char target — kills the `$`-anchor drop)', async () => {
        // Arrange — a loose ref whose NAME is `<40 hex>z` (41 chars). The L55
        // regex `/^[0-9a-f]{40}$/` must NOT match (length 41 + trailing `z`), so
        // resolveSwitchOid resolves it via resolveRef into the real commit oid.
        // Dropping the `$` anchor (`/^[0-9a-f]{40}/`) matches the 40-hex PREFIX,
        // making resolveSwitchOid return the raw ref name as the oid — `sut.id`
        // would then be the ref text, not the resolved commit.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'first', author });
        const hexPrefixRef = `${'a'.repeat(40)}z`; // 40 hex chars + non-hex `z`
        // Write the loose ref directly (resolveRef joins the name onto gitDir).
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${hexPrefixRef}`, `${c.id}\n`);

        // Act — detach:true forces the detached branch; target is the hex-prefix ref.
        const sut = await checkout(ctx, { target: hexPrefixRef, detach: true });

        // Assert — id is the RESOLVED commit oid, never the raw ref text.
        expect(sut.detached).toBe(true);
        expect(sut.id).toBe(c.id);
        expect(sut.id).not.toBe(hexPrefixRef);
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe(`${c.id}\n`);
      });
    });
  });

  describe('Given detach:true onto a ref name with a 40-hex SUFFIX', () => {
    describe('When checkout', () => {
      it('Then resolveSwitchOid resolves it via resolveRef (L55 `^...{40}$` rejects the slashed target — kills the `^`-anchor drop)', async () => {
        // Arrange — a branch literally named with 40 hex characters, so its full
        // ref path `refs/heads/<40 hex>` ENDS with a 40-hex run. The L55 regex
        // `/^[0-9a-f]{40}$/` must NOT match (the `refs/heads/` prefix breaks the
        // `^` anchor), so resolveSwitchOid resolves it via resolveRef. Dropping
        // the `^` anchor (`/[0-9a-f]{40}$/`) matches the 40-hex SUFFIX, making
        // resolveSwitchOid return the raw `refs/heads/<40 hex>` text as the oid.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'first', author });
        const hexBranch = 'b'.repeat(40); // branch name = 40 hex chars
        await branchCreate(ctx, { name: hexBranch });
        const fullRefPath = `refs/heads/${hexBranch}`;

        // Act — target is the full ref path ending in a 40-hex run.
        const sut = await checkout(ctx, { target: fullRefPath, detach: true });

        // Assert — id is the RESOLVED commit oid, never the raw ref path text.
        expect(sut.detached).toBe(true);
        expect(sut.id).toBe(c.id);
        expect(sut.id).not.toBe(fullRefPath);
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe(`${c.id}\n`);
      });
    });
  });

  describe('Given a non-detached switch that both writes and deletes files', () => {
    describe('When checkout', () => {
      it('Then changedPaths is written + deleted (L115 sum)', async () => {
        // Arrange — main ends on a commit with only `b.txt`; `feature` sits on a
        // commit with only `a.txt`. Switching main→feature WRITES `a.txt` and
        // DELETES `b.txt`: written===1, deleted===1. The non-detached return at
        // L115 sums them — an ArithmeticOperator `+`→`-` mutant would yield 0.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a-content');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'a-only', author });
        await branchCreate(ctx, { name: 'feature' });
        // Advance main: drop a.txt, add b.txt.
        const { rm } = await import('../../../../src/application/commands/rm.js');
        await rm(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b-content');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'b-only', author });

        // Act — non-detached switch back to feature (writes a.txt, deletes b.txt).
        const sut = await checkout(ctx, { target: 'feature', force: true });

        // Assert — symref branch (non-detached) and the exact sum 1 + 1 = 2.
        expect(sut.detached).toBe(false);
        expect(sut.branch).toBe('refs/heads/feature');
        expect(sut.changedPaths).toBe(2);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(false);
      });
    });
  });

  describe('Given a locked path-restore whose index read fails', () => {
    describe('When checkout', () => {
      it('Then the index lock is released by the finally block (L226)', async () => {
        // Arrange — path-restore from HEAD takes the LOCKED branch:
        // acquireIndexLock creates `index.lock`, then readIndex runs inside the
        // try. Corrupt the index so readIndex throws AFTER the lock is held but
        // BEFORE lock.commit() — only the L226 `finally { await lock.release() }`
        // can then remove the lock. A BlockStatement→`{}` mutant on that finally
        // would leak `index.lock` on disk.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'baseline', author });
        // Corrupt the on-disk index: a 4-byte header readIndex rejects.
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array([0x00, 0x00, 0x00, 0x00]));
        const lockPath = `${ctx.layout.gitDir}/index.lock`;

        // Act — must throw (corrupt index), and the lock must be released.
        let caught: unknown;
        try {
          await checkout(ctx, { paths: ['a.txt'], source: 'HEAD' });
        } catch (err) {
          caught = err;
        }

        // Assert — the parse error surfaced AND the lock file is gone (released).
        expect(caught).toBeInstanceOf(TsgitError);
        expect(await ctx.fs.exists(lockPath)).toBe(false);
      });
    });
  });

  describe('Given empty paths array', () => {
    describe('When checkout', () => {
      it('Then the error names the paths option and the empty reason', async () => {
        // Arrange — pins the L128 string literals 'paths' and 'must not be empty'.
        const { ctx } = await seedWithBranches();

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { paths: [] });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('paths');
          expect(data.reason).toBe('must not be empty');
        }
        expect((caught as TsgitError).message).toBe(
          'INVALID_OPTION: invalid option: paths — must not be empty',
        );
      });
    });
  });

  describe('Given a glob with no match on the index source', () => {
    describe('When path-restore', () => {
      it('Then changedPaths is 0 and HEAD is unchanged (L145 zero-match branch)', async () => {
        // Arrange — default source 'index'; a glob matching nothing exits via the
        // L145 `pathSet.size === 0` early return. A ConditionalExpression→false
        // mutant would skip the early return and call materialize with an empty
        // set; the BlockStatement mutant would drop the early return body.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a');
        await add(ctx, ['a.ts']);
        const c = await commit(ctx, { message: 'baseline', author });

        // Act
        const sut = await checkout(ctx, { paths: ['*.nomatch'] });

        // Assert — zero-match no-op; result resolves current HEAD, detached false.
        expect(sut.changedPaths).toBe(0);
        expect(sut.detached).toBe(false);
        expect(sut.branch).toBeUndefined();
        expect(sut.id).toBe(c.id);
      });
    });
  });

  describe('Given a zero-match glob from HEAD AND a corrupted index', () => {
    describe('When path-restore', () => {
      it('Then the early return short-circuits before readIndex (L145 branch + body)', async () => {
        // Arrange — glob `*.nomatch` yields an empty pathSet. The L145
        // `pathSet.size === 0` early return must fire BEFORE materialize touches
        // the index. Corrupt the index so that a mutant — either the
        // ConditionalExpression→false (skip the return) or the BlockStatement→{}
        // (drop the return body) — would fall through to
        // materializePathRestoreLocked → readIndex and throw a parse error.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a');
        await add(ctx, ['a.ts']);
        const c = await commit(ctx, { message: 'baseline', author });
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array([0, 0, 0, 0]));

        // Act — must succeed: the early return never reads the corrupt index.
        const sut = await checkout(ctx, { paths: ['*.nomatch'], source: 'HEAD' });

        // Assert — no-op result, no parse error surfaced.
        expect(sut.changedPaths).toBe(0);
        expect(sut.id).toBe(c.id);
        expect(sut.detached).toBe(false);
      });
    });
  });

  describe('Given a successful path-restore from index', () => {
    describe('When run', () => {
      it('Then result.detached is false (L168 boolean) and changedPaths sums written+deleted (L169)', async () => {
        // Arrange — stage a file then locally modify it; path-restore from index
        // rewrites exactly one path. Pins L168 detached:false and the L169
        // written+deleted sum (ArithmeticOperator + → - would give 0 or negative).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'staged');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'c', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty');

        // Act
        const sut = await checkout(ctx, { paths: ['a.txt'] });

        // Assert
        expect(sut.detached).toBe(false);
        expect(sut.changedPaths).toBe(1);
      });
    });
  });

  describe('Given a path-restore from HEAD that rewrites a file', () => {
    describe('When run', () => {
      it('Then the index is committed with HEADs blob id (L215 written>0 guard + L219 commit block)', async () => {
        // Arrange — commit `h.txt`, then stage a divergent version so the index
        // records a DIFFERENT blob id than HEAD. Path-restore from HEAD goes
        // through the locked path: the L215 `result.written > 0` guard and the
        // L219 `lock.commit` block must run so the index ends up recording
        // HEAD's blob id. A ConditionalExpression→false or EqualityOperator
        // (> → <=) mutant skips the commit, leaving the index on the staged blob.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/h.txt`, 'head-version');
        await add(ctx, ['h.txt']);
        await commit(ctx, { message: 'c', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/h.txt`, 'staged-version');
        await add(ctx, ['h.txt']);

        // Capture HEAD's blob id and the (different) staged blob id.
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const { resolveRef } = await import(
          '../../../../src/application/primitives/resolve-ref.js'
        );
        const { readTree } = await import('../../../../src/application/primitives/read-tree.js');
        const headOid = await resolveRef(ctx, 'HEAD');
        const headTree = await readTree(ctx, headOid);
        const headBlobId = headTree.entries.find((e) => e.name === 'h.txt')?.id;
        const stagedBlobId = (await readIndex(ctx)).entries.find((e) => e.path === 'h.txt')?.id;
        expect(headBlobId).toBeDefined();
        expect(stagedBlobId).not.toBe(headBlobId);

        // Act
        const sut = await checkout(ctx, { paths: ['h.txt'], source: 'HEAD' });

        // Assert — disk reverts AND the index commit recorded HEAD's blob id.
        expect(sut.changedPaths).toBe(1);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/h.txt`)).toBe('head-version');
        const committedIndex = await readIndex(ctx);
        expect(committedIndex.entries.find((e) => e.path === 'h.txt')?.id).toBe(headBlobId);
      });
    });
  });

  describe('Given a path-restore from HEAD over a nested tree', () => {
    describe('When run', () => {
      it('Then the nested file is restored from HEAD', async () => {
        // Arrange — commit a file inside a subdirectory, then locally modify it.
        // Exercises enumerateSourcePaths over a tree containing a DIRECTORY entry
        // (L246) — directory entries are filtered out of the path universe.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dir/nested.txt`, 'nested-head');
        await add(ctx, ['dir/nested.txt']);
        await commit(ctx, { message: 'c', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dir/nested.txt`, 'dirty');

        // Act
        const sut = await checkout(ctx, { paths: ['dir/nested.txt'], source: 'HEAD' });

        // Assert
        expect(sut.changedPaths).toBe(1);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/dir/nested.txt`)).toBe('nested-head');
      });
    });
  });

  describe('Given both target and paths', () => {
    describe('When checkout', () => {
      it('Then the error names the paths option and the combine reason (L259 literals)', async () => {
        // Arrange — pins the L259 string literals 'paths' and
        // 'cannot be combined with target'.
        const { ctx } = await seedWithBranches();

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, {
            target: 'main',
            paths: ['a.txt'],
          } as unknown as Parameters<typeof checkout>[1]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('paths');
          expect(data.reason).toBe('cannot be combined with target');
        }
        expect((caught as TsgitError).message).toBe(
          'INVALID_OPTION: invalid option: paths — cannot be combined with target',
        );
      });
    });
  });

  describe('Given neither target nor paths', () => {
    describe('When checkout', () => {
      it('Then the error names the target option and the requirement reason (L262 literals)', async () => {
        // Arrange — pins the L262 string literals 'target' and
        // 'either target or paths must be provided'.
        const { ctx } = await seedWithBranches();

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, {} as unknown as Parameters<typeof checkout>[1]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('target');
          expect(data.reason).toBe('either target or paths must be provided');
        }
        expect((caught as TsgitError).message).toBe(
          'INVALID_OPTION: invalid option: target — either target or paths must be provided',
        );
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When checkout', () => {
      it('Then throws BARE_REPOSITORY naming the checkout operation (L253 literal)', async () => {
        // Arrange — a bare repo; assertNotBare(ctx, 'checkout') must throw with
        // the operation string 'checkout'. A StringLiteral mutant emptying the
        // 'checkout' argument would surface an empty operation in the message.
        const ctx = createMemoryContext();
        await init(ctx);
        const cfgPath = `${ctx.layout.gitDir}/config`;
        const cfg = await ctx.fs.readUtf8(cfgPath);
        await ctx.fs.writeUtf8(cfgPath, `${cfg}\n[core]\n\tbare = true\n`);

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { target: 'main' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('BARE_REPOSITORY');
        if (data.code === 'BARE_REPOSITORY') {
          expect(data.operation).toBe('checkout');
        }
        expect((caught as TsgitError).message).toBe(
          'BARE_REPOSITORY: operation requires a working tree: checkout',
        );
      });
    });
  });
});

describe('checkout — sparse checkout', () => {
  // Two branches `main` / `feature`, both holding `src/a.txt` + `docs/b.txt`,
  // BOTH on disk and recorded as normal (non-skip-worktree) index entries.
  // Sparse is then flipped on by writing `.git/info/sparse-checkout` and the
  // `core` config directly — so the index entries stay normal and the branch
  // switch itself must apply the matcher (rather than inheriting an already
  // materialised sparse state).
  const seedRepoOnTwoBranches = async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');
    await add(ctx, ['src/a.txt', 'docs/b.txt']);
    await commit(ctx, { message: 'first', author });
    await branchCreate(ctx, { name: 'feature' });
    return ctx;
  };

  const enableSparseSrcOnly = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const { updateCoreConfig } = await import(
      '../../../../src/application/primitives/update-config.js'
    );
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/*\n!/*/\n/src/\n');
    await updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: 'true' });
  };

  describe('Given a sparse repo with normal index entries', () => {
    describe('When checkout switches branch', () => {
      it('Then only in-pattern files are materialised and excluded entries become skip-worktree', async () => {
        // Arrange — make the repo sparse AFTER the commit; `docs/b.txt` is still a
        // normal index entry and present on disk. The branch switch must apply the
        // matcher: drop `docs/b.txt` from disk and flag it skip-worktree.
        const ctx = await seedRepoOnTwoBranches();
        await enableSparseSrcOnly(ctx);

        // Act
        const sut = await checkout(ctx, { target: 'feature' });

        // Assert — in-pattern file present, excluded file removed from disk.
        expect(sut.branch).toBe('refs/heads/feature');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        // The new index keeps every path; `docs/b.txt` is now skip-worktree.
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const idx = await readIndex(ctx);
        expect(idx.entries.find((e) => e.path === 'src/a.txt')?.flags.skipWorktree).toBe(false);
        expect(idx.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a NON-sparse repo', () => {
    describe('When checkout switches branch', () => {
      it('Then every tracked file is materialised (sparse threading is inert)', async () => {
        // Arrange — no sparse config: `loadSparseMatcher` returns undefined, so the
        // `materializeTree` call must behave byte-for-byte as before this slice.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');
        await add(ctx, ['src/a.txt', 'docs/b.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });

        // Act
        const sut = await checkout(ctx, { target: 'feature' });

        // Assert — both files on disk, no skip-worktree entry.
        expect(sut.branch).toBe('refs/heads/feature');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(true);
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const idx = await readIndex(ctx);
        expect(idx.entries.every((e) => e.flags.skipWorktree === false)).toBe(true);
      });
    });
  });

  describe('Given a sparse repo', () => {
    describe('When checkout switches to a branch where only an excluded file differs', () => {
      it('Then the index records the new branch excluded id', async () => {
        // Regression — a sparse branch switch whose in-pattern files are identical
        // but whose excluded file differs has written=0 AND deleted=0. The index
        // commit must still run: guarding it on those counts would leave the prior
        // branch's stale excluded id, and the next commit would serialise it wrong.
        // Arrange — `main` and `feature` share `src/a.txt`; only `docs/b.txt` differs.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');
        await add(ctx, ['src/a.txt', 'docs/b.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b-on-feature');
        await add(ctx, ['docs/b.txt']);
        await commit(ctx, { message: 'feature edit', author });
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const featureDocsId = (await readIndex(ctx)).entries.find(
          (e) => e.path === 'docs/b.txt',
        )?.id;
        await checkout(ctx, { target: 'main' });
        const { sparseCheckout } = await import(
          '../../../../src/application/commands/sparse-checkout.js'
        );
        await sparseCheckout(ctx, { action: 'set', patterns: ['src'], cone: true });
        const mainDocsId = (await readIndex(ctx)).entries.find((e) => e.path === 'docs/b.txt')?.id;

        // Act — switch to feature: in-pattern `src/a.txt` is byte-identical, so
        // written=0; `docs/b.txt` is excluded and already absent, so deleted=0.
        await checkout(ctx, { target: 'feature' });

        // Assert — the excluded entry now carries feature's id, not main's stale one.
        const docsEntry = (await readIndex(ctx)).entries.find((e) => e.path === 'docs/b.txt');
        expect(docsEntry?.flags.skipWorktree).toBe(true);
        expect(docsEntry?.id).toBe(featureDocsId);
        expect(docsEntry?.id).not.toBe(mainDocsId);
      });
    });
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
    await branchCreate(ctx, { name: 'feature' });
    return ctx;
  };

  describe('Given a successful checkout', () => {
    describe('When run', () => {
      it("Then start fires before end with op === 'checkout:materialize'", async () => {
        // Arrange
        const ctx = await seedWithBranch();
        const { reporter, events } = recordingProgress();

        await checkout(withProgress(ctx, reporter), { target: 'feature' });

        // Assert
        expect(events[0]).toEqual({ kind: 'start', op: 'checkout:materialize' });
        expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'checkout:materialize' });
      });
    });
  });

  describe('Given a glob pathspec restoring from HEAD', () => {
    describe('When checkout', () => {
      it('Then only matching paths are restored', async () => {
        // Arrange — stage two files + commit them, then locally modify both.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a-original');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.md`, 'b-original');
        await add(ctx, ['a.ts', 'b.md']);
        await commit(ctx, { message: 'baseline', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a-modified');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.md`, 'b-modified');

        // Act — restore only `*.ts`.
        const sut = await checkout(ctx, { paths: ['*.ts'], source: 'HEAD' });

        // Assert — a.ts reverts, b.md stays modified.
        expect(sut.changedPaths).toBe(1);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.ts`)).toBe('a-original');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/b.md`)).toBe('b-modified');
      });
    });
  });

  describe('Given a glob pathspec with no match', () => {
    describe('When checkout', () => {
      it('Then changedPaths is 0 and nothing throws', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a');
        await add(ctx, ['a.ts']);
        await commit(ctx, { message: 'baseline', author });

        // Act
        const sut = await checkout(ctx, { paths: ['*.nope'], source: 'HEAD' });

        // Assert
        expect(sut.changedPaths).toBe(0);
      });
    });
  });

  describe('Given a literal pathspec with no match', () => {
    describe('When checkout', () => {
      it('Then throws PATHSPEC_NO_MATCH', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a');
        await add(ctx, ['a.ts']);
        await commit(ctx, { message: 'baseline', author });

        // Act
        let caught: unknown;
        try {
          await checkout(ctx, { paths: ['nope.txt'], source: 'HEAD' });
        } catch (err) {
          caught = err;
        }

        // Assert — pin the pattern field so a mutant that drops the
        // missing-literal into the error payload is killed.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('PATHSPEC_NO_MATCH');
        if (data.code === 'PATHSPEC_NO_MATCH') {
          expect(data.pattern).toBe('nope.txt');
        }
      });
    });
  });

  describe('Given a pathspec with glob + negation', () => {
    describe('When checkout', () => {
      it('Then negated paths are excluded', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a-original');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.test.ts`, 'test-original');
        await add(ctx, ['a.ts', 'a.test.ts']);
        await commit(ctx, { message: 'baseline', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a-modified');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.test.ts`, 'test-modified');

        // Act — restore *.ts but exclude *.test.ts.
        await checkout(ctx, { paths: ['*.ts', '!*.test.ts'], source: 'HEAD' });

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.ts`)).toBe('a-original');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.test.ts`)).toBe('test-modified');
      });
    });
  });

  describe('Given a checkout that throws (unknown branch)', () => {
    describe('When run', () => {
      it('Then end still fires', async () => {
        // Arrange
        const ctx = await seedWithBranch();
        const { reporter, events } = recordingProgress();

        try {
          await checkout(withProgress(ctx, reporter), { target: 'does-not-exist' });
        } catch {
          // expected
        }

        const startCount = events.filter((e) => e.kind === 'start').length;
        const endCount = events.filter((e) => e.kind === 'end').length;
        // Assert
        expect(endCount).toBe(startCount);
      });
    });
  });
});

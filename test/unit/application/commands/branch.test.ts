import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  branchCreate,
  branchDelete,
  branchList,
  branchRename,
  compareRefName,
} from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  __resetConfigCacheForTests,
  invalidateConfigCache,
} from '../../../../src/application/primitives/config-read.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
import { getRefStore, refExists } from '../../../../src/application/primitives/ref-store.js';
import {
  appendReflog,
  deleteReflog,
  listReflogs,
  readReflog,
  reflogExists,
} from '../../../../src/application/primitives/reflog-store.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { fileNotFound, TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, RefName, Tag } from '../../../../src/domain/objects/index.js';
import { ObjectId, serializeObject, zeroOid } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/reflog-entry.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ZERO_OID = '0'.repeat(40);
const FROZEN_NOW_S = 1_700_000_000;
const FROZEN_NOW_MS = FROZEN_NOW_S * 1000;

/**
 * Extends the base commit fixture with non-commit branch-point candidates:
 * a bare tree and blob (by oid), a lightweight tag over the tree, and
 * annotated tags over the tree and over the commit — the shapes
 * `branch.create`'s start-point typing (D12) must refuse or peel.
 */
const seedWithCommit = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  const treeId = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const blobId = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode('blob'),
  });
  await updateRef(ctx, 'refs/tags/light-to-tree' as RefName, treeId, { reflogMessage: 'test' });
  const tagToTreeId = await writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: treeId,
      objectType: 'tree',
      tagName: 'tag-to-tree',
      tagger: author,
      message: 'tag-to-tree\n',
      extraHeaders: [],
    },
  });
  await updateRef(ctx, 'refs/tags/tag-to-tree' as RefName, tagToTreeId, { reflogMessage: 'test' });
  const tagToCommitId = await writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: c.id,
      objectType: 'commit',
      tagName: 'tag-to-commit',
      tagger: author,
      message: 'tag-to-commit\n',
      extraHeaders: [],
    },
  });
  await updateRef(ctx, 'refs/tags/tag-to-commit' as RefName, tagToCommitId, {
    reflogMessage: 'test',
  });
  return { ctx, commitId: c.id, treeId, blobId, tagToTreeId, tagToCommitId };
};

/**
 * Plants a raw loose tag object at `id`'s OWN chosen path without computing
 * its hash from `tag`'s content — the on-disk shape a hostile repository can
 * plant (git's cryptographic hash makes an honest self- or mutually-
 * referential tag chain impossible to produce any other way). `readObject`
 * defaults to `verifyHash: false`, so the mismatch between `id` and the
 * content's real hash is never checked.
 */
const writeForgedLooseTag = async (ctx: Context, id: ObjectId, tag: Tag): Promise<void> => {
  const bytes = serializeObject(tag, ctx.hashConfig);
  const compressed = await ctx.compressor.deflate(bytes);
  await ctx.fs.mkdir(objectsDir(ctx.layout.gitDir, id.slice(0, 2)));
  await ctx.fs.writeExclusive(looseObjectPath(ctx.layout.gitDir, id), compressed);
};

/**
 * A reftable-backed repository with `refs/heads/main` live and one reflog
 * entry — seeded through the real `RefStore` write path (`applyRefUpdates`),
 * never hand-built binary tables. `init` bootstraps the files-style
 * compatibility state (`.git/HEAD`, `.git/config`) `assertOperationalRepository`
 * needs; tsgit's `init` never PRODUCES a reftable repository on its own
 * (that stack is populated here, standing in for one created by real git),
 * so HEAD and `refs/heads/main` are written directly into the stack.
 */
const seedReftableWithCommit = async (): Promise<{
  readonly ctx: Context;
  readonly tip: ObjectId;
}> => {
  const ctx = withReftableStorage(createMemoryContext());
  await init(ctx);
  const tip = ObjectId.fromRaw(new Uint8Array(20).fill(0x01));
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'setSymbolic', name: 'HEAD' as RefName, target: 'refs/heads/main' as RefName },
    {
      kind: 'set',
      name: 'refs/heads/main' as RefName,
      id: tip,
      reflog: {
        oldId: zeroOid(ctx.hashConfig),
        newId: tip,
        message: 'commit (initial): first',
        unconditional: true,
      },
    },
  ]);
  return { ctx, tip };
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('branch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Given a repo with main + one commit', () => {
    describe('When branch list', () => {
      it('Then returns main as current', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        const result = await branchList(ctx);

        // Assert
        expect(result.branches.map((b) => b.name)).toContain('refs/heads/main');
        expect(result.branches.find((b) => b.name === 'refs/heads/main')?.current).toBe(true);
      });
    });
  });

  describe('Given a malformed core.maxTreeDepth', () => {
    describe('When branch list runs', () => {
      it('Then it still runs — git lists refs without parsing an object', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        const result = await branchList(ctx);

        // Assert
        expect(result.branches.map((b) => b.name)).toContain('refs/heads/main');
      });
    });

    describe('When branch rename runs', () => {
      it('Then it still runs — git renames refs without parsing an object', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        const result = await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert
        expect(result).toEqual({ from: 'refs/heads/main', to: 'refs/heads/trunk' });
      });
    });

    describe('When branch delete runs on a nonexistent branch (unforced)', () => {
      it('Then it dies on the class, not BRANCH_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act + Assert
        await expectError(() => branchDelete(ctx, { name: 'nope' }), 'CONFIG_BAD_NUMERIC_VALUE');
      });
    });

    describe('When branch create runs (cold session — first touch settles the invalid verdict)', () => {
      it('Then it dies on the class before writing the ref — typing the start point reaches the boundary naturally', async () => {
        // Arrange — branch.create carries no explicit assertRepoSettingsValid
        // call of its own; requireCommit's readObject on the resolved start
        // point is the first object-store touch, and that boundary's own
        // fast path settles the (invalid) verdict.
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act + Assert
        await expectError(() => branchCreate(ctx, { name: 'nope' }), 'CONFIG_BAD_NUMERIC_VALUE');
        expect(await refExists(ctx, 'refs/heads/nope' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a fresh branch name', () => {
    describe('When branch create', () => {
      it('Then refs/heads/<name> exists', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await branchCreate(ctx, { name: 'feature' });

        // Assert
        expect(result.id).toBe(commitId);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(true);
      });
    });
  });

  describe('Given an existing branch name', () => {
    describe('When branch create without force', () => {
      it('Then throws BRANCH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act + Assert
        await expectError(() => branchCreate(ctx, { name: 'feature' }), 'BRANCH_EXISTS');
      });
    });
  });

  describe('Given refs/heads/x is a symbolic ref to an absent refs/heads/nope', () => {
    describe('When branch x is created without force', () => {
      it('Then the branch is written through the dangling symref and both names log the creation', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW_MS);
        const { ctx, commitId } = await seedWithCommit();
        await writeSymbolicRef(ctx, 'refs/heads/x' as RefName, 'refs/heads/nope' as RefName);
        const sut = branchCreate;

        // Act
        const result = await sut(ctx, { name: 'x' });

        // Assert
        const store = getRefStore(ctx);
        // git 2.55.0 resolves HEAD before typing the entry and strips
        // `refs/heads/`, so an attached HEAD labels it with the branch name.
        const line = `${ZERO_OID} ${commitId} tsgit <tsgit@localhost> ${FROZEN_NOW_S} +0000\tbranch: Created from main\n`;
        expect(result).toEqual({ name: 'refs/heads/x', id: commitId });
        expect(await store.resolveDirect('refs/heads/x' as RefName)).toEqual({
          kind: 'symbolic',
          target: 'refs/heads/nope',
        });
        expect(await store.resolveDirect('refs/heads/nope' as RefName)).toEqual({
          kind: 'direct',
          id: commitId,
        });
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/nope`)).toBe(line);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/x`)).toBe(line);
      });
    });
  });

  describe('Given refs/heads/y is a symbolic ref to the existing refs/heads/main', () => {
    describe('When branch y is created without force', () => {
      it('Then it refuses BRANCH_EXISTS naming y', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await writeSymbolicRef(ctx, 'refs/heads/y' as RefName, 'refs/heads/main' as RefName);
        const sut = branchCreate;

        // Act
        const caught = await expectError(() => sut(ctx, { name: 'y' }), 'BRANCH_EXISTS');

        // Assert
        expect(caught.data).toEqual({ code: 'BRANCH_EXISTS', name: 'refs/heads/y' });
      });
    });
  });

  describe('Given a branch other than the current', () => {
    describe('When branch delete', () => {
      it('Then it is removed', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        await branchDelete(ctx, { name: 'feature' });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(false);
      });
    });
  });

  describe('Given a symbolic branch name pointing at another branch', () => {
    describe('When branch delete runs', () => {
      it('Then the symbolic ref itself is deleted and its target is kept, --no-deref', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'x' });
        await writeSymbolicRef(ctx, 'refs/heads/sym' as RefName, 'refs/heads/x' as RefName);

        // Act
        const result = await branchDelete(ctx, { name: 'sym' });

        // Assert
        expect(result).toEqual({ name: 'refs/heads/sym' });
        expect(await getRefStore(ctx).resolveDirect('refs/heads/sym' as RefName)).toEqual({
          kind: 'missing',
        });
        expect(await refExists(ctx, 'refs/heads/x' as RefName)).toBe(true);
      });
    });
  });

  describe('Given the current branch', () => {
    describe('When branch delete', () => {
      it('Then the refusal names the branch and the worktree holding it', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        let caught: unknown;
        try {
          await branchDelete(ctx, { name: 'main' });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'BRANCH_CHECKED_OUT',
          branch: 'refs/heads/main',
          path: ctx.layout.workDir,
        });
      });
    });
  });

  describe('Given a non-existent branch', () => {
    describe('When branch delete', () => {
      it('Then throws BRANCH_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act + Assert
        await expectError(() => branchDelete(ctx, { name: 'ghost' }), 'BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given a branch', () => {
    describe('When branch rename', () => {
      it('Then old gone + new exists, HEAD updated when current', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        const result = await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert
        expect(result).toEqual({ from: 'refs/heads/main', to: 'refs/heads/trunk' });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/trunk`)).toBe(true);
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe('ref: refs/heads/trunk\n');
      });
    });
  });

  describe('Given the checked-out branch', () => {
    describe('When branch rename runs', () => {
      it('Then logs/HEAD gains exactly two new entries: the delete then the re-point', async () => {
        // Arrange — `seedWithCommit` already made one commit through HEAD,
        // which itself appended one `logs/HEAD` entry; only the entries
        // APPENDED by the rename are under test here.
        const { ctx } = await seedWithCommit();
        const before = await getRefStore(ctx).resolveDirect('refs/heads/main' as RefName);
        if (before.kind !== 'direct') throw new Error('unreachable');
        const id = before.id;
        const baseline = await readReflog(ctx, 'HEAD' as RefName);

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });
        const result = await readReflog(ctx, 'HEAD' as RefName);
        const appended = result.slice(baseline.length);

        // Assert
        expect(appended).toHaveLength(2);
        expect(appended[0]?.oldId).toBe(id);
        expect(appended[0]?.newId).toBe(zeroOid(ctx.hashConfig));
        expect(appended[0]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/trunk');
        expect(appended[1]?.oldId).toBe(zeroOid(ctx.hashConfig));
        expect(appended[1]?.newId).toBe(id);
        expect(appended[1]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/trunk');
      });
    });

    describe('When branch rename force-renames onto a live branch', () => {
      it('Then logs/HEAD still gains exactly the same two new entries', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'other' });
        const before = await getRefStore(ctx).resolveDirect('refs/heads/main' as RefName);
        if (before.kind !== 'direct') throw new Error('unreachable');
        const id = before.id;
        const baseline = await readReflog(ctx, 'HEAD' as RefName);

        // Act
        await branchRename(ctx, { from: 'main', to: 'other', force: true });
        const result = await readReflog(ctx, 'HEAD' as RefName);
        const appended = result.slice(baseline.length);

        // Assert
        expect(appended).toHaveLength(2);
        expect(appended[0]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/other');
        expect(appended[1]?.oldId).toBe(zeroOid(ctx.hashConfig));
        expect(appended[1]?.newId).toBe(id);
      });
    });
  });

  describe('Given a branch other than the checked-out one', () => {
    describe('When branch rename runs', () => {
      it('Then logs/HEAD gains no new entry', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'other' });
        const baseline = await readReflog(ctx, 'HEAD' as RefName);

        // Act
        await branchRename(ctx, { from: 'other', to: 'renamed2' });
        const result = await readReflog(ctx, 'HEAD' as RefName);

        // Assert
        expect(result).toEqual(baseline);
      });
    });
  });

  describe('Given a self-rename of the checked-out branch', () => {
    describe('When branch rename runs', () => {
      it('Then logs/HEAD gains no new entry — the self-rename arm neither deletes nor re-points', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const baseline = await readReflog(ctx, 'HEAD' as RefName);

        // Act
        await branchRename(ctx, { from: 'main', to: 'main', force: true });
        const result = await readReflog(ctx, 'HEAD' as RefName);

        // Assert
        expect(result).toEqual(baseline);
      });
    });
  });

  describe('Given a branch whose reflog contains a malformed line', () => {
    describe('When branch rename', () => {
      it('Then the malformed line survives verbatim under the new name, followed by the rename entry', async () => {
        // Arrange — a strict read-then-rewrite would throw on this line, and
        // a lenient read-then-rewrite would silently drop it; a
        // byte-preserving move must never parse it at all.
        const { ctx } = await seedWithCommit();
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/logs/refs/heads/main`,
          'this is not a valid reflog line at all\n',
        );

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert
        const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/trunk`);
        const lines = raw.split('\n').filter((line) => line.length > 0);
        expect(lines[1]).toBe('this is not a valid reflog line at all');
        expect(lines[2]).toContain('Branch: renamed refs/heads/main to refs/heads/trunk');
      });
    });
  });

  describe('Given a branch with reflog history', () => {
    describe('When branch rename', () => {
      it('Then the new ref reflog is [...source-history, rename-entry] and the source reflog is gone', async () => {
        // Arrange — the seed commit logs one entry to refs/heads/main's reflog.
        const { ctx } = await seedWithCommit();
        const before = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(before).toHaveLength(1);

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert — the moved history precedes the rename entry on the new ref,
        // and the source reflog file no longer exists.
        const movedLog = await readReflog(ctx, 'refs/heads/trunk' as RefName);
        expect(movedLog).toHaveLength(2);
        expect(movedLog[0]).toEqual(before[0]);
        expect(movedLog[1]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/trunk');
        expect(await reflogExists(ctx, 'refs/heads/main' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a branch with reflog history', () => {
    describe('When branch rename', () => {
      it('Then the rename entry carries the current tip as both oldId and newId', async () => {
        // Arrange — the rename entry notes the rename; it does not move the
        // ref's value, so old/new are both the tip resolveRef found before
        // the write (measured against real git's files-backend `branch -m`).
        const { ctx } = await seedWithCommit();
        const before = await readReflog(ctx, 'refs/heads/main' as RefName);
        const tip = before[0]?.newId;

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert
        const movedLog = await readReflog(ctx, 'refs/heads/trunk' as RefName);
        const renameEntry = movedLog[movedLog.length - 1];
        expect(renameEntry?.oldId).toBe(tip);
        expect(renameEntry?.newId).toBe(tip);
      });
    });
  });

  describe('Given a reftable-backed branch with reflog history', () => {
    describe('When branch rename runs', () => {
      it("Then the old branch is gone, the new branch exists, and history moved with git's reftable delete-then-create shape — never a half-applied rename", async () => {
        // Arrange
        const { ctx } = await seedReftableWithCommit();
        const before = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(before).toHaveLength(1);

        // Act
        const result = await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert — the two branches never coexist.
        expect(result).toEqual({ from: 'refs/heads/main', to: 'refs/heads/trunk' });
        const names = (await branchList(ctx)).branches.map((b) => b.name);
        expect(names).not.toContain('refs/heads/main');
        expect(names).toContain('refs/heads/trunk');

        // Assert — moved history, then TWO rename entries (git's reftable
        // shape): a delete-shaped `<id> 0{40}` then a create-shaped
        // `0{40} <id>`, unlike the files backend's single `<id> <id>` entry.
        const movedLog = await readReflog(ctx, 'refs/heads/trunk' as RefName);
        expect(movedLog).toHaveLength(3);
        expect(movedLog[0]).toEqual(before[0]);
        expect(movedLog[1]?.oldId).toBe(before[0]?.newId);
        expect(movedLog[1]?.newId).toBe(zeroOid(ctx.hashConfig));
        expect(movedLog[1]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/trunk');
        expect(movedLog[2]?.oldId).toBe(zeroOid(ctx.hashConfig));
        expect(movedLog[2]?.newId).toBe(before[0]?.newId);
        expect(movedLog[2]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/trunk');
        expect(await readReflog(ctx, 'refs/heads/main' as RefName)).toEqual([]);
        expect(await listReflogs(ctx)).not.toContain('refs/heads/main');
      });
    });

    describe('When branch rename force-renames onto a live branch whose own record sits between the source history', () => {
      it("Then the destination's own entries stay in update-index order — never dropped, never reordered", async () => {
        // Arrange — three separate writes, each its own update index: the
        // source's own commit, then the destination branch's creation, then
        // a second move on the source — so a naive merge that appends the
        // whole source history after the destination's would reorder them incorrectly.
        const { ctx, tip } = await seedReftableWithCommit();
        const store = getRefStore(ctx);
        const secondTip = ObjectId.fromRaw(new Uint8Array(20).fill(0x02));
        await store.applyRefUpdates([
          {
            kind: 'set',
            name: 'refs/heads/other' as RefName,
            id: tip,
            reflog: {
              oldId: zeroOid(ctx.hashConfig),
              newId: tip,
              message: 'branch: Created from main',
              unconditional: true,
            },
          },
        ]);
        await store.applyRefUpdates([
          {
            kind: 'set',
            name: 'refs/heads/main' as RefName,
            id: secondTip,
            reflog: {
              oldId: tip,
              newId: secondTip,
              message: 'commit: second',
              unconditional: true,
            },
          },
        ]);

        // Act
        await branchRename(ctx, { from: 'main', to: 'other', force: true });

        // Assert
        const merged = await readReflog(ctx, 'refs/heads/other' as RefName);
        expect(merged.map((e) => e.message)).toEqual([
          'commit (initial): first',
          'branch: Created from main',
          'commit: second',
          'Branch: renamed refs/heads/main to refs/heads/other',
          'Branch: renamed refs/heads/main to refs/heads/other',
        ]);
      });
    });
  });

  describe('Given a branch renamed onto its own name with force', () => {
    describe('When branch rename', () => {
      it('Then the branch and its history survive and only the rename entry is appended', async () => {
        // Arrange — git accepts a self-rename (`branch -M x x` exits 0): the
        // ref stays, the log stays, one rename entry lands (measured, 2.55.0).
        const { ctx } = await seedWithCommit();
        const before = await readReflog(ctx, 'refs/heads/main' as RefName);

        // Act
        const result = await branchRename(ctx, { from: 'main', to: 'main', force: true });

        // Assert
        expect(result).toEqual({ from: 'refs/heads/main', to: 'refs/heads/main' });
        const names = (await branchList(ctx)).branches.map((b) => b.name);
        expect(names).toContain('refs/heads/main');
        const log = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(log).toHaveLength(before.length + 1);
        expect(log[log.length - 1]?.message).toBe(
          'Branch: renamed refs/heads/main to refs/heads/main',
        );
      });
    });
  });

  describe('Given a branch renamed onto its own name without force', () => {
    describe('When branch rename', () => {
      it('Then it succeeds exactly like the forced form instead of refusing', async () => {
        // Arrange — `branch -m x x` also exits 0 in git; the absent-CAS that
        // guards a real rename does not apply to the self case.
        const { ctx } = await seedWithCommit();

        // Act
        const result = await branchRename(ctx, { from: 'main', to: 'main' });

        // Assert
        expect(result).toEqual({ from: 'refs/heads/main', to: 'refs/heads/main' });
        const names = (await branchList(ctx)).branches.map((b) => b.name);
        expect(names).toContain('refs/heads/main');
      });
    });
  });

  describe('Given a log-less source force-renamed onto a live branch that has a reflog', () => {
    describe('When branch rename', () => {
      it('Then the destination old history is dropped and only the rename entry remains', async () => {
        // Arrange — the one shape where the destination-log drop is
        // load-bearing on its own: with no source log to rename over it,
        // only the explicit drop separates "replaced" from "concatenated"
        // (git's forced rename deletes the destination ref, dropping its
        // log, before the rename entry is appended).
        const { ctx, commitId } = await seedWithCommit();
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'set', name: 'refs/heads/other' as RefName, id: commitId },
        ]);
        const stale = (await readReflog(ctx, 'refs/heads/main' as RefName))[0] as ReflogEntry;
        await appendReflog(ctx, 'refs/heads/other' as RefName, stale);
        await deleteReflog(ctx, 'refs/heads/main' as RefName);

        // Act
        await branchRename(ctx, { from: 'main', to: 'other', force: true });

        // Assert — exactly one entry: the rename; the stale history is gone.
        const log = await readReflog(ctx, 'refs/heads/other' as RefName);
        expect(log).toHaveLength(1);
        expect(log[0]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/other');
      });
    });
  });

  describe('Given a log-less source and an orphan reflog file under the destination name', () => {
    describe('When branch rename', () => {
      it('Then the orphan history is kept and the rename entry appends to it', async () => {
        // Arrange — `to` is NOT a live ref, only a leftover log file exists.
        // git keeps that orphan log and appends (measured, 2.55.0); only a
        // forced rename over a LIVE ref drops the old log.
        const { ctx } = await seedWithCommit();
        const mainLog = await readReflog(ctx, 'refs/heads/main' as RefName);
        const orphan = mainLog[0] as ReflogEntry;
        await appendReflog(ctx, 'refs/heads/trunk' as RefName, orphan);
        await deleteReflog(ctx, 'refs/heads/main' as RefName);

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert — orphan entry first, rename entry after it.
        const log = await readReflog(ctx, 'refs/heads/trunk' as RefName);
        expect(log).toHaveLength(2);
        expect(log[0]).toEqual(orphan);
        expect(log[1]?.message).toBe('Branch: renamed refs/heads/main to refs/heads/trunk');
      });
    });
  });

  describe('Given a source branch with no reflog', () => {
    describe('When branch rename', () => {
      it('Then the renamed branch gets no empty reflog file', async () => {
        // Arrange — logging is off before the seed commit, so refs/heads/main has
        // no reflog. The rename must not write an (empty) reflog for the target:
        // the moved-history write is guarded on a non-empty source log.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  logallrefupdates = false\n',
        );
        __resetConfigCacheForTests();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        expect(await reflogExists(ctx, 'refs/heads/main' as RefName)).toBe(false);

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert — no source history to move, so the target has no reflog file.
        expect(await reflogExists(ctx, 'refs/heads/trunk' as RefName)).toBe(false);
        __resetConfigCacheForTests();
      });
    });
  });

  describe('Given a branch a, and refs/heads/y a symbolic ref to the existing refs/heads/main', () => {
    const seedSymbolicDestination = async () => {
      const seeded = await seedWithCommit();
      await branchCreate(seeded.ctx, { name: 'a' });
      await writeSymbolicRef(seeded.ctx, 'refs/heads/y' as RefName, 'refs/heads/main' as RefName);
      return seeded;
    };

    describe('When branch rename moves a onto y without force', () => {
      it('Then it refuses BRANCH_EXISTS naming y and changes nothing', async () => {
        // Arrange
        const { ctx, commitId } = await seedSymbolicDestination();
        const store = getRefStore(ctx);
        const sut = branchRename;

        // Act
        const caught = await expectError(() => sut(ctx, { from: 'a', to: 'y' }), 'BRANCH_EXISTS');

        // Assert
        expect(caught.data).toEqual({ code: 'BRANCH_EXISTS', name: 'refs/heads/y' });
        expect(await store.resolveDirect('refs/heads/y' as RefName)).toEqual({
          kind: 'symbolic',
          target: 'refs/heads/main',
        });
        expect(await store.resolveDirect('refs/heads/a' as RefName)).toEqual({
          kind: 'direct',
          id: commitId,
        });
        expect(await readReflog(ctx, 'refs/heads/a' as RefName)).toHaveLength(1);
      });
    });

    describe('When branch rename moves a onto y with force', () => {
      it("Then y becomes a direct ref carrying a's log plus the rename entry, and main is untouched", async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW_MS);
        const { ctx, commitId } = await seedSymbolicDestination();
        const store = getRefStore(ctx);
        const mainLogBefore = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`);
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'a', to: 'y', force: true });

        // Assert
        const identity = `tsgit <tsgit@localhost> ${FROZEN_NOW_S} +0000`;
        expect(await store.resolveDirect('refs/heads/y' as RefName)).toEqual({
          kind: 'direct',
          id: commitId,
        });
        expect(await store.resolveDirect('refs/heads/a' as RefName)).toEqual({ kind: 'missing' });
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/y`)).toBe(
          `${ZERO_OID} ${commitId} ${identity}\tbranch: Created from main\n` +
            `${commitId} ${commitId} ${identity}\tBranch: renamed refs/heads/a to refs/heads/y\n`,
        );
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`)).toBe(
          mainLogBefore,
        );
      });
    });
  });

  describe('Given a branch b, and refs/heads/dy a symbolic ref to an absent refs/heads/nope', () => {
    describe('When branch rename moves b onto dy without force', () => {
      it('Then dy is replaced by a direct ref and nope is never created', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await branchCreate(ctx, { name: 'b' });
        await writeSymbolicRef(ctx, 'refs/heads/dy' as RefName, 'refs/heads/nope' as RefName);
        const store = getRefStore(ctx);
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'b', to: 'dy' });

        // Assert
        expect(await store.resolveDirect('refs/heads/dy' as RefName)).toEqual({
          kind: 'direct',
          id: commitId,
        });
        expect(await store.resolveDirect('refs/heads/nope' as RefName)).toEqual({
          kind: 'missing',
        });
        expect(await store.resolveDirect('refs/heads/b' as RefName)).toEqual({ kind: 'missing' });
      });
    });
  });

  describe('Given refs/heads/sym is a symbolic ref to refs/heads/x, and a branch y', () => {
    const seedSymbolicSource = async () => {
      const seeded = await seedWithCommit();
      await branchCreate(seeded.ctx, { name: 'x' });
      await branchCreate(seeded.ctx, { name: 'y' });
      await writeSymbolicRef(seeded.ctx, 'refs/heads/sym' as RefName, 'refs/heads/x' as RefName);
      return seeded;
    };

    describe('When branch rename moves sym', () => {
      it.each([
        { label: 'to a new name', to: 'renamed', force: false },
        { label: 'onto itself', to: 'sym', force: false },
        { label: 'onto the existing y with force', to: 'y', force: true },
      ])(
        'Then renaming it $label refuses UNSUPPORTED_OPERATION and changes nothing',
        async ({ to, force }) => {
          // Arrange
          const { ctx, commitId } = await seedSymbolicSource();
          const store = getRefStore(ctx);
          const symLogBefore = await readReflog(ctx, 'refs/heads/sym' as RefName);
          const sut = branchRename;

          // Act
          const caught = await expectError(
            () => sut(ctx, { from: 'sym', to, force }),
            'UNSUPPORTED_OPERATION',
          );

          // Assert
          expect(caught.data).toEqual({
            code: 'UNSUPPORTED_OPERATION',
            operation: 'branch.rename',
            reason: 'refname refs/heads/sym is a symbolic ref',
          });
          expect(await store.resolveDirect('refs/heads/sym' as RefName)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/x',
          });
          expect(await store.resolveDirect('refs/heads/y' as RefName)).toEqual({
            kind: 'direct',
            id: commitId,
          });
          expect(await store.resolveDirect('refs/heads/renamed' as RefName)).toEqual({
            kind: 'missing',
          });
          expect(await readReflog(ctx, 'refs/heads/sym' as RefName)).toEqual(symLogBefore);
        },
      );

      it('Then renaming it onto the existing y without force refuses BRANCH_EXISTS first', async () => {
        // Arrange
        const { ctx } = await seedSymbolicSource();
        const sut = branchRename;

        // Act
        const caught = await expectError(() => sut(ctx, { from: 'sym', to: 'y' }), 'BRANCH_EXISTS');

        // Assert
        expect(caught.data).toEqual({ code: 'BRANCH_EXISTS', name: 'refs/heads/y' });
      });
    });
  });

  describe('Given a non-current branch', () => {
    describe('When branch rename', () => {
      it('Then HEAD is unchanged (only the renamed-current branch updates HEAD)', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'other' });

        // Act
        await branchRename(ctx, { from: 'other', to: 'renamed' });

        // Assert
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe('ref: refs/heads/main\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/renamed`)).toBe(true);
      });
    });
  });

  describe('Given an existing branch + force=true', () => {
    describe('When branch create', () => {
      it('Then it overwrites without throwing', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act + Assert — must not throw with force.
        const result = await branchCreate(ctx, { name: 'feature', force: true });
        // Assert
        expect(result.name).toBe('refs/heads/feature');
      });
    });
  });

  describe('Given a branch name a ref already resolves under', () => {
    describe('When branch create forces it onto a new start point', () => {
      it('Then the appended reflog reads "branch: Reset to <start-point>"', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const sut = branchCreate;
        await sut(ctx, { name: 'feature', startPoint: commitId });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });

        // Act
        await sut(ctx, { name: 'feature', startPoint: 'main', force: true });

        // Assert
        const log = await readReflog(ctx, 'refs/heads/feature' as RefName);
        expect(log.at(-1)?.message).toBe('branch: Reset to main');
      });
    });

    describe('When branch create forces a name only a dangling symbolic ref holds', () => {
      it('Then the appended reflog still reads "branch: Created from <start-point>"', async () => {
        // Arrange — git types the message off `ref_exists`, which a symbolic
        // ref whose target is absent does not satisfy.
        const { ctx, commitId } = await seedWithCommit();
        await writeSymbolicRef(ctx, 'refs/heads/dangling' as RefName, 'refs/heads/nope' as RefName);
        const sut = branchCreate;

        // Act
        await sut(ctx, { name: 'dangling', startPoint: commitId, force: true });

        // Assert
        const log = await readReflog(ctx, 'refs/heads/nope' as RefName);
        expect(log.at(-1)?.message).toBe(`branch: Created from ${commitId}`);
      });
    });
  });

  describe('Given a branch name nothing holds', () => {
    describe('When branch create forces it', () => {
      it('Then the appended reflog reads "branch: Created from <start-point>"', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const sut = branchCreate;

        // Act
        await sut(ctx, { name: 'fresh', startPoint: commitId, force: true });

        // Assert
        const log = await readReflog(ctx, 'refs/heads/fresh' as RefName);
        expect(log.at(-1)?.message).toBe(`branch: Created from ${commitId}`);
      });
    });
  });

  describe('Given an explicit startPoint (oid)', () => {
    describe('When branch create', () => {
      it('Then the new ref points at that oid', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await branchCreate(ctx, { name: 'pin', startPoint: commitId });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a SHA-256 repository and an explicit startPoint (64-hex oid)', () => {
    describe('When branch create', () => {
      it('Then the new ref points at that oid, taken verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const { id: commitId } = await commit(ctx, { message: 'first', author });
        expect(commitId).toHaveLength(64);

        // Act
        const result = await branchCreate(ctx, { name: 'pin', startPoint: commitId });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given an explicit startPoint as a branch name', () => {
    describe('When branch create', () => {
      it('Then resolves and pins to that branch tip', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        const result = await branchCreate(ctx, { name: 'pin', startPoint: 'feature' });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a startPoint that resolves to a tree (full oid)', () => {
    describe('When branch create runs', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE and writes nothing', async () => {
        // Arrange
        const { ctx, treeId } = await seedWithCommit();
        let caught: unknown;

        // Act
        try {
          await branchCreate(ctx, { name: 'b2', startPoint: treeId });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: treeId,
        });
        expect(await refExists(ctx, 'refs/heads/b2' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a startPoint that resolves to a blob (full oid)', () => {
    describe('When branch create runs', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE and writes nothing', async () => {
        // Arrange
        const { ctx, blobId } = await seedWithCommit();
        let caught: unknown;

        // Act
        try {
          await branchCreate(ctx, { name: 'b2', startPoint: blobId });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'blob',
          id: blobId,
        });
        expect(await refExists(ctx, 'refs/heads/b2' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a startPoint that is a lightweight tag over a tree', () => {
    describe('When branch create runs', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE for the tree and writes nothing', async () => {
        // Arrange
        const { ctx, treeId } = await seedWithCommit();
        let caught: unknown;

        // Act
        try {
          await branchCreate(ctx, { name: 'b2', startPoint: 'refs/tags/light-to-tree' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: treeId,
        });
        expect(await refExists(ctx, 'refs/heads/b2' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a startPoint that is an annotated tag over a tree', () => {
    describe('When branch create runs', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE with the tag oid, not the tree, and writes nothing', async () => {
        // Arrange — git reports the resolved tag's own oid, never the peeled
        // target, alongside the fully-peeled type (measured, git 2.55.0).
        const { ctx, tagToTreeId } = await seedWithCommit();
        let caught: unknown;

        // Act
        try {
          await branchCreate(ctx, { name: 'b2', startPoint: 'refs/tags/tag-to-tree' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: tagToTreeId,
        });
        expect(await refExists(ctx, 'refs/heads/b2' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a startPoint that is an annotated tag over a commit', () => {
    describe('When branch create runs', () => {
      it('Then the branch lands on the commit, not the tag object', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await branchCreate(ctx, {
          name: 'peeled',
          startPoint: 'refs/tags/tag-to-commit',
        });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a two-object tag cycle (A -> B -> A), forged directly on disk', () => {
    describe('When branch create runs', () => {
      it('Then throws REF_CHAIN_TOO_DEEP instead of hanging', async () => {
        // Arrange — no honest hash chain can produce a mutual reference, so
        // both tags are forged straight onto the loose-object store.
        const { ctx } = await seedWithCommit();
        const tagAId = ObjectId.from('a'.repeat(40));
        const tagBId = ObjectId.from('b'.repeat(40));
        await writeForgedLooseTag(ctx, tagAId, {
          type: 'tag',
          id: tagAId,
          data: {
            object: tagBId,
            objectType: 'tag',
            tagName: 'cycle-a',
            tagger: author,
            message: 'cycle-a\n',
            extraHeaders: [],
          },
        });
        await writeForgedLooseTag(ctx, tagBId, {
          type: 'tag',
          id: tagBId,
          data: {
            object: tagAId,
            objectType: 'tag',
            tagName: 'cycle-b',
            tagger: author,
            message: 'cycle-b\n',
            extraHeaders: [],
          },
        });

        // Act
        let caught: unknown;
        try {
          await branchCreate(ctx, { name: 'x', startPoint: tagAId });
        } catch (err) {
          caught = err;
        }

        // Assert — the full payload, not just the code: pins the depth cap
        // as the refusal, not some other error shape.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'REF_CHAIN_TOO_DEEP',
          depth: 6,
          chain: [],
        });
      }, 5_000);
    });
  });

  describe('Given an existing branch name and an unresolvable startPoint', () => {
    describe('When branch create runs without force', () => {
      it('Then throws BRANCH_EXISTS before the startPoint ever resolves', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'side' });

        // Act + Assert
        await expectError(
          () => branchCreate(ctx, { name: 'side', startPoint: 'nope' }),
          'BRANCH_EXISTS',
        );
      });
    });
  });

  describe('Given an existing branch name and an unresolvable startPoint, with force', () => {
    describe('When branch create runs', () => {
      it('Then throws BRANCH_NOT_FOUND — force skips the exists check, not resolution', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'side' });

        // Act + Assert
        await expectError(
          () => branchCreate(ctx, { name: 'side', startPoint: 'nope', force: true }),
          'BRANCH_NOT_FOUND',
        );
      });
    });
  });

  describe('Given a startPoint that is a nonexistent full oid', () => {
    describe('When branch create runs', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const missing = ObjectId.fromRaw(new Uint8Array(20).fill(0x09));

        // Act + Assert
        await expectError(
          () => branchCreate(ctx, { name: 'ghost', startPoint: missing }),
          'OBJECT_NOT_FOUND',
        );
      });
    });
  });

  describe('Given branch list on a repo with no refs/heads dir', () => {
    describe('When branch list', () => {
      it('Then returns an empty array', async () => {
        // Arrange — fresh ctx, no init.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await branchList(ctx);

        // Assert
        expect(result.branches).toEqual([]);
      });
    });
  });

  /**
   * Simulates a dangling-symlink HEAD (the shape real git's discovery
   * accepts by link text alone — measured against git 2.55.0): `readlink`
   * succeeds so discovery's `hasUsableHead` passes, but the loose-ref lookup
   * `resolveDirect` reads the target through `readUtf8` — which a
   * stat-following read reports as `FILE_NOT_FOUND` for a dangling target,
   * exactly like the node adapter does for a real dangling symlink (`exists`
   * is faked the same way, for the same reason). `resolveDirect(HEAD)`
   * therefore answers `{ kind: 'missing' }`, and `readHeadRaw` throws
   * `REF_NOT_FOUND`.
   */
  const FAKE_SYMLINK_STAT: FileStat = {
    ctimeMs: 0,
    mtimeMs: 0,
    dev: 0,
    ino: 0,
    mode: 0o120000,
    uid: 0,
    gid: 0,
    size: 0,
    isFile: false,
    isDirectory: false,
    isSymbolicLink: true,
  };

  const withUnresolvableHead = (ctx: Context): Context => {
    const headPath = `${ctx.layout.gitDir}/HEAD`;
    return {
      ...ctx,
      fs: {
        ...ctx.fs,
        // `hasUsableHead` discriminates on `lstat` before choosing `readlink`
        // vs `readUtf8` — report the symlink shape this fake simulates (a
        // literal stat, not the underlying real one, since one of the two
        // callers below has no real HEAD file at all) so it takes the
        // `readlink` branch, exactly as it did before that discrimination
        // existed.
        lstat: async (path: string): Promise<FileStat> =>
          path === headPath ? FAKE_SYMLINK_STAT : ctx.fs.lstat(path),
        readlink: async (path: string) =>
          path === headPath ? 'refs/heads/does-not-exist' : ctx.fs.readlink(path),
        exists: async (path: string) => (path === headPath ? false : ctx.fs.exists(path)),
        readUtf8: async (path: string) => {
          if (path === headPath) throw fileNotFound(headPath);
          return ctx.fs.readUtf8(path);
        },
      },
    };
  };

  describe('Given a repository with branches whose HEAD does not resolve', () => {
    describe('When branch list', () => {
      it('Then every branch is listed with current: false, instead of throwing', async () => {
        // Arrange — measured: git 2.55.0 `branch --list` against a dangling
        // HEAD symlink exits 0 and lists branches, marking none current.
        const { ctx } = await seedWithCommit();

        // Act
        const result = await branchList(withUnresolvableHead(ctx));

        // Assert
        expect(result.branches.map((b) => b.name)).toContain('refs/heads/main');
        expect(result.branches.every((b) => b.current === false)).toBe(true);
      });
    });
  });

  describe('Given a repository with no branches and an unresolvable HEAD', () => {
    describe('When branch list', () => {
      it('Then returns an empty array without throwing', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await branchList(withUnresolvableHead(ctx));

        // Assert
        expect(result.branches).toEqual([]);
      });
    });
  });

  describe('Given an existing target branch + force=true', () => {
    describe('When branch rename', () => {
      it('Then force overrides the BRANCH_EXISTS guard', async () => {
        // Arrange — kills `force === true ? {} : { expected: 'absent' }` mutants on rename.
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'a' });
        await branchCreate(ctx, { name: 'b' });

        // Act + Assert — without force this would BRANCH_EXISTS; with force it succeeds.
        await branchRename(ctx, { from: 'a', to: 'b', force: true });
        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/a`)).toBe(false);
      });
    });
  });

  describe('Given an existing target branch with its own reflog + force=true', () => {
    describe('When branch rename', () => {
      it('Then the target reflog becomes the source history plus the rename entry, not a concatenation', async () => {
        // Arrange — both `a` and `b` get their own one-entry creation reflog.
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'a' });
        await branchCreate(ctx, { name: 'b' });
        const sourceLog = await readReflog(ctx, 'refs/heads/a' as RefName);
        expect(sourceLog).toHaveLength(1);

        // Act
        await branchRename(ctx, { from: 'a', to: 'b', force: true });

        // Assert — b's own prior entry is gone; only a's history plus the
        // rename entry remain, matching git's own delete_ref-then-move.
        const targetLog = await readReflog(ctx, 'refs/heads/b' as RefName);
        expect(targetLog).toHaveLength(2);
        expect(targetLog[0]).toEqual(sourceLog[0]);
        expect(targetLog[1]?.message).toBe('Branch: renamed refs/heads/a to refs/heads/b');
      });
    });
  });

  describe('Given an existing target branch + force=false', () => {
    describe('When branch rename', () => {
      it('Then throws BRANCH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'a' });
        await branchCreate(ctx, { name: 'b' });

        // Act + Assert
        await expectError(() => branchRename(ctx, { from: 'a', to: 'b' }), 'BRANCH_EXISTS');
      });
    });
  });

  describe('Given a nested branch and a packed-only branch', () => {
    describe('When branch list', () => {
      it('Then both the nested branch and the packed-only branch appear', async () => {
        // Arrange — `nested/leaf` creates a `nested` DIRECTORY entry under
        // refs/heads (a flat readdir would have skipped it); `packed` exists
        // only in packed-refs, with no loose file at all.
        const { ctx, commitId } = await seedWithCommit();
        await branchCreate(ctx, { name: 'nested/leaf' });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/packed-refs`,
          `# pack-refs with: peeled fully-peeled sorted\n${commitId} refs/heads/packed\n`,
        );

        // Act
        const result = await branchList(ctx);

        // Assert
        expect(result.branches.map((b) => b.name)).toEqual([
          'refs/heads/main',
          'refs/heads/nested/leaf',
          'refs/heads/packed',
        ]);
      });
    });
  });

  describe('Given a non-current branch in the list', () => {
    describe('When branch list', () => {
      it('Then that branch is current=false', async () => {
        // Arrange — kills `name === currentTarget -> true` (every branch flagged current).
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        const result = await branchList(ctx);

        // Assert
        expect(result.branches.find((b) => b.name === 'refs/heads/feature')?.current).toBe(false);
      });
    });
  });

  describe('Given branches created out of order', () => {
    describe('When branch list', () => {
      it('Then branches are sorted ascending by name', async () => {
        // Arrange — readdir yields entries by name, so the comparator's input is
        // already ['main','xray','beta'] in name order? No: memory-fs readdir
        // returns insertion order. Seeding xray then beta after the default `main`
        // gives walk order [main, xray, beta] — distinct from BOTH the sorted
        // result [beta, main, xray] AND its reverse [xray, main, beta]. A
        // comparator mutated to a constant -1 (reverse) or 1 (identity) therefore
        // produces a provably wrong order, killing both ConditionalExpression
        // mutants on the comparator.
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'xray' });
        await branchCreate(ctx, { name: 'beta' });

        // Act
        const result = await branchList(ctx);

        // Assert — ascending: beta < main < xray.
        expect(result.branches.map((b) => b.name)).toEqual([
          'refs/heads/beta',
          'refs/heads/main',
          'refs/heads/xray',
        ]);
      });
    });
  });

  describe('Given updateRef throws a non-TsgitError', () => {
    describe('When branch create', () => {
      it('Then that exact error propagates unchanged', async () => {
        // Arrange — kills the `err instanceof TsgitError` operand on createBranch.
        const { ctx } = await seedWithCommit();
        const boom = new Error('disk gone');
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        let caught: unknown;
        try {
          await branchCreate(failingCtx, { name: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — same instance, not wrapped, not a TsgitError-coded error.
        expect(caught).toBe(boom);
        expect(caught).not.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given updateRef throws a non-conflict TsgitError', () => {
    describe('When branch create', () => {
      it('Then it propagates as-is (not BRANCH_EXISTS)', async () => {
        // Arrange — kills the `code === REF_UPDATE_CONFLICT` operand on createBranch.
        const { ctx } = await seedWithCommit();
        const boom = new TsgitError({ code: 'NETWORK_ERROR', reason: 'transient' });
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        const err = await expectError(
          () => branchCreate(failingCtx, { name: 'feature' }),
          'NETWORK_ERROR',
        );

        // Assert — original error, not remapped to BRANCH_EXISTS.
        expect(err).toBe(boom);
      });
    });
  });

  describe('Given a create/create race between the early exists probe and the CAS write', () => {
    describe('When branch create runs', () => {
      it('Then the CAS conflict still surfaces as BRANCH_EXISTS', async () => {
        // Arrange — the early `refExists` probe reads the loose ref file and
        // finds it absent; a concurrent `branch create` lands before
        // `updateRef`'s own CAS re-reads the SAME file, which now reports the
        // ref present, so `expected: 'absent'` conflicts. This is the only
        // path that reaches the catch's positive arm (REF_UPDATE_CONFLICT ->
        // BRANCH_EXISTS) — the pre-existing "already exists" test proves the
        // early check instead.
        const { ctx, commitId } = await seedWithCommit();
        const racedPath = `${ctx.layout.gitDir}/refs/heads/race`;
        let reads = 0;
        const racyCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path, mode) => {
              if (path !== racedPath) return ctx.fs.openWithNoFollow(path, mode);
              reads += 1;
              if (reads === 1) throw fileNotFound(path);
              await ctx.fs.writeUtf8(racedPath, `${commitId}\n`);
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        };

        // Act + Assert — the read count is the only thing separating this
        // from the early-probe test, which refuses with the same code: two
        // reads means the probe found nothing and the CAS re-read found the
        // ref, so the catch's positive arm is what answered.
        await expectError(() => branchCreate(racyCtx, { name: 'race' }), 'BRANCH_EXISTS');
        expect(reads).toBe(2);
      });
    });
  });

  describe('Given updateRef throws a non-TsgitError', () => {
    describe('When branch rename', () => {
      it('Then that exact error propagates unchanged', async () => {
        // Arrange — kills the `err instanceof TsgitError` operand on renameBranch.
        const { ctx } = await seedWithCommit();
        const boom = new Error('disk gone');
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        let caught: unknown;
        try {
          await branchRename(failingCtx, { from: 'main', to: 'trunk' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(boom);
        expect(caught).not.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given updateRef throws a non-conflict TsgitError', () => {
    describe('When branch rename', () => {
      it('Then it propagates as-is (not BRANCH_EXISTS)', async () => {
        // Arrange — kills the `code === REF_UPDATE_CONFLICT` operand on renameBranch.
        const { ctx } = await seedWithCommit();
        const boom = new TsgitError({ code: 'NETWORK_ERROR', reason: 'transient' });
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        const err = await expectError(
          () => branchRename(failingCtx, { from: 'main', to: 'trunk' }),
          'NETWORK_ERROR',
        );

        // Assert
        expect(err).toBe(boom);
      });
    });
  });

  describe('Given a startPoint that does not resolve to a commit', () => {
    describe('When branch create runs', () => {
      it.each([
        {
          label: 'an unresolvable ref name',
          buildStartPoint: (): string => 'no-such',
        },
        {
          label: '40 hex chars with a trailing extra char',
          buildStartPoint: (commitId: string): string => `${commitId}f`,
        },
        {
          label: '40 hex chars with a leading extra char',
          buildStartPoint: (commitId: string): string => `f${commitId}`,
        },
      ])('Then $label throws BRANCH_NOT_FOUND', async ({ buildStartPoint }) => {
        // Arrange — the trailing/leading extra char breaks the oid regex's `$`/`^`
        // anchor, so the value resolves as a ref name instead of an oid.
        const { ctx, commitId } = await seedWithCommit();
        const startPoint = buildStartPoint(commitId);
        let caught: unknown;

        // Act
        try {
          await branchCreate(ctx, { name: 'pin', startPoint });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given two ref names to compare', () => {
    describe('When compareRefName runs', () => {
      it.each([
        {
          label: 'left lexically before right',
          left: 'refs/heads/alpha',
          right: 'refs/heads/beta',
          expected: -1,
        },
        {
          label: 'left lexically after right',
          left: 'refs/heads/zeta',
          right: 'refs/heads/main',
          expected: 1,
        },
        {
          label: 'equal ref names (unreachable via listBranches, whose dir entries are unique)',
          left: 'refs/heads/main',
          right: 'refs/heads/main',
          expected: 0,
        },
      ])('Then $label returns exactly $expected', ({ left, right, expected }) => {
        // Arrange — kills the `<`/`>` relational-operator mutants (`< -> >=`,
        // `> -> <=`, `<-><=`, `>->>=`) and the `if (lower)`/`if (higher)`
        // ConditionalExpression boolean-literal mutants on each branch.
        const l = left as RefName;
        const r = right as RefName;

        // Act
        const result = compareRefName(l, r);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a branch literally named HEAD pointing elsewhere', () => {
    describe('When branch create with default startPoint', () => {
      it('Then it resolves the HEAD symref not refs/heads/HEAD', async () => {
        // Arrange — kills `startPoint === 'HEAD'` and its 'HEAD' string literal:
        // if candidates became [refs/heads/HEAD, HEAD], the wrong (older) commit would win.
        const { ctx, commitId: first } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'updated');
        await add(ctx, ['a.txt']);
        const second = await commit(ctx, { message: 'second', author });
        expect(second.id).not.toBe(first);
        await branchCreate(ctx, { name: 'HEAD', startPoint: first });

        // Act — default startPoint ('HEAD') must resolve the symbolic HEAD -> second.
        const result = await branchCreate(ctx, { name: 'probe' });

        // Assert
        expect(result.id).toBe(second.id);
      });
    });
  });
});

describe('branch create — an unborn HEAD', () => {
  describe('Given a fresh repository whose HEAD names a branch no commit backs', () => {
    describe('When branch create runs with no start point', () => {
      it('Then the refusal names the branch HEAD points at, not HEAD itself', async () => {
        // Arrange — git substitutes the resolved current branch for the
        // omitted start point before it reports what it could not resolve.
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        let caught: unknown;
        try {
          await branchCreate(ctx, { name: 'sprout' });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({ code: 'BRANCH_NOT_FOUND', name: 'main' });
      });
    });

    describe('When branch create runs with force and no start point', () => {
      it('Then it refuses the same way, force reaching no further', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        let caught: unknown;
        try {
          await branchCreate(ctx, { name: 'sprout', force: true });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'BRANCH_NOT_FOUND', name: 'main' });
      });
    });

    describe('When branch create runs with a start point nothing resolves', () => {
      it('Then the refusal names that start point verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        let caught: unknown;
        try {
          await branchCreate(ctx, { name: 'sprout', startPoint: 'nope-xyz' });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'BRANCH_NOT_FOUND', name: 'nope-xyz' });
      });
    });
  });
});

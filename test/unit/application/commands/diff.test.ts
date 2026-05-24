import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { diff } from '../../../../src/application/commands/diff.js';
import { init } from '../../../../src/application/commands/init.js';
import { rm } from '../../../../src/application/commands/rm.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('diff', () => {
  describe('Given two commits with one file change', () => {
    describe('When diff(from=c1, to=c2)', () => {
      it('Then returns a TreeDiff with the change', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a2');
        await add(ctx, ['a.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await diff(ctx, { from: c1.id, to: c2.id });

        // Assert — TreeDiff carries `changes`; modifying `a.txt` must produce ≥1 change.
        expect(sut.changes.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Given a non-repo ctx', () => {
    describe('When diff', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await diff(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given `from` omitted', () => {
    describe('When diff with only `to`', () => {
      it('Then resolves the missing side as HEAD (not the empty string)', async () => {
        // Arrange — a single committed file; HEAD points at that commit.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'first', author });

        // Act — `from` defaults to 'HEAD'. With `from`=='' it would fail ref
        // resolution; with HEAD it resolves to c1, so HEAD-vs-c1 is the empty diff.
        const sut = await diff(ctx, { to: c1.id });

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given `to` omitted', () => {
    describe('When diff(from=HEAD)', () => {
      it('Then diffs HEAD tree against the empty tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });

        // Act — `to` undefined → empty tree; every committed file shows as a delete.
        const sut = await diff(ctx);

        // Assert
        expect(sut.changes).toHaveLength(1);
        expect(sut.changes[0]?.type).toBe('delete');
      });
    });
  });

  describe('Given a rename and detectRenames=true', () => {
    describe('When diff', () => {
      it('Then collapses delete+add into a single rename change', async () => {
        // Arrange — commit a file, then move it to a new path verbatim.
        const ctx = createMemoryContext();
        await init(ctx);
        const content = 'unique content used to anchor rename detection';
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src.txt`, content);
        await add(ctx, ['src.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dst.txt`, content);
        await rm(ctx, ['src.txt']);
        await add(ctx, ['dst.txt']);
        const c2 = await commit(ctx, { message: 'rename', author });

        // Act
        const sut = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: true });

        // Assert — rename detection emits exactly one 'rename' change.
        expect(sut.changes.some((c) => c.type === 'rename')).toBe(true);
      });
    });
  });

  describe('Given a rename and detectRenames omitted', () => {
    describe('When diff', () => {
      it('Then yields separate add and delete (no rename)', async () => {
        // Arrange — same rename scenario as above.
        const ctx = createMemoryContext();
        await init(ctx);
        const content = 'unique content used to anchor rename detection';
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src.txt`, content);
        await add(ctx, ['src.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dst.txt`, content);
        await rm(ctx, ['src.txt']);
        await add(ctx, ['dst.txt']);
        const c2 = await commit(ctx, { message: 'rename', author });

        // Act — detectRenames defaults to off; passing `{}` (not `{detectRenames:true}`).
        const sut = await diff(ctx, { from: c1.id, to: c2.id });

        // Assert — no rename; the two paths show as independent add + delete.
        expect(sut.changes.some((c) => c.type === 'rename')).toBe(false);
        expect(sut.changes.some((c) => c.type === 'add')).toBe(true);
        expect(sut.changes.some((c) => c.type === 'delete')).toBe(true);
      });
    });
  });

  describe('Given detectRenames=false explicitly', () => {
    describe('When diff on a rename', () => {
      it('Then no rename change is produced', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const content = 'unique content used to anchor rename detection';
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src.txt`, content);
        await add(ctx, ['src.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dst.txt`, content);
        await rm(ctx, ['src.txt']);
        await add(ctx, ['dst.txt']);
        const c2 = await commit(ctx, { message: 'rename', author });

        // Act — `detectRenames: false` must take the `{}` branch, not `{detectRenames:true}`.
        const sut = await diff(ctx, { from: c1.id, to: c2.id, detectRenames: false });

        // Assert
        expect(sut.changes.some((c) => c.type === 'rename')).toBe(false);
      });
    });
  });

  describe('Given a tree oid (not a commit) as `from`', () => {
    describe('When diff', () => {
      it('Then resolves the tree id verbatim', async () => {
        // Arrange — commit a file; the commit's `tree` field is a real tree oid.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'first', author });

        // Act — passing the TREE oid (40-hex) directly: regex matches → used verbatim,
        // readObject yields a tree → returned as-is. Diffing it against itself is empty.
        const sut = await diff(ctx, { from: c1.tree, to: c1.tree });

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given a tree oid vs the empty tree', () => {
    describe('When diff', () => {
      it('Then a non-commit target still produces real changes', async () => {
        // Arrange — guarantees the tree-oid branch returns the tree itself, not an
        // empty/wrong id: diffing the tree against the empty tree must list files.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'first', author });

        // Act — `from` is the tree oid; `to` omitted → empty tree.
        const sut = await diff(ctx, { from: c1.tree });

        // Assert
        expect(sut.changes).toHaveLength(1);
        expect(sut.changes[0]?.type).toBe('delete');
      });
    });
  });

  describe('Given a 41-hex-character `from`', () => {
    describe('When diff', () => {
      it('Then it is treated as a ref name — proving both regex anchors', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        const tooLong = 'a'.repeat(41);

        // Act — 41 hex chars: `/^[0-9a-f]{40}$/` rejects (length mismatch), so it is
        // routed through validateRefName → resolveRef → REF_NOT_FOUND.
        let caught: unknown;
        try {
          await diff(ctx, { from: tooLong });
        } catch (err) {
          caught = err;
        }

        // Assert — must be a REF lookup failure, NOT an object lookup. Dropping the
        // `^` anchor (`/[0-9a-f]{40}$/`) would match the last 40 chars; dropping the
        // `$` anchor (`/^[0-9a-f]{40}/`) would match the first 40 — either mutation
        // mis-treats the string as an oid → OBJECT_NOT_FOUND, failing this assert.
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a `from` with a 39-hex prefix and a non-hex suffix', () => {
    describe('When diff', () => {
      it('Then it is treated as a ref name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        // 40 chars total: 39 hex + a trailing non-hex char → not an oid.
        const notAnOid = `${'a'.repeat(39)}z`;

        // Act — `[0-9a-f]{40}` cannot match 40 chars containing a non-hex `z`, so
        // the value is a ref name and resolution fails.
        let caught: unknown;
        try {
          await diff(ctx, { from: notAnOid, to: c1.id });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given an explicit HEAD target', () => {
    describe('When diff(from=HEAD)', () => {
      it('Then resolves the HEAD ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });

        // Act — 'HEAD' is validated then resolved via resolveRef; HEAD vs HEAD is
        // the empty diff.
        const sut = await diff(ctx, { from: 'HEAD', to: 'HEAD' });

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given a branch ref name as target', () => {
    describe('When diff', () => {
      it('Then resolves it via validateRefName', async () => {
        // Arrange — HEAD is on `refs/heads/main`; diff using the branch name.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });

        // Act — a branch name is validated then resolved; the missing-ref test
        // below pins the failure path for an unresolvable ref.
        const sut = await diff(ctx, { from: 'refs/heads/main', to: 'refs/heads/main' });

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given a non-existent ref name as target', () => {
    describe('When diff', () => {
      it('Then fails ref resolution (proving the non-HEAD branch is taken)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a1');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });

        // Act — 'refs/heads/missing' !== 'HEAD'. The non-HEAD branch validates and
        // resolves it; resolution fails. If `target==='HEAD'` were forced true (or
        // the conditional replaced with `true`), it would resolve HEAD and the diff
        // would succeed with an empty result — so this pins the equality operator.
        let caught: unknown;
        try {
          await diff(ctx, { from: 'refs/heads/missing' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_NOT_FOUND');
      });
    });
  });
});

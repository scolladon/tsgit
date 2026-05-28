/**
 * Integration test — `diff({ format: 'patch' })`.
 *
 * Drives the end-to-end pipeline: memory adapter → commit history →
 * `repo.diff` with the new patch-text envelope → canonical golden text.
 *
 * @proves
 *   surface: diff.patch
 *   bucket:  coverage-gap
 *   unique:  diff command threads TreeDiff through readBlob into the patch serializer end-to-end
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import { rm } from '../../src/application/commands/rm.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('integration — diff patch-text output', () => {
  it('Given two commits modifying a file, When diff({ format: patch }), Then text matches the canonical unified-diff grammar', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/lines.txt`, '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
    await add(ctx, ['lines.txt']);
    const c1 = await commit(ctx, { message: 'first', author });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/lines.txt`, '1\n2\n3\n4\nFOUR\n6\n7\n8\n9\n10\n');
    await add(ctx, ['lines.txt']);
    const c2 = await commit(ctx, { message: 'second', author });

    // Act
    const sut = await diff(ctx, { from: c1.id, to: c2.id, format: 'patch' });

    // Assert — golden text frozen against the canonical grammar.
    expect(sut.format).toBe('patch');
    expect(sut.text).toMatch(/^diff --git a\/lines\.txt b\/lines\.txt\n/);
    expect(sut.text).toContain('@@ -2,7 +2,7 @@');
    expect(sut.text).toContain('-5\n');
    expect(sut.text).toContain('+FOUR\n');
    // Three context lines on each side of the change.
    expect(sut.text).toContain(' 2\n');
    expect(sut.text).toContain(' 3\n');
    expect(sut.text).toContain(' 4\n');
    expect(sut.text).toContain(' 6\n');
    expect(sut.text).toContain(' 7\n');
    expect(sut.text).toContain(' 8\n');
    expect(sut.text.endsWith('\n')).toBe(true);
  });

  it('Given an add then a rename across two commits with detectRenames, When diff({ format: patch }), Then the rename block + a normal add block both appear', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    const content = 'unique content to anchor rename detection\nline two\n';
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src.txt`, content);
    await add(ctx, ['src.txt']);
    const c1 = await commit(ctx, { message: 'first', author });
    await rm(ctx, ['src.txt']);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dst.txt`, content);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/new.txt`, 'fresh\n');
    await add(ctx, ['dst.txt', 'new.txt']);
    const c2 = await commit(ctx, { message: 'rename and add', author });

    // Act
    const sut = await diff(ctx, {
      from: c1.id,
      to: c2.id,
      format: 'patch',
      detectRenames: true,
    });

    // Assert — rename block (no hunks) + the brand-new file's add block both
    // appear in the canonical text.
    expect(sut.text).toContain('diff --git a/src.txt b/dst.txt');
    expect(sut.text).toContain('similarity index 100%');
    expect(sut.text).toContain('rename from src.txt');
    expect(sut.text).toContain('rename to dst.txt');
    expect(sut.text).toContain('diff --git a/new.txt b/new.txt');
    expect(sut.text).toContain('new file mode 100644');
    expect(sut.text).toContain('+fresh');
  });
});

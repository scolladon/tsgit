import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { writeSparsePatternText } from '../../../../src/application/primitives/write-sparse-checkout.js';
import type { Context } from '../../../../src/ports/context.js';
import { instrumentedContext } from './fixtures.js';

const sparsePath = (ctx: Context): string => `${ctx.layout.gitDir}/info/sparse-checkout`;

describe('primitives/write-sparse-checkout', () => {
  it('Given pattern text, When writeSparsePatternText, Then the file is written at .git/info/sparse-checkout', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const text = '/*\n!/*/\n/src/\n';

    // Act
    await writeSparsePatternText(ctx, text);

    // Assert
    const written = await ctx.fs.readUtf8(sparsePath(ctx));
    expect(written).toBe(text);
  });

  it('Given an existing pattern file, When writeSparsePatternText, Then the file is overwritten', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await writeSparsePatternText(ctx, '/old/\n');

    // Act
    await writeSparsePatternText(ctx, '/new/\n');

    // Assert
    const written = await ctx.fs.readUtf8(sparsePath(ctx));
    expect(written).toBe('/new/\n');
  });

  it('Given a fresh repository, When writeSparsePatternText, Then .git/info is mkdir-ed before the write', async () => {
    // Arrange — the defensive mkdir must run before the writeUtf8.
    const { ctx, calls } = instrumentedContext(createMemoryContext());

    // Act
    await writeSparsePatternText(ctx, '/src/\n');

    // Assert — mkdir of info/ precedes the writeUtf8 of the pattern file.
    const ops = calls();
    const mkdirIndex = ops.findIndex(
      (c) => c.method === 'mkdir' && c.path === `${ctx.layout.gitDir}/info`,
    );
    const writeIndex = ops.findIndex((c) => c.method === 'writeUtf8' && c.path === sparsePath(ctx));
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(mkdirIndex);
  });
});

/**
 * Integration test — `add({ all: true })`.
 *
 * Walks the working tree end-to-end through the memory adapter, validating
 * that the entries surfaced by the bulk-mode dispatcher match the on-disk
 * index produced by `readIndex`.
 *
 * @proves
 *   surface: addAll
 *   bucket:  multi-adapter-parity
 *   unique:  bulk-mode dispatcher entries match the index produced by readIndex
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { readIndex } from '../../src/application/primitives/read-index.js';

describe('integration — add --all', () => {
  it('Given a populated working tree with an embedded repo, When add --all, Then every non-embedded path is staged in sorted order', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const tree: Readonly<Record<string, string>> = {
      'README.md': '# repo\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'dist/main.js': 'console.log(1)',
      'node_modules/foo/index.js': 'module.exports = {}',
      'vendor/lib/.git/HEAD': 'ref: refs/heads/main',
      'vendor/lib/src/x.ts': 'export {};',
    };
    for (const [path, content] of Object.entries(tree)) {
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
    }
    await ctx.fs.symlink('src/a.ts', `${ctx.layout.workDir}/link`);

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert — bulk-mode added paths are sorted and exclude the embedded repo.
    expect(sut.added).toEqual([
      'README.md',
      'dist/main.js',
      'link',
      'node_modules/foo/index.js',
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(sut.modified).toEqual([]);
    expect(sut.removed).toEqual([]);

    // On-disk index reflects exactly the same set.
    const idx = await readIndex(ctx);
    const paths = idx.entries.map((e) => e.path).sort();
    expect(paths).toEqual([
      'README.md',
      'dist/main.js',
      'link',
      'node_modules/foo/index.js',
      'src/a.ts',
      'src/b.ts',
    ]);
    // The symlink entry uses git's symlink mode.
    expect(idx.entries.find((e) => e.path === 'link')?.mode).toBe('120000');
    // No gitlink (160000) for the embedded repo.
    expect(idx.entries.filter((e) => e.mode === '160000')).toEqual([]);
  });
});

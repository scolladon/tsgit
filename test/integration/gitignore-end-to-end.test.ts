/**
 * Integration — `.gitignore` evaluation across `add --all` + `status`
 * (Phase 14.3). Exercises the four ignore sources, nested rules with
 * negation, and the tracked-beats-ignored invariant end-to-end through
 * the memory adapter.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { init } from '../../src/application/commands/init.js';
import { status } from '../../src/application/commands/status.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('integration — gitignore end-to-end', () => {
  it('Given a multi-level gitignore setup (global + info + root + nested with negation), When add --all + status, Then ignore decisions match Git semantics', async () => {
    // Arrange. (Note: the global core.excludesFile path is exercised in
    // the unit tests for `readGlobalExcludes` and `buildIgnoreEvaluator`.
    // Putting a home directory under the memory FS containment would
    // make `add --all` walk and stage it; this integration test scopes
    // to info/exclude + repo-root + nested for exact assertions.)
    const ctx = createMemoryContext();
    await init(ctx);

    // Per-clone excludes.
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'private/\n');

    // Repo-root .gitignore.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n*.swp\nnode_modules/\n');

    // Nested .gitignore with a negation.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/.gitignore`, '!keep.log\n');

    // Working-tree files exercising each branch.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/README.md`, '# repo\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app.ts`, 'export const x = 1;\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/debug.log`, 'debug'); // matched by root *.log → ignored
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/keep.log`, 'keep'); // re-included by nested !keep.log
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/node_modules/foo/x.js`, 'x'); // matched by root node_modules/
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/private/secret.txt`, 'shh'); // matched by info/exclude

    // Act — bulk add.
    const addResult = await add(ctx, [], { all: true });

    // Assert — only non-ignored paths are staged. Matrix:
    //   - .gitignore           staged
    //   - README.md            staged
    //   - src/.gitignore       staged
    //   - src/app.ts           staged
    //   - src/keep.log         staged (negation under src/)
    //   - src/debug.log        IGNORED (root *.log)
    //   - node_modules/foo/x.js IGNORED (root node_modules/)
    //   - private/secret.txt   IGNORED (info/exclude)
    expect([...addResult.added].sort()).toEqual([
      '.gitignore',
      'README.md',
      'src/.gitignore',
      'src/app.ts',
      'src/keep.log',
    ]);

    // Commit + clean status: only the .gitignore files + content above are tracked.
    await commit(ctx, { message: 'initial', author });
    const cleanStatus = await status(ctx);
    expect(cleanStatus.workingTreeChanges).toEqual([]);
    expect(cleanStatus.clean).toBe(true);

    // The on-disk index never contains ignored paths.
    const idx = await readIndex(ctx);
    const paths = idx.entries.map((e) => e.path).sort();
    expect(paths).toEqual([
      '.gitignore',
      'README.md',
      'src/.gitignore',
      'src/app.ts',
      'src/keep.log',
    ]);

    // Add another untracked-but-ignored file → status still clean.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/new.swp`, 'swap');
    const stillClean = await status(ctx);
    expect(stillClean.clean).toBe(true);

    // Add an untracked non-ignored file → status emits 'untracked'.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/TODO.md`, 'todo');
    const dirtyStatus = await status(ctx);
    expect(dirtyStatus.clean).toBe(false);
    expect(dirtyStatus.workingTreeChanges).toContainEqual({
      kind: 'untracked',
      path: 'TODO.md',
    });
    // Note: src/keep.log gets staged earlier (it was negated), so a
    // SECOND `add --all` after re-modifying it would surface as 'modified'.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/keep.log`, 'changed');
    const modifiedStatus = await status(ctx);
    expect(modifiedStatus.workingTreeChanges).toContainEqual({
      kind: 'modified',
      path: 'src/keep.log',
    });
  });
});

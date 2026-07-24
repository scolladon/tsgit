import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  compareWorkingTreeDelta,
  compareWorkingTreeEntry,
  isWorkingTreeModified,
  type WorkingTreeComparison,
} from '../../../../src/application/primitives/compare-working-tree-entry.js';
import { buildAttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const uppercase = (b: Uint8Array): Uint8Array => enc(dec(b).toUpperCase());

/** Fake runner: applies a transform to stdin bytes and returns them as stdout. */
class FakeRunner implements CommandRunner {
  constructor(private readonly transform: (input: Uint8Array) => Uint8Array = uppercase) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    return { exitCode: 0, stdout: this.transform(request.stdin ?? new Uint8Array(0)) };
  }
}

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

const seedFile = async (
  name: string,
  content: string,
): Promise<{ ctx: Context; entry: IndexEntry }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(work(ctx, name), content);
  await add(ctx, [name]);
  const index = await readIndex(ctx);
  const entry = index.entries.find((e) => e.path === name);
  if (entry === undefined) throw new Error(`seed failed: ${name} not staged`);
  return { ctx, entry };
};

const seedSymlink = async (
  name: string,
  target: string,
): Promise<{ ctx: Context; entry: IndexEntry }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.symlink(target, work(ctx, name));
  await add(ctx, [name]);
  const index = await readIndex(ctx);
  const entry = index.entries.find((e) => e.path === name);
  if (entry === undefined) throw new Error(`seed failed: ${name} not staged`);
  return { ctx, entry };
};

describe('compareWorkingTreeEntry', () => {
  describe('Given a staged file whose working copy was deleted', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('absent');
      });
    });
  });

  describe('Given a staged file whose working copy is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('unchanged');
      });
    });
  });

  describe('Given a staged file whose working content changed', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'changed\n');

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given an executable-mode entry whose working file is a same-content regular file', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'mode-changed' (same blob, exec bit differs)", async () => {
        // Arrange — index says 100755, working file is the seeded regular file
        // with identical content.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(sut).toBe('mode-changed');
      });
    });
  });

  describe('Given an executable-mode entry whose working file changed content too', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified' (content change dominates the mode change)", async () => {
        // Arrange — both the blob and the mode differ; git renders M (content),
        // not a mode-only change.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'changed\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given an entry whose working file is a different kind (regular vs symlink)', () => {
    describe('When the index says symlink but the working file is a regular file', () => {
      it("Then returns 'type-changed'", async () => {
        // Arrange — regular working file, entry mode forced to symlink kind.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const symlinkEntry: IndexEntry = { ...entry, mode: '120000' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, symlinkEntry);

        // Assert
        expect(sut).toBe('type-changed');
      });
    });

    describe('When the index says regular file but the working file is a symlink', () => {
      it("Then returns 'type-changed'", async () => {
        // Arrange — symlink working file, entry mode forced to regular-file kind.
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        const regularEntry: IndexEntry = { ...entry, mode: '100644' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, regularEntry);

        // Assert
        expect(sut).toBe('type-changed');
      });
    });
  });

  describe('isWorkingTreeModified', () => {
    describe('Given each working-tree comparison value', () => {
      describe('When asking whether it is a modified variant', () => {
        it("Then 'modified', 'type-changed', and 'mode-changed' are modified; 'unchanged' and 'absent' are not", () => {
          // Arrange
          const modifiedVariants: ReadonlyArray<WorkingTreeComparison> = [
            'modified',
            'type-changed',
            'mode-changed',
          ];
          const cleanVariants: ReadonlyArray<WorkingTreeComparison> = ['unchanged', 'absent'];

          // Act / Assert
          for (const variant of modifiedVariants) {
            expect(isWorkingTreeModified(variant)).toBe(true);
          }
          for (const variant of cleanVariants) {
            expect(isWorkingTreeModified(variant)).toBe(false);
          }
        });
      });
    });
  });

  describe('Given a staged file that exists but cannot be read', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified' (an unverifiable file is never reported unchanged)", async () => {
        // Arrange — lstat succeeds (mode matches) but read throws, so the content
        // hash cannot be computed.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const failingReadCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path === work(ctx, 'a.txt')) throw new Error('simulated read failure');
              return ctx.fs.read(path);
            },
          },
        };

        // Act
        const sut = await compareWorkingTreeEntry(failingReadCtx, entry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given a staged symlink whose target is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('unchanged');
      });
    });
  });

  describe('Given a staged symlink whose target changed', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified' (link content read via readlink, not followed)", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        await ctx.fs.rm(work(ctx, 'link'));
        await ctx.fs.symlink('target-b', work(ctx, 'link'));

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given a gitlink (submodule) entry over a working directory', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified', not 'type-changed' (git reports a submodule as M)", async () => {
        // Arrange — a 160000 entry whose working path is a directory. The kind
        // derived from the directory is a file kind, but a gitlink must NOT read
        // as a type change; the unreadable directory degrades to `modified`.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.mkdir(work(ctx, 'sub'));
        const gitlinkEntry: IndexEntry = {
          ...entry,
          path: 'sub' as typeof entry.path,
          mode: '160000',
        };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, gitlinkEntry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });
});

describe('compareWorkingTreeDelta', () => {
  describe('Given a staged file whose working copy was deleted', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'absent' and the worktree mode is omitted", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry);

        // Assert — no working file exists, so there is no mode to report.
        expect(sut).toEqual({ status: 'absent' });
        expect(sut.worktreeMode).toBeUndefined();
      });
    });
  });

  describe('Given a staged file whose working copy is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'unchanged' and the worktree mode is the regular blob mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(sut).toEqual({ status: 'unchanged', worktreeMode: '100644' });
      });
    });
  });

  describe('Given a staged file whose working content changed', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'modified' and the worktree mode is the regular blob mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'changed\n');

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(sut).toEqual({ status: 'modified', worktreeMode: '100644' });
      });
    });
  });

  describe('Given an executable-mode entry whose working file is a same-content regular file', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'mode-changed' and the worktree mode is the regular blob mode", async () => {
        // Arrange — index says 100755, working file is the seeded regular file.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = await compareWorkingTreeDelta(ctx, executableEntry);

        // Assert
        expect(sut).toEqual({ status: 'mode-changed', worktreeMode: '100644' });
      });
    });
  });

  describe('Given a symlink entry whose working file is a regular file', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'type-changed' and the worktree mode is the regular blob mode", async () => {
        // Arrange — regular working file, entry mode forced to symlink kind.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const symlinkEntry: IndexEntry = { ...entry, mode: '120000' };

        // Act
        const sut = await compareWorkingTreeDelta(ctx, symlinkEntry);

        // Assert
        expect(sut).toEqual({ status: 'type-changed', worktreeMode: '100644' });
      });
    });
  });

  describe('Given a staged symlink whose target is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'unchanged' and the worktree mode is the symlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(sut).toEqual({ status: 'unchanged', worktreeMode: '120000' });
      });
    });
  });

  describe('Given a staged symlink whose target changed', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'modified' and the worktree mode is the symlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        await ctx.fs.rm(work(ctx, 'link'));
        await ctx.fs.symlink('target-b', work(ctx, 'link'));

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(sut).toEqual({ status: 'modified', worktreeMode: '120000' });
      });
    });
  });

  // ── Filter-aware clean re-application ─────────────────────────────────────

  /**
   * Seeds a repo with a .gitattributes filter mapping and a [filter] config
   * section, stages the CLEANED (uppercased) bytes via add+runner, then
   * returns the ctx WITH a command runner, the index entry (cleaned OID),
   * and a provider.
   */
  const seedFilterRepo = async (
    name: string,
    smudgedContent: string,
  ): Promise<{ ctx: Context; entry: IndexEntry }> => {
    const runner = new FakeRunner(uppercase);
    const baseCtx = createMemoryContext();
    await init(baseCtx);

    // Write .gitattributes: *.y filter=myf
    const ext = name.split('.').pop() ?? 'y';
    await baseCtx.fs.writeUtf8(work(baseCtx, '.gitattributes'), `*.${ext} filter=myf\n`);

    // Write filter config in .git/config
    const configPath = `${baseCtx.layout.gitDir}/config`;
    const existingConfig = await baseCtx.fs.readUtf8(configPath).catch(() => '');
    await baseCtx.fs.writeUtf8(
      configPath,
      `${existingConfig}\n[filter "myf"]\n\tclean = uppercase-clean\n\tsmudge = lowercase-smudge\n`,
    );

    // Context WITH command runner so clean filter runs during add
    const ctxWithRunner: Context = { ...baseCtx, command: runner };

    // Stage the file — the clean filter (uppercase) runs and stores CLEANED bytes
    await ctxWithRunner.fs.writeUtf8(work(baseCtx, name), smudgedContent);
    await add(ctxWithRunner, [name]);
    const index = await readIndex(ctxWithRunner);
    const entry = index.entries.find((e) => e.path === name);
    if (entry === undefined) throw new Error(`seedFilterRepo: ${name} not staged`);

    return { ctx: ctxWithRunner, entry };
  };

  describe('Given a smudged worktree file under an active filter=myf', () => {
    describe('When the clean driver produces bytes whose hash equals the staged cleaned blob OID', () => {
      it("Then compareWorkingTreeDelta returns 'unchanged' (worktree-side clean re-application)", async () => {
        // Arrange
        const smudgedContent = 'hello world\n';
        const { ctx, entry } = await seedFilterRepo('f1.y', smudgedContent);

        // Worktree holds smudged (lowercase) bytes — simulating post-checkout state
        await ctx.fs.writeUtf8(work(ctx, 'f1.y'), smudgedContent);

        const provider = await buildAttributeProvider(ctx);

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry, provider);

        // Assert — clean(smudged) == staged OID => unchanged
        expect(sut.status).toBe('unchanged');
      });
    });
  });

  describe('Given a genuinely-modified file under an active filter=myf', () => {
    describe('When the cleaned worktree bytes differ from the staged blob OID', () => {
      it("Then compareWorkingTreeDelta returns 'modified'", async () => {
        // Arrange
        const { ctx, entry } = await seedFilterRepo('f1mod.y', 'hello world\n');

        // Worktree has genuinely different content (cleaned hash will also differ)
        await ctx.fs.writeUtf8(work(ctx, 'f1mod.y'), 'different content\n');

        const provider = await buildAttributeProvider(ctx);

        // Act
        const sut = await compareWorkingTreeDelta(ctx, entry, provider);

        // Assert
        expect(sut.status).toBe('modified');
      });
    });
  });

  describe('Given a smudged worktree file but ctx.command is absent', () => {
    describe('When compareWorkingTreeDelta is called without a runner', () => {
      it("Then it falls back to raw-bytes comparison and reports 'modified'", async () => {
        // Arrange — build a context without command (no runner wired)
        const smudgedContent = 'hello world\n';
        const { ctx, entry } = await seedFilterRepo('f1raw.y', smudgedContent);

        // Worktree holds smudged bytes; raw hash differs from cleaned OID -> modified
        await ctx.fs.writeUtf8(work(ctx, 'f1raw.y'), smudgedContent);

        const provider = await buildAttributeProvider(ctx);

        // Build a fresh context sharing the same fs/layout but without command
        const baseCtx = createMemoryContext();
        const noRunnerCtx: Context = {
          ...baseCtx,
          fs: ctx.fs,
          layout: ctx.layout,
        };

        // Act
        const sut = await compareWorkingTreeDelta(noRunnerCtx, entry, provider);

        // Assert — no runner -> raw path -> smudged bytes hash != cleaned OID -> modified
        expect(sut.status).toBe('modified');
      });
    });
  });

  describe('Given a symlink entry under an active filter=myf', () => {
    describe('When compareWorkingTreeDelta is called with a provider', () => {
      it('Then the symlink target is hashed raw, never passed through clean', async () => {
        // Arrange — seed with a regular file to get .gitattributes + config,
        // then create a symlink that is NOT filtered (symlinks are always raw).
        const { ctx } = await seedFilterRepo('sym.y', 'hello\n');
        // Stage a symlink (without runner so it is stored as raw link target)
        await ctx.fs.symlink('target-link', work(ctx, 'sym2.y'));
        // Use a context without command runner to stage the symlink without filtering
        const baseNoCmd = createMemoryContext();
        const noRunnerCtx: Context = { ...baseNoCmd, fs: ctx.fs, layout: ctx.layout };
        await add(noRunnerCtx, ['sym2.y']);
        const index = await readIndex(ctx);
        const symEntry = index.entries.find((e) => e.path === 'sym2.y');
        if (symEntry === undefined) throw new Error('symlink not staged');

        const provider = await buildAttributeProvider(ctx);

        // Act — worktree symlink target unchanged; should be unchanged (raw)
        const sut = await compareWorkingTreeDelta(ctx, symEntry, provider);

        // Assert — symlink target hashed raw (not cleaned) => unchanged
        expect(sut.status).toBe('unchanged');
      });
    });
  });
});

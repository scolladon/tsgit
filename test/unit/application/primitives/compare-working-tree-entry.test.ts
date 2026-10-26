import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  compareAndRefresh,
  compareWorkingTreeDelta,
  compareWorkingTreeEntry,
  isWorkingTreeModified,
  racyContentMatcher,
  type WorkingTreeComparison,
} from '../../../../src/application/primitives/compare-working-tree-entry.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import {
  type AttributeProvider,
  buildAttributeProvider,
} from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';
import { refuseReadOnSymlink } from './fixtures.js';

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

const MOVED_HEAD = 'b'.repeat(40);

const gitlinkOf = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  path: 'sub' as typeof entry.path,
  mode: '160000',
});

/** An absorbed submodule checkout at `sub`: a gitfile over a module dir holding HEAD and one branch. */
const layOutSubmodule = async (ctx: Context, branch: string, config?: string): Promise<void> => {
  const sub = work(ctx, 'sub');
  const moduleDir = `${ctx.layout.gitDir}/modules/sub`;
  await ctx.fs.mkdir(sub);
  await ctx.fs.writeUtf8(`${sub}/.git`, 'gitdir: ../.git/modules/sub\n');
  await ctx.fs.writeUtf8(`${moduleDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${moduleDir}/objects`);
  await ctx.fs.writeUtf8(`${moduleDir}/refs/heads/main`, `${branch}\n`);
  if (config !== undefined) await ctx.fs.writeUtf8(`${moduleDir}/config`, config);
};

describe('compareWorkingTreeEntry', () => {
  describe('Given a staged file whose working copy was deleted', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const result = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(result).toBe('absent');
      });
    });
  });

  describe('Given a staged file whose working copy is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');

        // Act
        const result = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(result).toBe('unchanged');
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
        const result = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(result).toBe('modified');
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
        const result = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(result).toBe('mode-changed');
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
        const result = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(result).toBe('modified');
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
        const result = await compareWorkingTreeEntry(ctx, symlinkEntry);

        // Assert
        expect(result).toBe('type-changed');
      });
    });

    describe('When the index says regular file but the working file is a symlink', () => {
      it("Then returns 'type-changed'", async () => {
        // Arrange — symlink working file, entry mode forced to regular-file kind.
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        const regularEntry: IndexEntry = { ...entry, mode: '100644' };

        // Act
        const result = await compareWorkingTreeEntry(ctx, regularEntry);

        // Assert
        expect(result).toBe('type-changed');
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

          // Act & Assert
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
        const result = await compareWorkingTreeEntry(failingReadCtx, entry);

        // Assert
        expect(result).toBe('modified');
      });
    });
  });

  describe('Given a staged symlink whose target is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');

        // Act
        const result = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(result).toBe('unchanged');
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
        const result = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(result).toBe('modified');
      });
    });
  });

  describe('Given a staged symlink (no-dereference audit)', () => {
    describe('When comparing the entry to the working tree, and ctx.fs.read is wired to fail on the symlink path', () => {
      it('Then it never dereferences the link', async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        const guarded = refuseReadOnSymlink(ctx, work(ctx, 'link'));

        // Act
        const result = await compareWorkingTreeEntry(guarded, entry);

        // Assert
        expect(result).toBe('unchanged');
      });
    });
  });

  describe('Given a gitlink whose checked-out HEAD moved', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'modified' with the gitlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await layOutSubmodule(ctx, MOVED_HEAD);
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'modified', worktreeMode: '160000' });
      });
    });
  });

  describe('Given a gitlink (submodule) entry over an empty working directory', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'unchanged' with the gitlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.mkdir(work(ctx, 'sub'));
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '160000' });
      });
    });
  });
});

describe('compareWorkingTreeDelta', () => {
  describe('Given a stat-clean untouched file and the index mtime supplied', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'unchanged' without reading or hashing the content", async () => {
        // Arrange — index mtime strictly after the entry's mtime ⇒ non-racy
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const reads: string[] = [];
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (readPath: string) => {
              reads.push(readPath);
              return ctx.fs.read(readPath);
            },
          },
        };
        const indexMtime = { seconds: entry.mtimeSeconds + 10, nanoseconds: 0 };

        // Act
        const result = await compareWorkingTreeDelta(spiedCtx, entry, undefined, indexMtime);

        // Assert
        expect(result.status).toBe('unchanged');
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given an armed entry whose recorded size differs from the working file', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'modified' without reading — size settles the verdict as git does", async () => {
        // Arrange — non-racy index mtime; only the recorded size disagrees,
        // so the stat-clean check fails and the size shortcut must answer
        // before any content read (git never runs the clean filter here).
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const sizeMismatched: IndexEntry = { ...entry, fileSize: entry.fileSize + 1 };
        const reads: string[] = [];
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (readPath: string) => {
              reads.push(readPath);
              return ctx.fs.read(readPath);
            },
          },
        };
        const indexMtime = { seconds: entry.mtimeSeconds + 10, nanoseconds: 0 };

        // Act
        const result = await compareWorkingTreeDelta(
          spiedCtx,
          sizeMismatched,
          undefined,
          indexMtime,
        );

        // Assert
        expect(result.status).toBe('modified');
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given a gitlink entry over a working directory with a size-mismatched entry, index mtime supplied', () => {
    describe('When comparing the delta', () => {
      it("Then no read happens and the verdict is 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.mkdir(work(ctx, 'sub'));
        const reads: string[] = [];
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (readPath: string) => {
              reads.push(readPath);
              return ctx.fs.read(readPath);
            },
          },
        };
        const indexMtime = { seconds: entry.mtimeSeconds + 10, nanoseconds: 0 };
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(spiedCtx, gitlinkOf(entry), undefined, indexMtime);

        // Assert
        expect(result.status).toBe('unchanged');
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given a converting caller (provider + command wired) and [filter "zed"].required = maybe with NO attributes, working file otherwise unchanged', () => {
    describe('When comparing the delta', () => {
      it('Then it refuses the malformed value as git does, even though no attribute selects "zed"', async () => {
        // Arrange — no .gitattributes at all; only the malformed [filter "zed"]
        // section, and the working file is byte-identical to the staged blob.
        // git's re-hash of a racy or stat-dirty file runs the convert
        // machinery and dies on the value; a dropped eagerSectionValidation
        // flag would compute the real (matching) hash and report 'unchanged'.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "zed"]\n\trequired = maybe\n',
        );
        // `seedFile`'s `add` call already opened this session's operational
        // gate epoch on the (empty) config that preceded this raw rewrite —
        // without this, the read below would still be served the pre-rewrite,
        // trusted entry until the next gate call.
        invalidateConfigCache(ctx);
        const runner = new FakeRunner();
        const enrichedCtx: Context = { ...ctx, command: runner };
        const provider = await buildAttributeProvider(enrichedCtx);

        // Act
        const result = await compareWorkingTreeDelta(enrichedCtx, entry, provider).catch(
          (err: unknown) => err,
        );

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'filter.zed.required',
          source: expect.any(String),
          value: 'maybe',
        });
      });
    });
  });

  describe.each([
    { label: 'configures no clean command', section: '\trequired = true\n', exitCode: undefined },
    {
      label: 'configures an empty clean command',
      section: '\tclean =\n\trequired = true\n',
      exitCode: undefined,
    },
    {
      label: 'runs a clean command that fails',
      section: '\tclean = c\n\trequired = true\n',
      exitCode: 3,
    },
  ])('Given a required driver that $label over an untouched file', ({ section, exitCode }) => {
    describe('When comparing the delta', () => {
      it("Then it refuses with CLEAN_FILTER_FAILED, as git's convert_to_git dies", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.txt filter=d\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `[filter "d"]\n${section}`);
        invalidateConfigCache(ctx);
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 3, stdout: new Uint8Array(0) }),
        };
        const enrichedCtx: Context = { ...ctx, command: runner };
        const provider = await buildAttributeProvider(enrichedCtx);

        // Act
        const result = await compareWorkingTreeDelta(enrichedCtx, entry, provider).catch(
          (err: unknown) => err,
        );

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CLEAN_FILTER_FAILED',
          path: 'a.txt',
          filter: 'd',
          ...(exitCode !== undefined && { exitCode }),
        });
      });
    });
  });

  describe('Given a context that cannot run commands and a required clean driver', () => {
    describe('When comparing the delta of an untouched file', () => {
      it('Then it refuses with CLEAN_FILTER_FAILED, as the driver cannot start', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.txt filter=d\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "d"]\n\tclean = c\n\trequired = true\n',
        );
        invalidateConfigCache(ctx);
        const provider = await buildAttributeProvider(ctx);
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, entry, provider).catch((err: unknown) => err);

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CLEAN_FILTER_FAILED',
          path: 'a.txt',
          filter: 'd',
        });
      });
    });
  });

  describe('Given an optional driver configuring no clean command over an untouched file', () => {
    describe('When comparing the delta', () => {
      it('Then it hashes the raw bytes and reports unchanged', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.txt filter=d\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "d"]\n\tsmudge = s\n');
        invalidateConfigCache(ctx);
        const enrichedCtx: Context = { ...ctx, command: new FakeRunner() };
        const provider = await buildAttributeProvider(enrichedCtx);

        // Act
        const result = await compareWorkingTreeDelta(enrichedCtx, entry, provider);

        // Assert
        expect(result.status).toBe('unchanged');
      });
    });
  });

  describe('Given a stat-clean file whose recorded mode differs from the working file, index mtime supplied', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'mode-changed' without reading or hashing the content (stat-cache ternary distinguishes the mode mismatch)", async () => {
        // Arrange — index mtime strictly after the entry's mtime ⇒ non-racy; matchesContentStat
        // deliberately excludes mode, so the stat cache reports clean even though this
        // entry's mode (100755) differs from the seeded working file's real mode (100644) —
        // only the caller's ternary is what must tell 'unchanged' from 'mode-changed' apart.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };
        const reads: string[] = [];
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (readPath: string) => {
              reads.push(readPath);
              return ctx.fs.read(readPath);
            },
          },
        };
        const indexMtime = { seconds: entry.mtimeSeconds + 10, nanoseconds: 0 };

        // Act
        const result = await compareWorkingTreeDelta(
          spiedCtx,
          executableEntry,
          undefined,
          indexMtime,
        );

        // Assert
        expect(result.status).toBe('mode-changed');
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given an assume-valid gitlink entry whose HEAD moved and the index mtime supplied', () => {
    describe('When comparing the delta', () => {
      it("Then the verdict is 'unchanged' and the submodule is never touched", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await layOutSubmodule(ctx, MOVED_HEAD);
        const touched: string[] = [];
        const spy =
          <A extends unknown[], R>(call: (...args: A) => R) =>
          (...args: A): R => {
            touched.push(String(args[0]));
            return call(...args);
          };
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: spy(ctx.fs.lstat.bind(ctx.fs)),
            readSlice: spy(ctx.fs.readSlice.bind(ctx.fs)),
          },
        };
        const gitlinkEntry: IndexEntry = {
          ...gitlinkOf(entry),
          flags: { ...entry.flags, assumeValid: true },
        };
        const indexMtime = { seconds: entry.mtimeSeconds + 10, nanoseconds: 0 };
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(spiedCtx, gitlinkEntry, undefined, indexMtime);

        // Assert
        expect(result.status).toBe('unchanged');
        expect(touched.filter((p) => p.includes('sub/.git'))).toEqual([]);
      });
    });
  });

  describe('Given a gitlink entry whose path holds a regular file', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'type-changed' with the file mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'sub'), 'f\n');
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'type-changed', worktreeMode: '100644' });
      });
    });
  });

  describe('Given a gitlink entry whose path holds an executable file', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'type-changed' with the executable mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'sub'), 'f\n');
        const executableCtx: Context = {
          ...ctx,
          fs: { ...ctx.fs, lstat: async (p) => ({ ...(await ctx.fs.lstat(p)), mode: 0o100755 }) },
        };
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(executableCtx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'type-changed', worktreeMode: '100755' });
      });
    });
  });

  describe('Given a gitlink entry whose path holds a symlink', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'type-changed' with the symlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.symlink('a.txt', work(ctx, 'sub'));
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'type-changed', worktreeMode: '120000' });
      });
    });
  });

  describe('Given a gitlink whose checked-out HEAD equals the entry', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'unchanged' with the gitlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await layOutSubmodule(ctx, entry.id);
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '160000' });
      });
    });
  });

  describe('Given a gitlink whose .git is an empty directory', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'unchanged' because git finds no commit there", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.mkdir(`${work(ctx, 'sub')}/.git`);
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '160000' });
      });
    });
  });

  describe('Given a gitlink whose .git is a gitfile past the size git reads', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'unchanged' without reading it", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.write(`${work(ctx, 'sub')}/.git`, new Uint8Array((1 << 20) + 1));
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '160000' });
      });
    });
  });

  describe('Given a gitlink whose repository declares a format version git refuses', () => {
    describe('When comparing the delta', () => {
      it("Then returns 'unchanged' instead of refusing", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await layOutSubmodule(ctx, MOVED_HEAD, '[core]\n\trepositoryformatversion = 2\n');
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkOf(entry));

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '160000' });
      });
    });
  });

  describe('Given a gitlink whose repository config cannot be read for a reason of its own', () => {
    describe('When comparing the delta', () => {
      it('Then the failure surfaces unchanged', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await layOutSubmodule(ctx, MOVED_HEAD);
        const failure = new Error('boom');
        const isConfig = (p: string): boolean => p.endsWith('/modules/sub/config');
        const failingCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            tryReadUtf8: async (p: string) => {
              if (isConfig(p)) throw failure;
              return ctx.fs.tryReadUtf8?.(p);
            },
            readUtf8: async (p: string) => {
              if (isConfig(p)) throw failure;
              return ctx.fs.readUtf8(p);
            },
          },
        };
        const sut = compareWorkingTreeDelta;

        // Act
        const outcome = await sut(failingCtx, gitlinkOf(entry)).catch((err: unknown) => err);

        // Assert
        expect(outcome).toBe(failure);
      });
    });
  });

  describe('Given an assume-valid gitlink entry whose HEAD moved and no index mtime', () => {
    describe('When comparing the delta', () => {
      it("Then the submodule is probed and the verdict is 'modified'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await layOutSubmodule(ctx, MOVED_HEAD);
        const gitlinkEntry: IndexEntry = {
          ...gitlinkOf(entry),
          flags: { ...entry.flags, assumeValid: true },
        };
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, gitlinkEntry);

        // Assert
        expect(result.status).toBe('modified');
      });
    });
  });

  describe('Given a staged file whose working copy was deleted', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'absent' and the worktree mode is omitted", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const result = await compareWorkingTreeDelta(ctx, entry);

        // Assert — no working file exists, so there is no mode to report.
        expect(result).toEqual({ status: 'absent' });
        expect(result.worktreeMode).toBeUndefined();
      });
    });
  });

  describe('Given a staged file whose working copy is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'unchanged' and the worktree mode is the regular blob mode", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');

        // Act
        const result = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '100644' });
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
        const result = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(result).toEqual({ status: 'modified', worktreeMode: '100644' });
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
        const result = await compareWorkingTreeDelta(ctx, executableEntry);

        // Assert
        expect(result).toEqual({ status: 'mode-changed', worktreeMode: '100644' });
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
        const result = await compareWorkingTreeDelta(ctx, symlinkEntry);

        // Assert
        expect(result).toEqual({ status: 'type-changed', worktreeMode: '100644' });
      });
    });
  });

  describe('Given a staged symlink whose target is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then the status is 'unchanged' and the worktree mode is the symlink mode", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');

        // Act
        const result = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(result).toEqual({ status: 'unchanged', worktreeMode: '120000' });
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
        const result = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(result).toEqual({ status: 'modified', worktreeMode: '120000' });
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
        const result = await compareWorkingTreeDelta(ctx, entry, provider);

        // Assert — clean(smudged) == staged OID => unchanged
        expect(result.status).toBe('unchanged');
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
        const result = await compareWorkingTreeDelta(ctx, entry, provider);

        // Assert
        expect(result.status).toBe('modified');
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
        const result = await compareWorkingTreeDelta(noRunnerCtx, entry, provider);

        // Assert — no runner -> raw path -> smudged bytes hash != cleaned OID -> modified
        expect(result.status).toBe('modified');
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
        const result = await compareWorkingTreeDelta(ctx, symEntry, provider);

        // Assert — symlink target hashed raw (not cleaned) => unchanged
        expect(result.status).toBe('unchanged');
      });
    });
  });
});

describe('compareWorkingTreeDelta — lstat cost', () => {
  const trackLstat = (ctx: Context): { readonly ctx: Context; readonly calls: () => number } => {
    const baseLstat = ctx.fs.lstat;
    let calls = 0;
    const trackingFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (p: string) => {
            calls += 1;
            return baseLstat(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { ctx: { ...ctx, fs: trackingFs }, calls: () => calls };
  };

  describe('Given an existing tracked file', () => {
    describe('When compareWorkingTreeDelta is called', () => {
      it('Then exactly one lstat is issued', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const { ctx: tracked, calls } = trackLstat(ctx);

        // Act
        const result = await compareWorkingTreeDelta(tracked, entry);

        // Assert
        expect(calls()).toBe(1);
        expect(result.status).toBe('unchanged');
      });
    });
  });

  describe('Given the working file is absent', () => {
    describe('When compareWorkingTreeDelta is called', () => {
      it("Then the status is 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const result = await compareWorkingTreeDelta(ctx, entry);

        // Assert
        expect(result.status).toBe('absent');
      });
    });
  });
});

describe('Given a malformed core.bigFileThreshold', () => {
  const withMalformedThreshold = async (ctx: Context): Promise<void> => {
    const configPath = `${ctx.layout.gitDir}/config`;
    const config = await ctx.fs.readUtf8(configPath);
    await ctx.fs.writeUtf8(configPath, `${config}[core]\n\tbigFileThreshold = x\n`);
    invalidateConfigCache(ctx);
  };
  const racyAgainst = (entry: IndexEntry) => ({ seconds: entry.mtimeSeconds, nanoseconds: 0 });
  const cleanAgainst = (entry: IndexEntry) => ({
    seconds: entry.mtimeSeconds + 10,
    nanoseconds: 0,
  });

  describe('When the stat cache sends a racy regular file to be hashed', () => {
    it('Then it refuses with the key, as git reads it before hashing', async () => {
      // Arrange
      const { ctx, entry } = await seedFile('a.txt', 'hello\n');
      await withMalformedThreshold(ctx);
      const sut = compareWorkingTreeDelta;

      // Act
      const result = await sut(ctx, entry, undefined, racyAgainst(entry)).catch(
        (err: { data: unknown }) => err.data,
      );

      // Assert
      expect(result).toMatchObject({
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'core.bigfilethreshold',
        value: 'x',
      });
    });
  });

  describe('When the stat cache settles a non-racy regular file', () => {
    it('Then it compares without reading the threshold', async () => {
      // Arrange
      const { ctx, entry } = await seedFile('a.txt', 'hello\n');
      await withMalformedThreshold(ctx);
      const sut = compareWorkingTreeDelta;

      // Act
      const result = await sut(ctx, entry, undefined, cleanAgainst(entry));

      // Assert
      expect(result.status).toBe('unchanged');
    });
  });

  describe('When the stat cache sends a racy symlink to be hashed', () => {
    it('Then it compares without reading the threshold', async () => {
      // Arrange
      const { ctx, entry } = await seedSymlink('link', 'target');
      await withMalformedThreshold(ctx);
      const sut = compareWorkingTreeDelta;

      // Act
      const result = await sut(ctx, entry, undefined, racyAgainst(entry));

      // Assert
      expect(result.status).toBe('unchanged');
    });
  });

  describe('When a regular file is hashed without the stat cache', () => {
    it('Then it compares without reading the threshold, as git would not hash it', async () => {
      // Arrange
      const { ctx, entry } = await seedFile('a.txt', 'hello\n');
      await withMalformedThreshold(ctx);
      const sut = compareWorkingTreeDelta;

      // Act
      const result = await sut(ctx, entry);

      // Assert
      expect(result.status).toBe('unchanged');
    });
  });
});

describe('Given a malformed core.bigFileThreshold and a filter driver engaged on the path', () => {
  /** `a.txt` staged under `filter=d`, the threshold malformed after the fact. */
  const seedUnderDriver = async (
    driver: string,
  ): Promise<{ ctx: Context; entry: IndexEntry; provider: AttributeProvider }> => {
    const { ctx: bare, entry } = await seedFile('a.txt', 'hello\n');
    const ctx: Context = { ...bare, command: new FakeRunner((bytes) => bytes) };
    await ctx.fs.writeUtf8(work(ctx, '.gitattributes'), 'a.txt filter=d\n');
    const configPath = `${ctx.layout.gitDir}/config`;
    const config = await ctx.fs.readUtf8(configPath);
    await ctx.fs.writeUtf8(
      configPath,
      `${config}[filter "d"]\n${driver}[core]\n\tbigFileThreshold = x\n`,
    );
    invalidateConfigCache(ctx);
    return { ctx, entry, provider: await buildAttributeProvider(ctx) };
  };
  const racyAgainst = (entry: IndexEntry) => ({ seconds: entry.mtimeSeconds, nanoseconds: 0 });

  describe('When the stat cache sends the racy file under a required driver to be hashed', () => {
    it('Then it compares without reading the threshold, as git streams it through the filter', async () => {
      // Arrange
      const { ctx, entry, provider } = await seedUnderDriver('\tclean = cat\n\trequired = true\n');
      const sut = compareWorkingTreeDelta;

      // Act
      const result = await sut(ctx, entry, provider, racyAgainst(entry));

      // Assert
      expect(result.status).toBe('unchanged');
    });
  });

  describe('When the stat cache sends the racy file under an optional driver to be hashed', () => {
    it('Then it refuses with the key', async () => {
      // Arrange
      const { ctx, entry, provider } = await seedUnderDriver('\tclean = cat\n');
      const sut = compareWorkingTreeDelta;

      // Act
      const result = await sut(ctx, entry, provider, racyAgainst(entry)).catch(
        (err: { data: unknown }) => err.data,
      );

      // Assert
      expect(result).toMatchObject({ code: 'CONFIG_BAD_NUMERIC_VALUE', value: 'x' });
    });
  });
});

describe('Given a caller that states whether a filter driver is configured', () => {
  describe('When the scope says none is, on a racy file under a required driver and a malformed core.bigFileThreshold', () => {
    it('Then it does not look the driver up and refuses on the threshold', async () => {
      // Arrange
      const { ctx, entry } = await seedFile('a.txt', 'hello\n');
      const runnerCtx: Context = { ...ctx, command: new FakeRunner((bytes) => bytes) };
      await runnerCtx.fs.writeUtf8(work(runnerCtx, '.gitattributes'), 'a.txt filter=d\n');
      await runnerCtx.fs.writeUtf8(
        `${runnerCtx.layout.gitDir}/config`,
        '[filter "d"]\n\tclean = cat\n\trequired = true\n[core]\n\tbigFileThreshold = x\n',
      );
      invalidateConfigCache(runnerCtx);
      const provider = await buildAttributeProvider(runnerCtx);
      const indexMtime = { seconds: entry.mtimeSeconds, nanoseconds: 0 };
      const sut = compareAndRefresh;

      // Act
      const result = await sut(runnerCtx, entry, {
        provider,
        indexMtime,
        filterDriversConfigured: false,
      }).catch((err: { data: unknown }) => err.data);

      // Assert
      expect(result).toMatchObject({ code: 'CONFIG_BAD_NUMERIC_VALUE', value: 'x' });
    });
  });

  describe('When the scope says none is, on a file with only a malformed unused [filter] section', () => {
    it('Then the section is not validated and the file compares unchanged', async () => {
      // Arrange
      const { ctx, entry } = await seedFile('a.txt', 'hello\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "zed"]\n\trequired = maybe\n');
      invalidateConfigCache(ctx);
      const runnerCtx: Context = { ...ctx, command: new FakeRunner() };
      const provider = await buildAttributeProvider(runnerCtx);
      const sut = compareAndRefresh;

      // Act
      const result = await sut(runnerCtx, entry, { provider, filterDriversConfigured: false });

      // Assert
      expect(result.delta.status).toBe('unchanged');
    });
  });

  describe('When the scope says one is, on the same malformed section', () => {
    it('Then it still refuses the value', async () => {
      // Arrange
      const { ctx, entry } = await seedFile('a.txt', 'hello\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "zed"]\n\trequired = maybe\n');
      invalidateConfigCache(ctx);
      const runnerCtx: Context = { ...ctx, command: new FakeRunner() };
      const provider = await buildAttributeProvider(runnerCtx);
      const sut = compareAndRefresh;

      // Act
      const result = await sut(runnerCtx, entry, { provider, filterDriversConfigured: true }).catch(
        (err: { data: unknown }) => err.data,
      );

      // Assert
      expect(result).toMatchObject({
        code: 'CONFIG_BAD_BOOLEAN_VALUE',
        key: 'filter.zed.required',
      });
    });
  });
});

describe('compareWorkingTreeDelta line-ending conversion', () => {
  const CRLF_WORKTREE = 'a\r\nb\r\n';
  const staged = async (
    stagedText: string,
    worktreeText: string,
    settings: { readonly config?: string; readonly attributes?: string },
  ) => {
    const { ctx, entry } = await seedFile('f', stagedText);
    await ctx.fs.writeUtf8(work(ctx, 'f'), worktreeText);
    if (settings.attributes !== undefined) {
      await ctx.fs.writeUtf8(work(ctx, '.gitattributes'), settings.attributes);
    }
    if (settings.config !== undefined) {
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, settings.config);
    }
    invalidateConfigCache(ctx);
    return { ctx, entry, provider: await buildAttributeProvider(ctx) };
  };

  describe('Given an LF blob, core.autocrlf true and a CRLF worktree file', () => {
    describe('When compared with the attribute provider', () => {
      it('Then the entry is unchanged', async () => {
        // Arrange
        const { ctx, entry, provider } = await staged('a\nb\n', CRLF_WORKTREE, {
          config: '[core]\n\tautocrlf = true\n',
        });
        const sut = compareWorkingTreeEntry;

        // Act
        const result = await sut(ctx, entry, provider);

        // Assert
        expect(result).toBe('unchanged');
      });
    });

    describe('When compared without a provider', () => {
      it('Then the entry is unchanged', async () => {
        // Arrange
        const { ctx, entry } = await staged('a\nb\n', CRLF_WORKTREE, {
          config: '[core]\n\tautocrlf = true\n',
        });
        const sut = compareWorkingTreeEntry;

        // Act
        const result = await sut(ctx, entry);

        // Assert
        expect(result).toBe('unchanged');
      });
    });
  });

  describe('Given an LF blob, no autocrlf and a CRLF worktree file', () => {
    describe('When compared', () => {
      it('Then the entry is modified', async () => {
        // Arrange
        const { ctx, entry, provider } = await staged('a\nb\n', CRLF_WORKTREE, {});
        const sut = compareWorkingTreeEntry;

        // Act
        const result = await sut(ctx, entry, provider);

        // Assert
        expect(result).toBe('modified');
      });
    });
  });

  describe("Given an index CRLF text blob, '* text=auto' and the same CRLF worktree file", () => {
    describe('When compared', () => {
      it('Then the entry is unchanged', async () => {
        // Arrange
        const { ctx, entry, provider } = await staged(CRLF_WORKTREE, CRLF_WORKTREE, {
          attributes: '* text=auto\n',
        });
        const sut = compareWorkingTreeEntry;

        // Act
        const result = await sut(ctx, entry, provider);

        // Assert
        expect(result).toBe('unchanged');
      });
    });
  });

  describe('Given core.safecrlf true and a lossy worktree file', () => {
    describe('When compared', () => {
      it('Then it reports modified without refusing', async () => {
        // Arrange
        const { ctx, entry, provider } = await staged('a\nb\n', 'a\r\nb\nc\n', {
          config: '[core]\n\tautocrlf = true\n\tsafecrlf = true\n',
        });
        const sut = compareWorkingTreeEntry;

        // Act
        const result = await sut(ctx, entry, provider);

        // Assert
        expect(result).toBe('modified');
      });
    });
  });

  describe('Given an armed entry recorded with size 0 and a converted worktree file', () => {
    describe('When comparing the delta', () => {
      it('Then the size 0 falls through to the content compare, as git does', async () => {
        // Arrange
        const { ctx, entry, provider } = await staged('a\nb\n', CRLF_WORKTREE, {
          config: '[core]\n\tautocrlf = true\n',
        });
        const unsized: IndexEntry = { ...entry, fileSize: 0 };
        const indexMtime = { seconds: entry.mtimeSeconds + 10, nanoseconds: 0 };
        const sut = compareWorkingTreeDelta;

        // Act
        const result = await sut(ctx, unsized, provider, indexMtime);

        // Assert
        expect(result.status).toBe('unchanged');
      });
    });
  });
});

describe('compareAndRefresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SEED_MS = 1_700_000_000_000;

  /** Staged at SEED_MS, then rewritten with the given bytes ten seconds later. */
  const stagedThenRewritten = async (
    rewrite: string,
  ): Promise<{
    ctx: Context;
    entry: IndexEntry;
    indexMtime: { seconds: number; nanoseconds: number };
  }> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SEED_MS);
    const { ctx, entry } = await seedFile('a.txt', 'hello\n');
    vi.setSystemTime(SEED_MS + 10_000);
    await ctx.fs.writeUtf8(work(ctx, 'a.txt'), rewrite);
    const indexMtime = { seconds: entry.mtimeSeconds + 5, nanoseconds: 0 };
    return { ctx, entry, indexMtime };
  };

  describe('Given a committed file rewritten with the same bytes after the clock moved', () => {
    describe('When comparing with the index mtime', () => {
      it('Then the delta is unchanged and refreshed carries the new mtime and the old id', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        const sut = compareAndRefresh;

        // Act
        const result = await sut(ctx, entry, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed?.mtimeSeconds).toBe(Math.floor((SEED_MS + 10_000) / 1000));
        expect(result.refreshed?.id).toBe(entry.id);
      });
    });
  });

  describe('Given nothing moved since staging', () => {
    describe('When comparing with the index mtime', () => {
      it('Then refreshed is undefined', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(SEED_MS);
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const indexMtime = { seconds: entry.mtimeSeconds + 5, nanoseconds: 0 };
        const sut = compareAndRefresh;

        // Act
        const result = await sut(ctx, entry, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed).toBeUndefined();
      });
    });
  });

  describe('Given an entry whose stat moved but which must not be refreshed', () => {
    describe('When comparing with the index mtime', () => {
      it('Then refreshed is undefined for changed content', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('HELLO\n');

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, entry, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('modified');
        expect(result.refreshed).toBeUndefined();
      });

      it('Then refreshed is undefined for a changed mode', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        const executable: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, executable, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('mode-changed');
        expect(result.refreshed).toBeUndefined();
      });

      it('Then refreshed is undefined for an assume-valid entry', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        const assumeValid: IndexEntry = { ...entry, flags: { ...entry.flags, assumeValid: true } };

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, assumeValid, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed).toBeUndefined();
      });

      it('Then refreshed is undefined for an intent-to-add entry', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        const placeholder: IndexEntry = { ...entry, flags: { ...entry.flags, intentToAdd: true } };

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, placeholder, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed).toBeUndefined();
      });

      it('Then refreshed is undefined for a skip-worktree entry', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        const skipped: IndexEntry = { ...entry, flags: { ...entry.flags, skipWorktree: true } };

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, skipped, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed).toBeUndefined();
      });

      it('Then a gitlink whose HEAD matches is unchanged and never refreshed', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        await layOutSubmodule(ctx, entry.id);
        const gitlink = gitlinkOf(entry);

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, gitlink, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed).toBeUndefined();
      });

      it('Then refreshed is undefined for a conflicted (stage 2) entry', async () => {
        // Arrange
        const { ctx, entry, indexMtime } = await stagedThenRewritten('hello\n');
        const conflicted: IndexEntry = { ...entry, flags: { ...entry.flags, stage: 2 } };

        // Act
        const sut = compareAndRefresh;
        const result = await sut(ctx, conflicted, { indexMtime });

        // Assert
        expect(result.delta.status).toBe('unchanged');
        expect(result.refreshed).toBeUndefined();
      });
    });
  });

  describe('Given a stat-clean, non-racy entry and an index mtime', () => {
    describe('When compareWorkingTreeEntry receives the index mtime', () => {
      it('Then it does not read the file', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(SEED_MS);
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const indexMtime = { seconds: entry.mtimeSeconds + 5, nanoseconds: 0 };
        const read = vi.fn(ctx.fs.read.bind(ctx.fs));
        const spiedCtx: Context = { ...ctx, fs: { ...ctx.fs, read } };
        const sut = compareWorkingTreeEntry;

        // Act
        const result = await sut(spiedCtx, entry, undefined, indexMtime);

        // Assert
        expect(result).toBe('unchanged');
        expect(read).not.toHaveBeenCalled();
      });
    });
  });
});

describe('compareAndRefresh on a lossy entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LOSSY_BYTES = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
  const OTHER_BLOB = 'a'.repeat(40) as ObjectId;

  describe('Given a lossy entry and a file at its decoded view on disk', () => {
    describe('When comparing', () => {
      it('Then the entry is absent and the file system is never asked about it', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('\uFFFD.txt', 'u\n');
        const sut = { ...entry, id: OTHER_BLOB, pathBytes: LOSSY_BYTES };
        const lstat = vi.spyOn(ctx.fs, 'lstat');

        // Act
        const result = await compareAndRefresh(ctx, sut);

        // Assert
        expect(result).toEqual({ delta: { status: 'absent' } });
        expect(lstat).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe('Given a lossy entry whose blob equals the decoded view file content', () => {
    describe('When comparing', () => {
      it('Then no refresh is offered', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('\uFFFD.txt', 'u\n');
        const sut = { ...entry, mtimeSeconds: 0, ctimeSeconds: 0, pathBytes: LOSSY_BYTES };

        // Act
        const result = await compareAndRefresh(ctx, sut);

        // Assert
        expect('refreshed' in result).toBe(false);
      });
    });
  });

  describe('Given a lossy entry', () => {
    describe('When projecting the comparison to a status', () => {
      it('Then it is absent', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('\uFFFD.txt', 'u\n');
        const sut = { ...entry, pathBytes: LOSSY_BYTES };

        // Act
        const result = await compareWorkingTreeEntry(ctx, sut);

        // Assert
        expect(result).toBe('absent');
      });
    });
  });

  describe('Given the UTF-8 twin of a lossy entry', () => {
    describe('When comparing', () => {
      it('Then it is unchanged with its own stat', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('\uFFFD.txt', 'u\n');

        // Act
        const result = await compareAndRefresh(ctx, entry);

        // Assert
        expect(result.delta.status).toBe('unchanged');
      });
    });
  });
});

const replaceDirWithLink = async (ctx: Context, dir: string, copy: string): Promise<void> => {
  await ctx.fs.writeUtf8(work(ctx, `${copy}/f`), 'x\n');
  await ctx.fs.rm(work(ctx, `${dir}/f`));
  await ctx.fs.rm(work(ctx, dir));
  await ctx.fs.symlink(copy, work(ctx, dir));
};

describe('compareAndRefresh below a leading directory', () => {
  describe('Given a leading directory that cannot be lstat-ed', () => {
    describe('When comparing a regular file below it', () => {
      it("Then it is 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('d/f', 'x\n');
        const realLstat = ctx.fs.lstat.bind(ctx.fs);
        const lstat = vi.spyOn(ctx.fs, 'lstat').mockImplementation(async (p) => {
          if (p === work(ctx, 'd')) throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
          return realLstat(p);
        });
        const sut = compareAndRefresh;

        // Act
        const result = await sut(ctx, entry);

        // Assert — the leading-directory verdict alone decides: the leaf is never probed.
        expect(result.delta.status).toBe('absent');
        expect(lstat.mock.calls.map(([p]) => p)).not.toContain(work(ctx, 'd/f'));
      });
    });
  });

  describe('Given a regular file whose leading directory became a symlink to an identical copy', () => {
    describe('When comparing the entry', () => {
      it("Then it is 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('d/f', 'x\n');
        await replaceDirWithLink(ctx, 'd', 'copy');
        const sut = compareAndRefresh;

        // Act
        const result = await sut(ctx, entry);

        // Assert
        expect(result.delta).toEqual({ status: 'absent' });
      });
    });
  });

  describe('Given a gitlink whose leading directory became a symlink', () => {
    describe('When comparing the entry', () => {
      it("Then it is 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('d/f', 'x\n');
        await replaceDirWithLink(ctx, 'd', 'copy');
        const gitlink = { ...entry, mode: FILE_MODE.GITLINK };
        const sut = compareAndRefresh;

        // Act
        const result = await sut(ctx, gitlink);

        // Assert
        expect(result.delta).toEqual({ status: 'absent' });
      });
    });
  });

  describe('Given a root-level file', () => {
    describe('When comparing the entry', () => {
      it('Then only the leaf is lstat-ed', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'x\n');
        const spy = vi.spyOn(ctx.fs, 'lstat');
        const sut = compareAndRefresh;

        // Act
        await sut(ctx, entry);

        // Assert
        expect(spy.mock.calls.map(([p]) => p)).toEqual([work(ctx, 'a.txt')]);
      });
    });
  });
});

describe('racyContentMatcher', () => {
  describe('Given a staged file whose content is unchanged', () => {
    describe('When the matcher judges it', () => {
      it('Then the content matches', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'one\n');
        const sut = racyContentMatcher(ctx);
        const stat = await ctx.fs.lstat(work(ctx, 'a.txt'));

        // Act
        const result = await sut(entry, work(ctx, 'a.txt'), stat);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a staged file rewritten with other content of the same size', () => {
    describe('When the matcher judges it', () => {
      it('Then the content differs', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'one\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'two\n');
        const sut = racyContentMatcher(ctx);
        const stat = await ctx.fs.lstat(work(ctx, 'a.txt'));

        // Act
        const result = await sut(entry, work(ctx, 'a.txt'), stat);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given one matcher judging two files', () => {
    describe('When both are judged', () => {
      it('Then the attribute sources are read once', async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'one\n');
        const sut = racyContentMatcher(ctx);
        const stat = await ctx.fs.lstat(work(ctx, 'a.txt'));
        const readSpy = vi.spyOn(ctx.fs, 'lstatIfReachable');
        await sut(entry, work(ctx, 'a.txt'), stat);
        const afterFirst = readSpy.mock.calls.filter(([p]) => p.endsWith('info/attributes')).length;

        // Act
        await sut(entry, work(ctx, 'a.txt'), stat);

        // Assert
        const afterSecond = readSpy.mock.calls.filter(([p]) =>
          p.endsWith('info/attributes'),
        ).length;
        expect(afterFirst).toBe(1);
        expect(afterSecond).toBe(afterFirst);
      });
    });
  });
});

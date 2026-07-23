import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryCommandRunner } from '../../../../src/adapters/memory/memory-command-runner.js';
import { buildContentMerger } from '../../../../src/application/primitives/build-content-merger.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { ContentMergeContext, ContentMerger } from '../../../../src/domain/merge/index.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: enc(content), id: '' as ObjectId });

const mergeCtxFor = async (
  ctx: Context,
  parts: { base?: string; ours: string; theirs: string; path?: string },
): Promise<ContentMergeContext> => {
  const [baseId, ourId, theirId] = await Promise.all([
    parts.base === undefined ? Promise.resolve(undefined) : blob(ctx, parts.base),
    blob(ctx, parts.ours),
    blob(ctx, parts.theirs),
  ]);
  return {
    path: (parts.path ?? 'f.txt') as FilePath,
    ourId,
    theirId,
    ourMode: FILE_MODE.REGULAR,
    theirMode: FILE_MODE.REGULAR,
    ...(baseId !== undefined ? { baseId, baseMode: FILE_MODE.REGULAR } : {}),
  };
};

describe('buildContentMerger', () => {
  describe('Given no merge attribute', () => {
    describe('When merging non-overlapping edits', () => {
      it('Then it delegates to the built-in line merge (clean)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status).toBe('clean');
        expect(result.status === 'clean' && dec(result.bytes)).toBe('THEIRS\nL1\nOURS\n');
      });
    });
  });

  describe('Given the merge attribute unset (`-merge`)', () => {
    describe('When merging', () => {
      it('Then it yields a binary conflict carrying the ours bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* -merge\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, { base: 'b', ours: 'OURS', theirs: 'THEIRS' });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status).toBe('conflict');
        expect(result.status === 'conflict' && result.conflictType).toBe('binary');
        expect(result.status === 'conflict' && dec(result.markedBytes)).toBe('OURS');
      });
    });
  });

  describe('Given merge=union on an overlapping change', () => {
    describe('When merging', () => {
      it('Then it resolves cleanly by concatenating both sides', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=union\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'a\nb\nc\n',
          ours: 'a\nX\nc\n',
          theirs: 'a\nY\nc\n',
        });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status).toBe('clean');
        expect(result.status === 'clean' && dec(result.bytes)).toBe('a\nX\nY\nc\n');
      });
    });
  });

  describe('Given a configured external driver and a wired CommandRunner', () => {
    describe('When merging', () => {
      it('Then the driver output becomes the merge result', async () => {
        // Arrange — driver copies the %O (base) file onto the %A output
        const ctx = createMemoryContext({
          command: new MemoryCommandRunner(async (req) => {
            const [o, a] = req.command.split(' ');
            await ctx.fs.write(a as string, await ctx.fs.read(o as string));
            return 0;
          }),
        });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n  driver = %O %A\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, { base: 'DRIVEN', ours: 'OURS', theirs: 'THEIRS' });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('DRIVEN');
      });
    });
  });

  describe('Given a configured external driver but no CommandRunner', () => {
    describe('When merging', () => {
      it('Then it falls back to the built-in line merge', async () => {
        // Arrange — no `command` runner wired
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n  driver = should-not-run\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('THEIRS\nL1\nOURS\n');
      });
    });
  });

  describe('Given supplied labels and an overlapping change', () => {
    describe('When the built-in merge conflicts', () => {
      it('Then the markers carry the ours / theirs labels', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildContentMerger(ctx, { ours: 'HEAD', theirs: 'feature', base: 'main' });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'a\nb\nc\n',
          ours: 'a\nX\nc\n',
          theirs: 'a\nY\nc\n',
        });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status).toBe('conflict');
        const text = result.status === 'conflict' ? dec(result.markedBytes) : '';
        expect(text).toContain('<<<<<<< HEAD\n');
        expect(text).toContain('>>>>>>> feature\n');
      });
    });
  });

  describe('Given conflict-marker-size=2 and an overlapping change', () => {
    describe('When the built-in merge conflicts', () => {
      it('Then the markers are two characters long', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.workDir}/.gitattributes`,
          '* conflict-marker-size=2\n',
        );
        const sut = buildContentMerger(ctx, { ours: 'HEAD', theirs: 'feature', base: 'main' });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'a\nb\nc\n',
          ours: 'a\nX\nc\n',
          theirs: 'a\nY\nc\n',
        });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        const text = result.status === 'conflict' ? dec(result.markedBytes) : '';
        expect(text).toContain('<< HEAD\n');
        expect(text).toContain('>> feature\n');
      });
    });
  });

  describe('Given an external driver with conflict-marker-size=9 and supplied labels', () => {
    describe('When merging', () => {
      it('Then the driver receives the resolved %L and %X %Y labels', async () => {
        // Arrange
        let captured = '';
        const ctx = createMemoryContext({
          command: new MemoryCommandRunner(async (req) => {
            captured = req.command;
            const a = req.command.split(' ')[0] as string;
            await ctx.fs.write(a, enc('done'));
            return 0;
          }),
        });
        await ctx.fs.writeUtf8(
          `${ctx.layout.workDir}/.gitattributes`,
          '* merge=custom conflict-marker-size=9\n',
        );
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n  driver = %A | %L | %X | %Y\n',
        );
        const sut = buildContentMerger(ctx, { ours: 'HEAD', theirs: 'feat', base: 'main' });
        const mergeCtx = await mergeCtxFor(ctx, { base: 'B', ours: 'O', theirs: 'T' });

        // Act
        await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(captured.endsWith(' | 9 | HEAD | feat')).toBe(true);
      });
    });
  });

  describe('Given the merger is invoked for two paths', () => {
    describe('When merging twice', () => {
      it('Then the attribute provider is reused (both lookups resolve)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.bin -merge\n');
        const sut = buildContentMerger(ctx);
        const first = await mergeCtxFor(ctx, { base: 'b', ours: 'O', theirs: 'T', path: 'a.bin' });
        const second = await mergeCtxFor(ctx, { base: 'b', ours: 'O', theirs: 'T', path: 'b.bin' });

        // Act
        const r1 = await sut(first, undefined, new Uint8Array(0), new Uint8Array(0));
        const r2 = await sut(second, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(r1.status).toBe('conflict');
        expect(r2.status).toBe('conflict');
      });
    });
  });

  describe('Given a valueless [merge *] driver config', () => {
    const mergeData = async (
      sut: ContentMerger,
      mergeCtx: ContentMergeContext,
    ): Promise<{ code?: string; key?: string; line?: number; source?: string }> => {
      try {
        await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));
      } catch (err) {
        return (err as { data?: { code?: string; key?: string; line?: number; source?: string } })
          .data as { code?: string; key?: string; line?: number; source?: string };
      }
      return {};
    };

    describe('When a path enters content merge with a valueless merge.custom.driver and NO attribute', () => {
      it('Then it throws CONFIG_MISSING_VALUE for merge.custom.driver at its line', async () => {
        // Arrange — driver valueless at line 2; no `.gitattributes` selects custom.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "custom"]\n\tdriver\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.custom.driver');
        expect(result.line).toBe(2);
        expect(result.source).toMatch(/\/config$/);
      });
    });

    describe('When a path enters content merge with a valueless merge.custom.recursive and NO attribute', () => {
      it('Then it throws CONFIG_MISSING_VALUE for merge.custom.recursive at its line', async () => {
        // Arrange — recursive valueless at line 2; no `.gitattributes` selects custom.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "custom"]\n\trecursive\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.custom.recursive');
        expect(result.line).toBe(2);
        expect(result.source).toMatch(/\/config$/);
      });
    });

    describe('When a path enters content merge with a subsectionless valueless [merge] recursive', () => {
      it('Then the guard skips it (git ignores subsectionless merge keys) and does not throw', async () => {
        // Arrange — `[merge] recursive` with no subsection is inert to git; the guard
        // requires a subsection, so it must not refuse here.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge]\n\trecursive\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert — no CONFIG_MISSING_VALUE; the merge proceeds
        expect(result.code).toBeUndefined();
      });
    });

    describe('When a path enters content merge with a valued driver but a valueless name', () => {
      it('Then it throws CONFIG_MISSING_VALUE for merge.custom.name at its line', async () => {
        // Arrange — driver valued at line 2, name valueless at line 3.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n\tdriver = mycmd\n\tname\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.custom.name');
        expect(result.line).toBe(3);
      });
    });

    describe('When two [merge *] subsections are each valueless', () => {
      it('Then it reports the earlier-by-line key across subsections', async () => {
        // Arrange — name valueless at line 2 (zzz), driver valueless at line 4 (aaa).
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "zzz"]\n\tname\n[merge "aaa"]\n\tdriver\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.zzz.name');
        expect(result.line).toBe(2);
      });
    });

    describe('When driver and name are both valueless with driver earlier in one subsection', () => {
      it('Then it reports the earlier-by-line key merge.custom.driver', async () => {
        // Arrange — driver valueless at line 2, name valueless at line 3.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n\tdriver\n\tname\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.custom.driver');
        expect(result.line).toBe(2);
      });
    });

    describe('When driver and name are both valueless with name earlier in one subsection', () => {
      it('Then it reports the earlier-by-line key merge.custom.name', async () => {
        // Arrange — name valueless at line 2, driver valueless at line 3.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n\tname\n\tdriver\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'L1\n',
          ours: 'L1\nOURS\n',
          theirs: 'THEIRS\nL1\n',
        });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.custom.name');
        expect(result.line).toBe(2);
      });
    });

    describe('When the path resolves merge=custom via attribute and that driver is valueless', () => {
      it('Then the chokepoint still refuses with CONFIG_MISSING_VALUE', async () => {
        // Arrange — the attribute-selected case still refuses now the guard moved
        // from namedChoice to the chokepoint.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "custom"]\n\tdriver\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, { base: 'b', ours: 'OURS', theirs: 'THEIRS' });

        // Act
        const result = await mergeData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('merge.custom.driver');
        expect(result.line).toBe(2);
      });
    });

    describe('When the merger is constructed but its closure is invoked for zero paths', () => {
      it('Then the config is never scanned at construction (lazy — guard lives in the closure)', async () => {
        // Arrange — a valueless driver is configured, but no content-merge path is
        // ever submitted (the fast-forward / no-content-merge case).
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "custom"]\n\tdriver\n');
        const readSpy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act — construct the merger; do NOT invoke the returned closure.
        const sut = buildContentMerger(ctx);

        // Assert — construction reads no config: an eager guard moved into the
        // synchronous body (instead of the per-path closure) would scan here and be caught.
        expect(sut).toBeInstanceOf(Function);
        expect(readSpy).not.toHaveBeenCalledWith(`${ctx.layout.gitDir}/config`);
      });
    });
  });

  describe('Given a registered-but-driverless merge driver', () => {
    const missingCommandData = async (
      sut: ContentMerger,
      mergeCtx: ContentMergeContext,
    ): Promise<{ code?: string; name?: string }> => {
      try {
        await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));
      } catch (err) {
        return (err as { data?: { code?: string; name?: string } }).data as {
          code?: string;
          name?: string;
        };
      }
      return {};
    };

    describe('When a selected driverless section (valued name, no driver) enters content merge', () => {
      it('Then it throws MERGE_DRIVER_MISSING_COMMAND for the resolved name', async () => {
        // Arrange
        const ctx = createMemoryContext({
          command: new MemoryCommandRunner(async () => 0),
        });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "custom"]\n\tname = X\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, { base: 'b', ours: 'OURS', theirs: 'THEIRS' });

        // Act
        const result = await missingCommandData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('MERGE_DRIVER_MISSING_COMMAND');
        expect(result.name).toBe('custom');
      });
    });

    describe('When the same selection has no CommandRunner wired', () => {
      it('Then it still throws MERGE_DRIVER_MISSING_COMMAND (platform-independent)', async () => {
        // Arrange — no `command` runner; the throw precedes the ctx.command branch.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "custom"]\n\tname = X\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, { base: 'b', ours: 'OURS', theirs: 'THEIRS' });

        // Act
        const result = await missingCommandData(sut, mergeCtx);

        // Assert
        expect(result.code).toBe('MERGE_DRIVER_MISSING_COMMAND');
        expect(result.name).toBe('custom');
      });
    });

    describe('When an unselected driverless section is configured but the path selects a different driver', () => {
      it('Then it does not throw and returns a normal merge result', async () => {
        // Arrange — [merge "unused"] is registered driverless, but the path resolves merge=text.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=text\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge "unused"]\n\tname = X\n');
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'a\nb\nc\n',
          ours: 'a\nX\nc\n',
          theirs: 'a\nY\nc\n',
        });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status).toBe('conflict');
      });
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryCommandRunner } from '../../../../src/adapters/memory/memory-command-runner.js';
import {
  buildBlobUnchanged,
  buildContentMerger,
} from '../../../../src/application/primitives/build-content-merger.js';
import type { IndexBlobLookup } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import * as readBlobMod from '../../../../src/application/primitives/read-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  type ContentMergeContext,
  type ContentMerger,
  MAX_CONFLICT_OUTPUT_BYTES,
} from '../../../../src/domain/merge/index.js';
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

  describe.each([
    [
      'no diff algorithm, so ort’s histogram',
      {},
      '<<<<<<< o\n=======\nb\nd\nb\nb\n}\nc\nb\nd\na\nd\n>>>>>>> t\n}\nd\n<<<<<<< o\nb\na\nb\nc\n}\n}\nd\nb\nd\n=======\n}\n}\n>>>>>>> t\nd\n',
    ],
    [
      'diff-algorithm=myers',
      { diffAlgorithm: 'myers' },
      '<<<<<<< o\n}\n=======\nb\nd\nb\nb\n}\nc\n>>>>>>> t\nb\nd\nb\na\n<<<<<<< o\nb\nc\n}\n}\nd\nb\n=======\nd\n}\n>>>>>>> t\nd\n}\n}\nd\n',
    ],
  ] as const)(
    'Given %s and sides the algorithms anchor differently',
    (_label, settings, expected) => {
      describe('When the built-in merge conflicts', () => {
        it('Then the conflict regions sit where git’s merge puts them', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = buildContentMerger(ctx, { ours: 'o', theirs: 't', base: 'b' }, settings);
          const mergeCtx = await mergeCtxFor(ctx, {
            base: 'd\nd\nb\nd\na\nc\nd\nc\n}\nb\nd\nd\n',
            ours: '}\nb\nd\nb\na\nb\nc\n}\n}\nd\nb\nd\nd\n',
            theirs: 'b\nd\nb\nb\n}\nc\nb\nd\na\nd\n}\nd\n}\n}\nd\n',
          });

          // Act
          const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

          // Assert
          expect(result.status === 'conflict' && dec(result.markedBytes)).toBe(expected);
        });
      });
    },
  );

  describe('Given a renamed path whose sides held it at different paths', () => {
    describe('When the built-in merge conflicts', () => {
      it('Then each marker label names its side path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildContentMerger(ctx, { ours: 'HEAD', theirs: 'side', base: 'abc1234' });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: 'a\nb\nc\n',
          ours: 'a\nX\nc\n',
          theirs: 'a\nY\nc\n',
          path: 'big2',
        });
        const sidePaths = {
          base: 'big' as FilePath,
          ours: 'big' as FilePath,
          theirs: 'big2' as FilePath,
        };

        // Act
        const result = await sut(
          { ...mergeCtx, sidePaths },
          undefined,
          new Uint8Array(0),
          new Uint8Array(0),
        );

        // Assert
        const text = result.status === 'conflict' ? dec(result.markedBytes) : '';
        expect(text).toContain('<<<<<<< HEAD:big\n');
        expect(text).toContain('>>>>>>> side:big2\n');
      });
    });
  });

  describe('Given an external driver and a renamed path', () => {
    describe('When merging', () => {
      it('Then the driver receives each side label with its path', async () => {
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
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n  driver = %A | %S | %X | %Y\n',
        );
        const sut = buildContentMerger(ctx, { ours: 'HEAD', theirs: 'feat', base: 'main' });
        const mergeCtx = await mergeCtxFor(ctx, { base: 'B', ours: 'O', theirs: 'T' });
        const sidePaths = {
          base: 'old' as FilePath,
          ours: 'new' as FilePath,
          theirs: 'old' as FilePath,
        };

        // Act
        await sut({ ...mergeCtx, sidePaths }, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(captured.endsWith(' | main:old | HEAD:new | feat:old')).toBe(true);
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

  describe('Given a merge context asking for one extra marker character', () => {
    describe('When the built-in merge conflicts', () => {
      it('Then the markers are one character longer than the attribute size', async () => {
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
        const result = await sut(
          { ...mergeCtx, extraMarkerSize: 1 },
          undefined,
          new Uint8Array(0),
          new Uint8Array(0),
        );

        // Assert
        const text = result.status === 'conflict' ? dec(result.markedBytes) : '';
        expect(text.split('\n')).toEqual([
          'a',
          '<<< HEAD',
          'X',
          '===',
          'Y',
          '>>> feature',
          'c',
          '',
        ]);
      });
    });
  });

  describe('Given an external driver and a merge context asking for one extra marker character', () => {
    describe('When merging', () => {
      it('Then the driver receives the enlarged %L', async () => {
        // Arrange
        let captured = '';
        const ctx = createMemoryContext({
          command: new MemoryCommandRunner(async (req) => {
            captured = req.command;
            await ctx.fs.write(req.command.split(' ')[0] as string, enc('done'));
            return 0;
          }),
        });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n  driver = %A | %L\n',
        );
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, { base: 'B', ours: 'O', theirs: 'T' });

        // Act
        await sut(
          { ...mergeCtx, extraMarkerSize: 1 },
          undefined,
          new Uint8Array(0),
          new Uint8Array(0),
        );

        // Assert
        expect(captured.endsWith(' | 8')).toBe(true);
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

    describe('When a path enters content merge with a registered merge.* subsection valueless key', () => {
      it.each([
        {
          label: 'a valueless merge.custom.driver with no attribute selecting it',
          config: '[merge "custom"]\n\tdriver\n',
          expectedKey: 'merge.custom.driver',
          expectedLine: 2,
        },
        {
          label: 'a valueless merge.custom.recursive with no attribute selecting it',
          config: '[merge "custom"]\n\trecursive\n',
          expectedKey: 'merge.custom.recursive',
          expectedLine: 2,
        },
        {
          label: 'a valued driver but a valueless name',
          config: '[merge "custom"]\n\tdriver = mycmd\n\tname\n',
          expectedKey: 'merge.custom.name',
          expectedLine: 3,
        },
        {
          label: 'two [merge *] subsections each valueless (earlier-by-line across subsections)',
          config: '[merge "zzz"]\n\tname\n[merge "aaa"]\n\tdriver\n',
          expectedKey: 'merge.zzz.name',
          expectedLine: 2,
        },
        {
          label: 'driver and name both valueless, driver earlier in the subsection',
          config: '[merge "custom"]\n\tdriver\n\tname\n',
          expectedKey: 'merge.custom.driver',
          expectedLine: 2,
        },
        {
          label: 'driver and name both valueless, name earlier in the subsection',
          config: '[merge "custom"]\n\tname\n\tdriver\n',
          expectedKey: 'merge.custom.name',
          expectedLine: 2,
        },
        {
          label: 'the path resolves merge=custom via attribute and that driver is valueless',
          config: '[merge "custom"]\n\tdriver\n',
          attributes: '* merge=custom\n',
          expectedKey: 'merge.custom.driver',
          expectedLine: 2,
        },
      ])(
        'Then it throws CONFIG_MISSING_VALUE for $expectedKey ($label)',
        async ({ config, attributes, expectedKey, expectedLine }) => {
          // Arrange
          const ctx = createMemoryContext();
          if (attributes !== undefined) {
            await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, attributes);
          }
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
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
          expect(result.key).toBe(expectedKey);
          expect(result.line).toBe(expectedLine);
          expect(result.source).toMatch(/\/config$/);
        },
      );
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
  describe.each([
    ['ours', 'O\n'],
    ['theirs', 'T\n'],
  ] as const)('Given the %s variant and an overlapping change', (variant, expected) => {
    describe('When the built-in merge runs', () => {
      it('Then the overlap resolves cleanly to that side', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildContentMerger(ctx, undefined, { variant });
        const mergeCtx = await mergeCtxFor(ctx, { base: 'B\n', ours: 'O\n', theirs: 'T\n' });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe(expected);
      });
    });
  });

  describe('Given the theirs variant and the merge attribute unset (`-merge`)', () => {
    describe('When merging', () => {
      it('Then the binary merge settles on theirs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* -merge\n');
        const sut = buildContentMerger(ctx, undefined, { variant: 'theirs' });
        const mergeCtx = await mergeCtxFor(ctx, { base: 'b', ours: 'OURS', theirs: 'THEIRS' });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('THEIRS');
      });
    });
  });

  describe('Given the ours variant and merge=union on an overlapping change', () => {
    describe('When merging', () => {
      it('Then union still concatenates both sides', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=union\n');
        const sut = buildContentMerger(ctx, undefined, { variant: 'ours' });
        const mergeCtx = await mergeCtxFor(ctx, { base: 'B\n', ours: 'O\n', theirs: 'T\n' });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('O\nT\n');
      });
    });
  });

  describe('Given ignored space changes and a whitespace-only edit on ours', () => {
    describe('When the built-in merge runs', () => {
      it("Then theirs' real edit wins the line cleanly", async () => {
        // Arrange
        const ctx = createMemoryContext();
        const lineKey = { mode: 'change', ignoreCrAtEol: false } as const;
        const sut = buildContentMerger(ctx, undefined, { lineKey });
        const mergeCtx = await mergeCtxFor(ctx, { base: 'a b\n', ours: 'a  b\n', theirs: 'AB\n' });

        // Act
        const result = await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0));

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('AB\n');
      });
    });
  });
});

describe('buildContentMerger conflict style', () => {
  const LABELS = { ours: 'HEAD', theirs: 'side', base: 'b8cdee5' };
  const conflictOf = async (config: string): Promise<unknown> => {
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
    const sut = buildContentMerger(ctx, LABELS);
    const mergeCtx = await mergeCtxFor(ctx, { base: 'a\nx\n', ours: 'A1\nx\n', theirs: 'A2\nx\n' });
    const result = await Promise.resolve()
      .then(() => sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0)))
      .catch((error: unknown) => error);
    return 'markedBytes' in (result as object)
      ? dec((result as { markedBytes: Uint8Array }).markedBytes)
      : (result as { data?: unknown }).data;
  };

  describe('Given merge.conflictStyle = diff3, When the built-in merge conflicts', () => {
    it('Then the markers carry the base section under the base label', async () => {
      // Arrange
      const config = '[merge]\n  conflictStyle = diff3\n';

      // Act
      const result = await conflictOf(config);

      // Assert
      expect(result).toBe('<<<<<<< HEAD\nA1\n||||||| b8cdee5\na\n=======\nA2\n>>>>>>> side\nx\n');
    });
  });

  describe('Given merge.conflictStyle holding a style git does not know, When the merge runs', () => {
    it('Then it refuses the value, as git dies on it', async () => {
      // Arrange
      const config = '[merge]\n  conflictStyle = bogus\n';

      // Act
      const result = await conflictOf(config);

      // Assert
      expect(result).toMatchObject({
        code: 'CONFIG_UNKNOWN_VALUE',
        key: 'merge.conflictstyle',
        value: 'bogus',
      });
    });
  });

  describe('Given a valueless merge.conflictStyle, When the merge runs', () => {
    it('Then it refuses the missing value', async () => {
      // Arrange
      const config = '[merge]\n  conflictStyle\n';

      // Act
      const result = await conflictOf(config);

      // Assert
      expect(result).toMatchObject({ code: 'CONFIG_MISSING_VALUE', key: 'merge.conflictstyle' });
    });
  });
});

describe('buildContentMerger renormalize', () => {
  const TEXT_AUTO = '* text=auto\n';
  const attributesLookup = async (ctx: Context, content: string): Promise<IndexBlobLookup> => {
    const attributesId = await blob(ctx, content);
    return (path) => (path === ('.gitattributes' as FilePath) ? attributesId : undefined);
  };
  const CRLF_BASE = 'a\r\nb\r\nc\r\n';
  const CRLF_OURS = 'a\r\nb\r\nC\r\n';
  const LF_THEIRS = 'A\nb\nc\n';
  const none = new Uint8Array(0);

  describe('Given a CRLF base, a CRLF edited ours and an LF-renormalized edited theirs under text=auto', () => {
    describe('When the merger runs', () => {
      it('Then the merge is clean with LF bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attributes = await attributesLookup(ctx, TEXT_AUTO);
        const sut = buildContentMerger(ctx, undefined, { renormalize: { attributes } });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: CRLF_BASE,
          ours: CRLF_OURS,
          theirs: LF_THEIRS,
        });

        // Act
        const result = await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('A\nb\nC\n');
      });
    });
  });

  describe('Given no merged attributes and an untracked worktree .gitattributes of text=auto', () => {
    describe('When the merger runs with renormalize', () => {
      it('Then the worktree file governs and the merge is clean with LF bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, TEXT_AUTO);
        const sut = buildContentMerger(ctx, undefined, {
          renormalize: { attributes: () => undefined },
        });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: CRLF_BASE,
          ours: CRLF_OURS,
          theirs: LF_THEIRS,
        });

        // Act
        const result = await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('A\nb\nC\n');
      });
    });
  });

  describe('Given merged attributes of * -text and a worktree .gitattributes of text=auto', () => {
    describe('When the merger runs with renormalize', () => {
      it('Then the merged index governs and the sides are not normalized', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, TEXT_AUTO);
        const attributes = await attributesLookup(ctx, '* -text\n');
        const sut = buildContentMerger(ctx, undefined, { renormalize: { attributes } });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: CRLF_BASE,
          ours: CRLF_OURS,
          theirs: LF_THEIRS,
        });

        // Act
        const result = await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(result.status).toBe('conflict');
      });
    });
  });

  describe('Given the same sides without renormalize', () => {
    describe('When the merger runs', () => {
      it('Then the line endings make it conflict', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildContentMerger(ctx);
        const mergeCtx = await mergeCtxFor(ctx, {
          base: CRLF_BASE,
          ours: CRLF_OURS,
          theirs: LF_THEIRS,
        });

        // Act
        const result = await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(result.status).toBe('conflict');
      });
    });
  });

  describe('Given no base and text=auto', () => {
    describe('When the merger runs on identical CRLF and LF sides', () => {
      it('Then the sides merge to the LF form', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attributes = await attributesLookup(ctx, TEXT_AUTO);
        const sut = buildContentMerger(ctx, undefined, { renormalize: { attributes } });
        const mergeCtx = await mergeCtxFor(ctx, { ours: 'x\r\n', theirs: 'x\n' });

        // Act
        const result = await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(result.status === 'clean' && dec(result.bytes)).toBe('x\n');
      });
    });
  });

  describe('Given an external driver from the work tree attributes', () => {
    describe('When the merger runs', () => {
      it('Then the driver received normalized bytes for all three sides', async () => {
        // Arrange
        const seen: string[] = [];
        const ctx = createMemoryContext({
          command: new MemoryCommandRunner(async (req) => {
            const [o, a, b] = req.command.split(' ') as [string, string, string];
            for (const file of [o, a, b]) seen.push(dec(await ctx.fs.read(file)));
            return 0;
          }),
        });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* merge=custom\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[merge "custom"]\n  driver = %O %A %B\n',
        );
        const attributes = await attributesLookup(ctx, TEXT_AUTO);
        const sut = buildContentMerger(ctx, undefined, { renormalize: { attributes } });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: CRLF_BASE,
          ours: CRLF_OURS,
          theirs: LF_THEIRS,
        });

        // Act
        await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(seen).toEqual(['a\nb\nc\n', 'a\nb\nC\n', 'A\nb\nc\n']);
      });
    });
  });

  describe('Given the binary driver and text=auto', () => {
    describe('When the merger runs', () => {
      it('Then the conflict carries the normalized ours bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* -merge\n');
        const attributes = await attributesLookup(ctx, TEXT_AUTO);
        const sut = buildContentMerger(ctx, undefined, { renormalize: { attributes } });
        const mergeCtx = await mergeCtxFor(ctx, {
          base: CRLF_BASE,
          ours: CRLF_OURS,
          theirs: LF_THEIRS,
        });

        // Act
        const result = await sut(mergeCtx, undefined, none, none);

        // Assert
        expect(result.status === 'conflict' && dec(result.markedBytes)).toBe('a\nb\nC\n');
      });
    });
  });
});

describe('buildBlobUnchanged', () => {
  const TEXT_AUTO = '* text=auto\n';
  const PATH = 'f.txt' as FilePath;
  const entry = (oid: ObjectId, mode: string = FILE_MODE.REGULAR) => ({
    id: oid,
    mode: mode as typeof FILE_MODE.REGULAR,
  });
  const setup = async () => {
    const ctx = createMemoryContext();
    const attributesId = await blob(ctx, TEXT_AUTO);
    const attributes = (path: FilePath) =>
      path === ('.gitattributes' as FilePath) ? attributesId : undefined;
    return { ctx, sut: buildBlobUnchanged(ctx, { attributes }) };
  };
  const MISSING = 'f'.repeat(40) as ObjectId;
  const OTHER_MISSING = 'e'.repeat(40) as ObjectId;

  describe('Given two entries with the same id and mode', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then it is, without reading any blob', async () => {
        // Arrange
        const { sut } = await setup();

        // Act
        const result = await sut(PATH, entry(MISSING), entry(MISSING));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given two entries whose modes differ', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then it is not, without reading any blob', async () => {
        // Arrange
        const { sut } = await setup();

        // Act
        const result = await sut(PATH, entry(MISSING), entry(MISSING, FILE_MODE.EXECUTABLE));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a CRLF base and an LF-renormalized side under text=auto', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then it is', async () => {
        // Arrange
        const { ctx, sut } = await setup();
        const base = await blob(ctx, 'a\r\nb\r\n');
        const side = await blob(ctx, 'a\nb\n');

        // Act
        const result = await sut(PATH, entry(base), entry(side));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a base and a side whose content really differs', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then it is not', async () => {
        // Arrange
        const { ctx, sut } = await setup();
        const base = await blob(ctx, 'a\r\nb\r\n');
        const side = await blob(ctx, 'A\nb\n');

        // Act
        const result = await sut(PATH, entry(base), entry(side));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given two different ids that are not stored', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then the side counts as changed', async () => {
        // Arrange
        const { sut } = await setup();

        // Act
        const result = await sut(PATH, entry(MISSING), entry(OTHER_MISSING));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a base that is stored as a tree rather than a blob', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then the side counts as changed', async () => {
        // Arrange
        const { ctx, sut } = await setup();
        const tree = await writeObject(ctx, { type: 'tree', entries: [], id: '' as ObjectId });
        const side = await blob(ctx, 'a\n');

        // Act
        const result = await sut(PATH, entry(tree), entry(side));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a submodule commit id on each side', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then the side counts as changed, without reading any object', async () => {
        // Arrange
        const { sut } = await setup();
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await sut(
          PATH,
          entry(MISSING, FILE_MODE.GITLINK),
          entry(OTHER_MISSING, FILE_MODE.GITLINK),
        );

        // Assert
        expect(result).toBe(false);
        expect(readSpy).not.toHaveBeenCalled();
        readSpy.mockRestore();
      });
    });
  });

  describe('Given two stored blobs that differ', () => {
    describe('When asked whether the side is unchanged', () => {
      it('Then both reads are capped at the conflict output limit', async () => {
        // Arrange
        const { ctx, sut } = await setup();
        const base = await blob(ctx, 'a\n');
        const side = await blob(ctx, 'b\n');
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        await sut(PATH, entry(base), entry(side));

        // Assert
        const compared = readSpy.mock.calls.filter(([, id]) => id === base || id === side);
        expect(compared.map(([, , options]) => options)).toEqual([
          { maxBytes: MAX_CONFLICT_OUTPUT_BYTES },
          { maxBytes: MAX_CONFLICT_OUTPUT_BYTES },
        ]);
        readSpy.mockRestore();
      });
    });
  });
});

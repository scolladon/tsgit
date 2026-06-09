import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryCommandRunner } from '../../../../src/adapters/memory/memory-command-runner.js';
import { buildContentMerger } from '../../../../src/application/primitives/build-content-merger.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { ContentMergeContext } from '../../../../src/domain/merge/index.js';
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
});

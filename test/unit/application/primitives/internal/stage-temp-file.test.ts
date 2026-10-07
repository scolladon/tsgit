import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { stageTempFile } from '../../../../../src/application/primitives/internal/stage-temp-file.js';
import { TsgitError } from '../../../../../src/domain/error.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
/** `Math.random` values drawing the first and the last alphabet character. */
const FIRST = 0;
const LAST = 0.999;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stageTempFile', () => {
  describe('Given a free name', () => {
    describe('When bytes are staged', () => {
      it('Then they land at the stem plus six random characters', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stem = `${ctx.layout.gitDir}/.tmp`;
        vi.spyOn(Math, 'random').mockReturnValue(LAST);
        const sut = stageTempFile;

        // Act
        const result = await sut(ctx, stem, enc('sig'));

        // Assert
        expect(result).toBe(`${stem}999999`);
        expect(dec(await ctx.fs.read(result))).toBe('sig');
      });
    });
  });

  describe('Given a file already at the first drawn name', () => {
    describe('When bytes are staged', () => {
      it('Then the file is left untouched and a fresh name is drawn', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stem = `${ctx.layout.gitDir}/.tmp`;
        await ctx.fs.write(`${stem}AAAAAA`, enc('precious'));
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(FIRST)
          .mockReturnValueOnce(FIRST)
          .mockReturnValueOnce(FIRST)
          .mockReturnValueOnce(FIRST)
          .mockReturnValueOnce(FIRST)
          .mockReturnValueOnce(FIRST)
          .mockReturnValue(LAST);
        const sut = stageTempFile;

        // Act
        const result = await sut(ctx, stem, enc('sig'));

        // Assert
        expect(result).toBe(`${stem}999999`);
        expect(dec(await ctx.fs.read(`${stem}AAAAAA`))).toBe('precious');
        expect(dec(await ctx.fs.read(result))).toBe('sig');
      });
    });
  });

  describe('Given every drawn name already taken', () => {
    describe('When bytes are staged', () => {
      it('Then it refuses with FILE_EXISTS naming the template, after eight draws', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stem = `${ctx.layout.gitDir}/.tmp`;
        await ctx.fs.write(`${stem}AAAAAA`, enc('precious'));
        const random = vi.spyOn(Math, 'random').mockReturnValue(FIRST);
        const sut = stageTempFile;

        // Act
        const result = await sut(ctx, stem, enc('sig')).catch((error: unknown) => error);

        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect((result as TsgitError).data).toEqual({ code: 'FILE_EXISTS', path: `${stem}XXXXXX` });
        expect(random).toHaveBeenCalledTimes(48);
      });
    });
  });

  describe('Given a write failing for another reason', () => {
    describe('When bytes are staged', () => {
      it('Then that failure propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const failure = new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
        vi.spyOn(ctx.fs, 'writeExclusive').mockRejectedValue(failure);
        const sut = stageTempFile;

        // Act
        const result = await sut(ctx, `${ctx.layout.gitDir}/.tmp`, enc('sig')).catch(
          (error: unknown) => error,
        );

        // Assert
        expect(result).toBe(failure);
      });
    });
  });
});

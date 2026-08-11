import { describe, expect, it } from 'vitest';
import {
  loadBitmapBytes,
  loadPackRevIndex,
} from '../../../../../src/application/primitives/internal/pack-artefact-source.js';
import { fileNotFound } from '../../../../../src/domain/error.js';
import {
  REASON_REV_INDEX_CORRUPT,
  REV_HEADER_SIZE,
} from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext } from '../fixtures.js';

const revPath = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack/pack-artefact.rev`;
const bitmapPath = (ctx: Context): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-artefact.bitmap`;

/** A context whose first touch of the artefact reports it gone, everything
 *  else intact — the listing-then-open window a scan cannot close. Covers
 *  both loaders: `.rev` opens with a bounded `readSlice`, the bitmap with a
 *  `stat`, and a helper that stubbed only one would leave the other reading
 *  the real file. */
function withVanishedArtefact(ctx: Context, suffix: string): Context {
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      stat: async (path: string) => {
        if (path.endsWith(suffix)) throw fileNotFound(path);
        return ctx.fs.stat(path);
      },
      readSlice: async (path: string, offset: number, length: number) => {
        if (path.endsWith(suffix)) throw fileNotFound(path);
        return ctx.fs.readSlice(path, offset, length);
      },
    },
  };
}

describe('loadPackRevIndex', () => {
  describe('Given a .rev the scan listed but whose read reports it gone', () => {
    describe('When the loader runs with present true', () => {
      it('Then the load is absent — the vanished file is not reported as one it could not read', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx = withVanishedArtefact(base, '.rev');
        const sut = loadPackRevIndex;

        // Act
        const result = await sut(ctx, revPath(ctx), true, 20, 4);

        // Assert
        expect(result.kind).toBe('absent');
      });
    });
  });

  describe('Given a .rev whose length disagrees with the exact formula', () => {
    describe('When the loader runs', () => {
      it('Then it refuses on the length that came back and never reads the whole file', async () => {
        // Arrange — one word short of the four-object formula, so the length
        // gate and only the length gate can produce this refusal.
        const base = await buildSeededContext();
        const objectCount = 4;
        const shortSize = REV_HEADER_SIZE + 4 * objectCount + 2 * 20 - 4;
        await base.fs.write(revPath(base), new Uint8Array(shortSize));
        const { ctx, calls } = instrumentedContext(base);
        const sut = loadPackRevIndex;

        // Act
        const result = await sut(ctx, revPath(base), true, 20, objectCount);

        // Assert
        expect(result.kind).toBe('refused');
        expect((result as { data: { reason: string } }).data.reason).toBe(REASON_REV_INDEX_CORRUPT);
        expect(calls().filter((call) => call.method === 'read')).toEqual([]);
      });
    });
  });

  describe('Given a .rev the loader will accept', () => {
    describe('When the loader runs', () => {
      it('Then it touches the file exactly once — one bounded read, no stat', async () => {
        // Arrange — the round-trip count IS the behaviour under test here: a
        // stat followed by a read costs two round trips per pack, which is
        // what made the accelerator lose on repositories with many packs.
        const base = await buildSeededContext();
        const objectCount = 4;
        const exactSize = REV_HEADER_SIZE + 4 * objectCount + 2 * 20;
        await base.fs.write(revPath(base), new Uint8Array(exactSize));
        const { ctx, calls } = instrumentedContext(base);
        const sut = loadPackRevIndex;

        // Act
        await sut(ctx, revPath(base), true, 20, objectCount);

        // Assert
        const touches = calls().filter((call) => call.path.endsWith('.rev'));
        expect(touches).toEqual([{ method: 'readSlice', path: revPath(base) }]);
      });
    });
  });
});

describe('loadBitmapBytes', () => {
  describe('Given a bitmap the scan listing says is not there', () => {
    describe('When the loader runs with present false', () => {
      it('Then the load is absent and the filesystem is never touched', async () => {
        // Arrange — the artefact exists on disk; only the listing says
        // otherwise, so a load that reaches the filesystem is observable.
        const base = await buildSeededContext();
        await base.fs.write(bitmapPath(base), new Uint8Array(16));
        const { ctx, calls } = instrumentedContext(base);
        const sut = loadBitmapBytes;

        // Act
        const result = await sut(ctx, bitmapPath(base), false, 4);

        // Assert
        expect(result.kind).toBe('absent');
        expect(calls()).toEqual([]);
      });
    });
  });
});

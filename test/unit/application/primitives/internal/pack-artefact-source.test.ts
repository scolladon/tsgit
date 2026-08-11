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

/** A context whose `stat` reports the artefact gone, everything else intact —
 *  the listing-then-stat window a scan cannot close. */
function withVanishedArtefact(ctx: Context, suffix: string): Context {
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      stat: async (path: string) => {
        if (path.endsWith(suffix)) throw fileNotFound(path);
        return ctx.fs.stat(path);
      },
    },
  };
}

describe('loadPackRevIndex', () => {
  describe('Given a .rev the scan listed but whose stat reports it gone', () => {
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

  describe('Given a .rev whose stat size disagrees with the exact formula', () => {
    describe('When the loader runs', () => {
      it('Then it refuses on the stat alone and never reads the bytes', async () => {
        // Arrange — one word short of the four-object formula, so the size gate
        // and only the size gate can produce this refusal.
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

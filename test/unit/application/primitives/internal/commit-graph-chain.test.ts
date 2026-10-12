import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  isGraphDecodeFailure,
  loadChain,
} from '../../../../../src/application/primitives/internal/commit-graph-chain.js';
import type { ObjectSource } from '../../../../../src/application/primitives/object-store.js';
import { fileNotFound, TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

// The chain loader only reads layer files; it never consults the source's pack registry.
const sourceWithoutPacks = (ctx: Context): ObjectSource =>
  ({ objectsDir: '/repo/.git/objects', fs: ctx.fs, local: true }) as unknown as ObjectSource;

describe('isGraphDecodeFailure', () => {
  describe('Given a RangeError from an out-of-range chunk read', () => {
    describe('When isGraphDecodeFailure', () => {
      it('Then it is a decode failure', () => {
        // Arrange
        const sut = isGraphDecodeFailure;

        // Act
        const result = sut(new RangeError('offset is outside the bounds of the DataView'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a commit-graph decode error', () => {
    describe('When isGraphDecodeFailure', () => {
      it('Then it is a decode failure', () => {
        // Arrange
        const sut = isGraphDecodeFailure;

        // Act
        const result = sut(new TsgitError({ code: 'INVALID_COMMIT_GRAPH_CHUNK', reason: 'x' }));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a TsgitError that is not a commit-graph decode error', () => {
    describe('When isGraphDecodeFailure', () => {
      it('Then it is not a decode failure', () => {
        // Arrange
        const sut = isGraphDecodeFailure;

        // Act
        const result = sut(fileNotFound('objects/info/commit-graph'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('loadChain', () => {
  describe('Given a chain line holding a full hash followed by extra text', () => {
    describe('When loadChain', () => {
      it('Then git reads the hash and the missing layer file is the verdict', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = loadChain;
        const hash = 'a'.repeat(ctx.hashConfig.digestLength * 2);
        const line = `${hash}x`;
        const source = sourceWithoutPacks(ctx);

        // Act
        const result = await sut(ctx, [source], new TextEncoder().encode(`${line}\n`));

        // Assert
        expect(result).toEqual({
          layers: [],
          verdicts: [{ check: 'chain-layer-missing' }],
          incomplete: true,
          stoppedAt: line,
        });
      });
    });
  });

  describe('Given a full-length chain line that is not hexadecimal', () => {
    describe('When loadChain', () => {
      it('Then the line is the not-a-hash verdict', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = loadChain;
        const line = 'z'.repeat(ctx.hashConfig.digestLength * 2);
        const source = sourceWithoutPacks(ctx);

        // Act
        const result = await sut(ctx, [source], new TextEncoder().encode(`${line}\n`));

        // Assert
        expect(result).toEqual({
          layers: [],
          verdicts: [{ check: 'chain-line-not-hash', line }],
          incomplete: true,
          stoppedAt: line,
        });
      });
    });
  });
});

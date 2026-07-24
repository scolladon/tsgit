import { describe, expect, it } from 'vitest';

import { adapterUnavailable } from '../../../src/domain/commands/error.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { Compressor } from '../../../src/ports/compressor.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import type { HashService } from '../../../src/ports/hash-service.js';
import type { HttpTransport } from '../../../src/ports/http-transport.js';
import { composeAdapters } from '../../../src/repository/compose-adapters.js';

const sentinelFs = {} as FileSystem;
const sentinelHash = {} as HashService;
const sentinelCompressor = {} as Compressor;
const sentinelTransport = {} as HttpTransport;
const fallbackFs = {} as FileSystem;
const fallbackHash = {} as HashService;
const fallbackCompressor = {} as Compressor;
const fallbackTransport = {} as HttpTransport;

const fallback = {
  fs: fallbackFs,
  hash: fallbackHash,
  compressor: fallbackCompressor,
  transport: fallbackTransport,
  runtime: 'memory' as const,
};

describe('composeAdapters — fallback only', () => {
  describe('Given no user overrides', () => {
    describe('When composeAdapters runs', () => {
      it('Then returns the fallback set verbatim', () => {
        // Arrange
        const sut = composeAdapters({}, fallback);

        // Assert
        expect(sut.fs).toBe(fallbackFs);
        expect(sut.hash).toBe(fallbackHash);
        expect(sut.compressor).toBe(fallbackCompressor);
        expect(sut.transport).toBe(fallbackTransport);
      });
    });
  });
});

describe('composeAdapters — partial user overrides', () => {
  describe('Given user overrides one field and every other field comes from fallback', () => {
    describe('When composeAdapters runs', () => {
      it.each([
        {
          overrides: { fs: sentinelFs },
          expected: {
            fs: sentinelFs,
            hash: fallbackHash,
            compressor: fallbackCompressor,
            transport: fallbackTransport,
          },
          label: 'fs is sentinelFs and the other three come from fallback',
        },
        {
          overrides: { hash: sentinelHash },
          expected: {
            fs: fallbackFs,
            hash: sentinelHash,
            compressor: fallbackCompressor,
            transport: fallbackTransport,
          },
          label: 'only hash is sentinelHash',
        },
        {
          overrides: {
            fs: sentinelFs,
            hash: sentinelHash,
            compressor: sentinelCompressor,
            transport: sentinelTransport,
          },
          expected: {
            fs: sentinelFs,
            hash: sentinelHash,
            compressor: sentinelCompressor,
            transport: sentinelTransport,
          },
          label: 'every slot is the user-supplied value',
        },
      ])('Then $label', ({ overrides, expected }) => {
        // Arrange
        const sut = composeAdapters(overrides, fallback);

        // Assert
        expect(sut.fs).toBe(expected.fs);
        expect(sut.hash).toBe(expected.hash);
        expect(sut.compressor).toBe(expected.compressor);
        expect(sut.transport).toBe(expected.transport);
      });
    });
  });

  describe('Given user overrides compressor only', () => {
    describe('When composeAdapters runs', () => {
      it('Then only compressor is sentinelCompressor', () => {
        // Arrange
        const sut = composeAdapters({ compressor: sentinelCompressor }, fallback);

        // Assert
        expect(sut.compressor).toBe(sentinelCompressor);
        expect(sut.fs).toBe(fallbackFs);
      });
    });
  });

  describe('Given user overrides transport only', () => {
    describe('When composeAdapters runs', () => {
      it('Then only transport is sentinelTransport', () => {
        // Arrange
        const sut = composeAdapters({ transport: sentinelTransport }, fallback);

        // Assert
        expect(sut.transport).toBe(sentinelTransport);
        expect(sut.fs).toBe(fallbackFs);
      });
    });
  });
});

describe('composeAdapters — ADAPTER_UNAVAILABLE', () => {
  describe('Given a fallback missing exactly one adapter slot', () => {
    describe('When composeAdapters runs', () => {
      it.each([
        ['fs', 'memory'],
        ['hash', 'node'],
        ['compressor', 'node'],
        ['transport', 'browser'],
      ] as const)('Then throws ADAPTER_UNAVAILABLE mentioning %s', (field, runtime) => {
        // Arrange
        const sut = composeAdapters;
        try {
          sut({}, { ...fallback, [field]: undefined, runtime } as unknown as Parameters<
            typeof composeAdapters
          >[1]);
          // Assert
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data;
          expect(data.code).toBe('ADAPTER_UNAVAILABLE');
          if (data.code === 'ADAPTER_UNAVAILABLE') {
            expect(data.runtime).toBe(runtime);
            expect(data.reason).toContain(field);
          }
        }
      });
    });
  });

  // Sanity check the factory we depend on at the data shape level.
  describe('Given the adapterUnavailable factory', () => {
    describe('When invoked with a reason', () => {
      it('Then sanitization runs (control bytes hex-escaped)', () => {
        // Arrange
        const e = adapterUnavailable('node', 'bad\x07data');
        // Assert
        expect(e.data.code === 'ADAPTER_UNAVAILABLE' && e.data.reason).toBe('bad\\x07data');
      });
    });
  });
});

import { describe, expect, it } from 'vitest';

import { adapterUnavailable } from '../../../src/domain/commands/error.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { Compressor } from '../../../src/ports/compressor.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import type { HashService } from '../../../src/ports/hash-service.js';
import type { HttpTransport } from '../../../src/ports/http-transport.js';
import { composeAdapters, isFirstPartyFs } from '../../../src/repository/compose-adapters.js';

const sentinelFs = {} as FileSystem;
const sentinelHash = {} as HashService;
const sentinelCompressor = {} as Compressor;
const sentinelTransport = {} as HttpTransport;
const fallbackFs = {} as FileSystem;
const fallbackHash = {} as HashService;
const fallbackCompressor = {} as Compressor;
const fallbackTransport = {} as HttpTransport;

// `runtime: 'node'` — the one runtime whose fallback adapter is branded
// first-party (its own containment already equals the layout's root set).
// Tests that specifically exercise the memory-runtime carve-out build their
// own fallback with `runtime: 'memory'` instead.
const fallback = {
  fs: fallbackFs,
  hash: fallbackHash,
  compressor: fallbackCompressor,
  transport: fallbackTransport,
  runtime: 'node' as const,
};

describe('composeAdapters — fallback only', () => {
  describe('Given no user overrides', () => {
    describe('When composeAdapters runs', () => {
      it('Then returns the fallback set verbatim', () => {
        // Arrange & Act
        const result = composeAdapters({}, fallback);

        // Assert
        expect(result.fs).toBe(fallbackFs);
        expect(result.hash).toBe(fallbackHash);
        expect(result.compressor).toBe(fallbackCompressor);
        expect(result.transport).toBe(fallbackTransport);
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
        // Arrange & Act
        const result = composeAdapters(overrides, fallback);

        // Assert
        expect(result.fs).toBe(expected.fs);
        expect(result.hash).toBe(expected.hash);
        expect(result.compressor).toBe(expected.compressor);
        expect(result.transport).toBe(expected.transport);
      });
    });
  });

  describe('Given user overrides compressor only', () => {
    describe('When composeAdapters runs', () => {
      it('Then only compressor is sentinelCompressor', () => {
        // Arrange & Act
        const result = composeAdapters({ compressor: sentinelCompressor }, fallback);

        // Assert
        expect(result.compressor).toBe(sentinelCompressor);
        expect(result.fs).toBe(fallbackFs);
      });
    });
  });

  describe('Given user overrides transport only', () => {
    describe('When composeAdapters runs', () => {
      it('Then only transport is sentinelTransport', () => {
        // Arrange & Act
        const result = composeAdapters({ transport: sentinelTransport }, fallback);

        // Assert
        expect(result.transport).toBe(sentinelTransport);
        expect(result.fs).toBe(fallbackFs);
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
        const brokenFallback = {
          ...fallback,
          [field]: undefined,
          runtime,
        } as unknown as Parameters<typeof composeAdapters>[1];

        // Act & Assert
        try {
          composeAdapters({}, brokenFallback);
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
        // Arrange & Act
        const result = adapterUnavailable('node', 'bad\x07data');

        // Assert
        expect(result.data.code === 'ADAPTER_UNAVAILABLE' && result.data.reason).toBe(
          'bad\\x07data',
        );
      });
    });
  });
});

describe('composeAdapters — first-party provenance brand', () => {
  describe('Given no user override for fs (the fallback adapter is used)', () => {
    describe('When composeAdapters runs', () => {
      it('Then the composed fs is branded first-party', () => {
        // Arrange & Act
        const result = composeAdapters({}, fallback);

        // Assert
        expect(isFirstPartyFs(result.fs)).toBe(true);
      });
    });
  });

  describe('Given a fresh user-supplied fs override never seen by composeAdapters before', () => {
    describe('When composeAdapters runs', () => {
      it('Then the composed fs is NOT branded', () => {
        // Arrange — a fs object of its own, never passed as a fallback anywhere else.
        const freshOverrideFs = {} as FileSystem;

        // Act
        const result = composeAdapters({ fs: freshOverrideFs }, fallback);

        // Assert
        expect(isFirstPartyFs(result.fs)).toBe(false);
      });
    });
  });

  describe('Given a fresh fs never passed through composeAdapters as an override', () => {
    describe('When composeAdapters runs with it only in the fallback arm', () => {
      it('Then the brand check is by reference, not by the shape of a single call — a fresh unrelated fs stays unbranded', () => {
        // Arrange — its own fallback set, isolated from the shared module-level fixture,
        // so branding this fs cannot leak into any other test's assertions.
        const freshFallbackFs = {} as FileSystem;
        const isolatedFallback = {
          fs: freshFallbackFs,
          hash: fallbackHash,
          compressor: fallbackCompressor,
          transport: fallbackTransport,
          runtime: 'node' as const,
        };
        const unrelatedFs = {} as FileSystem;

        // Act
        composeAdapters({}, isolatedFallback);

        // Assert — branding tracks the exact object composeAdapters resolved to, not
        // every FileSystem value that happens to exist.
        expect(isFirstPartyFs(freshFallbackFs)).toBe(true);
        expect(isFirstPartyFs(unrelatedFs)).toBe(false);
      });
    });
  });

  describe('Given an unrelated FileSystem object never seen by composeAdapters', () => {
    describe('When isFirstPartyFs is called', () => {
      it('Then it returns false', () => {
        // Arrange
        const strangerFs = {} as FileSystem;

        // Act
        const result = isFirstPartyFs(strangerFs);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a memory-runtime fallback and no user override for fs', () => {
    describe('When composeAdapters runs', () => {
      it('Then the composed fs is NOT branded first-party — MemoryFileSystem is single-rooted, independent of the layout, so the wrapper must stay the containment authority', () => {
        // Arrange — a fresh fallback so branding this fs cannot leak into
        // any other test's assertions.
        const memoryFallbackFs = {} as FileSystem;
        const memoryFallback = {
          fs: memoryFallbackFs,
          hash: fallbackHash,
          compressor: fallbackCompressor,
          transport: fallbackTransport,
          runtime: 'memory' as const,
        };

        // Act
        const result = composeAdapters({}, memoryFallback);

        // Assert
        expect(isFirstPartyFs(result.fs)).toBe(false);
      });
    });
  });
});

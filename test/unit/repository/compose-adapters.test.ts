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
  it('Given no user overrides, When composeAdapters runs, Then returns the fallback set verbatim', () => {
    // Arrange
    const sut = composeAdapters({}, fallback);

    // Assert
    expect(sut.fs).toBe(fallbackFs);
    expect(sut.hash).toBe(fallbackHash);
    expect(sut.compressor).toBe(fallbackCompressor);
    expect(sut.transport).toBe(fallbackTransport);
  });
});

describe('composeAdapters — partial user overrides', () => {
  it('Given user overrides fs only, When composeAdapters runs, Then returned fs is sentinelFs and the other three come from fallback', () => {
    // Arrange
    const sut = composeAdapters({ fs: sentinelFs }, fallback);

    // Assert
    expect(sut.fs).toBe(sentinelFs);
    expect(sut.hash).toBe(fallbackHash);
    expect(sut.compressor).toBe(fallbackCompressor);
    expect(sut.transport).toBe(fallbackTransport);
  });

  it('Given user overrides hash only, When composeAdapters runs, Then only hash is sentinelHash', () => {
    // Arrange
    const sut = composeAdapters({ hash: sentinelHash }, fallback);

    // Assert
    expect(sut.fs).toBe(fallbackFs);
    expect(sut.hash).toBe(sentinelHash);
    expect(sut.compressor).toBe(fallbackCompressor);
    expect(sut.transport).toBe(fallbackTransport);
  });

  it('Given user overrides compressor only, When composeAdapters runs, Then only compressor is sentinelCompressor', () => {
    // Arrange
    const sut = composeAdapters({ compressor: sentinelCompressor }, fallback);

    // Assert
    expect(sut.compressor).toBe(sentinelCompressor);
    expect(sut.fs).toBe(fallbackFs);
  });

  it('Given user overrides transport only, When composeAdapters runs, Then only transport is sentinelTransport', () => {
    // Arrange
    const sut = composeAdapters({ transport: sentinelTransport }, fallback);

    // Assert
    expect(sut.transport).toBe(sentinelTransport);
    expect(sut.fs).toBe(fallbackFs);
  });

  it('Given user overrides all four, When composeAdapters runs, Then every slot is the user-supplied value', () => {
    // Arrange
    const sut = composeAdapters(
      {
        fs: sentinelFs,
        hash: sentinelHash,
        compressor: sentinelCompressor,
        transport: sentinelTransport,
      },
      fallback,
    );

    // Assert
    expect(sut.fs).toBe(sentinelFs);
    expect(sut.hash).toBe(sentinelHash);
    expect(sut.compressor).toBe(sentinelCompressor);
    expect(sut.transport).toBe(sentinelTransport);
  });
});

describe('composeAdapters — ADAPTER_UNAVAILABLE', () => {
  it('Given no fs override AND fallback.fs is undefined, When composeAdapters runs, Then throws ADAPTER_UNAVAILABLE for runtime fallback.runtime', () => {
    // Arrange
    try {
      composeAdapters(
        {},
        {
          ...fallback,
          fs: undefined as unknown as FileSystem,
          runtime: 'memory',
        },
      );
      // Assert
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const data = (err as TsgitError).data;
      expect(data.code).toBe('ADAPTER_UNAVAILABLE');
      if (data.code === 'ADAPTER_UNAVAILABLE') {
        expect(data.runtime).toBe('memory');
        expect(data.reason).toContain('fs');
      }
    }
  });

  it('Given fallback.hash is undefined with runtime node, When composeAdapters runs, Then throws ADAPTER_UNAVAILABLE with reason mentioning hash', () => {
    // Arrange
    try {
      composeAdapters(
        {},
        { ...fallback, hash: undefined as unknown as HashService, runtime: 'node' },
      );
      // Assert
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('ADAPTER_UNAVAILABLE');
      if (data.code === 'ADAPTER_UNAVAILABLE') {
        expect(data.runtime).toBe('node');
        expect(data.reason).toContain('hash');
      }
    }
  });

  it('Given fallback.compressor is undefined with runtime node, When composeAdapters runs, Then throws ADAPTER_UNAVAILABLE with reason mentioning compressor', () => {
    // Arrange
    try {
      composeAdapters(
        {},
        { ...fallback, compressor: undefined as unknown as Compressor, runtime: 'node' },
      );
      // Assert
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('ADAPTER_UNAVAILABLE');
      if (data.code === 'ADAPTER_UNAVAILABLE') {
        expect(data.runtime).toBe('node');
        expect(data.reason).toContain('compressor');
      }
    }
  });

  it('Given no override AND fallback.transport is undefined with runtime browser, When composeAdapters runs, Then throws ADAPTER_UNAVAILABLE with runtime browser', () => {
    // Arrange
    try {
      composeAdapters(
        {},
        {
          ...fallback,
          transport: undefined as unknown as HttpTransport,
          runtime: 'browser',
        },
      );
      // Assert
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('ADAPTER_UNAVAILABLE');
      if (data.code === 'ADAPTER_UNAVAILABLE') {
        expect(data.runtime).toBe('browser');
        expect(data.reason).toContain('transport');
      }
    }
  });

  // Sanity check the factory we depend on at the data shape level.
  it('Given the adapterUnavailable factory, When invoked with a reason, Then sanitization runs (control bytes hex-escaped)', () => {
    // Arrange
    const e = adapterUnavailable('node', 'bad\x07data');
    // Assert
    expect(e.data.code === 'ADAPTER_UNAVAILABLE' && e.data.reason).toBe('bad\\x07data');
  });
});

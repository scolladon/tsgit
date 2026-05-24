import { describe, expect, it } from 'vitest';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import type { Compressor } from '../../../src/ports/compressor.js';
import { createContext, type RepositoryLayout } from '../../../src/ports/context.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import type { HashService } from '../../../src/ports/hash-service.js';
import type { HttpTransport } from '../../../src/ports/http-transport.js';
import type { ProgressReporter } from '../../../src/ports/progress-reporter.js';

// Sentinel dummies — distinct objects per port to catch field-swap mutants.
const sentinelFs = {} as FileSystem;
const sentinelHash = {} as HashService;
const sentinelCompressor = {} as Compressor;
const sentinelTransport = {} as HttpTransport;
const sentinelProgress = {} as ProgressReporter;
const sentinelLayout: RepositoryLayout = { workDir: '/w', gitDir: '/w/.git', bare: false };
const sentinelHashConfig = SHA1_CONFIG;
const sentinelDeltaCache = createLruCache<Uint8Array>(1024);

describe('Context', () => {
  describe('Given distinct sentinel ports', () => {
    describe('When creating context', () => {
      it('Then ctx.fs === sentinelFs', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.fs).toBe(sentinelFs);
      });
      it('Then ctx.hash === sentinelHash', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.hash).toBe(sentinelHash);
      });
      it('Then ctx.compressor === sentinelCompressor', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.compressor).toBe(sentinelCompressor);
      });
      it('Then ctx.transport === sentinelTransport', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.transport).toBe(sentinelTransport);
      });
      it('Then ctx.progress === sentinelProgress', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.progress).toBe(sentinelProgress);
      });
    });
  });

  describe('Given config', () => {
    describe('When reading ctx.config', () => {
      it('Then all fields match input', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.layout).toEqual({ workDir: '/w', gitDir: '/w/.git', bare: false });
      });
    });
  });

  describe('Given created context', () => {
    describe('When attempting mutation', () => {
      it('Then throws (frozen)', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(() => Object.assign(sut, { fs: {} })).toThrow();
      });
    });
  });

  describe('Given context with signal', () => {
    describe('When reading ctx.signal', () => {
      it('Then correct AbortSignal returned', () => {
        // Arrange
        const ac = new AbortController();
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
          signal: ac.signal,
        });
        // Assert
        expect(sut.signal).toBe(ac.signal);
      });
    });
  });

  describe('Given context without signal', () => {
    describe('When reading ctx.signal', () => {
      it('Then undefined', () => {
        // Arrange
        const sut = createContext({
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        });
        // Assert
        expect(sut.signal).toBeUndefined();
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import type { Compressor } from '../../../src/ports/compressor.js';
import { type Context, createContext, type RepositoryLayout } from '../../../src/ports/context.js';
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
const sentinelRuntime = 'node' as const;
const sentinelHashConfig = SHA1_CONFIG;
const sentinelDeltaCache = createLruCache<Uint8Array>(1024);

describe('Context', () => {
  describe('Given distinct sentinel ports', () => {
    describe('When creating context', () => {
      it.each([
        { select: (ctx: Context) => ctx.fs, expected: sentinelFs, label: 'ctx.fs === sentinelFs' },
        {
          select: (ctx: Context) => ctx.hash,
          expected: sentinelHash,
          label: 'ctx.hash === sentinelHash',
        },
        {
          select: (ctx: Context) => ctx.compressor,
          expected: sentinelCompressor,
          label: 'ctx.compressor === sentinelCompressor',
        },
        {
          select: (ctx: Context) => ctx.transport,
          expected: sentinelTransport,
          label: 'ctx.transport === sentinelTransport',
        },
        {
          select: (ctx: Context) => ctx.progress,
          expected: sentinelProgress,
          label: 'ctx.progress === sentinelProgress',
        },
      ])('Then $label', ({ select, expected }) => {
        // Arrange
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(select(sut)).toBe(expected);
      });
    });
  });

  describe('Given config', () => {
    describe('When reading ctx.config', () => {
      it('Then all fields match input', () => {
        // Arrange
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(sut.layout).toEqual({ workDir: '/w', gitDir: '/w/.git', bare: false });
      });
    });
  });

  describe('Given created context', () => {
    describe('When attempting mutation', () => {
      it('Then throws (frozen)', () => {
        // Arrange
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        };

        // Act
        const sut = createContext(options);

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
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
          signal: ac.signal,
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(sut.signal).toBe(ac.signal);
      });
    });
  });

  describe('Given context without signal', () => {
    describe('When reading ctx.signal', () => {
      it('Then undefined', () => {
        // Arrange
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(sut.signal).toBeUndefined();
      });
    });
  });

  describe('Given an explicit parts.cwd', () => {
    describe('When creating context', () => {
      it('Then ctx.cwd is the explicit value, not layout.workDir', () => {
        // Arrange
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
          cwd: '/elsewhere',
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(sut.cwd).toBe('/elsewhere');
      });
    });
  });

  describe('Given no parts.cwd and a layout with a workDir', () => {
    describe('When creating context', () => {
      it('Then ctx.cwd falls back to layout.workDir', () => {
        // Arrange
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: sentinelLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(sut.cwd).toBe(sentinelLayout.workDir);
      });
    });
  });

  describe('Given no parts.cwd and a layout with no workDir (bare)', () => {
    describe('When creating context', () => {
      it('Then ctx.cwd falls back to layout.gitDir', () => {
        // Arrange — matches git, whose `--show-prefix` is empty and
        // `--is-inside-git-dir` is `true` in exactly this shape.
        const bareLayout: RepositoryLayout = { gitDir: '/bare.git', bare: true };
        const options = {
          fs: sentinelFs,
          hash: sentinelHash,
          compressor: sentinelCompressor,
          transport: sentinelTransport,
          progress: sentinelProgress,
          layout: bareLayout,
          runtime: sentinelRuntime,
          hashConfig: sentinelHashConfig,
          deltaCache: sentinelDeltaCache,
        };

        // Act
        const sut = createContext(options);

        // Assert
        expect(sut.cwd).toBe(bareLayout.gitDir);
      });
    });
  });
});

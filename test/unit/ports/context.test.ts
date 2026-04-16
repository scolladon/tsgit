import { describe, expect, it } from 'vitest';
import type { Compressor } from '../../../src/ports/compressor.js';
import { createContext, type RepositoryConfig } from '../../../src/ports/context.js';
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
const sentinelConfig: RepositoryConfig = { workDir: '/w', gitDir: '/w/.git', bare: false };

describe('Context', () => {
  it('Given distinct sentinel ports, When creating context, Then ctx.fs === sentinelFs', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.fs).toBe(sentinelFs);
  });

  it('Given distinct sentinel ports, When creating context, Then ctx.hash === sentinelHash', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.hash).toBe(sentinelHash);
  });

  it('Given distinct sentinel ports, When creating context, Then ctx.compressor === sentinelCompressor', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.compressor).toBe(sentinelCompressor);
  });

  it('Given distinct sentinel ports, When creating context, Then ctx.transport === sentinelTransport', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.transport).toBe(sentinelTransport);
  });

  it('Given distinct sentinel ports, When creating context, Then ctx.progress === sentinelProgress', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.progress).toBe(sentinelProgress);
  });

  it('Given config, When reading ctx.config, Then all fields match input', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.config).toEqual({ workDir: '/w', gitDir: '/w/.git', bare: false });
  });

  it('Given created context, When attempting mutation, Then throws (frozen)', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(() => Object.assign(sut, { fs: {} })).toThrow();
  });

  it('Given context with signal, When reading ctx.signal, Then correct AbortSignal returned', () => {
    const ac = new AbortController();
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
      signal: ac.signal,
    });
    expect(sut.signal).toBe(ac.signal);
  });

  it('Given context without signal, When reading ctx.signal, Then undefined', () => {
    const sut = createContext({
      fs: sentinelFs,
      hash: sentinelHash,
      compressor: sentinelCompressor,
      transport: sentinelTransport,
      progress: sentinelProgress,
      config: sentinelConfig,
    });
    expect(sut.signal).toBeUndefined();
  });
});

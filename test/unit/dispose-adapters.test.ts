import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { disposeAdapters } from '../../src/dispose-adapters.js';
import type { Context } from '../../src/ports/context.js';

const withPort = (
  base: Context,
  key: 'fs' | 'transport' | 'compressor' | 'hash',
  port: unknown,
): Context => ({ ...base, [key]: port });

const baseCtx = (): Context => createMemoryContext();

describe('disposeAdapters', () => {
  it('Given a ctx with ports that lack dispose, When disposeAdapters runs, Then resolves without error', async () => {
    // Arrange
    const sut = disposeAdapters;

    // Act
    const promise = sut(baseCtx());

    // Assert
    await expect(promise).resolves.toBeUndefined();
  });

  it('Given a ctx with one disposable port, When disposeAdapters runs, Then that dispose is called exactly once', async () => {
    // Arrange
    const dispose = vi.fn(async () => {});
    const ctx = withPort(baseCtx(), 'fs', { ...baseCtx().fs, dispose });
    const sut = disposeAdapters;

    // Act
    await sut(ctx);

    // Assert
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('Given a ctx with multiple disposable ports, When disposeAdapters runs, Then ALL dispose methods are called (no early bail)', async () => {
    // Arrange
    const fsDispose = vi.fn(async () => {});
    const transportDispose = vi.fn(async () => {});
    const compressorDispose = vi.fn(async () => {});
    const hashDispose = vi.fn(async () => {});
    const base = baseCtx();
    let ctx = withPort(base, 'fs', { ...base.fs, dispose: fsDispose });
    ctx = withPort(ctx, 'transport', { ...base.transport, dispose: transportDispose });
    ctx = withPort(ctx, 'compressor', { ...base.compressor, dispose: compressorDispose });
    ctx = withPort(ctx, 'hash', { ...base.hash, dispose: hashDispose });
    const sut = disposeAdapters;

    // Act
    await sut(ctx);

    // Assert
    expect(fsDispose).toHaveBeenCalledTimes(1);
    expect(transportDispose).toHaveBeenCalledTimes(1);
    expect(compressorDispose).toHaveBeenCalledTimes(1);
    expect(hashDispose).toHaveBeenCalledTimes(1);
  });

  it('Given a port whose dispose throws, When disposeAdapters runs, Then the error is swallowed and other ports still dispose', async () => {
    // Arrange
    const fsDispose = vi.fn(async () => {
      throw new Error('boom');
    });
    const transportDispose = vi.fn(async () => {});
    const base = baseCtx();
    let ctx = withPort(base, 'fs', { ...base.fs, dispose: fsDispose });
    ctx = withPort(ctx, 'transport', { ...base.transport, dispose: transportDispose });
    const sut = disposeAdapters;

    // Act
    const promise = sut(ctx);

    // Assert
    await expect(promise).resolves.toBeUndefined();
    expect(fsDispose).toHaveBeenCalledTimes(1);
    expect(transportDispose).toHaveBeenCalledTimes(1);
  });

  it('Given a port whose dispose throws AND a logger on ctx, When disposeAdapters runs, Then logger.warn is called with the port key and error string', async () => {
    // Arrange
    const fsDispose = vi.fn(async () => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    const base = baseCtx();
    const ctx: Context = {
      ...withPort(base, 'fs', { ...base.fs, dispose: fsDispose }),
      logger: { warn },
    };
    const sut = disposeAdapters;

    // Act
    await sut(ctx);

    // Assert
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('disposeAdapters: port dispose threw', {
      port: 'fs',
      err: 'Error: boom',
    });
  });

  it('Given a port whose dispose returns a non-Promise truthy dispose property, When disposeAdapters checks, Then it skips that port (typeof check)', async () => {
    // Arrange
    const ctx = withPort(baseCtx(), 'fs', {
      ...baseCtx().fs,
      dispose: 'not-a-function' as unknown,
    });
    const sut = disposeAdapters;

    // Act
    const promise = sut(ctx);

    // Assert — must not throw despite non-function dispose property.
    await expect(promise).resolves.toBeUndefined();
  });

  it('Given two concurrent calls, When disposeAdapters runs twice, Then both resolve and each port dispose is called twice (no shared state)', async () => {
    // Arrange
    const dispose = vi.fn(async () => {});
    const ctx = withPort(baseCtx(), 'fs', { ...baseCtx().fs, dispose });
    const sut = disposeAdapters;

    // Act
    await Promise.all([sut(ctx), sut(ctx)]);

    // Assert
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

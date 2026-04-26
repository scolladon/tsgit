import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';

describe('createMemoryContext', () => {
  it('Given default options, When reading config, Then workDir is /repo and gitDir is /repo/.git', () => {
    // Arrange / Act
    const sut = createMemoryContext();

    // Assert
    expect(sut.layout.workDir).toBe('/repo');
    expect(sut.layout.gitDir).toBe('/repo/.git');
    expect(sut.layout.bare).toBe(false);
  });

  it('Given default options, When reading hash algorithm, Then is sha1', () => {
    // Arrange / Act
    const sut = createMemoryContext();

    // Assert
    expect(sut.hash.algorithm).toBe('sha1');
  });

  it('Given algorithm option sha256, When reading hash algorithm, Then is sha256', () => {
    // Arrange / Act
    const sut = createMemoryContext({ algorithm: 'sha256' });

    // Assert
    expect(sut.hash.algorithm).toBe('sha256');
    expect(sut.hash.digestLength).toBe(32);
  });

  it('Given pre-seeded files, When reading via fs, Then returns seeded bytes', async () => {
    // Arrange
    const seeded = new Uint8Array([1, 2, 3]);
    const sut = createMemoryContext({ files: { '/repo/pre.bin': seeded } });

    // Act
    const result = await sut.fs.read('/repo/pre.bin');

    // Assert
    expect(result).toEqual(seeded);
  });

  it('Given two contexts, When mutating one, Then other is unaffected', async () => {
    // Arrange
    const sutA = createMemoryContext();
    const sutB = createMemoryContext();

    // Act
    await sutA.fs.write('/repo/only-a.bin', new Uint8Array([42]));

    // Assert
    expect(await sutA.fs.exists('/repo/only-a.bin')).toBe(true);
    expect(await sutB.fs.exists('/repo/only-a.bin')).toBe(false);
  });

  it('Given context, When it is frozen, Then mutating fs property throws', () => {
    // Arrange
    const sut = createMemoryContext();

    // Act / Assert
    expect(() => {
      (sut as { fs: unknown }).fs = null;
    }).toThrow();
  });

  it('Given signal option, When reading context signal, Then matches input', () => {
    // Arrange
    const controller = new AbortController();

    // Act
    const sut = createMemoryContext({ signal: controller.signal });

    // Assert
    expect(sut.signal).toBe(controller.signal);
  });

  it('Given default options, When reading progress reporter, Then start/update/end are no-op functions', () => {
    // Arrange / Act
    const sut = createMemoryContext();

    // Assert
    expect(typeof sut.progress.start).toBe('function');
    expect(typeof sut.progress.update).toBe('function');
    expect(typeof sut.progress.end).toBe('function');
    expect(() => sut.progress.start('test', 1)).not.toThrow();
    expect(() => sut.progress.update('test', 0, 1)).not.toThrow();
    expect(() => sut.progress.end('test')).not.toThrow();
  });
});

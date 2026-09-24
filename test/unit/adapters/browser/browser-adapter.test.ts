import { describe, expect, it } from 'vitest';
import { createBrowserContext } from '../../../../src/adapters/browser/browser-adapter.js';
import { BrowserCompressor } from '../../../../src/adapters/browser/browser-compressor.js';
import { BrowserFileSystem } from '../../../../src/adapters/browser/browser-file-system.js';
import {
  BrowserHashService,
  toHex,
} from '../../../../src/adapters/browser/browser-hash-service.js';
import { BrowserHttpTransport } from '../../../../src/adapters/browser/browser-http-transport.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';

const rootHandle = {} as unknown as FileSystemDirectoryHandle;

describe('createBrowserContext', () => {
  describe('Given no options', () => {
    describe('When creating context', () => {
      it('Then each port is its expected concrete class (no field-swap)', () => {
        // Arrange
        const sut = createBrowserContext;

        // Act
        const result = sut({ rootHandle });

        // Assert — distinct class checks catch a mutant that swaps two port fields in the factory.
        expect(result.fs).toBeInstanceOf(BrowserFileSystem);
        expect(result.hash).toBeInstanceOf(BrowserHashService);
        expect(result.compressor).toBeInstanceOf(BrowserCompressor);
        expect(result.transport).toBeInstanceOf(BrowserHttpTransport);
      });

      it("Then ctx.hash.algorithm is 'sha1' and ctx.hashConfig is SHA1_CONFIG", () => {
        // Arrange
        const sut = createBrowserContext;

        // Act
        const result = sut({ rootHandle });

        // Assert — the default (no algorithm option) still yields sha1.
        expect(result.hash.algorithm).toBe('sha1');
        expect(result.hashConfig).toBe(SHA1_CONFIG);
      });
    });
  });

  describe('Given default options (concurrency)', () => {
    describe('When creating context', () => {
      it('Then ctx.concurrency carries a derived cpuBound and ioBound', () => {
        // Arrange
        const sut = createBrowserContext;

        // Act
        const result = sut({ rootHandle });

        // Assert — a real hardwareConcurrency reading populates the policy,
        // not left for every consumer to fall back to the floor.
        expect(result.concurrency).toBeDefined();
        expect(result.concurrency?.cpuBound).toBeGreaterThanOrEqual(1);
        expect(result.concurrency?.ioBound).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("Given algorithm 'sha256'", () => {
    describe('When creating context', () => {
      it("Then ctx.hash.algorithm is 'sha256' and ctx.hashConfig is SHA256_CONFIG", () => {
        // Arrange
        const sut = createBrowserContext;

        // Act
        const result = sut({ rootHandle, algorithm: 'sha256' });

        // Assert
        expect(result.hash.algorithm).toBe('sha256');
        expect(result.hashConfig).toBe(SHA256_CONFIG);
      });
    });
  });

  describe('Given no options', () => {
    describe('When reading layout.refStorage', () => {
      it("Then it is 'files' — the browser shim never runs the Stage-2 scan", () => {
        // Arrange
        const sut = createBrowserContext;

        // Act
        const result = sut({ rootHandle });

        // Assert
        expect(result.layout.refStorage).toBe('files');
      });
    });
  });

  describe.each([
    ['parsedObjectMemoMaxEntries', 3],
    ['flatTreeCacheMaxBytes', 4096],
    ['deltaBaseCacheMaxBytes', 8192],
  ] as const)('Given %s: %s', (option, value) => {
    describe('When creating context', () => {
      it('Then ctx.cacheBudgets carries exactly that one field', () => {
        // Arrange
        const sut = createBrowserContext;

        // Act — each of the three budget overrides must reach
        // ctx.cacheBudgets on its own; before this test createBrowserContext
        // had no cacheBudgets coverage at all.
        const result = sut({ rootHandle, [option]: value });

        // Assert
        expect(result.cacheBudgets).toStrictEqual({ [option]: value });
      });
    });
  });
});

describe('BrowserHashService', () => {
  describe('Given every byte value 0-255', () => {
    it('Then toHex renders each byte as byte.toString(16).padStart(2, "0")', () => {
      // Arrange
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      const expected = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

      // Act
      const result = toHex(bytes);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a hasher fed three chunks', () => {
    it('Then the streamed digest equals the one-shot digest of the concatenation', async () => {
      // Arrange
      const sut = new BrowserHashService('sha1');
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5]);
      const chunk3 = new Uint8Array([6, 7, 8, 9]);
      const concatenated = new Uint8Array([...chunk1, ...chunk2, ...chunk3]);
      const hasher = sut.createHasher();

      // Act
      hasher.update(chunk1);
      hasher.update(chunk2);
      hasher.update(chunk3);
      const streamed = await hasher.digestHex();
      const oneShot = await sut.hashHex(concatenated);

      // Assert
      expect(streamed).toBe(oneShot);
    });
  });

  describe('Given a chunk mutated after update() but before digest()', () => {
    it('Then the digest covers the bytes as they were at update() time', async () => {
      // Arrange
      const sut = new BrowserHashService('sha1');
      const chunk = new Uint8Array([1, 2, 3]);
      const hasher = sut.createHasher();
      hasher.update(chunk);
      chunk[0] = 99;
      const expected = await sut.hashHex(new Uint8Array([1, 2, 3]));

      // Act
      const result = await hasher.digestHex();

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a hasher fed a single chunk', () => {
    it('Then the streamed digest equals the one-shot digest', async () => {
      // Arrange
      const sut = new BrowserHashService('sha256');
      const chunk = new Uint8Array([10, 20, 30, 40]);
      const hasher = sut.createHasher();
      hasher.update(chunk);
      const expected = await sut.hashHex(new Uint8Array([10, 20, 30, 40]));

      // Act
      const result = await hasher.digestHex();

      // Assert
      expect(result).toBe(expected);
    });
  });
});

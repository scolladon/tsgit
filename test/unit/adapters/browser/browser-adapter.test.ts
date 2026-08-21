import { describe, expect, it } from 'vitest';
import { createBrowserContext } from '../../../../src/adapters/browser/browser-adapter.js';
import { BrowserCompressor } from '../../../../src/adapters/browser/browser-compressor.js';
import { BrowserFileSystem } from '../../../../src/adapters/browser/browser-file-system.js';
import { BrowserHashService } from '../../../../src/adapters/browser/browser-hash-service.js';
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

        // Assert — the default (no algorithm option) still yields sha1 (R6).
        expect(result.hash.algorithm).toBe('sha1');
        expect(result.hashConfig).toBe(SHA1_CONFIG);
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
});

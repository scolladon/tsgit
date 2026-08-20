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
        // Arrange / Act
        const sut = createBrowserContext({ rootHandle });

        // Assert — distinct class checks catch a mutant that swaps two port fields in the factory.
        expect(sut.fs).toBeInstanceOf(BrowserFileSystem);
        expect(sut.hash).toBeInstanceOf(BrowserHashService);
        expect(sut.compressor).toBeInstanceOf(BrowserCompressor);
        expect(sut.transport).toBeInstanceOf(BrowserHttpTransport);
      });

      it("Then ctx.hash.algorithm is 'sha1' and ctx.hashConfig is SHA1_CONFIG", () => {
        // Arrange / Act
        const sut = createBrowserContext({ rootHandle });

        // Assert — the default (no algorithm option) still yields sha1 (R6).
        expect(sut.hash.algorithm).toBe('sha1');
        expect(sut.hashConfig).toBe(SHA1_CONFIG);
      });
    });
  });

  describe("Given algorithm 'sha256'", () => {
    describe('When creating context', () => {
      it("Then ctx.hash.algorithm is 'sha256' and ctx.hashConfig is SHA256_CONFIG", () => {
        // Arrange / Act
        const sut = createBrowserContext({ rootHandle, algorithm: 'sha256' });

        // Assert
        expect(sut.hash.algorithm).toBe('sha256');
        expect(sut.hashConfig).toBe(SHA256_CONFIG);
      });
    });
  });
});

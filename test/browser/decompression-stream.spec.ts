/// <reference lib="dom" />
/**
 * Scenario 3 — DecompressionStream.
 *
 * Given a zlib-deflated payload produced in the browser,
 * When the browser adapter inflates it via DecompressionStream,
 * Then the unpacked bytes match the original input.
 *
 * Closes the loop on the BrowserCompressor port: deflate → inflate round-trip
 * proves both directions work against the engine's Web Streams implementation.
 */
import { expect, test } from './fixtures.js';

const PAYLOAD = 'tsgit browser decompression round-trip - '.repeat(32);

test.describe('BrowserCompressor', () => {
  test('Given a deflated payload, When inflated via DecompressionStream, Then it matches the original', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async (payload: string) => {
      type Compressor = {
        deflate: (b: Uint8Array) => Promise<Uint8Array>;
        inflate: (b: Uint8Array) => Promise<Uint8Array>;
      };
      const tsgit = (
        window as unknown as {
          __tsgit: { adapters: { BrowserCompressor: new () => Compressor } };
        }
      ).__tsgit;
      const compressor = new tsgit.adapters.BrowserCompressor();
      const input = new TextEncoder().encode(payload);
      const deflated = await compressor.deflate(input);
      const inflated = await compressor.inflate(deflated);
      return {
        originalSize: input.length,
        deflatedSize: deflated.length,
        inflatedText: new TextDecoder().decode(inflated),
      };
    }, PAYLOAD);

    expect(result.inflatedText).toBe(PAYLOAD);
    expect(result.originalSize).toBe(PAYLOAD.length);
    // Deflated should be strictly smaller for our repeated payload, proving the
    // CompressionStream actually compressed.
    expect(result.deflatedSize).toBeLessThan(result.originalSize);
  });

  test('Given a non-zlib byte stream, When inflated, Then BrowserCompressor rejects with DECOMPRESS_FAILED', async ({
    readyPage,
  }) => {
    const error = await readyPage.evaluate(async () => {
      type Compressor = { inflate: (b: Uint8Array) => Promise<Uint8Array> };
      const tsgit = (
        window as unknown as {
          __tsgit: { adapters: { BrowserCompressor: new () => Compressor } };
        }
      ).__tsgit;
      const compressor = new tsgit.adapters.BrowserCompressor();
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      try {
        await compressor.inflate(garbage);
        return { caught: false, name: 'NONE', code: undefined as string | undefined };
      } catch (err) {
        // Surface enough shape to fail loudly if a future refactor replaces
        // TsgitError with a plain Error (preserves the mutation-resistance
        // bar the project sets for typed-error assertions).
        const e = err as { name?: string; data?: { code?: string } };
        return {
          caught: true,
          name: e.name ?? '<no-name>',
          code: e.data?.code,
        };
      }
    });

    expect(error.caught).toBe(true);
    expect(error.name).toBe('TsgitError');
    expect(error.code).toBe('DECOMPRESS_FAILED');
  });
});

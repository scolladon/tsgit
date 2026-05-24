import { describe, expect, it } from 'vitest';
import { MemoryHttpTransport } from '../../../../src/adapters/memory/memory-http-transport.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { httpTransportContractTests } from '../../ports/http-transport.contract.js';

describe('MemoryHttpTransport', () => {
  httpTransportContractTests(async () => {
    const sut = new MemoryHttpTransport();
    return {
      sut,
      setupMock: (mock) => {
        sut.addMockResponse(mock);
        return mock.url;
      },
      clearMocks: () => sut.clearMocks(),
    };
  });

  describe('memory-specific behaviors', () => {
    describe('Given unregistered URL', () => {
      describe('When requesting', () => {
        it('Then throws NETWORK_ERROR with URL-echoing reason', async () => {
          // Arrange
          const sut = new MemoryHttpTransport();
          const url = 'https://example.com/unknown';

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url,
              method: 'GET',
              headers: {},
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('NETWORK_ERROR');
          expect(data.code === 'NETWORK_ERROR' && data.reason).toBe(`no mock for ${url}`);
        });
      });
    });

    describe('Given mock then clearMocks', () => {
      describe('When requesting', () => {
        it('Then throws NETWORK_ERROR', async () => {
          // Arrange
          const sut = new MemoryHttpTransport();
          sut.addMockResponse({
            method: 'GET',
            url: 'https://example.com/clear',
            response: { statusCode: 200, headers: {}, body: new Uint8Array() },
          });
          sut.clearMocks();

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url: 'https://example.com/clear',
              method: 'GET',
              headers: {},
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NETWORK_ERROR');
        });
      });
    });

    describe('Given mock response', () => {
      describe('When reading body stream', () => {
        it('Then yields seeded bytes', async () => {
          // Arrange
          const sut = new MemoryHttpTransport();
          const body = new TextEncoder().encode('hello body');
          sut.addMockResponse({
            method: 'GET',
            url: 'https://example.com/body',
            response: { statusCode: 200, headers: {}, body },
          });

          // Act
          const res = await sut.request({
            url: 'https://example.com/body',
            method: 'GET',
            headers: {},
          });
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const combined = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }

          // Assert
          expect(combined).toEqual(body);
        });
      });
    });

    describe('Given mock source buffer mutated after addMockResponse', () => {
      describe('When requesting', () => {
        it('Then response body still contains original bytes', async () => {
          // Arrange — proves addMockResponse defensively copies the body (kills the `.slice()` mutant).
          const sut = new MemoryHttpTransport();
          const originalBytes = new Uint8Array([1, 2, 3]);
          sut.addMockResponse({
            method: 'GET',
            url: 'https://example.com/defensive-add',
            response: { statusCode: 200, headers: {}, body: originalBytes },
          });
          originalBytes[0] = 99;

          // Act
          const res = await sut.request({
            url: 'https://example.com/defensive-add',
            method: 'GET',
            headers: {},
          });
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const combined = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }

          // Assert — the stored body reflects the original pre-mutation bytes.
          expect(combined).toEqual(new Uint8Array([1, 2, 3]));
        });
      });
    });

    describe('Given consecutive requests to the same mock', () => {
      describe('When mutating the raw first chunk', () => {
        it('Then second request returns pristine bytes', async () => {
          // Arrange — proves request() copies the stored body on each call (kills the `mock.body` mutant).
          // We must mutate the raw chunk returned by the ReadableStream reader — a mutation applied
          // to a post-read concatenation would mutate an independent buffer and miss the mutant.
          const sut = new MemoryHttpTransport();
          sut.addMockResponse({
            method: 'GET',
            url: 'https://example.com/defensive-get',
            response: { statusCode: 200, headers: {}, body: new Uint8Array([7, 8, 9]) },
          });
          const readFirstChunk = async (): Promise<Uint8Array> => {
            const res = await sut.request({
              url: 'https://example.com/defensive-get',
              method: 'GET',
              headers: {},
            });
            const reader = res.body.getReader();
            const { value } = await reader.read();
            // Drain remainder to release the stream.
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
            return value as Uint8Array;
          };

          // Act — mutate the raw chunk, then issue a second request
          const firstChunk = await readFirstChunk();
          firstChunk[0] = 0;
          const secondChunk = await readFirstChunk();

          // Assert — the second read returns the original bytes because request() sliced upstream.
          expect(Array.from(secondChunk)).toEqual([7, 8, 9]);
        });
      });
    });

    describe('Given method-specific mocks', () => {
      describe('When requesting wrong method', () => {
        it('Then throws NETWORK_ERROR', async () => {
          // Arrange
          const sut = new MemoryHttpTransport();
          sut.addMockResponse({
            method: 'GET',
            url: 'https://example.com/resource',
            response: { statusCode: 200, headers: {}, body: new Uint8Array() },
          });

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url: 'https://example.com/resource',
              method: 'POST',
              headers: {},
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NETWORK_ERROR');
        });
      });
    });
  });
});

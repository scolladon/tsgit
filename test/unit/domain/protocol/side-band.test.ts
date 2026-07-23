import { describe, expect, it, vi } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import type { PktLine } from '../../../../src/domain/protocol/pkt-line.js';
import { parseSideBand } from '../../../../src/domain/protocol/side-band.js';

const enc = new TextEncoder();

const dataPkt = (channel: number, body: Uint8Array): PktLine => {
  const payload = new Uint8Array(body.byteLength + 1);
  payload[0] = channel;
  payload.set(body, 1);
  return { kind: 'data', payload };
};

const flushPkt = (): PktLine => ({ kind: 'flush' });

async function* asyncOf(items: ReadonlyArray<PktLine>): AsyncIterable<PktLine> {
  for (const i of items) yield i;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

describe('parseSideBand — channel 1 (pack data)', () => {
  describe('Given two channel-1 packets', () => {
    describe('When iterated to exhaustion', () => {
      it('Then yields two Uint8Arrays containing A then B', async () => {
        // Arrange
        const a = enc.encode('AAA');
        const b = enc.encode('BBB');
        const source = asyncOf([dataPkt(1, a), dataPkt(1, b)]);

        // Act
        const sut = await collect(parseSideBand(source, {}));

        // Assert
        expect(sut).toHaveLength(2);
        expect(sut[0]).toEqual(a);
        expect(sut[1]).toEqual(b);
      });
    });
  });

  describe('Given an empty channel-1 packet', () => {
    describe('When iterated', () => {
      it('Then yields a 0-byte Uint8Array; iteration continues', async () => {
        // Arrange
        const empty = new Uint8Array(0);
        const tail = enc.encode('next');
        const source = asyncOf([dataPkt(1, empty), dataPkt(1, tail)]);

        // Act
        const sut = await collect(parseSideBand(source, {}));

        // Assert
        expect(sut).toHaveLength(2);
        expect(sut[0]?.byteLength).toBe(0);
        expect(sut[1]).toEqual(tail);
      });
    });
  });
});

describe('parseSideBand — channel 2 (progress)', () => {
  describe('Given a channel-2 packet', () => {
    describe('When iterated with onProgress callback', () => {
      it('Then onProgress called once and no Uint8Array yielded', async () => {
        // Arrange
        const onProgress = vi.fn<(text: string) => void>();
        const source = asyncOf([dataPkt(2, enc.encode('Counting...')), flushPkt()]);

        // Act
        const sut = await collect(parseSideBand(source, { onProgress }));

        // Assert
        expect(sut).toHaveLength(0);
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith('Counting...');
      });
    });
  });

  describe('Given a channel-2 packet whose body is not valid UTF-8', () => {
    describe('When iterated with onProgress callback', () => {
      it('Then onProgress receives the replacement character instead of a decode failure', async () => {
        // Arrange — 0xff is never valid UTF-8; a fatal decoder would throw TypeError
        const onProgress = vi.fn<(text: string) => void>();
        const source = asyncOf([dataPkt(2, Uint8Array.from([0xff])), flushPkt()]);

        // Act
        const sut = await collect(parseSideBand(source, { onProgress }));

        // Assert
        expect(sut).toHaveLength(0);
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith('�');
      });
    });
  });

  describe('Given an onProgress that throws', () => {
    describe('When a channel-2 packet is processed', () => {
      it('Then iteration continues normally and downstream packets are still yielded', async () => {
        // Arrange
        const onProgress = vi.fn<(text: string) => void>().mockImplementation(() => {
          throw new Error('boom');
        });
        const tail = enc.encode('after-progress');
        const source = asyncOf([dataPkt(2, enc.encode('progress')), dataPkt(1, tail)]);

        // Act
        const sut = await collect(parseSideBand(source, { onProgress }));

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]).toEqual(tail);
      });
    });
  });
});

describe('parseSideBand — channel 3 (fatal)', () => {
  describe('Given a channel-3 packet with onError callback', () => {
    describe('When iterated', () => {
      it('Then onError called once AND iteration throws SIDEBAND_FATAL', async () => {
        // Arrange
        const onError = vi.fn<(text: string) => void>();
        const source = asyncOf([dataPkt(3, enc.encode('repository not found'))]);

        // Act & Assert
        try {
          await collect(parseSideBand(source, { onError }));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'SIDEBAND_FATAL', message: 'repository not found' });
          expect(onError).toHaveBeenCalledTimes(1);
          expect(onError).toHaveBeenCalledWith('repository not found');
        }
      });
    });
  });

  describe('Given a channel-3 packet WITHOUT an onError callback', () => {
    describe('When iterated', () => {
      it('Then still throws SIDEBAND_FATAL', async () => {
        // Arrange
        const source = asyncOf([dataPkt(3, enc.encode('boom'))]);

        // Act & Assert
        try {
          await collect(parseSideBand(source, {}));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'SIDEBAND_FATAL', message: 'boom' });
        }
      });
    });
  });

  describe('Given an onError that throws', () => {
    describe('When a channel-3 packet is processed', () => {
      it('Then SIDEBAND_FATAL still propagates (NOT the callback error)', async () => {
        // Arrange
        const onError = vi.fn<(text: string) => void>().mockImplementation(() => {
          throw new Error('callback boom');
        });
        const source = asyncOf([dataPkt(3, enc.encode('fatal-msg'))]);

        // Act & Assert
        try {
          await collect(parseSideBand(source, { onError }));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'SIDEBAND_FATAL', message: 'fatal-msg' });
        }
      });
    });
  });
});

describe('parseSideBand — invalid channel', () => {
  describe('Given a packet with an invalid channel byte', () => {
    describe('When iterated', () => {
      it.each([
        {
          channel: -1,
          buildSource: () => asyncOf([{ kind: 'data', payload: new Uint8Array(0) } as PktLine]),
          label: 'a 0-byte data packet (no channel byte) throws with channel=-1',
        },
        {
          channel: 4,
          buildSource: () => asyncOf([dataPkt(4, enc.encode('???'))]),
          label: 'a channel-4 packet throws with channel=4',
        },
        {
          channel: 0,
          buildSource: () => asyncOf([dataPkt(0, enc.encode('???'))]),
          label: 'a channel-0 packet throws with channel=0',
        },
      ])('Then $label', async ({ channel, buildSource }) => {
        // Arrange
        const source = buildSource();

        // Act & Assert
        try {
          await collect(parseSideBand(source, {}));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'INVALID_SIDEBAND_CHANNEL', channel });
        }
      });
    });
  });
});

describe('parseSideBand — flush handling', () => {
  describe('Given only a flush packet', () => {
    describe('When iterated', () => {
      it('Then iteration ends naturally with zero yields and no error', async () => {
        // Arrange
        const source = asyncOf([flushPkt()]);

        // Act
        const sut = await collect(parseSideBand(source, {}));

        // Assert
        expect(sut).toHaveLength(0);
      });
    });
  });

  describe('Given [channel-1 A, flush, channel-1 B]', () => {
    describe('When iterated', () => {
      it('Then yields A only and stops at flush (B never reached)', async () => {
        // Arrange
        const a = enc.encode('A');
        const b = enc.encode('B');
        const source = asyncOf([dataPkt(1, a), flushPkt(), dataPkt(1, b)]);

        // Act
        const sut = await collect(parseSideBand(source, {}));

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]).toEqual(a);
      });
    });
  });
});

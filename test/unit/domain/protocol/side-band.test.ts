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
  it('Given two channel-1 packets, When iterated to exhaustion, Then yields two Uint8Arrays containing A then B', async () => {
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

  it('Given an empty channel-1 packet, When iterated, Then yields a 0-byte Uint8Array; iteration continues', async () => {
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

describe('parseSideBand — channel 2 (progress)', () => {
  it('Given a channel-2 packet, When iterated with onProgress callback, Then onProgress called once and no Uint8Array yielded', async () => {
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

  it('Given an onProgress that throws, When a channel-2 packet is processed, Then iteration continues normally and downstream packets are still yielded', async () => {
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

describe('parseSideBand — channel 3 (fatal)', () => {
  it('Given a channel-3 packet with onError callback, When iterated, Then onError called once AND iteration throws SIDEBAND_FATAL', async () => {
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

  it('Given a channel-3 packet WITHOUT an onError callback, When iterated, Then still throws SIDEBAND_FATAL', async () => {
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

  it('Given an onError that throws, When a channel-3 packet is processed, Then SIDEBAND_FATAL still propagates (NOT the callback error)', async () => {
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

describe('parseSideBand — empty data packet', () => {
  it('Given a 0-byte data packet (no channel byte), When iterated, Then throws INVALID_SIDEBAND_CHANNEL with channel=-1', async () => {
    // Arrange
    const empty: PktLine = { kind: 'data', payload: new Uint8Array(0) };
    const source = asyncOf([empty]);

    // Act & Assert
    try {
      await collect(parseSideBand(source, {}));
      throw new Error('expected throw');
    } catch (err) {
      // Assert
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'INVALID_SIDEBAND_CHANNEL', channel: -1 });
    }
  });
});

describe('parseSideBand — invalid channels', () => {
  it('Given a channel-4 packet, When iterated, Then throws INVALID_SIDEBAND_CHANNEL with channel=4', async () => {
    // Arrange
    const source = asyncOf([dataPkt(4, enc.encode('???'))]);

    // Act & Assert
    try {
      await collect(parseSideBand(source, {}));
      throw new Error('expected throw');
    } catch (err) {
      // Assert
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'INVALID_SIDEBAND_CHANNEL', channel: 4 });
    }
  });

  it('Given a channel-0 packet, When iterated, Then throws INVALID_SIDEBAND_CHANNEL with channel=0', async () => {
    // Arrange
    const source = asyncOf([dataPkt(0, enc.encode('???'))]);

    // Act & Assert
    try {
      await collect(parseSideBand(source, {}));
      throw new Error('expected throw');
    } catch (err) {
      // Assert
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'INVALID_SIDEBAND_CHANNEL', channel: 0 });
    }
  });
});

describe('parseSideBand — flush handling', () => {
  it('Given only a flush packet, When iterated, Then iteration ends naturally with zero yields and no error', async () => {
    // Arrange
    const source = asyncOf([flushPkt()]);

    // Act
    const sut = await collect(parseSideBand(source, {}));

    // Assert
    expect(sut).toHaveLength(0);
  });

  it('Given [channel-1 A, flush, channel-1 B], When iterated, Then yields A only and stops at flush (B never reached)', async () => {
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

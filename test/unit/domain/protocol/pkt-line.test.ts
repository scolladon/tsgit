import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  DELIM_PKT,
  decodePktStream,
  encodePktLine,
  encodePktLines,
  encodePktStream,
  FLUSH_PKT,
  MAX_PKT_LINE_PAYLOAD,
  type PktLine,
  RESPONSE_END_PKT,
} from '../../../../src/domain/protocol/pkt-line.js';

const enc = new TextEncoder();

const bytesOf = (s: string): Uint8Array => enc.encode(s);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

async function* asyncOf(chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

async function collect(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const out: PktLine[] = [];
  for await (const pkt of source) out.push(pkt);
  return out;
}

describe('encodePktLine', () => {
  describe('Given an empty payload', () => {
    describe('When encodePktLine', () => {
      it('Then result equals bytesOf("0004")', () => {
        // Arrange
        const payload = new Uint8Array(0);

        // Act
        const result = encodePktLine(payload);

        // Assert
        expect(result).toEqual(bytesOf('0004'));
      });
    });
  });

  describe('Given a 1-byte payload', () => {
    describe('When encodePktLine', () => {
      it('Then result equals "0005A"', () => {
        // Arrange
        const payload = bytesOf('A');

        // Act
        const result = encodePktLine(payload);

        // Assert
        expect(result).toEqual(bytesOf('0005A'));
      });
    });
  });

  describe('Given a payload of MAX_PKT_LINE_PAYLOAD bytes', () => {
    describe('When encodePktLine', () => {
      it('Then byte length equals MAX + 4', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);

        // Act
        const result = encodePktLine(payload);

        // Assert
        expect(result.byteLength).toBe(MAX_PKT_LINE_PAYLOAD + 4);
      });
    });
  });

  describe('Given MAX_PKT_LINE_PAYLOAD bytes', () => {
    describe('When encodePktLine', () => {
      it('Then first 4 bytes equal "fff0"', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);

        // Act
        const result = encodePktLine(payload);

        // Assert
        expect(result.slice(0, 4)).toEqual(bytesOf('fff0'));
      });
    });
  });

  describe('Given MAX_PKT_LINE_PAYLOAD - 1 bytes', () => {
    describe('When encodePktLine', () => {
      it('Then first 4 bytes equal "ffef"', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD - 1);

        // Act
        const result = encodePktLine(payload);

        // Assert
        expect(result.slice(0, 4)).toEqual(bytesOf('ffef'));
      });
    });
  });

  describe('Given MAX_PKT_LINE_PAYLOAD + 1 bytes', () => {
    describe('When encodePktLine', () => {
      it('Then it throws RangeError with the exact documented message', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 1);
        const expected = `pkt-line: payload too large (${MAX_PKT_LINE_PAYLOAD + 1} > ${MAX_PKT_LINE_PAYLOAD})`;

        // Act & Assert
        try {
          encodePktLine(payload);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(RangeError);
          expect((err as RangeError).message).toBe(expected);
        }
      });
    });
  });
});

describe('encodePktStream', () => {
  describe('Given a list of payloads', () => {
    describe('When encodePktStream', () => {
      it.each([
        {
          payloads: [] as ReadonlyArray<Uint8Array>,
          expected: bytesOf('0000'),
          label: 'result equals just the trailing flush "0000" for an empty array',
        },
        {
          payloads: [bytesOf('foo')],
          expected: bytesOf('0007foo0000'),
          label: 'result equals "0007foo0000" for a single "foo" payload',
        },
        {
          payloads: [bytesOf('alpha'), bytesOf('beta'), bytesOf('gamma')],
          expected: concat(
            encodePktLine(bytesOf('alpha')),
            encodePktLine(bytesOf('beta')),
            encodePktLine(bytesOf('gamma')),
            bytesOf('0000'),
          ),
          label: 'result equals concat(encodePktLine each, FLUSH) for three payloads',
        },
      ])('Then $label', ({ payloads, expected }) => {
        // Arrange & Act
        const result = encodePktStream(payloads);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given two 1-KB payloads', () => {
    describe('When encodePktStream', () => {
      it('Then byte length equals (p1+4) + (p2+4) + 4', () => {
        // Arrange
        const p1 = new Uint8Array(1024);
        const p2 = new Uint8Array(1024);

        // Act
        const result = encodePktStream([p1, p2]);

        // Assert
        expect(result.byteLength).toBe(p1.byteLength + 4 + p2.byteLength + 4 + 4);
      });
    });
  });

  describe('Given a payload of exactly MAX_PKT_LINE_PAYLOAD bytes in the stream', () => {
    describe('When encodePktStream', () => {
      it('Then it does NOT throw', () => {
        // Arrange — exact-boundary payload must be accepted; kills the `>=` mutant
        // on the `p.byteLength > MAX_PKT_LINE_PAYLOAD` guard.
        const atMax = new Uint8Array(MAX_PKT_LINE_PAYLOAD);

        // Act
        const result = encodePktStream([atMax]);

        // Assert — header(4) + payload + trailing flush(4)
        expect(result.byteLength).toBe(MAX_PKT_LINE_PAYLOAD + 4 + 4);
      });
    });
  });

  describe('Given a payload above MAX_PKT_LINE_PAYLOAD in the stream', () => {
    describe('When encodePktStream', () => {
      it('Then throws RangeError with the exact documented message', () => {
        // Arrange
        const tooBig = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 1);
        const expected = `pkt-line: payload too large (${MAX_PKT_LINE_PAYLOAD + 1} > ${MAX_PKT_LINE_PAYLOAD})`;

        // Act & Assert
        try {
          encodePktStream([tooBig]);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(RangeError);
          expect((err as RangeError).message).toBe(expected);
        }
      });
    });
  });
});

describe('encodePktLines', () => {
  describe('Given a list of payloads', () => {
    describe('When encodePktLines', () => {
      it.each([
        {
          payloads: [] as ReadonlyArray<Uint8Array>,
          expected: new Uint8Array(0),
          label: 'result is empty (no trailing flush) for an empty array',
        },
        {
          payloads: [bytesOf('foo')],
          expected: bytesOf('0007foo'),
          label: 'result equals "0007foo" with no trailing flush for a single "foo" payload',
        },
        {
          payloads: [bytesOf('alpha'), bytesOf('beta'), bytesOf('gamma')],
          expected: concat(
            encodePktLine(bytesOf('alpha')),
            encodePktLine(bytesOf('beta')),
            encodePktLine(bytesOf('gamma')),
          ),
          label: 'result equals concat(encodePktLine each) with no flush for three payloads',
        },
      ])('Then $label', ({ payloads, expected }) => {
        // Arrange & Act
        const result = encodePktLines(payloads);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a payload of exactly MAX_PKT_LINE_PAYLOAD bytes', () => {
    describe('When encodePktLines', () => {
      it('Then it does NOT throw', () => {
        // Arrange — exact-boundary payload must be accepted; kills the `>=`
        // mutant on the `p.byteLength > MAX_PKT_LINE_PAYLOAD` guard.
        const atMax = new Uint8Array(MAX_PKT_LINE_PAYLOAD);

        // Act
        const result = encodePktLines([atMax]);

        // Assert — header(4) + payload, no trailing flush
        expect(result.byteLength).toBe(MAX_PKT_LINE_PAYLOAD + 4);
      });
    });
  });

  describe('Given a payload above MAX_PKT_LINE_PAYLOAD', () => {
    describe('When encodePktLines', () => {
      it('Then throws RangeError with the exact documented message', () => {
        // Arrange
        const tooBig = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 1);
        const expected = `pkt-line: payload too large (${MAX_PKT_LINE_PAYLOAD + 1} > ${MAX_PKT_LINE_PAYLOAD})`;

        // Act & Assert
        try {
          encodePktLines([tooBig]);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(RangeError);
          expect((err as RangeError).message).toBe(expected);
        }
      });
    });
  });
});

describe('FLUSH_PKT / DELIM_PKT / RESPONSE_END_PKT constants', () => {
  describe('Given FLUSH_PKT', () => {
    describe('When inspected', () => {
      it('Then equals bytesOf("0000")', () => {
        // Arrange + Assert
        expect(FLUSH_PKT).toEqual(bytesOf('0000'));
      });
    });
  });

  describe('Given DELIM_PKT', () => {
    describe('When inspected', () => {
      it('Then equals bytesOf("0001")', () => {
        // Arrange + Assert
        expect(DELIM_PKT).toEqual(bytesOf('0001'));
      });
    });
  });

  describe('Given RESPONSE_END_PKT', () => {
    describe('When inspected', () => {
      it('Then equals bytesOf("0002")', () => {
        // Arrange + Assert
        expect(RESPONSE_END_PKT).toEqual(bytesOf('0002'));
      });
    });
  });
});

describe('decodePktStream — basic packets', () => {
  describe('Given the chunk "0000"', () => {
    describe('When decoded', () => {
      it('Then yields one flush', async () => {
        // Arrange
        const chunks = [bytesOf('0000')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(result).toEqual([{ kind: 'flush' }]);
      });
    });
  });

  describe('Given "0001" with v2:false', () => {
    describe('When decoded', () => {
      it('Then throws PKT_LENGTH_RESERVED with value=1', async () => {
        // Arrange
        const chunks = [bytesOf('0001')];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_LENGTH_RESERVED', value: 1 });
        }
      });
    });
  });

  describe('Given "0001" with v2:true', () => {
    describe('When decoded', () => {
      it('Then yields one delim', async () => {
        // Arrange
        const chunks = [bytesOf('0001')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks), { v2: true }));

        // Assert
        expect(result).toEqual([{ kind: 'delim' }]);
      });
    });
  });

  describe('Given "0002" with v2:false', () => {
    describe('When decoded', () => {
      it('Then throws PKT_LENGTH_RESERVED with value=2', async () => {
        // Arrange
        const chunks = [bytesOf('0002')];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_LENGTH_RESERVED', value: 2 });
        }
      });
    });
  });

  describe('Given "0002" with v2:true', () => {
    describe('When decoded', () => {
      it('Then yields one response-end', async () => {
        // Arrange
        const chunks = [bytesOf('0002')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks), { v2: true }));

        // Assert
        expect(result).toEqual([{ kind: 'response-end' }]);
      });
    });
  });

  describe('Given "0003" regardless of v2', () => {
    describe('When decoded', () => {
      it('Then throws PKT_LENGTH_RESERVED with value=3', async () => {
        // Arrange
        const chunks = [bytesOf('0003')];

        // Act & Assert
        for (const v2 of [false, true]) {
          try {
            await collect(decodePktStream(asyncOf(chunks), { v2 }));
            throw new Error('expected throw');
          } catch (err) {
            // Assert
            expect(err).toBeInstanceOf(TsgitError);
            const te = err as TsgitError;
            expect(te.data).toEqual({ code: 'PKT_LENGTH_RESERVED', value: 3 });
          }
        }
      });
    });
  });

  describe('Given "00040000"', () => {
    describe('When decoded', () => {
      it('Then yields { data, payload: 0 } then flush', async () => {
        // Arrange
        const chunks = [bytesOf('00040000')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(result).toEqual([{ kind: 'data', payload: new Uint8Array(0) }, { kind: 'flush' }]);
      });
    });
  });

  describe('Given "0009done\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields one data with payload "done\\n"', async () => {
        // Arrange
        const chunks = [bytesOf('0009done\n')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ kind: 'data', payload: bytesOf('done\n') });
      });
    });
  });
});

describe('decodePktStream — reassembly', () => {
  describe('Given chunks "00", "09do", "ne\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields one data with payload "done\\n"', async () => {
        // Arrange
        const chunks = [bytesOf('00'), bytesOf('09do'), bytesOf('ne\n')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(result).toEqual([{ kind: 'data', payload: bytesOf('done\n') }]);
      });
    });
  });

  describe('Given chunks "000f0123456" + "789\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields data "0123456789\\n"', async () => {
        // Arrange — header "000f" (length 15 = 4 prefix + 11 payload)
        const chunks = [bytesOf('000f0123456'), bytesOf('789\n')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(result).toEqual([{ kind: 'data', payload: bytesOf('0123456789\n') }]);
      });
    });
  });

  describe('Given two packets in one chunk "0006A\\\\n0006B\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields two data entries in order', async () => {
        // Arrange
        const chunks = [bytesOf('0006A\n0006B\n')];

        // Act
        const result = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(result).toEqual([
          { kind: 'data', payload: bytesOf('A\n') },
          { kind: 'data', payload: bytesOf('B\n') },
        ]);
      });
    });
  });
});

describe('decodePktStream — length boundary triple', () => {
  describe('Given length=0xfff0 (max)', () => {
    describe('When decoded', () => {
      it('Then yields data of length MAX_PKT_LINE_PAYLOAD', async () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);
        const chunk = encodePktLine(payload);

        // Act
        const result = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.kind).toBe('data');
        if (result[0]?.kind === 'data') {
          expect(result[0].payload.byteLength).toBe(MAX_PKT_LINE_PAYLOAD);
        }
      });
    });
  });

  describe('Given length=0xfff1 (just over max)', () => {
    describe('When decoded', () => {
      it('Then throws PKT_TOO_LARGE with value=0xfff1', async () => {
        // Arrange — encode the over-cap header manually with placeholder body bytes
        const headerBytes = bytesOf('fff1');
        const body = new Uint8Array(0xfff1 - 4); // unused — parser must throw before reading body
        const chunk = concat(headerBytes, body);

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf([chunk])));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_TOO_LARGE', value: 0xfff1 });
        }
      });
    });
  });

  describe('Given length=0xffef (just under max)', () => {
    describe('When decoded', () => {
      it('Then yields data of length MAX-1', async () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD - 1);
        const chunk = encodePktLine(payload);

        // Act
        const result = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.kind).toBe('data');
        if (result[0]?.kind === 'data') {
          expect(result[0].payload.byteLength).toBe(MAX_PKT_LINE_PAYLOAD - 1);
        }
      });
    });
  });
});

describe('decodePktStream — truncation', () => {
  describe('Given chunk "00" then EOF', () => {
    describe('When decoded', () => {
      it('Then throws PKT_TRUNCATED with remaining=2', async () => {
        // Arrange
        const chunks = [bytesOf('00')];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_TRUNCATED', remaining: 2 });
        }
      });
    });
  });

  describe('Given chunk "0009do" then EOF', () => {
    describe('When decoded', () => {
      it('Then throws PKT_TRUNCATED with remaining=6', async () => {
        // Arrange
        const chunks = [bytesOf('0009do')];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_TRUNCATED', remaining: 6 });
        }
      });
    });
  });
});

describe('decodePktStream — invalid length', () => {
  describe('Given chunk "xxxx"', () => {
    describe('When decoded', () => {
      it('Then throws INVALID_PKT_LENGTH with value="xxxx"', async () => {
        // Arrange
        const chunks = [bytesOf('xxxx')];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'INVALID_PKT_LENGTH', value: 'xxxx' });
        }
      });
    });
  });

  describe('Given chunk "0g00"', () => {
    describe('When decoded', () => {
      it('Then throws INVALID_PKT_LENGTH with value="0g00"', async () => {
        // Arrange
        const chunks = [bytesOf('0g00')];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'INVALID_PKT_LENGTH', value: '0g00' });
        }
      });
    });
  });
});

describe('decodePktStream — non-UTF-8 length header', () => {
  describe('Given a 4-byte header that is not valid UTF-8', () => {
    describe('When decoded', () => {
      it('Then throws INVALID_PKT_LENGTH carrying four replacement characters', async () => {
        // Arrange — 0xff is never valid UTF-8; a fatal decoder would throw
        // TypeError instead of surfacing the protocol error
        const chunks = [Uint8Array.from([0xff, 0xff, 0xff, 0xff])];

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf(chunks)));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'INVALID_PKT_LENGTH', value: '�'.repeat(4) });
        }
      });
    });
  });
});

describe('decodePktStream — DoS resistance', () => {
  describe('Given a giant chunk whose first 4 bytes are "gggg"', () => {
    describe('When decoded', () => {
      it('Then throws INVALID_PKT_LENGTH (parse runs first)', async () => {
        // Arrange
        const giant = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 100);
        giant.set(bytesOf('gggg'), 0);

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf([giant])));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('INVALID_PKT_LENGTH');
        }
      });
    });
  });

  describe('Given a giant chunk whose first 4 bytes are "fff5" (length 65525, exceeds max)', () => {
    describe('When decoded', () => {
      it('Then throws PKT_TOO_LARGE with value=0xfff5', async () => {
        // Arrange
        const giant = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 100);
        giant.set(bytesOf('fff5'), 0);

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf([giant])));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_TOO_LARGE', value: 0xfff5 });
        }
      });
    });
  });
});

describe('decodePktStream — chunk size independence (HTTP stream coalescing)', () => {
  describe('Given a single delivered chunk larger than the old fixed accumulator, containing only well-formed small pkt-lines', () => {
    describe('When decoded', () => {
      it('Then every pkt-line parses (delivered chunk size no longer bounds a single accept)', async () => {
        // Arrange — Node stream coalescing (highWaterMark 64 KiB) can deliver
        // this shape on real HTTP clone/fetch of a moderately large repo.
        const payloads = Array.from({ length: 100 }, (_, i) => new Uint8Array(700).fill(i % 256));
        const chunk = encodePktStream(payloads);

        // Act
        const result = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(chunk.byteLength).toBeGreaterThan(MAX_PKT_LINE_PAYLOAD + 4);
        expect(result).toEqual([
          ...payloads.map((payload) => ({ kind: 'data', payload })),
          { kind: 'flush' },
        ]);
      });
    });
  });

  describe('Given a chunk boundary that falls exactly at the old accumulator cap, mid pkt-line', () => {
    describe('When decoded', () => {
      it('Then both the filler and the straddling pkt-line parse', async () => {
        // Arrange — the filler frame occupies bytes [0, 65500); the straddle
        // frame spans [65500, 65604), so splitting at byte 65520 (the old
        // fixed accumulator size) lands inside the straddling frame's body.
        const oldAccumulatorCap = MAX_PKT_LINE_PAYLOAD + 4;
        const fillerPayload = new Uint8Array(65496);
        const straddlePayload = bytesOf('x'.repeat(100));
        const whole = encodePktLines([fillerPayload, straddlePayload]);
        const chunk1 = whole.slice(0, oldAccumulatorCap);
        const chunk2 = whole.slice(oldAccumulatorCap);

        // Act
        const result = await collect(decodePktStream(asyncOf([chunk1, chunk2])));

        // Assert
        expect(chunk1.byteLength).toBe(oldAccumulatorCap);
        expect(result).toEqual([
          { kind: 'data', payload: fillerPayload },
          { kind: 'data', payload: straddlePayload },
        ]);
      });
    });
  });
});

describe('decodePktStream — declared length vs delivered chunk size', () => {
  describe('Given a 2-byte partial header then an over-capacity chunk completing a declared length that exceeds the format max', () => {
    describe('When decoded', () => {
      it('Then throws PKT_TOO_LARGE with the declared value, regardless of delivered chunk size', async () => {
        // Arrange — chunk1 buffers 2 header bytes ("ff"); chunk2 supplies the
        // remaining 2 ("f1", declaring 0xfff1 > MAX_PKT_LINE_PAYLOAD + 4) plus
        // padding — refusal must key off the DECLARED length, never off how
        // much the delivered chunk itself contains.
        const chunk1 = bytesOf('ff');
        const overflow = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 100);
        overflow.set(bytesOf('f1'), 0);

        // Act & Assert
        try {
          await collect(decodePktStream(asyncOf([chunk1, overflow])));
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'PKT_TOO_LARGE', value: 0xfff1 });
        }
      });
    });
  });

  describe('Given a 2-byte partial header then an over-capacity chunk completing a small declared length plus a further well-formed frame', () => {
    describe('When decoded', () => {
      it('Then both pkt-lines parse — the incomplete tail never accumulates beyond one frame', async () => {
        // Arrange — chunk1 buffers 2 header bytes ("00"); chunk2 alone is
        // larger than the old fixed accumulator (used(2) + chunk2.length >
        // old cap) yet carries only the 2 remaining header bytes ("04", an
        // empty-payload pkt) followed by one further well-formed max-size
        // pkt-line. The carried tail is bounded by one frame, never by
        // delivered chunk size.
        const chunk1 = bytesOf('00');
        const maxPayload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);
        const chunk2 = concat(bytesOf('04'), encodePktLine(maxPayload));

        // Act
        const result = await collect(decodePktStream(asyncOf([chunk1, chunk2])));

        // Assert
        expect(chunk1.byteLength + chunk2.byteLength).toBeGreaterThan(MAX_PKT_LINE_PAYLOAD + 4);
        expect(result).toEqual([
          { kind: 'data', payload: new Uint8Array(0) },
          { kind: 'data', payload: maxPayload },
        ]);
      });
    });
  });
});

describe('decodePktStream — case-insensitive length parse', () => {
  describe('Given the chunk "000A" + 6 bytes payload', () => {
    describe('When decoded', () => {
      it('Then yields data of length 6', async () => {
        // Arrange — uppercase length prefix per spec ("accept either case")
        const chunk = concat(bytesOf('000A'), bytesOf('abcdef'));

        // Act
        const result = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ kind: 'data', payload: bytesOf('abcdef') });
      });
    });
  });
});

async function* asyncByteDrip(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.byteLength; i += 1) {
    yield bytes.subarray(i, i + 1);
  }
}

describe('decodePktStream — linear-time accumulation (byte-drip)', () => {
  describe('Given a maximal-size pkt-line delivered one byte at a time', () => {
    describe('When the bytes copied into the internal accumulator are counted', () => {
      it('Then total copied bytes scale with size, not size squared', async () => {
        // Arrange — a naive concat-then-slice accumulator copies the ENTIRE
        // pending tail on every delivered byte (`Uint8Array.prototype.set`
        // is the primitive both that and this accumulator copy through),
        // so byte-dripping an n-byte frame costs O(n²) total copied bytes —
        // for n = MAX_PKT_LINE_PAYLOAD that's ~65 520 vs ~4.3 BILLION.
        // Counting the actual work sidesteps wall-clock timing entirely —
        // a duration-based assertion is provably unreliable here: measured
        // under a fully-loaded CI run (every other suite's coverage
        // instrumentation competing for the same cores), a wall-clock
        // ratio between two sizes swung far past a ceiling that looked
        // generous in isolation. Byte-counting has no such dependency on
        // ambient system load.
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);
        const frame = encodePktLine(payload);
        let bytesCopied = 0;
        const originalSet = Uint8Array.prototype.set;
        const patchedSet = function patchedSet(
          this: Uint8Array,
          source: ArrayLike<number>,
          offset?: number,
        ): void {
          bytesCopied += source.length;
          originalSet.call(this, source, offset);
        };
        Uint8Array.prototype.set = patchedSet;

        // Act
        let result: PktLine[];
        try {
          result = await collect(decodePktStream(asyncByteDrip(frame)));
        } finally {
          Uint8Array.prototype.set = originalSet;
        }

        // Assert — 10x the frame size stays far above ANY plausible linear
        // constant factor, yet is dwarfed by the quadratic byte count.
        expect(result).toHaveLength(1);
        expect(bytesCopied).toBeLessThan(frame.byteLength * 10);
      });
    });
  });
});

describe('decodePktStream — buffer-ownership safety', () => {
  describe('Given a source that reuses one backing buffer across every yielded chunk', () => {
    describe('When decoded', () => {
      it('Then every payload decodes independently — later reuse of the source buffer does not corrupt an earlier payload', async () => {
        // Arrange — `Buffer.prototype.slice` (Node's `Uint8Array` subclass)
        // ALIASES its source instead of copying; a zero-copy stream source
        // that recycles one backing buffer per delivery (e.g. a Node
        // `Readable` in non-flowing mode) would otherwise silently corrupt
        // an already-yielded payload once the source overwrites the shared
        // buffer for its next chunk.
        const first = encodePktLine(bytesOf('first-payload'));
        const second = encodePktLine(bytesOf('second-payload'));
        const shared = Buffer.alloc(Math.max(first.byteLength, second.byteLength));

        async function* reusedBufferSource(): AsyncIterable<Uint8Array> {
          shared.set(first, 0);
          yield shared.subarray(0, first.byteLength);
          // Overwrite the SAME backing buffer before the consumer has had
          // any further chance to copy — a `.slice()`-based payload would
          // now read back as (part of) `second-payload`.
          shared.fill(0);
          shared.set(second, 0);
          yield shared.subarray(0, second.byteLength);
        }

        // Act
        const result = await collect(decodePktStream(reusedBufferSource()));

        // Assert
        expect(result).toEqual([
          { kind: 'data', payload: bytesOf('first-payload') },
          { kind: 'data', payload: bytesOf('second-payload') },
        ]);
      });
    });
  });
});

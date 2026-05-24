import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  DELIM_PKT,
  decodePktStream,
  encodePktLine,
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
        const sut = encodePktLine(payload);

        // Assert
        expect(sut).toEqual(bytesOf('0004'));
      });
    });
  });

  describe('Given a 1-byte payload', () => {
    describe('When encodePktLine', () => {
      it('Then result equals "0005A"', () => {
        // Arrange
        const payload = bytesOf('A');

        // Act
        const sut = encodePktLine(payload);

        // Assert
        expect(sut).toEqual(bytesOf('0005A'));
      });
    });
  });

  describe('Given a payload of MAX_PKT_LINE_PAYLOAD bytes', () => {
    describe('When encodePktLine', () => {
      it('Then byte length equals MAX + 4', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);

        // Act
        const sut = encodePktLine(payload);

        // Assert
        expect(sut.byteLength).toBe(MAX_PKT_LINE_PAYLOAD + 4);
      });
    });
  });

  describe('Given MAX_PKT_LINE_PAYLOAD bytes', () => {
    describe('When encodePktLine', () => {
      it('Then first 4 bytes equal "fff0"', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD);

        // Act
        const sut = encodePktLine(payload);

        // Assert
        expect(sut.slice(0, 4)).toEqual(bytesOf('fff0'));
      });
    });
  });

  describe('Given MAX_PKT_LINE_PAYLOAD - 1 bytes', () => {
    describe('When encodePktLine', () => {
      it('Then first 4 bytes equal "ffef"', () => {
        // Arrange
        const payload = new Uint8Array(MAX_PKT_LINE_PAYLOAD - 1);

        // Act
        const sut = encodePktLine(payload);

        // Assert
        expect(sut.slice(0, 4)).toEqual(bytesOf('ffef'));
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
  describe('Given an empty array', () => {
    describe('When encodePktStream', () => {
      it('Then result equals just the trailing flush "0000"', () => {
        // Arrange
        const payloads: ReadonlyArray<Uint8Array> = [];

        // Act
        const sut = encodePktStream(payloads);

        // Assert
        expect(sut).toEqual(bytesOf('0000'));
      });
    });
  });

  describe('Given a single "foo" payload', () => {
    describe('When encodePktStream', () => {
      it('Then result equals "0007foo0000"', () => {
        // Arrange
        const payloads = [bytesOf('foo')];

        // Act
        const sut = encodePktStream(payloads);

        // Assert
        expect(sut).toEqual(bytesOf('0007foo0000'));
      });
    });
  });

  describe('Given three payloads', () => {
    describe('When encodePktStream', () => {
      it('Then result equals concat(encodePktLine each, FLUSH)', () => {
        // Arrange
        const a = bytesOf('alpha');
        const b = bytesOf('beta');
        const c = bytesOf('gamma');

        // Act
        const sut = encodePktStream([a, b, c]);

        // Assert
        expect(sut).toEqual(
          concat(encodePktLine(a), encodePktLine(b), encodePktLine(c), bytesOf('0000')),
        );
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
        const sut = encodePktStream([p1, p2]);

        // Assert
        expect(sut.byteLength).toBe(p1.byteLength + 4 + p2.byteLength + 4 + 4);
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
        const sut = encodePktStream([atMax]);

        // Assert — header(4) + payload + trailing flush(4)
        expect(sut.byteLength).toBe(MAX_PKT_LINE_PAYLOAD + 4 + 4);
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
        const sut = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(sut).toEqual([{ kind: 'flush' }]);
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
        const sut = await collect(decodePktStream(asyncOf(chunks), { v2: true }));

        // Assert
        expect(sut).toEqual([{ kind: 'delim' }]);
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
        const sut = await collect(decodePktStream(asyncOf(chunks), { v2: true }));

        // Assert
        expect(sut).toEqual([{ kind: 'response-end' }]);
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
        const sut = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(sut).toEqual([{ kind: 'data', payload: new Uint8Array(0) }, { kind: 'flush' }]);
      });
    });
  });

  describe('Given "0009done\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields one data with payload "done\\n"', async () => {
        // Arrange
        const chunks = [bytesOf('0009done\n')];

        // Act
        const sut = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]).toEqual({ kind: 'data', payload: bytesOf('done\n') });
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
        const sut = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(sut).toEqual([{ kind: 'data', payload: bytesOf('done\n') }]);
      });
    });
  });

  describe('Given chunks "000f0123456" + "789\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields data "0123456789\\n"', async () => {
        // Arrange — header "000f" (length 15 = 4 prefix + 11 payload)
        const chunks = [bytesOf('000f0123456'), bytesOf('789\n')];

        // Act
        const sut = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(sut).toEqual([{ kind: 'data', payload: bytesOf('0123456789\n') }]);
      });
    });
  });

  describe('Given two packets in one chunk "0006A\\\\n0006B\\\\n"', () => {
    describe('When decoded', () => {
      it('Then yields two data entries in order', async () => {
        // Arrange
        const chunks = [bytesOf('0006A\n0006B\n')];

        // Act
        const sut = await collect(decodePktStream(asyncOf(chunks)));

        // Assert
        expect(sut).toEqual([
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
        const sut = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.kind).toBe('data');
        if (sut[0]?.kind === 'data') {
          expect(sut[0].payload.byteLength).toBe(MAX_PKT_LINE_PAYLOAD);
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
        const sut = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.kind).toBe('data');
        if (sut[0]?.kind === 'data') {
          expect(sut[0].payload.byteLength).toBe(MAX_PKT_LINE_PAYLOAD - 1);
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

describe('decodePktStream — partial-header then capacity overflow', () => {
  describe('Given a 2-byte partial header then an over-capacity chunk completing a valid length', () => {
    describe('When decoded', () => {
      it('Then PKT_TOO_LARGE value equals the 4-byte header count', () => {
        // Arrange — chunk1 buffers 2 header bytes ("00"); chunk2 overflows ACC_CAPACITY
        // and supplies the remaining 2 header bytes ("04") so the full header "0004"
        // parses to a valid length, reaching `throw pktTooLarge(this.used)`.
        // headerNeeded = MAX(0, 4 - 2) = 2 → used = 2 + 2 = 4.
        // The L119 `-`→`+` mutant makes headerNeeded = 4 + 2 = 6 → used = 8.
        // The L122 `+=`→`-=` mutant makes used = 2 - 2 = 0.
        const chunk1 = bytesOf('00');
        const overflow = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 100); // > ACC_CAPACITY - 2
        overflow.set(bytesOf('04'), 0);

        // Act & Assert
        return collect(decodePktStream(asyncOf([chunk1, overflow]))).then(
          () => {
            throw new Error('expected throw');
          },
          (err) => {
            // Assert
            expect(err).toBeInstanceOf(TsgitError);
            const te = err as TsgitError;
            expect(te.data).toEqual({ code: 'PKT_TOO_LARGE', value: 4 });
          },
        );
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
        const sut = await collect(decodePktStream(asyncOf([chunk])));

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]).toEqual({ kind: 'data', payload: bytesOf('abcdef') });
      });
    });
  });
});

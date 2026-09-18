import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';

import { decodePktStream, type PktLine } from '../../../../src/domain/protocol/pkt-line.js';
import { parseReceivePackResponse } from '../../../../src/domain/protocol/receive-pack.js';
import { buildReceivePackResponseBody } from '../../../fixtures/transport/builders.js';

async function* asyncBytes(parts: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

const enc = new TextEncoder();

const decodeAll = async (bytes: Uint8Array): Promise<AsyncIterable<PktLine>> =>
  decodePktStream(asyncBytes([bytes]));

describe('receive-pack integration — success', () => {
  describe('Given unpack ok and one ok ref', () => {
    describe('When parsed end-to-end', () => {
      it('Then unpackOk true and refUpdates accepted', async () => {
        // Arrange
        const body = buildReceivePackResponseBody({
          unpackResult: 'ok',
          refResults: [{ name: 'refs/heads/main', result: 'ok' }],
        });

        // Act
        const result = await parseReceivePackResponse(await decodeAll(body));

        // Assert
        expect(result.unpackOk).toBe(true);
        expect(result.refUpdates).toEqual([{ name: 'refs/heads/main', accepted: true }]);
      });
    });
  });
});

describe('receive-pack integration — partial rejection', () => {
  describe('Given unpack ok with one ok and one ng', () => {
    describe('When parsed', () => {
      it('Then both entries surface with correct accepted/reason', async () => {
        // Arrange
        const body = buildReceivePackResponseBody({
          unpackResult: 'ok',
          refResults: [
            { name: 'refs/heads/main', result: 'ok' },
            { name: 'refs/heads/feature', result: 'pre-receive hook declined' },
          ],
        });

        // Act
        const result = await parseReceivePackResponse(await decodeAll(body));

        // Assert
        expect(result.unpackOk).toBe(true);
        expect(result.refUpdates).toEqual([
          { name: 'refs/heads/main', accepted: true },
          {
            name: 'refs/heads/feature',
            accepted: false,
            reason: 'pre-receive hook declined',
          },
        ]);
      });
    });
  });
});

const pkt = (payload: string): Uint8Array => {
  const body = enc.encode(payload);
  return enc.encode(`${(body.byteLength + 4).toString(16).padStart(4, '0')}${payload}`);
};

const FLUSH = enc.encode('0000');

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const parseError = async (body: Uint8Array): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await parseReceivePackResponse(await decodeAll(body));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe('receive-pack integration — the error packet', () => {
  describe('Given an ERR packet where the unpack line belongs', () => {
    describe('When parsed', () => {
      it('Then it raises the remote error rather than an unparseable status', async () => {
        // Arrange
        const body = concat(pkt('ERR receive-pack refused midway'), FLUSH);

        // Act
        const caught = await parseError(body);

        // Assert
        expect(caught.data).toEqual({
          code: 'REMOTE_ERROR',
          message: 'receive-pack refused midway',
        });
      });
    });
  });

  describe('Given an ERR packet arriving after a clean unpack line', () => {
    describe('When parsed', () => {
      it('Then it raises the remote error too — the guard spans the whole report', async () => {
        // Arrange
        const body = concat(pkt('unpack ok\n'), pkt('ERR receive-pack refused midway'), FLUSH);

        // Act
        const caught = await parseError(body);

        // Assert
        expect(caught.data).toEqual({
          code: 'REMOTE_ERROR',
          message: 'receive-pack refused midway',
        });
      });
    });
  });

  describe('Given a report line whose ERR has no separating space', () => {
    describe('When parsed', () => {
      it('Then it stays an ordinary line and fails as an unparseable status', async () => {
        // Arrange
        const body = concat(pkt('ERRboom\n'), FLUSH);

        // Act
        const caught = await parseError(body);

        // Assert
        expect(caught.data).toEqual({ code: 'INVALID_REPORT_STATUS', line: 'ERRboom' });
      });
    });
  });
});

import { describe, expect, it } from 'vitest';

import { decodePktStream, type PktLine } from '../../../../src/domain/protocol/pkt-line.js';
import { parseReceivePackResponse } from '../../../../src/domain/protocol/receive-pack.js';
import { buildReceivePackResponseBody } from '../../../fixtures/transport/builders.js';

async function* asyncBytes(parts: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

const decodeAll = async (bytes: Uint8Array): Promise<AsyncIterable<PktLine>> =>
  decodePktStream(asyncBytes([bytes]));

describe('receive-pack integration — success', () => {
  it('Given unpack ok and one ok ref, When parsed end-to-end, Then unpackOk true and refUpdates accepted', async () => {
    // Arrange
    const body = buildReceivePackResponseBody({
      unpackResult: 'ok',
      refResults: [{ name: 'refs/heads/main', result: 'ok' }],
    });

    // Act
    const sut = await parseReceivePackResponse(await decodeAll(body));

    // Assert
    expect(sut.unpackOk).toBe(true);
    expect(sut.refUpdates).toEqual([{ name: 'refs/heads/main', accepted: true }]);
  });
});

describe('receive-pack integration — partial rejection', () => {
  it('Given unpack ok with one ok and one ng, When parsed, Then both entries surface with correct accepted/reason', async () => {
    // Arrange
    const body = buildReceivePackResponseBody({
      unpackResult: 'ok',
      refResults: [
        { name: 'refs/heads/main', result: 'ok' },
        { name: 'refs/heads/feature', result: 'pre-receive hook declined' },
      ],
    });

    // Act
    const sut = await parseReceivePackResponse(await decodeAll(body));

    // Assert
    expect(sut.unpackOk).toBe(true);
    expect(sut.refUpdates).toEqual([
      { name: 'refs/heads/main', accepted: true },
      {
        name: 'refs/heads/feature',
        accepted: false,
        reason: 'pre-receive hook declined',
      },
    ]);
  });
});

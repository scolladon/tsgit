import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import { encodeCommandRequest } from '../../../../../src/domain/protocol/v2/sections.js';
import { argsArb, commandArb, payloadsArb } from './arbitraries.js';

const RUNS = 200;
const ENCODER = new TextEncoder();

async function* asyncBytes(chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

async function collect(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const out: PktLine[] = [];
  for await (const pkt of source) out.push(pkt);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncBytes([bytes]), { v2: true }));

describe('Given an arbitrary command name, arg list, and payload set', () => {
  describe('When encodeCommandRequest is built and decoded', () => {
    it('Then the decoded frames reproduce command-header ∘ delim ∘ args ∘ flush', async () => {
      // Arrange
      const sut = encodeCommandRequest;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(
          commandArb(),
          argsArb(),
          payloadsArb(),
          async (command, args, payloads) => {
            const bytes = sut(command, args, payloads);
            const lines = await decodeAll(bytes);

            expect(lines[0]).toEqual({
              kind: 'data',
              payload: ENCODER.encode(`command=${command}\n`),
            });
            expect(lines[1]).toEqual({ kind: 'data', payload: ENCODER.encode(`${AGENT}\n`) });
            expect(lines[2]).toEqual({
              kind: 'data',
              payload: ENCODER.encode('object-format=sha1\n'),
            });
            expect(lines[3]).toEqual({ kind: 'delim' });

            const bodyStart = 4;
            args.forEach((arg, i) => {
              expect(lines[bodyStart + i]).toEqual({
                kind: 'data',
                payload: ENCODER.encode(`${arg}\n`),
              });
            });

            const payloadStart = bodyStart + args.length;
            payloads.forEach((payload, i) => {
              expect(lines[payloadStart + i]).toEqual({ kind: 'data', payload });
            });

            const flushIdx = payloadStart + payloads.length;
            expect(lines).toHaveLength(flushIdx + 1);
            expect(lines[flushIdx]).toEqual({ kind: 'flush' });
          },
        ),
        { numRuns: RUNS },
      );
    });
  });
});

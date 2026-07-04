import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../../src/domain/protocol/pkt-line.js';
import type { Advertisement } from '../../../../../src/domain/protocol/upload-pack.js';
import {
  buildLsRefsRequest,
  parseLsRefsResponse,
} from '../../../../../src/domain/protocol/v2/ls-refs.js';
import {
  type HeadFixture,
  headFixtureArb,
  type RefFixture,
  refFixturesArb,
} from './arbitraries.js';

const ROUND_TRIP_RUNS = 200;
const ENCODER = new TextEncoder();
const bytesOf = (s: string): Uint8Array => ENCODER.encode(s);

async function* asyncOf<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncOf([bytes]), { v2: true }));

const refLine = (ref: RefFixture): string =>
  ref.peeled === undefined
    ? `${ref.id} ${ref.name}\n`
    : `${ref.id} ${ref.name} peeled:${ref.peeled}\n`;

/**
 * Serializes a model (refs + head mode) into the wire bytes an `ls-refs`
 * response carries. The symref case deliberately writes a `wireId` on the
 * HEAD line that differs from the target's real oid — the parser must
 * derive `head` by looking up the target ref, never by trusting the oid
 * token sitting on the symref-target line itself.
 */
const serializeLsRefsResponse = (
  refs: ReadonlyArray<RefFixture>,
  head: HeadFixture,
): AsyncIterable<PktLine> => {
  const lines: string[] = [];
  if (head.kind === 'detached') {
    lines.push(`${head.id} HEAD\n`);
  } else if (head.kind === 'symref') {
    lines.push(`${head.wireId} HEAD symref-target:${head.target}\n`);
  }
  for (const ref of refs) lines.push(refLine(ref));
  return decodePktStream(asyncOf([encodePktStream(lines.map(bytesOf))]), { v2: true });
};

const findRefId = (refs: ReadonlyArray<RefFixture>, name: string): ObjectId => {
  const found = refs.find((ref) => ref.name === name);
  if (found === undefined) {
    throw new Error(`fixture invariant violated: ${name} is not among the generated refs`);
  }
  return found.id;
};

const expectedAdvertisement = (
  refs: ReadonlyArray<RefFixture>,
  head: HeadFixture,
): Advertisement => {
  const baseRefs = refs.map((ref) =>
    ref.peeled === undefined
      ? { name: ref.name, id: ref.id }
      : { name: ref.name, id: ref.id, peeled: ref.peeled },
  );
  if (head.kind === 'detached') {
    return {
      capabilities: [],
      refs: [{ name: 'HEAD', id: head.id }, ...baseRefs],
      head: { name: 'HEAD', id: head.id },
    };
  }
  if (head.kind === 'symref') {
    const targetId = findRefId(refs, head.target);
    return { capabilities: [], refs: baseRefs, head: { name: 'HEAD', id: targetId } };
  }
  return { capabilities: [], refs: baseRefs };
};

describe('Given an arbitrary set of refs and a head mode', () => {
  describe('When serialized to ls-refs response bytes and parsed', () => {
    it('Then the resulting Advertisement round-trips (refs/peeled/head, modulo the HEAD symref-target wire oid)', async () => {
      // Arrange
      const sut = parseLsRefsResponse;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(
          refFixturesArb().chain((refs) => fc.tuple(fc.constant(refs), headFixtureArb(refs))),
          async ([refs, head]) => {
            const stream = serializeLsRefsResponse(refs, head);
            const result = await sut(stream);
            expect(result).toEqual(expectedAdvertisement(refs, head));
          },
        ),
        { numRuns: ROUND_TRIP_RUNS },
      );
    });
  });
});

describe('Given arbitrary ls-refs request options', () => {
  describe('When buildLsRefsRequest builds the request and the bytes are decoded', () => {
    it('Then the body carries exactly symrefs, peel, and one ref-prefix line per prefix, in order', async () => {
      // Arrange
      const sut = buildLsRefsRequest;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.boolean(),
          fc.array(fc.stringMatching(/^[a-zA-Z0-9/_-]{1,12}$/), { minLength: 0, maxLength: 4 }),
          async (symrefs, peel, refPrefixes) => {
            const bytes = sut({ symrefs, peel, refPrefixes });
            const lines = await decodeAll(bytes);

            const expectedBody: string[] = [];
            if (symrefs) expectedBody.push('symrefs\n');
            if (peel) expectedBody.push('peel\n');
            for (const prefix of refPrefixes) expectedBody.push(`ref-prefix ${prefix}\n`);

            expect(lines[0]).toEqual({ kind: 'data', payload: bytesOf('command=ls-refs\n') });
            expect(lines[1]).toEqual({ kind: 'data', payload: bytesOf(`${AGENT}\n`) });
            expect(lines[2]).toEqual({ kind: 'data', payload: bytesOf('object-format=sha1\n') });
            expect(lines[3]).toEqual({ kind: 'delim' });
            expectedBody.forEach((text, i) => {
              expect(lines[4 + i]).toEqual({ kind: 'data', payload: bytesOf(text) });
            });
            expect(lines).toHaveLength(4 + expectedBody.length + 1);
            expect(lines.at(-1)).toEqual({ kind: 'flush' });
          },
        ),
        { numRuns: ROUND_TRIP_RUNS },
      );
    });
  });
});

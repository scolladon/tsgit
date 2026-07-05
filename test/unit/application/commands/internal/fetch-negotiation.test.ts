/**
 * Unit tests for the version-negotiation + fallback dispatch seam that wires
 * clone/fetch onto protocol v2 with a corrected v1 fallback.
 *
 * `git-service-session.test.ts` pins the HTTP `Git-Protocol` header; this
 * file pins the response-driven dispatch itself: which parser owns the
 * first advertisement line, and which wire request `negotiatePackBytes`
 * builds once the version is known.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  negotiateDiscovery,
  negotiatePackBytes,
} from '../../../../../src/application/commands/internal/fetch-negotiation.js';
import type { GitServiceSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import type { FetchPackInput } from '../../../../../src/application/primitives/fetch-pack.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/object-id.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import { recordingProgress, withProgress } from '../fixtures.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const OID_A = OID.from('a'.repeat(40));
const OID_B = OID.from('b'.repeat(40));

const bytesOf = (text: string): Uint8Array => ENCODER.encode(text);

const pktBytes = (text: string): Uint8Array => {
  const total = bytesOf(text).byteLength + 4;
  return bytesOf(total.toString(16).padStart(4, '0') + text);
};

const FLUSH = bytesOf('0000');

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const asyncBytes = async function* (chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
};

const responseStream = (bytes: Uint8Array): Promise<AsyncIterable<PktLine>> =>
  Promise.resolve(decodePktStream(asyncBytes([bytes]), { v2: true }));

const SERVICE_HEADER = concatBytes(pktBytes('# service=git-upload-pack\n'), FLUSH);

const v1RefLine = (): Uint8Array => pktBytes(`${OID_A} refs/heads/main\0ofs-delta\n`);

const v2CapabilityLines = (
  opts: { readonly fetch: boolean; readonly filter?: boolean } = { fetch: true },
): Uint8Array[] => {
  const lines = [
    pktBytes('version 2\n'),
    pktBytes('agent=git/test\n'),
    pktBytes('object-format=sha1\n'),
  ];
  lines.push(pktBytes('ls-refs\n'));
  if (opts.fetch) {
    lines.push(pktBytes(opts.filter === true ? 'fetch=shallow wait-for-done filter\n' : 'fetch\n'));
  }
  return lines;
};

const decodeRequest = async (session: GitServiceSession): Promise<string> => {
  const exchangeSpy = session.exchange as unknown as { mock: { calls: [Uint8Array][] } };
  const [requestBytes] = exchangeSpy.mock.calls.at(-1) ?? [];
  return requestBytes === undefined ? '' : DECODER.decode(requestBytes);
};

interface StubSessionOptions {
  readonly discoveryBody: Uint8Array;
  readonly servicePrologue?: boolean;
  readonly exchangeResponse?: Uint8Array;
}

const stubSession = (opts: StubSessionOptions): GitServiceSession => ({
  advertisement: () => responseStream(opts.discoveryBody),
  exchange: vi.fn(async () => responseStream(opts.exchangeResponse ?? FLUSH)),
  close: () => Promise.resolve(),
  servicePrologue: opts.servicePrologue ?? true,
});

const baseInput: FetchPackInput = {
  wants: [OID_A],
  haves: [],
  capabilities: ['ofs-delta'],
  progressOp: 'test:write-objects',
};

/**
 * Wraps a decoded pkt-line stream so its iterator's `return()` is a spy that
 * still delegates to the real iterator — proving a consumer released the
 * stream without breaking whatever cleanup the stream itself performs.
 */
const withReturnSpy = (
  stream: AsyncIterable<PktLine>,
): { readonly stream: AsyncIterable<PktLine>; readonly returnSpy: ReturnType<typeof vi.fn> } => {
  const inner = stream[Symbol.asyncIterator]();
  const returnSpy = vi.fn(
    async (value?: unknown): Promise<IteratorResult<PktLine>> =>
      (await inner.return?.(value)) ?? { done: true, value: undefined },
  );
  return {
    stream: {
      [Symbol.asyncIterator]: (): AsyncIterator<PktLine> => ({
        next: () => inner.next(),
        return: returnSpy,
      }),
    },
    returnSpy,
  };
};

describe('negotiateDiscovery', () => {
  describe('Given an advertisement whose first data line is "version 2"', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it issues an ls-refs exchange and returns version 2 with the parsed advertisement', async () => {
        // Arrange
        const discoveryBody = concatBytes(...v2CapabilityLines(), FLUSH);
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false, exchangeResponse });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(2);
        expect(sut.advertisement.refs).toEqual([{ name: 'refs/heads/main', id: OID_A }]);
        expect(session.exchange).toHaveBeenCalledTimes(1);
        expect(await decodeRequest(session)).toContain('command=ls-refs');
      });
    });
  });

  describe('Given a version-2 advertisement', () => {
    describe('When negotiateDiscovery builds its ls-refs request', () => {
      it('Then the request carries command=ls-refs and symrefs but omits peel and ref-prefix', async () => {
        // Arrange — tsgit always wants the full advertised ref set, so it
        // never asks the server to peel tags or filter by prefix.
        const discoveryBody = concatBytes(...v2CapabilityLines(), FLUSH);
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false, exchangeResponse });

        // Act
        await negotiateDiscovery(session);

        // Assert
        const request = await decodeRequest(session);
        expect(request).toContain('command=ls-refs');
        expect(request).toContain('symrefs');
        expect(request).not.toContain('peel');
        expect(request).not.toContain('ref-prefix');
      });
    });
  });

  describe('Given an HTTP advertisement with the service prologue ahead of a version-2 capability list', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it consumes the prologue before peeking the first capability line', async () => {
        // Arrange — a wrong consume-then-peek order would hand the `#
        // service=...` line to the version check instead of `version 2`,
        // misclassifying this as a v1 advertisement.
        const discoveryBody = concatBytes(SERVICE_HEADER, ...v2CapabilityLines(), FLUSH);
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: true, exchangeResponse });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(2);
        expect(sut.advertisement.refs).toEqual([{ name: 'refs/heads/main', id: OID_A }]);
      });
    });
  });

  describe('Given an HTTP advertisement with no service prologue ahead of a version-2 capability list', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it treats the version line as the first line without requiring a service header', async () => {
        // Arrange — real git-http-backend omits the `# service=...` prologue
        // entirely for protocol-v2 responses (only v1 HTTP responses carry
        // it); a session that unconditionally expects the prologue would
        // misread `version 2` as a malformed service header and throw.
        const discoveryBody = concatBytes(...v2CapabilityLines(), FLUSH);
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: true, exchangeResponse });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(2);
        expect(sut.advertisement.refs).toEqual([{ name: 'refs/heads/main', id: OID_A }]);
      });
    });
  });

  describe('Given an advertisement whose first data line is a v1 ref line', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it returns version 1 without any exchange', async () => {
        // Arrange
        const discoveryBody = concatBytes(v1RefLine(), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(1);
        expect(sut.advertisement.refs).toEqual([{ name: 'refs/heads/main', id: OID_A }]);
        expect(session.exchange).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an HTTP advertisement with the service prologue ahead of a v1 ref line', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it consumes the prologue before peeking the first ref line', async () => {
        // Arrange — a wrong consume-then-peek order would feed the `#
        // service=...` line into `parseAdvertisedRefs` as if it were a ref
        // line, corrupting the v1 fallback too.
        const discoveryBody = concatBytes(SERVICE_HEADER, v1RefLine(), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: true });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(1);
        expect(sut.advertisement.refs).toEqual([{ name: 'refs/heads/main', id: OID_A }]);
      });
    });
  });

  describe('Given a "version 2" line with no trailing newline', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it still recognizes protocol v2', async () => {
        // Arrange — real pkt-line payloads are LF-terminated, but the check
        // tolerates a bare final line the way `parseV2Capabilities` already does.
        const discoveryBody = concatBytes(
          pktBytes('version 2'),
          pktBytes('agent=git/test\n'),
          pktBytes('object-format=sha1\n'),
          pktBytes('ls-refs\n'),
          pktBytes('fetch\n'),
          FLUSH,
        );
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false, exchangeResponse });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(2);
      });
    });
  });

  describe('Given a discovery stream that is exhausted before yielding any pkt-line', () => {
    describe('When negotiateDiscovery runs', () => {
      it("Then it falls back to version 1 without reading a done result's value", async () => {
        // Arrange — `isVersion2Line` must short-circuit on `pkt.done` before
        // touching `pkt.value.kind`; skipping that guard throws on the
        // done-with-no-value result this exhausted iterator produces.
        const exhausted: AsyncIterable<PktLine> = {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        };
        const session: GitServiceSession = {
          advertisement: () => Promise.resolve(exhausted),
          exchange: vi.fn(),
          close: () => Promise.resolve(),
          servicePrologue: false,
        };

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(1);
        expect(sut.advertisement.refs).toEqual([]);
      });
    });
  });

  describe('Given a v1 advertisement whose stream iterator has no return method', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it still completes, without calling a return that does not exist', async () => {
        // Arrange — `GitServiceSession.advertisement()` is typed as a general
        // `AsyncIterable`, so `withPushback`'s cleanup must tolerate an
        // iterator that omits the optional `return` method.
        const discoveryBody = concatBytes(v1RefLine(), FLUSH);
        const inner = decodePktStream(
          (async function* () {
            yield discoveryBody;
          })(),
          { v2: true },
        )[Symbol.asyncIterator]();
        const noReturnStream: AsyncIterable<PktLine> = {
          [Symbol.asyncIterator]: () => ({ next: () => inner.next() }),
        };
        const session: GitServiceSession = {
          advertisement: () => Promise.resolve(noReturnStream),
          exchange: vi.fn(async () => responseStream(FLUSH)),
          close: () => Promise.resolve(),
          servicePrologue: false,
        };

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.version).toBe(1);
        expect(sut.advertisement.refs).toEqual([{ name: 'refs/heads/main', id: OID_A }]);
      });
    });
  });

  describe('Given a version-2 discovery whose discovery and exchange streams expose a return spy', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it releases both the discovery iterator and the ls-refs exchange iterator', async () => {
        // Arrange
        const discoveryBody = concatBytes(...v2CapabilityLines(), FLUSH);
        const exchangeResponseBytes = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const discovery = withReturnSpy(await responseStream(discoveryBody));
        const exchange = withReturnSpy(await responseStream(exchangeResponseBytes));
        const session: GitServiceSession = {
          advertisement: () => Promise.resolve(discovery.stream),
          exchange: vi.fn(async () => exchange.stream),
          close: () => Promise.resolve(),
          servicePrologue: false,
        };

        // Act
        await negotiateDiscovery(session);

        // Assert
        expect(discovery.returnSpy).toHaveBeenCalledTimes(1);
        expect(exchange.returnSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a version-2 advertisement missing the fetch command', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then it throws V2_COMMAND_UNSUPPORTED', async () => {
        // Arrange
        const discoveryBody = concatBytes(...v2CapabilityLines({ fetch: false }), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false });

        // Act
        let caught: TsgitError | undefined;
        try {
          await negotiateDiscovery(session);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({ code: 'V2_COMMAND_UNSUPPORTED', command: 'fetch' });
      });
    });
  });

  describe('Given a version-2 advertisement whose fetch command advertises filter', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then advertisement.capabilities includes filter', async () => {
        // Arrange
        const discoveryBody = concatBytes(
          ...v2CapabilityLines({ fetch: true, filter: true }),
          FLUSH,
        );
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false, exchangeResponse });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.advertisement.capabilities).toContain('filter');
      });
    });
  });

  describe('Given a version-2 advertisement whose fetch command does not advertise filter', () => {
    describe('When negotiateDiscovery runs', () => {
      it('Then advertisement.capabilities omits filter', async () => {
        // Arrange
        const discoveryBody = concatBytes(...v2CapabilityLines({ fetch: true }), FLUSH);
        const exchangeResponse = concatBytes(pktBytes(`${OID_A} refs/heads/main\n`), FLUSH);
        const session = stubSession({ discoveryBody, servicePrologue: false, exchangeResponse });

        // Act
        const sut = await negotiateDiscovery(session);

        // Assert
        expect(sut.advertisement.capabilities).not.toContain('filter');
      });
    });
  });
});

describe('negotiatePackBytes', () => {
  describe('Given version 2 and a want/have set', () => {
    describe('When negotiatePackBytes dispatches', () => {
      it('Then it builds the v2 fetch request and drains the pack', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const exchangeResponse = concatBytes(
          pktBytes('packfile\n'),
          pktBytes('\x01PACK-DATA'),
          FLUSH,
        );
        const session = stubSession({ discoveryBody: FLUSH, exchangeResponse });

        // Act
        const sut = await negotiatePackBytes(ctx, session, 2, baseInput);

        // Assert
        expect(await decodeRequest(session)).toContain('command=fetch');
        expect(DECODER.decode(sut.packBytes)).toBe('PACK-DATA');
      });
    });
  });

  describe('Given a version-2 packfile section carrying channel-2 progress text', () => {
    describe('When negotiatePackBytes dispatches', () => {
      it('Then it reports the sanitized progress text through ctx.progress', async () => {
        // Arrange
        const { reporter, events } = recordingProgress();
        const ctx = withProgress(createMemoryContext(), reporter);
        const exchangeResponse = concatBytes(
          pktBytes('packfile\n'),
          pktBytes('\x02Counting objects: 5, done.\n'),
          pktBytes('\x01PACK-DATA'),
          FLUSH,
        );
        const session = stubSession({ discoveryBody: FLUSH, exchangeResponse });

        // Act
        await negotiatePackBytes(ctx, session, 2, baseInput);

        // Assert
        const textUpdates = events.filter(
          (e): e is { kind: 'update'; op: string; current: number; text?: string } =>
            e.kind === 'update' && typeof e.text === 'string' && e.text.length > 0,
        );
        expect(textUpdates).toHaveLength(1);
        expect(textUpdates[0]?.text).toBe('Counting objects: 5, done.\n');
      });
    });
  });

  describe('Given version 2 with a depth and a filter set', () => {
    describe('When negotiatePackBytes dispatches', () => {
      it('Then the v2 fetch request carries deepen and filter args', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const exchangeResponse = concatBytes(
          pktBytes('packfile\n'),
          pktBytes('\x01PACK-DATA'),
          FLUSH,
        );
        const session = stubSession({ discoveryBody: FLUSH, exchangeResponse });
        const input: FetchPackInput = { ...baseInput, depth: 3, filter: 'blob:none' };

        // Act
        await negotiatePackBytes(ctx, session, 2, input);

        // Assert
        const request = await decodeRequest(session);
        expect(request).toContain('deepen 3');
        expect(request).toContain('filter blob:none');
      });
    });
  });

  describe('Given version 2, a want, and a have, with no depth or filter set', () => {
    describe('When negotiatePackBytes builds the fetch request', () => {
      it('Then the request carries command=fetch, want, have, and done but omits ofs-delta, include-tag, thin-pack, no-progress, deepen, and filter', async () => {
        // Arrange — capability negotiation (ofs-delta/include-tag) and
        // progress framing (thin-pack/no-progress) only steer how the server
        // *packs* bytes; the on-disk result is identical either way, so v2
        // never sends them as fetch-command args.
        const ctx = createMemoryContext();
        const exchangeResponse = concatBytes(
          pktBytes('packfile\n'),
          pktBytes('\x01PACK-DATA'),
          FLUSH,
        );
        const session = stubSession({ discoveryBody: FLUSH, exchangeResponse });
        const input: FetchPackInput = { ...baseInput, haves: [OID_B] };

        // Act
        await negotiatePackBytes(ctx, session, 2, input);

        // Assert
        const request = await decodeRequest(session);
        expect(request).toContain('command=fetch');
        expect(request).toContain(`want ${OID_A}`);
        expect(request).toContain(`have ${OID_B}`);
        expect(request).toContain('done');
        expect(request).not.toContain('ofs-delta');
        expect(request).not.toContain('include-tag');
        expect(request).not.toContain('thin-pack');
        expect(request).not.toContain('no-progress');
        expect(request).not.toContain('deepen');
        expect(request).not.toContain('filter');
        // Structural check (not just substring absence): the fetch-command
        // delim must be immediately followed by the want line's own pkt-line
        // prefix — proving zero arg pkt-lines were emitted, not merely that
        // none happened to contain the strings "deepen"/"filter".
        expect(request).toMatch(new RegExp(`object-format=sha1\\n0001[0-9a-f]{4}want ${OID_A}`));
      });
    });
  });

  describe('Given version 1 and a want/have set', () => {
    describe('When negotiatePackBytes dispatches', () => {
      it('Then it builds the v1 upload-pack request and drains the pack', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const exchangeResponse = concatBytes(pktBytes('NAK\n'), pktBytes('PACK-DATA'));
        const session = stubSession({ discoveryBody: FLUSH, exchangeResponse });

        // Act
        const sut = await negotiatePackBytes(ctx, session, 1, baseInput);

        // Assert
        const request = await decodeRequest(session);
        expect(request).toContain(`want ${OID_A}`);
        expect(request).not.toContain('command=fetch');
        expect(DECODER.decode(sut.packBytes)).toBe('PACK-DATA');
      });
    });
  });
});

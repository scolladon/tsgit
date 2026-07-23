import { describe, expect, it, vi } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { ObjectId as OID } from '../../../../src/domain/objects/object-id.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../src/domain/protocol/pkt-line.js';
import {
  buildDiscoveryUrl,
  buildUploadPackRequest,
  MAX_ADVERTISED_REFS,
  parseAdvertisedRefs,
  parseShallowResponse,
  parseUploadPackResponse,
} from '../../../../src/domain/protocol/upload-pack.js';

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

const OID1 = OID.from('a'.repeat(40));
const OID2 = OID.from('b'.repeat(40));
const OID3 = OID.from('c'.repeat(40));

async function* asyncOf<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function* asyncBytes(parts: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
}

interface BuildDiscoveryInput {
  readonly service: 'git-upload-pack' | 'git-receive-pack';
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<{
    readonly name: string;
    readonly id: ObjectId;
    readonly peeled?: ObjectId;
  }>;
}

const buildDiscoveryBody = (d: BuildDiscoveryInput): Uint8Array => {
  const NUL = '\0';
  const headerStream = encodePktStream([bytesOf(`# service=${d.service}\n`)]);
  const refLines: Uint8Array[] = [];
  d.refs.forEach((r, idx) => {
    if (idx === 0) {
      refLines.push(bytesOf(`${r.id} ${r.name}${NUL}${d.capabilities.join(' ')}\n`));
    } else {
      refLines.push(bytesOf(`${r.id} ${r.name}\n`));
    }
    if (r.peeled !== undefined) {
      refLines.push(bytesOf(`${r.peeled} ${r.name}^{}\n`));
    }
  });
  const refStream = encodePktStream(refLines);
  return concat(headerStream, refStream);
};

describe('buildDiscoveryUrl', () => {
  describe('Given a base URL and service', () => {
    describe('When buildDiscoveryUrl', () => {
      it.each([
        {
          url: 'https://example.com/repo.git',
          expected: 'https://example.com/repo.git/info/refs?service=git-upload-pack',
          label: 'appends /info/refs?service=...',
        },
        {
          url: 'https://example.com/repo.git/',
          expected: 'https://example.com/repo.git/info/refs?service=git-upload-pack',
          label: 'no double slash',
        },
        {
          url: 'https://example.com/repo.git?token=xyz',
          expected: 'https://example.com/repo.git/info/refs?token=xyz&service=git-upload-pack',
          label: 'appends with &',
        },
        {
          url: 'ftp://example.com/repo',
          expected: 'ftp://example.com/repo/info/refs?service=git-upload-pack',
          label: 'returns the URL (scheme validated at adapter layer)',
        },
        {
          url: 'https://example.com/repo',
          expected: 'https://example.com/repo/info/refs?service=git-upload-pack',
          label: 'no auto-append',
        },
      ])('Then $label', ({ url, expected }) => {
        // Arrange & Act
        const sut = buildDiscoveryUrl(url, 'git-upload-pack');

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given a fragment', () => {
    describe('When buildDiscoveryUrl', () => {
      it('Then throws INVALID_BASE_URL with reason "fragment must not be set"', () => {
        // Arrange
        try {
          buildDiscoveryUrl('https://example.com/repo.git#frag', 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'INVALID_BASE_URL', reason: 'fragment must not be set' });
        }
      });
    });
  });

  describe('Given an invalid URL', () => {
    describe('When buildDiscoveryUrl', () => {
      it('Then throws INVALID_BASE_URL with reason "invalid URL"', () => {
        // Arrange
        try {
          buildDiscoveryUrl('not-a-url', 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'INVALID_BASE_URL', reason: 'invalid URL' });
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — edge cases', () => {
  describe('Given a malformed or absent service header', () => {
    describe('When parsed', () => {
      it.each([
        {
          label: 'an empty stream',
          buildChunks: (): Uint8Array[] => [],
        },
        {
          label: 'a service header followed by a non-flush data packet (no separator)',
          buildChunks: (): Uint8Array[] => [
            encodePktStream([
              bytesOf('# service=git-upload-pack\n'),
              bytesOf(`${OID1} refs/heads/main\0caps\n`),
            ]),
          ],
        },
        {
          label: 'a service header without a trailing flush',
          buildChunks: (): Uint8Array[] => [
            encodePktStream([bytesOf('# service=git-upload-pack\n')]).subarray(0, -4),
          ],
        },
      ])('Then throws MISSING_SERVICE_HEADER ($label)', async ({ buildChunks }) => {
        // Arrange
        const chunks = buildChunks();

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes(chunks)), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('MISSING_SERVICE_HEADER');
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — happy path', () => {
  describe('Given a discovery body with two refs and HEAD', () => {
    describe('When parsed', () => {
      it('Then capabilities and refs deep-equal', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['multi_ack_detailed', 'side-band-64k'],
          refs: [
            { name: 'HEAD', id: OID1 },
            { name: 'refs/heads/main', id: OID1 },
          ],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.capabilities).toEqual(['multi_ack_detailed', 'side-band-64k']);
        expect(sut.refs).toHaveLength(2);
        expect(sut.head?.name).toBe('HEAD');
        expect(sut.head?.id).toBe(OID1);
      });
    });
  });
});

describe('parseAdvertisedRefs — servicePrologue option', () => {
  describe('Given a prologue-less (SSH-style) discovery body', () => {
    describe('When parsed with servicePrologue: false', () => {
      it('Then capabilities and refs deep-equal without expecting the service header', async () => {
        // Arrange — SSH transport never sends the `# service=...` line the HTTP
        // discovery prologue carries; only the ref/capability pkt-lines stream.
        const body = encodePktStream([
          bytesOf(`${OID1} HEAD\0multi_ack_detailed side-band-64k\n`),
          bytesOf(`${OID1} refs/heads/main\n`),
        ]);

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
          {
            servicePrologue: false,
          },
        );

        // Assert
        expect(sut.capabilities).toEqual(['multi_ack_detailed', 'side-band-64k']);
        expect(sut.refs).toHaveLength(2);
        expect(sut.head?.name).toBe('HEAD');
        expect(sut.head?.id).toBe(OID1);
      });
    });
  });

  describe('Given an empty-repo prologue-less advertisement (zero-oid capabilities^{} line)', () => {
    describe('When parsed with servicePrologue: false', () => {
      it('Then the zero-oid line parses as a ref without a HEAD match', async () => {
        // Arrange — the empty-repo advertisement is a single zero-oid
        // `capabilities^{}` line carrying only capabilities.
        const zero = '0'.repeat(40);
        const body = encodePktStream([bytesOf(`${zero} capabilities^{}\0report-status\n`)]);

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
          {
            servicePrologue: false,
          },
        );

        // Assert
        expect(sut.capabilities).toEqual(['report-status']);
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.name).toBe('capabilities^{}');
        expect(sut.head).toBeUndefined();
      });
    });
  });

  describe('Given an HTTP-style discovery body with the service prologue', () => {
    describe('When parsed with the default options (servicePrologue omitted)', () => {
      it('Then the prologue is consumed and the result matches explicit servicePrologue: true', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['multi_ack_detailed', 'side-band-64k'],
          refs: [
            { name: 'HEAD', id: OID1 },
            { name: 'refs/heads/main', id: OID1 },
          ],
        });

        // Act
        const defaulted = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );
        const explicit = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
          {
            servicePrologue: true,
          },
        );

        // Assert
        expect(defaulted).toEqual(explicit);
        expect(defaulted.refs).toHaveLength(2);
      });
    });
  });
});

describe('parseAdvertisedRefs — service header validation', () => {
  describe('Given a stream advertising the wrong service', () => {
    describe('When parsed with expected upload-pack', () => {
      it('Then throws MISSING_SERVICE_HEADER', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-receive-pack',
          capabilities: ['multi_ack_detailed'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({
            code: 'MISSING_SERVICE_HEADER',
            expected: 'git-upload-pack',
            actual: 'git-receive-pack',
          });
        }
      });
    });
  });

  // SERVICE_LINE_RE is anchored `^# service=(...)\n?$`. Each row below kills a
  // distinct anchor/prefix mutant: no header at all, leading garbage before the
  // literal (a missing `^`), and trailing content after an embedded newline (a
  // missing `$`).
  describe('Given a stream whose leading pkt-line does not carry a valid "# service=" header', () => {
    describe('When parsed', () => {
      it.each([
        {
          label: 'no service header at all — the first packet is a ref line',
          buildBody: (): Uint8Array =>
            encodePktStream([bytesOf(`${OID1} refs/heads/main\0multi_ack\n`)]),
        },
        {
          label: 'leading garbage before "# service="',
          buildBody: (): Uint8Array => encodePktStream([bytesOf('xxx# service=git-upload-pack\n')]),
        },
        {
          label: 'trailing content after an embedded newline',
          buildBody: (): Uint8Array =>
            encodePktStream([bytesOf('# service=git-upload-pack\nbogus')]),
        },
      ])('Then throws MISSING_SERVICE_HEADER ($label)', async ({ buildBody }) => {
        // Arrange
        const body = buildBody();

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('MISSING_SERVICE_HEADER');
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — capability extraction', () => {
  describe('Given the first ref payload without NUL', () => {
    describe('When parsed', () => {
      it('Then throws MISSING_CAPABILITIES', async () => {
        // Arrange
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const refStream = encodePktStream([bytesOf(`${OID1} refs/heads/main\n`)]);
        const body = concat(headerStream, refStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('MISSING_CAPABILITIES');
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — ref validation', () => {
  describe('Given a ref line with no name', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE', async () => {
        // Arrange
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const refStream = encodePktStream([bytesOf(`${OID1}\0caps\n`)]);
        const body = concat(headerStream, refStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('INVALID_REF_LINE');
        }
      });
    });
  });

  describe('Given a ref line with not-a-sha id', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE', async () => {
        // Arrange
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const refStream = encodePktStream([bytesOf('not-a-sha refs/heads/main\0caps\n')]);
        const body = concat(headerStream, refStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('INVALID_REF_LINE');
        }
      });
    });
  });

  describe('Given two ref lines with the same name', () => {
    describe('When parsed', () => {
      it('Then throws DUPLICATE_REF', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['caps'],
          refs: [
            { name: 'refs/heads/main', id: OID1 },
            { name: 'refs/heads/main', id: OID2 },
          ],
        });

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'DUPLICATE_REF', name: 'refs/heads/main' });
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — SHA_ANY_RE anchor boundaries', () => {
  describe('Given an id with 40 valid hex chars followed by trailing garbage', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE (not the ObjectId.from format error)', async () => {
        // Arrange — without SHA_ANY_RE's trailing `$` anchor, `.test()` would
        // match on the 40-hex prefix alone and let the malformed id past
        // validateOidString's own guard, surfacing a later INVALID_OBJECT_ID
        // from ObjectId.from instead of the intended INVALID_REF_LINE.
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const badId = `${'a'.repeat(40)}z`;
        const refStream = encodePktStream([bytesOf(`${badId} refs/heads/main\0caps\n`)]);
        const body = concat(headerStream, refStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('INVALID_REF_LINE');
        }
      });
    });
  });

  describe('Given an id with leading garbage followed by 40 valid hex chars', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE (not the ObjectId.from format error)', async () => {
        // Arrange — without SHA_ANY_RE's leading `^` anchor, `.test()` would
        // match the 40-hex suffix alone and let the malformed id past
        // validateOidString's own guard, surfacing a later INVALID_OBJECT_ID
        // from ObjectId.from instead of the intended INVALID_REF_LINE.
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const badId = `z${'a'.repeat(40)}`;
        const refStream = encodePktStream([bytesOf(`${badId} refs/heads/main\0caps\n`)]);
        const body = concat(headerStream, refStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('INVALID_REF_LINE');
        }
      });
    });
  });

  describe('Given a ref id that is a 64-hex (SHA-256-style) oid', () => {
    describe('When parsed', () => {
      it('Then the ref is accepted with the full 64-hex id', async () => {
        // Arrange — SHA_ANY_RE's optional trailing group matches the extra 24
        // hex chars a SHA-256 oid carries beyond the 40-hex SHA-1 form. No
        // other test exercises the 64-hex branch of this regex.
        const sha256Id = 'd'.repeat(64);
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const refStream = encodePktStream([bytesOf(`${sha256Id} refs/heads/main\0caps\n`)]);
        const body = concat(headerStream, refStream);

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.id).toBe(sha256Id);
      });
    });
  });
});

describe('parseAdvertisedRefs — advertised-refs cap (security HIGH-2)', () => {
  describe('Given an advertisement exceeding MAX_ADVERTISED_REFS', () => {
    describe('When parsed', () => {
      it('Then throws TOO_MANY_ADVERTISED_REFS before allocating beyond the cap', async () => {
        // Arrange — synthesize a PktLine async iterable directly so we don't
        // have to build MAX_ADVERTISED_REFS+1 raw bytes (that would balloon the
        // test). The parser consumes pkt-lines, not bytes, so an in-process
        // generator is the cheapest fixture.
        const overage = MAX_ADVERTISED_REFS + 1;
        async function* pkts(): AsyncIterable<PktLine> {
          yield { kind: 'data', payload: bytesOf('# service=git-upload-pack\n') };
          yield { kind: 'flush' };
          // First ref carries the capabilities. Subsequent refs reuse the
          // capability set parsed once.
          yield {
            kind: 'data',
            payload: bytesOf(`${OID1} refs/heads/b0 ofs-delta\n`),
          };
          for (let i = 1; i < overage; i += 1) {
            const padded = i.toString(16).padStart(40, '0');
            yield { kind: 'data', payload: bytesOf(`${padded} refs/heads/b${i}\n`) };
          }
          yield { kind: 'flush' };
        }

        // Act
        let caught: unknown;
        try {
          await parseAdvertisedRefs(pkts(), 'git-upload-pack');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          readonly code: string;
          readonly count?: number;
          readonly limit?: number;
        };
        expect(data.code).toBe('TOO_MANY_ADVERTISED_REFS');
        expect(data.limit).toBe(MAX_ADVERTISED_REFS);
        expect((data.count ?? 0) > MAX_ADVERTISED_REFS).toBe(true);
      }, 30_000);
    });
  });
});

describe('parseAdvertisedRefs — empty advertisement', () => {
  describe('Given a discovery body with header + flush + flush (no refs at all)', () => {
    describe('When parsed', () => {
      it('Then capabilities=[] and refs=[]', async () => {
        // Arrange — service header + ref-section with no entries
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const refStream = encodePktStream([]); // just a trailing flush
        const body = concat(headerStream, refStream);

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.capabilities).toEqual([]);
        expect(sut.refs).toEqual([]);
      });
    });
  });
});

describe('parseAdvertisedRefs — additional ref validation', () => {
  describe('Given a malformed ref line or peeled-tag reference', () => {
    describe('When parsed', () => {
      it.each([
        {
          label: 'a first ref line with a trailing space before NUL (empty name)',
          buildBody: (): Uint8Array =>
            concat(
              encodePktStream([bytesOf('# service=git-upload-pack\n')]),
              encodePktStream([bytesOf(`${OID1} \0caps\n`)]),
            ),
        },
        {
          label: 'a subsequent ref line with trailing space and empty name',
          buildBody: (): Uint8Array => {
            const body = buildDiscoveryBody({
              service: 'git-upload-pack',
              capabilities: ['caps'],
              refs: [{ name: 'refs/heads/main', id: OID1 }],
            });
            const extraStream = encodePktStream([bytesOf(`${OID2} \n`)]);
            return concat(body.subarray(0, -4), extraStream);
          },
        },
        {
          label: 'a peeled tag whose base ref is missing',
          buildBody: (): Uint8Array => {
            const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
            const refStream = encodePktStream([
              bytesOf(`${OID1} refs/heads/main\0caps\n`),
              bytesOf(`${OID2} refs/tags/missing^{}\n`),
            ]);
            return concat(headerStream, refStream);
          },
        },
      ])('Then throws INVALID_REF_LINE ($label)', async ({ buildBody }) => {
        // Arrange
        const body = buildBody();

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('INVALID_REF_LINE');
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — peeled tags', () => {
  describe('Given a tag with peeled commit', () => {
    describe('When parsed', () => {
      it('Then ref entry has peeled === commit oid', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['caps'],
          refs: [{ name: 'refs/tags/v1', id: OID2, peeled: OID3 }],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.name).toBe('refs/tags/v1');
        expect(sut.refs[0]?.id).toBe(OID2);
        expect(sut.refs[0]?.peeled).toBe(OID3);
      });
    });
  });
});

describe('parseAdvertisedRefs — symref HEAD without direct HEAD ref', () => {
  describe('Given symref pointing to an existing target ref but no HEAD ref', () => {
    describe('When parsed', () => {
      it('Then head.name === "HEAD" with target id', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.head?.name).toBe('HEAD');
        expect(sut.head?.id).toBe(OID1);
      });
    });
  });

  describe('Given symref pointing to a non-existent target', () => {
    describe('When parsed', () => {
      it('Then head is undefined', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['symref=HEAD:refs/heads/missing'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.head).toBeUndefined();
      });
    });
  });

  describe('Given no symref capability and no HEAD ref', () => {
    describe('When parsed', () => {
      it('Then head is undefined', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['multi_ack_detailed'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.head).toBeUndefined();
      });
    });
  });
});

describe('parseAdvertisedRefs — symref HEAD with direct HEAD ref', () => {
  describe('Given symref capability and a HEAD ref', () => {
    describe('When parsed', () => {
      it('Then head is exposed with name "HEAD"', async () => {
        // Arrange
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['multi_ack_detailed', 'symref=HEAD:refs/heads/main'],
          refs: [
            { name: 'HEAD', id: OID1 },
            { name: 'refs/heads/main', id: OID1 },
          ],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.head?.name).toBe('HEAD');
        expect(sut.refs.find((r) => r.name === 'refs/heads/main')).toBeDefined();
      });
    });
  });
});

describe('buildUploadPackRequest', () => {
  const decodeAll = async (bytes: Uint8Array): Promise<PktLine[]> =>
    collect(decodePktStream(asyncBytes([bytes])));

  describe('Given wants and done=true', () => {
    describe('When built', () => {
      it('Then bytes contain "want <oid> caps" + flush + "done"', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1],
          haves: [],
          capabilities: ['multi_ack_detailed', 'side-band-64k'],
          done: true,
        });
        const lines = await decodeAll(sut);

        // Assert
        expect(lines).toHaveLength(3);
        expect(lines[0]?.kind).toBe('data');
        if (lines[0]?.kind === 'data') {
          expect(new TextDecoder().decode(lines[0].payload)).toBe(
            `want ${OID1} multi_ack_detailed side-band-64k\n`,
          );
        }
        expect(lines[1]).toEqual({ kind: 'flush' });
        expect(lines[2]?.kind).toBe('data');
        if (lines[2]?.kind === 'data') {
          expect(new TextDecoder().decode(lines[2].payload)).toBe('done\n');
        }
      });
    });
  });

  describe('Given two wants', () => {
    describe('When built', () => {
      it('Then capabilities appear only on the first want line', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1, OID2],
          haves: [],
          capabilities: ['side-band-64k'],
          done: true,
        });
        const lines = await decodeAll(sut);

        // Assert
        const dataLines = lines.filter(
          (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
        );
        const dec = new TextDecoder();
        expect(dec.decode(dataLines[0]?.payload)).toBe(`want ${OID1} side-band-64k\n`);
        expect(dec.decode(dataLines[1]?.payload)).toBe(`want ${OID2}\n`);
      });
    });
  });

  describe('Given haves and no done', () => {
    describe('When built', () => {
      it('Then bytes include have lines and a trailing flush (multi-round)', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1],
          haves: [OID2, OID3],
          capabilities: ['side-band-64k'],
        });
        const lines = await decodeAll(sut);

        // Assert — kinds in order: data(want), flush, data(have), data(have), flush
        const kinds = lines.map((l) => l.kind);
        expect(kinds).toEqual(['data', 'flush', 'data', 'data', 'flush']);
        const dec = new TextDecoder();
        const dataLines = lines.filter(
          (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
        );
        expect(dec.decode(dataLines[1]?.payload)).toBe(`have ${OID2}\n`);
        expect(dec.decode(dataLines[2]?.payload)).toBe(`have ${OID3}\n`);
      });
    });
  });

  describe('Given depth', () => {
    describe('When built', () => {
      it('Then includes "deepen <n>" line before the flush', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1],
          haves: [],
          capabilities: [],
          depth: 5,
        });
        const lines = await decodeAll(sut);

        // Assert
        const dec = new TextDecoder();
        const dataLines = lines.filter(
          (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
        );
        expect(dec.decode(dataLines[1]?.payload)).toBe('deepen 5\n');
      });
    });
  });

  describe('Given a filter', () => {
    describe('When built', () => {
      it('Then includes a "filter <spec>" line before the flush', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1],
          haves: [],
          capabilities: ['filter'],
          filter: 'blob:none',
          done: true,
        });
        const lines = await decodeAll(sut);

        // Assert
        const dec = new TextDecoder();
        const dataLines = lines.filter(
          (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
        );
        expect(dec.decode(dataLines[1]?.payload)).toBe('filter blob:none\n');
        expect(lines[2]).toEqual({ kind: 'flush' });
      });
    });
  });

  describe('Given no filter', () => {
    describe('When built', () => {
      it('Then emits no filter line', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1],
          haves: [],
          capabilities: [],
        });
        const lines = await decodeAll(sut);

        // Assert
        const dec = new TextDecoder();
        const hasFilter = lines.some(
          (l) => l.kind === 'data' && dec.decode(l.payload).startsWith('filter '),
        );
        expect(hasFilter).toBe(false);
      });
    });
  });

  describe('Given both depth and filter', () => {
    describe('When built', () => {
      it('Then the filter line follows the deepen line', async () => {
        // Arrange & Act
        const sut = buildUploadPackRequest({
          wants: [OID1],
          haves: [],
          capabilities: [],
          depth: 1,
          filter: 'tree:0',
        });
        const lines = await decodeAll(sut);

        // Assert
        const dec = new TextDecoder();
        const dataLines = lines.filter(
          (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
        );
        expect(dec.decode(dataLines[1]?.payload)).toBe('deepen 1\n');
        expect(dec.decode(dataLines[2]?.payload)).toBe('filter tree:0\n');
      });
    });
  });

  describe('Given empty wants', () => {
    describe('When built', () => {
      it('Then throws EMPTY_WANTS', () => {
        // Arrange
        try {
          buildUploadPackRequest({ wants: [], haves: [], capabilities: [] });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data.code).toBe('EMPTY_WANTS');
        }
      });
    });
  });

  describe('Given haves and done=true', () => {
    describe('When built', () => {
      const buildLines = async (): Promise<PktLine[]> =>
        decodeAll(
          buildUploadPackRequest({
            wants: [OID1],
            haves: [OID2, OID3],
            capabilities: ['side-band-64k'],
            done: true,
          }),
        );

      it('Then have lines are terminated by "done" with no flush between the last have and done', async () => {
        // Arrange & Act
        const lines = await buildLines();

        // Assert — exactly one flush (after the want-list), then have, have, done —
        // no second flush is emitted before "done".
        expect(lines.map((l) => l.kind)).toEqual(['data', 'flush', 'data', 'data', 'data']);
        const last = lines[lines.length - 1];
        expect(last?.kind).toBe('data');
        if (last?.kind === 'data') {
          expect(new TextDecoder().decode(last.payload)).toBe('done\n');
        }
      });

      it('Then the two have payloads are preserved in order', async () => {
        // Arrange & Act
        const lines = await buildLines();

        // Assert
        const dataLines = lines.filter(
          (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
        );
        const dec = new TextDecoder();
        expect(dec.decode(dataLines[1]?.payload)).toBe(`have ${OID2}\n`);
        expect(dec.decode(dataLines[2]?.payload)).toBe(`have ${OID3}\n`);
      });
    });
  });
});

describe('parseUploadPackResponse', () => {
  const sideBandPkt = (channel: number, body: Uint8Array): PktLine => {
    const payload = new Uint8Array(body.byteLength + 1);
    payload[0] = channel;
    payload.set(body, 1);
    return { kind: 'data', payload };
  };
  const dataPkt = (s: string): PktLine => ({ kind: 'data', payload: bytesOf(s) });

  describe('Given NAK followed by sideband channel-1 packets and flush', () => {
    describe('When parsed (sideBand:true)', () => {
      it('Then nak true and packBody yields N bytes', async () => {
        // Arrange
        const packBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const source = asyncOf<PktLine>([
          dataPkt('NAK\n'),
          sideBandPkt(1, packBytes),
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: true });
        const collected = await collect(result.packBody);

        // Assert
        expect(result.nak).toBe(true);
        expect(result.acks).toEqual([]);
        const total = collected.reduce((n, c) => n + c.byteLength, 0);
        expect(total).toBe(packBytes.byteLength);
      });
    });
  });

  describe('Given ACK lines + NAK + sideband pack + flush', () => {
    describe('When parsed (sideBand:true)', () => {
      it('Then acks deep-equals expected statuses', async () => {
        // Arrange
        const packBytes = new Uint8Array([0xff]);
        const source = asyncOf<PktLine>([
          dataPkt(`ACK ${OID1} continue\n`),
          dataPkt(`ACK ${OID2}\n`),
          dataPkt('NAK\n'),
          sideBandPkt(1, packBytes),
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: true });
        await collect(result.packBody);

        // Assert
        expect(result.acks).toEqual([
          { id: OID1, status: 'continue' },
          { id: OID2, status: 'ack' },
        ]);
        expect(result.nak).toBe(true);
      });
    });
  });

  describe('Given an ACK line with status %s', () => {
    describe('When parsed', () => {
      it.each(['common', 'ready'] as const)(
        'Then acks contains the matching status entry',
        async (status) => {
          // Arrange
          const source = asyncOf<PktLine>([
            dataPkt(`ACK ${OID1} ${status}\n`),
            dataPkt('NAK\n'),
            { kind: 'flush' },
          ]);

          // Act
          const result = await parseUploadPackResponse(source, { sideBand: false });

          // Assert
          expect(result.acks).toEqual([{ id: OID1, status }]);
        },
      );
    });
  });

  describe('Given an unknown ACK status', () => {
    describe('When parsed', () => {
      it('Then rejects with UNKNOWN_ACK_STATUS', async () => {
        // Arrange
        const source = asyncOf<PktLine>([dataPkt(`ACK ${OID1} bogus\n`)]);

        // Act & Assert
        try {
          await parseUploadPackResponse(source, { sideBand: true });
          throw new Error('expected rejection');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const te = err as TsgitError;
          expect(te.data).toEqual({ code: 'UNKNOWN_ACK_STATUS', value: 'bogus' });
        }
      });
    });
  });

  describe('Given sideBand:false with raw pack packets', () => {
    describe('When parsed', () => {
      it('Then packBody yields raw payloads', async () => {
        // Arrange
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5, 6]);
        const source = asyncOf<PktLine>([
          dataPkt('NAK\n'),
          { kind: 'data', payload: a },
          { kind: 'data', payload: b },
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: false });
        const collected = await collect(result.packBody);

        // Assert
        expect(result.nak).toBe(true);
        expect(collected).toHaveLength(2);
        expect(collected[0]).toEqual(a);
        expect(collected[1]).toEqual(b);
      });
    });
  });

  describe('Given a channel-2 packet', () => {
    describe('When parsed (sideBand:true) with onProgress', () => {
      it('Then onProgress called once with the text', async () => {
        // Arrange
        const onProgress = vi.fn<(text: string) => void>();
        const source = asyncOf<PktLine>([
          dataPkt('NAK\n'),
          sideBandPkt(2, bytesOf('Counting objects: 5\n')),
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: true, onProgress });
        await collect(result.packBody);

        // Assert
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith('Counting objects: 5\n');
      });
    });
  });

  describe('Given an empty source', () => {
    describe('When parsed (sideBand:false)', () => {
      it('Then nak false, acks empty, packBody is empty', async () => {
        // Arrange
        const empty: AsyncIterable<PktLine> = (async function* () {
          // yield nothing
        })();

        // Act
        const result = await parseUploadPackResponse(empty, { sideBand: false });
        const collected = await collect(result.packBody);

        // Assert
        expect(result.nak).toBe(false);
        expect(result.acks).toEqual([]);
        expect(collected).toEqual([]);
      });
    });
  });

  describe('Given an ACK packet without a trailing newline', () => {
    describe('When parsed', () => {
      it('Then acks captured (defensive stripTrailingNewline branch)', async () => {
        // Arrange — payload without trailing \n exercises the false branch of stripTrailingNewline
        const ackNoNewline: PktLine = {
          kind: 'data',
          payload: bytesOf(`ACK ${OID1}`),
        };
        const source = asyncOf<PktLine>([ackNoNewline, dataPkt('NAK\n'), { kind: 'flush' }]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: false });
        await collect(result.packBody);

        // Assert
        expect(result.nak).toBe(true);
        expect(result.acks).toEqual([{ id: OID1, status: 'ack' }]);
      });
    });
  });

  describe('Given a flush as the first packet (no meta)', () => {
    describe('When parsed (sideBand:false)', () => {
      it('Then packBody yields nothing and acks empty', async () => {
        // Arrange — flush before any meta data; splitMeta returns immediately
        const source = asyncOf<PktLine>([{ kind: 'flush' }]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: false });
        const collected = await collect(result.packBody);

        // Assert
        expect(result.nak).toBe(false);
        expect(result.acks).toEqual([]);
        expect(collected).toEqual([]);
      });
    });
  });
});

describe('parseShallowResponse', () => {
  const dataPkt = (s: string): PktLine => ({ kind: 'data', payload: bytesOf(s) });

  describe('Given a flush immediately', () => {
    describe('When parsed', () => {
      it('Then returns empty arrays and the iterator is past the flush', async () => {
        // Arrange
        const iter = asyncOf<PktLine>([{ kind: 'flush' }])[Symbol.asyncIterator]();

        // Act
        const sut = await parseShallowResponse(iter);

        // Assert
        expect(sut.shallow).toEqual([]);
        expect(sut.unshallow).toEqual([]);
        expect((await iter.next()).done).toBe(true);
      });
    });
  });

  describe('Given a single shallow line + flush', () => {
    describe('When parsed', () => {
      it('Then shallow contains one oid', async () => {
        // Arrange
        const iter = asyncOf<PktLine>([dataPkt(`shallow ${OID1}\n`), { kind: 'flush' }])[
          Symbol.asyncIterator
        ]();

        // Act
        const sut = await parseShallowResponse(iter);

        // Assert
        expect(sut.shallow).toEqual([OID1]);
        expect(sut.unshallow).toEqual([]);
        // Iterator is past the flush — next read is end-of-stream.
        expect((await iter.next()).done).toBe(true);
      });
    });
  });

  describe('Given shallow + unshallow + flush', () => {
    describe('When parsed', () => {
      it('Then both arrays are populated in order', async () => {
        // Arrange
        const iter = asyncOf<PktLine>([
          dataPkt(`shallow ${OID1}\n`),
          dataPkt(`shallow ${OID2}\n`),
          dataPkt(`unshallow ${OID3}\n`),
          { kind: 'flush' },
        ])[Symbol.asyncIterator]();

        // Act
        const sut = await parseShallowResponse(iter);

        // Assert
        expect(sut.shallow).toEqual([OID1, OID2]);
        expect(sut.unshallow).toEqual([OID3]);
      });
    });
  });

  describe('Given a malformed shallow oid', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE with the raw line', async () => {
        // Arrange
        const iter = asyncOf<PktLine>([dataPkt('shallow not-an-oid\n'), { kind: 'flush' }])[
          Symbol.asyncIterator
        ]();

        // Act & Assert
        let caught: unknown;
        try {
          await parseShallowResponse(iter);
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; line?: string };
        expect(data.code).toBe('INVALID_REF_LINE');
        expect(data.line).toContain('shallow not-an-oid');
      });
    });
  });

  describe('Given a malformed unshallow oid', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE', async () => {
        // Arrange
        const iter = asyncOf<PktLine>([
          dataPkt(`shallow ${OID1}\n`),
          dataPkt('unshallow xyz\n'),
          { kind: 'flush' },
        ])[Symbol.asyncIterator]();

        // Act & Assert
        let caught: unknown;
        try {
          await parseShallowResponse(iter);
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_REF_LINE');
      });
    });
  });

  describe('Given a non-shallow data line (server skipped the block)', () => {
    describe('When parsed', () => {
      it('Then returns empty arrays via parseUploadPackResponse', async () => {
        // Arrange — server omitted the shallow section entirely. The caller
        // calls parseUploadPackResponse with expectShallow:true; the parser must
        // hand the ACK line back to splitMeta correctly.
        const source = asyncOf<PktLine>([dataPkt('NAK\n'), { kind: 'flush' }]);

        // Act
        const result = await parseUploadPackResponse(source, {
          sideBand: false,
          expectShallow: true,
        });

        // Assert
        expect(result.shallow).toEqual([]);
        expect(result.unshallow).toEqual([]);
        expect(result.nak).toBe(true);
      });
    });
  });

  describe('Given a shallow block then NAK + pack via sideband', () => {
    describe('When parsed (expectShallow + sideBand)', () => {
      it('Then both shallow and pack body surface', async () => {
        // Arrange
        const packBytes = new Uint8Array([1, 2, 3]);
        const channel1 = new Uint8Array(packBytes.byteLength + 1);
        channel1[0] = 0x01;
        channel1.set(packBytes, 1);
        const source = asyncOf<PktLine>([
          dataPkt(`shallow ${OID1}\n`),
          { kind: 'flush' },
          dataPkt('NAK\n'),
          { kind: 'data', payload: channel1 },
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, {
          sideBand: true,
          expectShallow: true,
        });
        const collected = await collect(result.packBody);

        // Assert
        expect(result.shallow).toEqual([OID1]);
        expect(result.nak).toBe(true);
        expect(collected.reduce((n, c) => n + c.byteLength, 0)).toBe(packBytes.byteLength);
      });
    });
  });

  describe('Given expectShallow unset', () => {
    describe('When parsed', () => {
      it('Then shallow/unshallow are empty and behavior is unchanged', async () => {
        // Arrange
        const source = asyncOf<PktLine>([dataPkt('NAK\n'), { kind: 'flush' }]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: false });

        // Assert
        expect(result.shallow).toEqual([]);
        expect(result.unshallow).toEqual([]);
        expect(result.nak).toBe(true);
      });
    });
  });

  describe('Given an unknown verb prefix (`shallowish`)', () => {
    describe('When parsed', () => {
      it('Then treats the line as non-shallow and returns empty arrays', async () => {
        // Arrange — `parseShallowResponse` accepts only verbs whose first token
        // is exactly "shallow " or "unshallow " (trailing space). The fake
        // `shallowish ` would match a `startsWith('shallow')` mutant but not the
        // correct `startsWith('shallow ')` guard. The downstream `splitMeta`
        // sees the bogus line as the buffered peek and falls into the pack-body
        // branch, NAK is then unreachable — the assertions here pin both the
        // shallow path AND the downstream consequence.
        const source = asyncOf<PktLine>([
          dataPkt('shallowish bogus\n'),
          dataPkt('NAK\n'),
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, {
          sideBand: false,
          expectShallow: true,
        });

        // Assert — no shallow updates.
        expect(result.shallow).toEqual([]);
        expect(result.unshallow).toEqual([]);
        // splitMeta receives the bogus line as the buffered peek. Because the
        // line is neither ACK nor NAK, splitMeta treats it as the first packBody
        // pkt — `result.nak` stays false (the literal `NAK\n` after never reaches
        // splitMeta). This kills the prefix-broadening mutant: any mutant that
        // would let `shallowish` through as a shallow line would either populate
        // `shallow`/`unshallow` or change the downstream nak flag.
        expect(result.nak).toBe(false);
      });
    });
  });

  describe('Given an iterator that ends without a flush', () => {
    describe('When parsed', () => {
      it('Then returns the accumulated shallow updates without error', async () => {
        // Arrange — iterator yields one shallow line then ends. The
        // `while (!pkt.done)` loop exits naturally; the post-loop return must
        // surface the accumulated updates. Without this test the post-loop
        // return is unreachable through normal protocol streams.
        const iter = asyncOf<PktLine>([{ kind: 'data', payload: bytesOf(`shallow ${OID1}\n`) }])[
          Symbol.asyncIterator
        ]();

        // Act
        const sut = await parseShallowResponse(iter);

        // Assert
        expect(sut.shallow).toEqual([OID1]);
        expect(sut.unshallow).toEqual([]);
      });
    });
  });

  describe('Given exactly `shallow` with no space (boundary)', () => {
    describe('When parsed', () => {
      it('Then NOT treated as a shallow line', async () => {
        // Arrange — pins the `startsWith('shallow ')` vs `startsWith('shallow')`
        // mutant. The literal word `shallow\n` without a trailing oid is invalid.
        const source = asyncOf<PktLine>([
          dataPkt('shallow\n'),
          dataPkt('NAK\n'),
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, {
          sideBand: false,
          expectShallow: true,
        });

        // Assert — the `shallow\n` line missed the `'shallow '` prefix (no space
        // after the verb) so the parser treated it as the first non-shallow line.
        expect(result.shallow).toEqual([]);
        expect(result.unshallow).toEqual([]);
      });
    });
  });
});

describe('parseAdvertisedRefs — first-ref splitting boundaries', () => {
  describe('Given a malformed first-ref line', () => {
    describe('When parsed', () => {
      it.each([
        {
          label:
            'a payload starting with a NUL byte (empty head; kills the `nul <= 0` boundary mutant — not MISSING_CAPABILITIES)',
          refLinePayload: '\0caps\n',
          expectedLine: '\0caps',
        },
        {
          label:
            'a head with no space, NUL-terminated (kills the ConditionalExpression-false mutant on `space < 0`)',
          refLinePayload: 'notasha\0caps\n',
          expectedLine: 'notasha\0caps',
        },
        {
          label: 'a head starting with a space, empty id (kills the `space <= 0` boundary mutant)',
          refLinePayload: ' refs/heads/main\0caps\n',
          expectedLine: '',
        },
      ])('Then throws INVALID_REF_LINE ($label)', async ({ refLinePayload, expectedLine }) => {
        // Arrange
        const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
        const refStream = encodePktStream([bytesOf(refLinePayload)]);
        const body = concat(headerStream, refStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data as { code: string; line?: string };
          expect(data.code).toBe('INVALID_REF_LINE');
          expect(data.line).toBe(expectedLine);
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — subsequent-ref splitting boundaries', () => {
  describe('Given a subsequent ref line with no space', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE carrying the whole ref line', async () => {
        // Arrange — the trailing `${OID2}\n` ref has no space. The genuine guard
        // `space < 0` throws `invalidRefLine(line)` with the full 40-hex line; the
        // ConditionalExpression-false mutant skips it and surfaces a 39-hex slice.
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['caps'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });
        const extraStream = encodePktStream([bytesOf(`${OID2}\n`)]);
        const fullBody = concat(body.subarray(0, body.byteLength - 4), extraStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([fullBody])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data as { code: string; line?: string };
          expect(data.code).toBe('INVALID_REF_LINE');
          expect(data.line).toBe(OID2);
        }
      });
    });
  });

  describe('Given a subsequent ref line starting with a space (empty id)', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_REF_LINE with an empty line field', async () => {
        // Arrange — the trailing ref ` refs/heads/dev` starts with a space. The
        // genuine guard `space < 0` is false (space===0); parsing continues with an
        // empty id and `validateOidString('')` throws `invalidRefLine('')`. The
        // `space <= 0` mutant throws early carrying the full line.
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['caps'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });
        const extraStream = encodePktStream([bytesOf(' refs/heads/dev\n')]);
        const fullBody = concat(body.subarray(0, body.byteLength - 4), extraStream);

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(asyncBytes([fullBody])), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data as { code: string; line?: string };
          expect(data.code).toBe('INVALID_REF_LINE');
          expect(data.line).toBe('');
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — symref capability lookup', () => {
  describe('Given a non-symref capability before the symref one', () => {
    describe('When parsed', () => {
      it('Then HEAD resolves via the symref-prefixed capability', async () => {
        // Arrange — the symref cap is NOT first. The genuine `startsWith('symref=HEAD:')`
        // filter skips `multi_ack_detailed` and picks the real symref. A mutant that
        // empties the literal turns `startsWith('')` into always-true, picking the
        // first (wrong) capability and failing to resolve HEAD.
        const body = buildDiscoveryBody({
          service: 'git-upload-pack',
          capabilities: ['multi_ack_detailed', 'symref=HEAD:refs/heads/main'],
          refs: [{ name: 'refs/heads/main', id: OID1 }],
        });

        // Act
        const sut = await parseAdvertisedRefs(
          decodePktStream(asyncBytes([body])),
          'git-upload-pack',
        );

        // Assert
        expect(sut.head?.name).toBe('HEAD');
        expect(sut.head?.id).toBe(OID1);
      });
    });
  });
});

describe('parseAdvertisedRefs — missing service header carries empty actual', () => {
  describe('Given an empty stream', () => {
    describe('When parsed', () => {
      it('Then throws MISSING_SERVICE_HEADER with actual === ""', async () => {
        // Arrange — empty source: `consumeServiceHeader` throws before any text is
        // decoded, so the `actual` field is the literal empty string. A mutant
        // replacing that literal would surface a non-empty `actual`.
        const empty: AsyncIterable<Uint8Array> = (async function* () {
          // yield nothing
        })();

        // Act & Assert
        try {
          await parseAdvertisedRefs(decodePktStream(empty), 'git-upload-pack');
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data as { code: string; actual?: string };
          expect(data.code).toBe('MISSING_SERVICE_HEADER');
          expect(data.actual).toBe('');
        }
      });
    });
  });
});

describe('parseAdvertisedRefs — iterator cleanup on error', () => {
  describe('Given a parse error', () => {
    describe('When parseAdvertisedRefs rejects', () => {
      it('Then the source iterator return() is invoked', async () => {
        // Arrange — a hand-rolled async iterable whose `return` flips a flag. The
        // service header is malformed (a ref line, not `# service=`), so parsing
        // throws and the `finally` block must call `iter.return`. The
        // BlockStatement mutant that empties the `finally` body would skip it.
        let returned = false;
        const source: AsyncIterable<PktLine> = {
          [Symbol.asyncIterator]() {
            let emitted = false;
            return {
              next(): Promise<IteratorResult<PktLine>> {
                if (emitted) return Promise.resolve({ done: true, value: undefined });
                emitted = true;
                return Promise.resolve({
                  done: false,
                  value: { kind: 'data', payload: bytesOf(`${OID1} refs/heads/main\0caps\n`) },
                });
              },
              return(): Promise<IteratorResult<PktLine>> {
                returned = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        };

        // Act
        let caught: unknown;
        try {
          await parseAdvertisedRefs(source, 'git-upload-pack');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(returned).toBe(true);
      });
    });
  });
});

describe('parseUploadPackResponse — buffered non-data first packet', () => {
  describe('Given a flush followed by raw pack data', () => {
    describe('When parsed (sideBand:false)', () => {
      it('Then the flush is buffered so packBody yields nothing', async () => {
        // Arrange — `splitMeta` returns at the leading flush with `buffered:[flush]`.
        // `replay` re-emits that flush ahead of the iterator, so `rawPackBytes`
        // stops on it and the data packet after is never surfaced. The
        // ArrayDeclaration mutant (`buffered: []`) would drop the flush and let the
        // trailing data leak into packBody.
        const leaked = new Uint8Array([9, 9, 9]);
        const source = asyncOf<PktLine>([{ kind: 'flush' }, { kind: 'data', payload: leaked }]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: false });
        const collected = await collect(result.packBody);

        // Assert — the buffered flush terminates the pack body before the data.
        expect(collected).toEqual([]);
      });
    });
  });

  describe('Given a shallow line as the first packet with expectShallow falsy', () => {
    describe('When parsed', () => {
      it('Then it is NOT consumed as a shallow update', async () => {
        // Arrange — `expectShallow` is unset, so `parseShallowResponse` must be
        // skipped entirely. The `ConditionalExpression -> true` mutant would force
        // the shallow parser on, consuming the `shallow <oid>` line into
        // `result.shallow` instead of leaving it for `splitMeta`/packBody.
        const source = asyncOf<PktLine>([
          { kind: 'data', payload: bytesOf(`shallow ${OID1}\n`) },
          { kind: 'flush' },
        ]);

        // Act
        const result = await parseUploadPackResponse(source, { sideBand: false });

        // Assert — no shallow updates surfaced; the line stays out of the shallow block.
        expect(result.shallow).toEqual([]);
        expect(result.unshallow).toEqual([]);
      });
    });
  });
});

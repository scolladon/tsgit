import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../../src/domain/error.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/object-id.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../../src/domain/protocol/pkt-line.js';
import { MAX_ADVERTISED_REFS } from '../../../../../src/domain/protocol/upload-pack.js';
import {
  buildLsRefsRequest,
  parseLsRefsResponse,
} from '../../../../../src/domain/protocol/v2/ls-refs.js';

const ENCODER = new TextEncoder();
const bytesOf = (s: string): Uint8Array => ENCODER.encode(s);

const OID1 = OID.from('1'.repeat(40));
const OID2 = OID.from('2'.repeat(40));
const OID3 = OID.from('3'.repeat(40));

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

const dataLine = (text: string): PktLine => ({ kind: 'data', payload: bytesOf(text) });

const responseBody = (lines: ReadonlyArray<string>): AsyncIterable<PktLine> =>
  decodePktStream(asyncOf([encodePktStream(lines.map(bytesOf))]), { v2: true });

describe('buildLsRefsRequest', () => {
  describe('Given symrefs, peel, and ref-prefixes', () => {
    describe('When buildLsRefsRequest builds the request', () => {
      it('Then it emits command=ls-refs, delim, symrefs, peel, and one ref-prefix line per prefix, flush', async () => {
        // Arrange
        const sut = buildLsRefsRequest;

        // Act
        const bytes = sut({
          symrefs: true,
          peel: true,
          refPrefixes: ['HEAD', 'refs/heads/', 'refs/tags/'],
        });
        const lines = await decodeAll(bytes);

        // Assert
        expect(lines).toEqual([
          dataLine('command=ls-refs\n'),
          dataLine(`${AGENT}\n`),
          dataLine('object-format=sha1\n'),
          { kind: 'delim' },
          dataLine('symrefs\n'),
          dataLine('peel\n'),
          dataLine('ref-prefix HEAD\n'),
          dataLine('ref-prefix refs/heads/\n'),
          dataLine('ref-prefix refs/tags/\n'),
          { kind: 'flush' },
        ]);
      });
    });
  });

  describe('Given symrefs and peel both omitted and no ref-prefixes', () => {
    describe('When buildLsRefsRequest builds the request', () => {
      it('Then it emits only the command header, delim, and flush', async () => {
        // Arrange
        const sut = buildLsRefsRequest;

        // Act
        const bytes = sut({});
        const lines = await decodeAll(bytes);

        // Assert
        expect(lines).toEqual([
          dataLine('command=ls-refs\n'),
          dataLine(`${AGENT}\n`),
          dataLine('object-format=sha1\n'),
          { kind: 'delim' },
          { kind: 'flush' },
        ]);
      });
    });
  });
});

describe('parseLsRefsResponse', () => {
  describe('Given an ls-refs response with a symref-target HEAD', () => {
    describe('When parsed', () => {
      it('Then head is synthesized with the target’s oid', async () => {
        // Arrange
        const stream = responseBody([
          `${OID2} HEAD symref-target:refs/heads/main\n`,
          `${OID1} refs/heads/main\n`,
        ]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.head).toEqual({ name: 'HEAD', id: OID1 });
        expect(sut.refs.find((r) => r.name === 'refs/heads/main')).toEqual({
          name: 'refs/heads/main',
          id: OID1,
        });
      });

      it('Then capabilities carries the synthesized symref=HEAD:<target> entry', async () => {
        // Arrange
        const stream = responseBody([
          `${OID2} HEAD symref-target:refs/heads/main\n`,
          `${OID1} refs/heads/main\n`,
        ]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.capabilities).toEqual(['symref=HEAD:refs/heads/main']);
      });
    });
  });

  describe('Given a symref-target HEAD line whose first token is an empty oid (leading space)', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE — the symref branch must still validate the oid token', async () => {
        // Arrange — a leading space makes the first token the empty string. Git
        // requires an ls-refs line's first token to be a valid oid or `unborn`;
        // the symref branch previously skipped that check and accepted it.
        const line = ' HEAD symref-target:refs/heads/main';
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given a symref-target HEAD line whose first token is neither an oid nor unborn', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE — a garbage first token is rejected on the symref branch', async () => {
        // Arrange — `zzzz` is neither a valid oid nor the `unborn` literal, so
        // git rejects the line; the symref branch previously accepted it and
        // advertised a bogus symref capability.
        const line = 'zzzz HEAD symref-target:refs/heads/main';
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given an ls-refs response with a peeled tag', () => {
    describe('When parsed', () => {
      it('Then the tag ref carries its peeled oid', async () => {
        // Arrange
        const stream = responseBody([`${OID1} refs/tags/v1 peeled:${OID2}\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.refs.find((r) => r.name === 'refs/tags/v1')?.peeled).toBe(OID2);
      });
    });
  });

  describe('Given an ls-refs response whose peeled attribute is not an oid', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE carrying the line', async () => {
        // Arrange — only the line's first token is checked while the ref line is
        // split; the peeled oid is validated when the ref is appended.
        const line = `${OID1} refs/tags/v1 peeled:nonsense`;
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given an unborn ref line that carries no symref-target', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE — unborn is only meaningful on a symref line', async () => {
        // Arrange — `unborn` is tolerated as a first token so the symref branch
        // can read it, but a line that never reaches that branch still has to
        // produce a real oid.
        const line = 'unborn refs/heads/main';
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given an ls-refs response line with a malformed oid', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE carrying the line', async () => {
        // Arrange
        const line = 'not-an-oid refs/heads/main\n';
        const stream = responseBody([line]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({
          code: 'INVALID_REF_LINE',
          line: 'not-an-oid refs/heads/main',
        });
      });
    });
  });

  describe('Given an oid token with garbage before an otherwise-valid 40-hex suffix', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE — the oid check must anchor at the start', async () => {
        // Arrange — an unanchored start would let the oid regex find a valid
        // 40-hex run starting after the "zz" prefix instead of rejecting the
        // token outright.
        const line = `zz${'3'.repeat(40)} refs/heads/main`;
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given an oid token with a 40-hex prefix followed by trailing garbage', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE — the oid check must anchor at the end', async () => {
        // Arrange — an unanchored end would let the oid regex stop matching
        // after the first 40 hex chars instead of rejecting the trailing
        // garbage.
        const line = `${'3'.repeat(40)}zz refs/heads/main`;
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given an oid token that is a valid 64-hex SHA-256-style id', () => {
    describe('When parsed', () => {
      it('Then it is accepted — the optional 24-hex-char suffix group must allow 64-char oids', async () => {
        // Arrange
        const oid64 = '3'.repeat(64);
        const stream = responseBody([`${oid64} refs/heads/main\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.refs).toEqual([{ name: 'refs/heads/main', id: OID.from(oid64) }]);
      });
    });
  });

  describe('Given an ls-refs response line with no space separator', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE carrying the line', async () => {
        // Arrange
        const stream = responseBody(['garbage\n']);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line: 'garbage' });
      });
    });
  });

  describe('Given a ref line with no space separator whose implied name-slice still looks like a valid oid', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE via the missing-space guard rather than accepting a corrupted parse', async () => {
        // Arrange — 41 hex chars, no space at all. The first 40 chars alone
        // would pass the oid check, so only the `spaceIdx < 0` guard (not
        // later oid validation) can catch this malformed line.
        const line = '1'.repeat(41);
        const stream = responseBody([`${line}\n`]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'INVALID_REF_LINE', line });
      });
    });
  });

  describe('Given an ls-refs response line with an empty ref name', () => {
    describe('When parsed', () => {
      it('Then it throws INVALID_REF_LINE carrying the line', async () => {
        // Arrange
        const line = `${OID1} \n`;
        const stream = responseBody([line]);

        // Act
        let sut: unknown;
        try {
          await parseLsRefsResponse(stream);
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({
          code: 'INVALID_REF_LINE',
          line: `${OID1} `,
        });
      });
    });
  });

  describe('Given an unborn HEAD symref-target whose branch does not exist yet', () => {
    describe('When parsed', () => {
      it('Then head is undefined and no HEAD ref is added', async () => {
        // Arrange
        const stream = responseBody(['unborn HEAD symref-target:refs/heads/main\n']);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.head).toBeUndefined();
        expect(sut.refs).toEqual([]);
      });

      it('Then capabilities still carries the synthesized symref=HEAD:<target> entry (v1-ghost parity)', async () => {
        // Arrange — mirrors v1's own broken-symref ("ghost") behaviour: the
        // target branch not existing yet leaves `head` unresolved, but the
        // capability that names the tracked branch is advertised regardless,
        // so a client can still create the correctly-named local branch.
        const stream = responseBody(['unborn HEAD symref-target:refs/heads/main\n']);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.capabilities).toEqual(['symref=HEAD:refs/heads/main']);
      });
    });
  });

  describe('Given a detached HEAD line with no symref-target attribute', () => {
    describe('When parsed', () => {
      it('Then head is the direct HEAD ref and it is present in refs', async () => {
        // Arrange
        const stream = responseBody([`${OID3} HEAD\n`, `${OID1} refs/heads/main\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.head).toEqual({ name: 'HEAD', id: OID3 });
        expect(sut.refs).toEqual([
          { name: 'HEAD', id: OID3 },
          { name: 'refs/heads/main', id: OID1 },
        ]);
      });

      it('Then capabilities stays empty', async () => {
        // Arrange
        const stream = responseBody([`${OID3} HEAD\n`, `${OID1} refs/heads/main\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.capabilities).toEqual([]);
      });
    });
  });

  describe('Given an ls-refs response with no capability line', () => {
    describe('When parsed', () => {
      it('Then capabilities is empty', async () => {
        // Arrange
        const stream = responseBody([`${OID1} refs/heads/main\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.capabilities).toEqual([]);
      });
    });
  });

  describe('Given a data line with no trailing newline', () => {
    describe('When parsed', () => {
      it('Then the line is still parsed as a ref', async () => {
        // Arrange
        const stream = responseBody([`${OID1} refs/heads/main`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.refs).toEqual([{ name: 'refs/heads/main', id: OID1 }]);
      });
    });
  });

  describe('Given a symref-target line for a ref other than HEAD', () => {
    describe('When parsed', () => {
      it('Then the line is dropped and no ref is added for it', async () => {
        // Arrange
        const stream = responseBody([
          `${OID2} refs/remotes/origin/HEAD symref-target:refs/heads/main\n`,
          `${OID1} refs/heads/main\n`,
        ]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.refs).toEqual([{ name: 'refs/heads/main', id: OID1 }]);
        expect(sut.head).toBeUndefined();
      });
    });
  });

  describe('Given a ref name that itself begins with the symref-target prefix and carries no attrs', () => {
    describe('When parsed', () => {
      it('Then the ref is still added — the bare name is never treated as its own attribute', async () => {
        // Arrange — there is no space after the name, so the attrs slice
        // must stay []; re-including the name itself would let it match its
        // own "symref-target:" prefix and get silently dropped instead.
        const stream = responseBody([`${OID1} symref-target:sneaky\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.refs).toEqual([{ name: 'symref-target:sneaky', id: OID1 }]);
      });
    });
  });

  describe('Given a ref name that begins with the symref-target prefix and carries a genuine trailing peeled attribute', () => {
    describe('When parsed', () => {
      it('Then the trailing attrs are sliced away from the name — the peeled oid is captured, not a bogus symref-target', async () => {
        // Arrange — there is a genuine attrs section this time. Dropping the
        // slice that removes the name from the attrs list would re-include
        // the name, letting its own "symref-target:" prefix match first and
        // swallow the ref before the real peeled attribute is even read.
        const stream = responseBody([`${OID1} symref-target:sneaky peeled:${OID2}\n`]);

        // Act
        const sut = await parseLsRefsResponse(stream);

        // Assert
        expect(sut.refs).toEqual([{ name: 'symref-target:sneaky', id: OID1, peeled: OID2 }]);
      });
    });
  });
});

describe('parseLsRefsResponse — advertised-refs cap', () => {
  describe('Given a response exceeding MAX_ADVERTISED_REFS', () => {
    describe('When parsed', () => {
      it('Then throws TOO_MANY_ADVERTISED_REFS before allocating beyond the cap', async () => {
        // Arrange — synthesize a PktLine async iterable directly so we don't
        // have to build MAX_ADVERTISED_REFS+1 raw bytes (that would balloon the
        // test). The parser consumes pkt-lines, not bytes, so an in-process
        // generator is the cheapest fixture.
        const overage = MAX_ADVERTISED_REFS + 1;
        async function* pkts(): AsyncIterable<PktLine> {
          for (let i = 0; i < overage; i += 1) {
            const padded = i.toString(16).padStart(40, '0');
            yield dataLine(`${padded} refs/heads/b${i}\n`);
          }
          yield { kind: 'flush' };
        }

        // Act
        let caught: unknown;
        try {
          await parseLsRefsResponse(pkts());
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
        expect(data.count).toBe(overage);
      }, 30_000);
    });
  });

  describe('Given a response with exactly MAX_ADVERTISED_REFS refs', () => {
    describe('When parsed', () => {
      it('Then it resolves with refs.length === MAX_ADVERTISED_REFS', async () => {
        // Arrange
        async function* pkts(): AsyncIterable<PktLine> {
          for (let i = 0; i < MAX_ADVERTISED_REFS; i += 1) {
            const padded = i.toString(16).padStart(40, '0');
            yield dataLine(`${padded} refs/heads/b${i}\n`);
          }
          yield { kind: 'flush' };
        }

        // Act
        const sut = await parseLsRefsResponse(pkts());

        // Assert
        expect(sut.refs.length).toBe(MAX_ADVERTISED_REFS);
      }, 30_000);
    });
  });
});

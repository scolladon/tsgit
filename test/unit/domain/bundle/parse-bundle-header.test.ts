import { describe, expect, it } from 'vitest';

import { parseBundleHeader } from '../../../../src/domain/bundle/parse-bundle-header.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/object-id.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));
const OID_SHA256_A = ObjectId.from('a'.repeat(64));

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseBundleHeader', () => {
  describe('Given a valid v2 bundle with no prerequisites, When parsed', () => {
    it('Then returns version 2, sha1, no prerequisites, and correct packOffset', () => {
      // Arrange
      const header = `# v2 git bundle\n${OID_A} refs/heads/main\n\n`;
      const bytes = encode(header);

      // Act
      const result = parseBundleHeader(bytes, 'test.bundle');

      // Assert
      expect(result.version).toBe(2);
      expect(result.hashAlgorithm).toBe('sha1');
      expect(result.prerequisites).toEqual([]);
      expect(result.refs).toEqual([{ oid: OID_A, name: RefName.from('refs/heads/main') }]);
      expect(result.packOffset).toBe(bytes.length);
    });
  });

  describe('Given a valid v2 bundle with prerequisites and refs, When parsed', () => {
    it('Then parses prerequisites and refs correctly with correct packOffset', () => {
      // Arrange
      const header = `# v2 git bundle\n-${OID_A} first commit\n${OID_B} refs/heads/main\n\n`;
      const packBytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // 'PACK'
      const allBytes = new Uint8Array(encode(header).length + packBytes.length);
      allBytes.set(encode(header), 0);
      allBytes.set(packBytes, encode(header).length);

      // Act
      const result = parseBundleHeader(allBytes, 'test.bundle');

      // Assert
      expect(result.version).toBe(2);
      expect(result.prerequisites).toEqual([{ oid: OID_A, comment: 'first commit' }]);
      expect(result.refs).toEqual([{ oid: OID_B, name: RefName.from('refs/heads/main') }]);
      expect(result.packOffset).toBe(encode(header).length);
    });
  });

  describe('Given bytes with pack data after the header, When parsed', () => {
    it('Then packOffset points to the byte immediately after the blank line', () => {
      // Arrange
      const header = `# v2 git bundle\n${OID_A} HEAD\n\n`;
      const extra = encode('PACK some pack data here');
      const bytes = new Uint8Array(encode(header).length + extra.length);
      bytes.set(encode(header), 0);
      bytes.set(extra, encode(header).length);

      // Act
      const result = parseBundleHeader(bytes, 'x.bundle');

      // Assert
      expect(result.packOffset).toBe(encode(header).length);
      // The bytes from packOffset onwards should be the pack data
      expect(bytes.subarray(result.packOffset, result.packOffset + 4)).toEqual(
        new TextEncoder().encode('PACK'),
      );
    });
  });

  describe('Given a malformed or unsupported header, When parsed', () => {
    it.each([
      {
        label: 'the magic line is not a bundle magic',
        bytes: encode('not a bundle file\nsome content\n\n'),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'not-a-bundle' },
      },
      {
        label: 'a v3 header has a ref line with no capability block',
        bytes: encode(`# v3 git bundle\n${OID_A} refs/heads/main\n\n`),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        label: 'the magic line is missing (empty bytes)',
        bytes: encode(''),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'not-a-bundle' },
      },
      {
        label: 'the header has no blank line terminator',
        bytes: encode(`# v2 git bundle\n${OID_A} refs/heads/main\n`),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        label: 'a ref line has a non-hex oid',
        bytes: encode(`# v2 git bundle\n${'z'.repeat(40)} refs/heads/main\n\n`),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        label: 'a prerequisite line has a non-hex oid',
        bytes: encode(
          `# v2 git bundle\n-${'z'.repeat(40)} bad prereq\n${OID_B} refs/heads/main\n\n`,
        ),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        label: 'the v2 header contains a capability (@) line',
        bytes: encode(`# v2 git bundle\n@object-format=sha1\n${OID_A} refs/heads/main\n\n`),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        label: 'a ref line contains no space (oid only, no refname)',
        bytes: encode(`# v2 git bundle\n${'a'.repeat(40)}\n\n`),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        label: 'the header starts with a blank line and has no magic line before the terminator',
        bytes: (() => {
          const headerBytes = encode('\n\n');
          const packBytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // 'PACK'
          const bytes = new Uint8Array(headerBytes.length + packBytes.length);
          bytes.set(headerBytes, 0);
          bytes.set(packBytes, headerBytes.length);
          return bytes;
        })(),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'not-a-bundle' },
      },
      {
        label: 'the header is v3 magic line with no blank line terminator',
        bytes: encode('# v3 git bundle'),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        // 41-char string, first 40 chars are valid hex; no space present. Without the
        // spaceIdx===-1 guard, slice(0,-1) yields 40 valid hex chars and the line would
        // be misread as a valid ref line instead of throwing.
        label: 'a ref line has 41 chars and no space (valid-hex-40 prefix plus one extra char)',
        bytes: encode(`# v2 git bundle\n${'a'.repeat(40)}b\n\n`),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
      {
        // Leading bytes precede the v3 magic, so the header does not START with a bundle
        // signature; classification keys off the leading bytes (not-a-bundle). An
        // endsWith check would misread the trailing magic and reclassify it as malformed.
        label:
          'the header ends with the v3 magic but does not start with a bundle signature and has no blank-line terminator',
        bytes: encode('X# v3 git bundle'),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'not-a-bundle' },
      },
      {
        label: 'a large payload has v2 magic but no blank-line terminator',
        bytes: (() => {
          const headerPart = encode(`# v2 git bundle\n${OID_A} refs/heads/main\n`);
          // 1 MB of zeros simulating a large embedded packfile with no blank line in header
          const packData = new Uint8Array(1_000_000);
          const bytes = new Uint8Array(headerPart.length + packData.length);
          bytes.set(headerPart, 0);
          bytes.set(packData, headerPart.length);
          return bytes;
        })(),
        expected: { code: 'BUNDLE_BAD_HEADER', reason: 'malformed-header' },
      },
    ])('Then throws because $label', ({ bytes, expected }) => {
      // Arrange + Act + Assert
      try {
        parseBundleHeader(bytes, 'test.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: Record<string, unknown> }).data).toMatchObject(expected);
      }
    });
  });

  describe('Given a v2 bundle with a HEAD ref line, When parsed', () => {
    it('Then parses HEAD as the ref name', () => {
      // Arrange
      const header = `# v2 git bundle\n${OID_A} HEAD\n\n`;
      const bytes = encode(header);

      // Act
      const result = parseBundleHeader(bytes, 'head.bundle');

      // Assert
      expect(result.refs).toEqual([{ oid: OID_A, name: RefName.from('HEAD') }]);
    });
  });

  describe('Given a prerequisite line with no space (oid only, no comment), When parsed', () => {
    it('Then parses the prerequisite with an empty comment', () => {
      // Arrange
      const bytes = encode(
        `# v2 git bundle\n-${'a'.repeat(40)}\n${'b'.repeat(40)} refs/heads/main\n\n`,
      );

      // Act
      const result = parseBundleHeader(bytes, 'no-comment-prereq.bundle');

      // Assert
      expect(result.prerequisites).toEqual([{ oid: OID_A, comment: '' }]);
    });
  });

  describe('Given a ref line with a valid oid and a refname ending with @, When parsed', () => {
    it('Then parses successfully without throwing', () => {
      // Arrange — a refname ending in @ is valid; the startsWith('@') guard at the
      // line-type dispatch only fires when the WHOLE line starts with @.
      const bytes = encode(`# v2 git bundle\n${'a'.repeat(40)} refs/heads/main@\n\n`);

      // Act
      const result = parseBundleHeader(bytes, 'at-suffix.bundle');

      // Assert
      expect(result.refs).toHaveLength(1);
      expect(result.refs[0]!.name).toBe('refs/heads/main@');
    });
  });

  describe('Given a v3 header declaring object-format sha256, When parsed', () => {
    it('Then version is 3, hashAlgorithm is sha256 and the 64-hex refs parse', () => {
      // Arrange
      const bytes = encode(
        `# v3 git bundle\n@object-format=sha256\n${OID_SHA256_A} refs/heads/main\n\n`,
      );

      // Act
      const result = parseBundleHeader(bytes, 'v3-sha256.bundle');

      // Assert
      expect(result.version).toBe(3);
      expect(result.hashAlgorithm).toBe('sha256');
      expect(result.refs).toEqual([{ oid: OID_SHA256_A, name: RefName.from('refs/heads/main') }]);
    });
  });

  describe('Given a v3 header declaring object-format sha1, When parsed', () => {
    it('Then version is 3, hashAlgorithm is sha1 and the 40-hex refs parse', () => {
      // Arrange
      const bytes = encode(`# v3 git bundle\n@object-format=sha1\n${OID_A} refs/heads/main\n\n`);

      // Act
      const result = parseBundleHeader(bytes, 'v3-sha1.bundle');

      // Assert
      expect(result.version).toBe(3);
      expect(result.hashAlgorithm).toBe('sha1');
      expect(result.refs).toEqual([{ oid: OID_A, name: RefName.from('refs/heads/main') }]);
    });
  });

  describe('Given a v3 header with @filter before @object-format, When parsed', () => {
    it('Then both capabilities apply regardless of order', () => {
      // Arrange
      const bytes = encode(
        `# v3 git bundle\n@filter=blob:none\n@object-format=sha1\n${OID_A} refs/heads/main\n\n`,
      );

      // Act
      const result = parseBundleHeader(bytes, 'swapped-caps.bundle');

      // Assert
      expect(result.version).toBe(3);
      expect(result.hashAlgorithm).toBe('sha1');
      expect(result.filter).toEqual({ kind: 'blob-none' });
    });
  });

  describe('Given a v3 header with duplicate object-format sha1 then sha256, When parsed', () => {
    it('Then the last value wins and the 64-hex ref parses', () => {
      // Arrange
      const bytes = encode(
        `# v3 git bundle\n@object-format=sha1\n@object-format=sha256\n${OID_SHA256_A} refs/heads/main\n\n`,
      );

      // Act
      const result = parseBundleHeader(bytes, 'dup-caps-sha1-sha256.bundle');

      // Assert
      expect(result.hashAlgorithm).toBe('sha256');
      expect(result.refs).toEqual([{ oid: OID_SHA256_A, name: RefName.from('refs/heads/main') }]);
    });
  });

  describe('Given a v3 header with duplicate object-format sha256 then sha1, When parsed', () => {
    it('Then the last value wins and fails on the first (64-hex) ref line', () => {
      // Arrange — proves last-wins rather than first-wins: if sha256 (the
      // first value) had won, this 64-hex ref line would parse successfully.
      const bytes = encode(
        `# v3 git bundle\n@object-format=sha256\n@object-format=sha1\n${OID_SHA256_A} refs/heads/main\n\n`,
      );
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'dup-caps-sha256-sha1.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as { code: string; reason?: string };
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      expect(data.reason).toBe('malformed-header');
    });
  });

  describe('Given a v3 header with an unknown capability, When parsed', () => {
    it('Then throws unknown-capability carrying the whole name=value text', () => {
      // Arrange
      const bytes = encode('# v3 git bundle\n@bogus=1\n\n');
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'bogus-cap.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as {
        code: string;
        reason?: string;
        capability?: string;
      };
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      expect(data.reason).toBe('unknown-capability');
      expect(data.capability).toBe('bogus=1');
    });
  });

  describe('Given a v3 header with a valueless object-format capability, When parsed', () => {
    it('Then throws unknown-capability — a missing value is a different key, not a missing one', () => {
      // Arrange
      const bytes = encode('# v3 git bundle\n@object-format\n\n');
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'valueless-object-format.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as {
        code: string;
        reason?: string;
        capability?: string;
      };
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      expect(data.reason).toBe('unknown-capability');
      expect(data.capability).toBe('object-format');
    });
  });

  describe('Given a v3 header with a bare @ capability line, When parsed', () => {
    it('Then throws unknown-capability with an empty capability text', () => {
      // Arrange
      const bytes = encode('# v3 git bundle\n@\n\n');
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'bare-at.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as {
        code: string;
        reason?: string;
        capability?: string;
      };
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      expect(data.reason).toBe('unknown-capability');
      expect(data.capability).toBe('');
    });
  });

  describe('Given a v3 header declaring an unrecognised hash algorithm, When parsed', () => {
    it('Then throws unknown-hash-algorithm carrying the algorithm value', () => {
      // Arrange
      const bytes = encode('# v3 git bundle\n@object-format=sha512\n\n');
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'bad-algo.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as {
        code: string;
        reason?: string;
        algorithm?: string;
      };
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      expect(data.reason).toBe('unknown-hash-algorithm');
      expect(data.algorithm).toBe('sha512');
    });
  });

  describe('Given a v3 header whose object-format capability arrives after the first ref line, When parsed', () => {
    it('Then throws malformed-header on that first ref line, never reaching the later capability', () => {
      // Arrange
      const refLine = `${OID_SHA256_A} refs/heads/main`;
      const bytes = encode(`# v3 git bundle\n${refLine}\n@object-format=sha256\n\n`);
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'late-cap.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as {
        code: string;
        reason?: string;
        line?: string;
        length?: number;
      };
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      expect(data.reason).toBe('malformed-header');
      expect(data.line).toBe(refLine);
      expect(data.length).toBe(new TextEncoder().encode(refLine).length);
    });
  });

  describe('Given a v3 header with @filter=blob:none, When parsed', () => {
    it('Then the parsed filter is exposed on the result', () => {
      // Arrange
      const bytes = encode(
        `# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n${OID_A} refs/heads/main\n\n`,
      );

      // Act
      const result = parseBundleHeader(bytes, 'filter.bundle');

      // Assert
      expect(result.filter).toEqual({ kind: 'blob-none' });
    });
  });

  describe('Given a v3 header with @filter=bogus, When parsed', () => {
    it('Then throws INVALID_FILTER_SPEC with the offending spec — validated eagerly, not parsed-and-ignored', () => {
      // Arrange
      const bytes = encode('# v3 git bundle\n@filter=bogus\n\n');
      let thrown: unknown;

      // Act
      try {
        parseBundleHeader(bytes, 'bad-filter.bundle');
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      const data = (thrown as TsgitError).data as { code: string; spec?: string };
      expect(data.code).toBe('INVALID_FILTER_SPEC');
      expect(data.spec).toBe('bogus');
    });
  });

  describe('Given a v3 header with no capabilities and no content lines, When parsed', () => {
    it('Then hashAlgorithm defaults to sha1', () => {
      // Arrange
      const bytes = encode('# v3 git bundle\n\n');

      // Act
      const result = parseBundleHeader(bytes, 'empty-v3.bundle');

      // Assert
      expect(result.version).toBe(3);
      expect(result.hashAlgorithm).toBe('sha1');
      expect(result.prerequisites).toEqual([]);
      expect(result.refs).toEqual([]);
    });
  });

  describe('Given a v3 header whose capability text is far longer than any legal value, When parsed', () => {
    it('Then the refusal reports a bounded, control-byte-free capability', () => {
      // Arrange — bundle bytes are untrusted and a header line is unbounded,
      // so the reported text is capped and escaped rather than echoed whole.
      const hostile = `${'A'.repeat(4000)}\u0007\u001b[31m`;
      const bytes = encode(`# v3 git bundle\n@${hostile}\n${OID_A} refs/heads/main\n\n`);
      const sut = parseBundleHeader;

      // Act
      let caught: unknown;
      try {
        sut(bytes, 'hostile.bundle');
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      if (data.code !== 'BUNDLE_BAD_HEADER') expect.unreachable();
      expect(data.reason).toBe('unknown-capability');
      if (data.reason !== 'unknown-capability') expect.unreachable();
      expect(data.capability.length).toBeLessThanOrEqual(256);
      expect(data.capability).not.toContain('\u0007');
      expect(data.capability).not.toContain('\u001b');
    });
  });

  describe('Given a header with no blank line whose first line exceeds the 64-byte diagnostic cap, When parsed', () => {
    it('Then the reported line and length are capped, not the whole untrusted first line', () => {
      // Arrange — bundle bytes are untrusted, so the diagnostic reads a bounded
      // prefix. The bound is observable: this first line is 76 bytes, and only
      // its first 64 may reach the payload.
      const firstLine = `${'# v2 git bundle'}${'X'.repeat(61)}`;
      const bytes = encode(`${firstLine}\ntrailing junk\n`);
      const sut = parseBundleHeader;

      // Act
      let caught: unknown;
      try {
        sut(bytes, 'long-first-line.bundle');
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(firstLine.length).toBe(76);
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BUNDLE_BAD_HEADER');
      if (data.code !== 'BUNDLE_BAD_HEADER') expect.unreachable();
      expect(data.reason).toBe('malformed-header');
      if (data.reason !== 'malformed-header') expect.unreachable();
      expect(data.line).toBe(firstLine.slice(0, 64));
      expect(data.length).toBe(64);
    });
  });
});

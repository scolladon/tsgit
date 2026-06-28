import { describe, expect, it } from 'vitest';

import { parseBundleHeader } from '../../../../src/domain/bundle/parse-bundle-header.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/object-id.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('Given parseBundleHeader', () => {
  describe('When given a valid v2 bundle with no prerequisites', () => {
    it('Then returns version 2, sha1, no prerequisites, and correct packOffset', () => {
      // Arrange
      const sut = parseBundleHeader;
      const header = `# v2 git bundle\n${OID_A} refs/heads/main\n\n`;
      const bytes = encode(header);

      // Act
      const result = sut(bytes, 'test.bundle');

      // Assert
      expect(result.version).toBe(2);
      expect(result.hashAlgorithm).toBe('sha1');
      expect(result.prerequisites).toEqual([]);
      expect(result.refs).toEqual([{ oid: OID_A, name: RefName.from('refs/heads/main') }]);
      expect(result.packOffset).toBe(bytes.length);
    });
  });

  describe('When given a valid v2 bundle with prerequisites and refs', () => {
    it('Then parses prerequisites and refs correctly with correct packOffset', () => {
      // Arrange
      const sut = parseBundleHeader;
      const header = `# v2 git bundle\n-${OID_A} first commit\n${OID_B} refs/heads/main\n\n`;
      const packBytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // 'PACK'
      const allBytes = new Uint8Array(encode(header).length + packBytes.length);
      allBytes.set(encode(header), 0);
      allBytes.set(packBytes, encode(header).length);

      // Act
      const result = sut(allBytes, 'test.bundle');

      // Assert
      expect(result.version).toBe(2);
      expect(result.prerequisites).toEqual([{ oid: OID_A, comment: 'first commit' }]);
      expect(result.refs).toEqual([{ oid: OID_B, name: RefName.from('refs/heads/main') }]);
      expect(result.packOffset).toBe(encode(header).length);
    });
  });

  describe('When given bytes with pack data after the header', () => {
    it('Then packOffset points to the byte immediately after the blank line', () => {
      // Arrange
      const sut = parseBundleHeader;
      const header = `# v2 git bundle\n${OID_A} HEAD\n\n`;
      const extra = encode('PACK some pack data here');
      const bytes = new Uint8Array(encode(header).length + extra.length);
      bytes.set(encode(header), 0);
      bytes.set(extra, encode(header).length);

      // Act
      const result = sut(bytes, 'x.bundle');

      // Assert
      expect(result.packOffset).toBe(encode(header).length);
      // The bytes from packOffset onwards should be the pack data
      expect(bytes.subarray(result.packOffset, result.packOffset + 4)).toEqual(
        new TextEncoder().encode('PACK'),
      );
    });
  });

  describe('When magic line is not a bundle magic', () => {
    it('Then throws bundleBadHeader with code BUNDLE_BAD_HEADER and reason not-a-bundle', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode('not a bundle file\nsome content\n\n');

      // Act + Assert
      try {
        sut(bytes, 'bad.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'not-a-bundle',
        );
      }
    });
  });

  describe('When magic line is v3 git bundle', () => {
    it('Then throws bundleUnsupportedVersion with code BUNDLE_UNSUPPORTED_VERSION and version 3', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode(`# v3 git bundle\n${OID_A} refs/heads/main\n\n`);

      // Act + Assert
      try {
        sut(bytes, 'v3.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; version: number } }).data.code).toBe(
          'BUNDLE_UNSUPPORTED_VERSION',
        );
        expect((err as { data: { code: string; version: number } }).data.version).toBe(3);
      }
    });
  });

  describe('When magic line is missing (empty bytes)', () => {
    it('Then throws bundleBadHeader with reason not-a-bundle', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode('');

      // Act + Assert
      try {
        sut(bytes, 'empty.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'not-a-bundle',
        );
      }
    });
  });

  describe('When header has no blank line terminator', () => {
    it('Then throws bundleBadHeader with reason malformed-header', () => {
      // Arrange
      const sut = parseBundleHeader;
      // No blank line at end
      const bytes = encode(`# v2 git bundle\n${OID_A} refs/heads/main\n`);

      // Act + Assert
      try {
        sut(bytes, 'no-blank.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });

  describe('When a ref line has a non-hex oid', () => {
    it('Then throws bundleBadHeader with reason malformed-header', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode(`# v2 git bundle\n${'z'.repeat(40)} refs/heads/main\n\n`);

      // Act + Assert
      try {
        sut(bytes, 'bad-oid.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });

  describe('When a prerequisite line has a non-hex oid', () => {
    it('Then throws bundleBadHeader with reason malformed-header', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode(
        `# v2 git bundle\n-${'z'.repeat(40)} bad prereq\n${OID_B} refs/heads/main\n\n`,
      );

      // Act + Assert
      try {
        sut(bytes, 'bad-prereq.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });

  describe('When v2 header contains a capability (@) line', () => {
    it('Then throws bundleBadHeader with reason malformed-header', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode(`# v2 git bundle\n@object-format=sha1\n${OID_A} refs/heads/main\n\n`);

      // Act + Assert
      try {
        sut(bytes, 'v2-with-cap.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });

  describe('When given a v2 bundle with HEAD ref line', () => {
    it('Then parses HEAD as the ref name', () => {
      // Arrange
      const sut = parseBundleHeader;
      const header = `# v2 git bundle\n${OID_A} HEAD\n\n`;
      const bytes = encode(header);

      // Act
      const result = sut(bytes, 'head.bundle');

      // Assert
      expect(result.refs).toEqual([{ oid: OID_A, name: RefName.from('HEAD') }]);
    });
  });

  describe('When a prerequisite line has no space (oid only, no comment)', () => {
    it('Then parses the prerequisite with an empty comment', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode(
        `# v2 git bundle\n-${'a'.repeat(40)}\n${'b'.repeat(40)} refs/heads/main\n\n`,
      );

      // Act
      const result = sut(bytes, 'no-comment-prereq.bundle');

      // Assert
      expect(result.prerequisites).toEqual([{ oid: OID_A, comment: '' }]);
    });
  });

  describe('When a ref line contains no space (oid only, no refname)', () => {
    it('Then throws bundleBadHeader with code BUNDLE_BAD_HEADER and reason malformed-header', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode(`# v2 git bundle\n${'a'.repeat(40)}\n\n`);

      // Act + Assert
      try {
        sut(bytes, 'no-space-ref.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });

  describe('When header starts with a blank line and has no magic line before the terminator', () => {
    it('Then throws bundleBadHeader with code BUNDLE_BAD_HEADER and reason not-a-bundle', () => {
      // Arrange
      const sut = parseBundleHeader;
      const headerBytes = encode('\n\n');
      const packBytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // 'PACK'
      const bytes = new Uint8Array(headerBytes.length + packBytes.length);
      bytes.set(headerBytes, 0);
      bytes.set(packBytes, headerBytes.length);

      // Act + Assert
      try {
        sut(bytes, 'blank-start.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'not-a-bundle',
        );
      }
    });
  });

  describe('When header is v3 magic line with no blank line terminator', () => {
    it('Then throws bundleUnsupportedVersion with code BUNDLE_UNSUPPORTED_VERSION and version 3', () => {
      // Arrange
      const sut = parseBundleHeader;
      const bytes = encode('# v3 git bundle');

      // Act + Assert
      try {
        sut(bytes, 'v3-no-blank.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; version: number } }).data.code).toBe(
          'BUNDLE_UNSUPPORTED_VERSION',
        );
        expect((err as { data: { code: string; version: number } }).data.version).toBe(3);
      }
    });
  });

  describe('When a ref line has 41 chars and no space (valid-hex-40 prefix plus one extra char)', () => {
    it('Then throws BUNDLE_BAD_HEADER with reason malformed-header', () => {
      // Arrange — 41-char string, first 40 chars are valid hex; no space present.
      // Without the spaceIdx===-1 guard, slice(0,-1) yields 40 valid hex chars and
      // the line would be misread as a valid ref line instead of throwing.
      const sut = parseBundleHeader;
      const bytes = encode(`# v2 git bundle\n${'a'.repeat(40)}b\n\n`);

      // Act + Assert
      try {
        sut(bytes, 'no-space-41.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });

  describe('When a ref line has a valid oid and a refname ending with @', () => {
    it('Then parses successfully without throwing', () => {
      // Arrange — a refname ending in @ is valid; the startsWith('@') guard at the
      // line-type dispatch only fires when the WHOLE line starts with @.
      const sut = parseBundleHeader;
      const bytes = encode(`# v2 git bundle\n${'a'.repeat(40)} refs/heads/main@\n\n`);

      // Act
      const result = sut(bytes, 'at-suffix.bundle');

      // Assert
      expect(result.refs).toHaveLength(1);
      expect(result.refs[0]!.name).toBe('refs/heads/main@');
    });
  });

  describe('When given a large payload with v2 magic but no blank-line terminator', () => {
    it('Then throws BUNDLE_BAD_HEADER on a large no-terminator input', () => {
      // Arrange
      const sut = parseBundleHeader;
      const headerPart = encode(`# v2 git bundle\n${OID_A} refs/heads/main\n`);
      // 1 MB of zeros simulating a large embedded packfile with no blank line in header
      const packData = new Uint8Array(1_000_000);
      const bytes = new Uint8Array(headerPart.length + packData.length);
      bytes.set(headerPart, 0);
      bytes.set(packData, headerPart.length);

      // Act + Assert
      try {
        sut(bytes, 'large-no-blank.bundle');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { data: { code: string; reason: string } }).data.code).toBe(
          'BUNDLE_BAD_HEADER',
        );
        expect((err as { data: { code: string; reason: string } }).data.reason).toBe(
          'malformed-header',
        );
      }
    });
  });
});

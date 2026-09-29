import { describe, expect, it } from 'vitest';
import { resolveBinaryOverride } from '../../../../src/application/primitives/resolve-binary-override.js';

describe('resolveBinaryOverride', () => {
  describe('Given diff attribute is false (binary macro / -diff)', () => {
    describe('When rawIsBinary, driverBinary and textconvConfigured are any values', () => {
      it('Then returns patch:binary and numstat:binary', () => {
        // Arrange
        const value = false as const;
        const named = { textconvConfigured: false, driverBinary: undefined, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'binary', numstat: 'binary' });
      });
    });
  });

  describe('Given diff attribute is true (bare diff)', () => {
    describe('When rawIsBinary, driverBinary and textconvConfigured are any values', () => {
      it('Then returns patch:text and numstat:text', () => {
        // Arrange
        const value = true as const;
        const named = { textconvConfigured: false, driverBinary: true, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'text' });
      });
    });
  });

  describe('Given diff attribute is unspecified', () => {
    describe('When rawIsBinary, driverBinary and textconvConfigured are any values', () => {
      it('Then returns empty override pair (no patch, no numstat)', () => {
        // Arrange
        const value = 'unspecified' as const;
        const named = { textconvConfigured: true, driverBinary: false, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result.patch).toBeUndefined();
        expect(result.numstat).toBeUndefined();
      });
    });
  });

  describe('Given diff attribute is a named driver with driverBinary unset (auto)', () => {
    describe('When textconv is configured and rawIsBinary is false', () => {
      it('Then returns patch:text and numstat:text', () => {
        // Arrange
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: true, driverBinary: undefined, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'text' });
      });
    });

    describe('When textconv is configured and rawIsBinary is true', () => {
      it('Then returns patch:text and numstat:binary', () => {
        // Arrange — the raw blob has a NUL (rawIsBinary), but textconv's own
        // output is always clean text: patch stays text, numstat alone
        // reflects the raw content.
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: true, driverBinary: undefined, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'binary' });
      });
    });

    describe('When textconv is not configured and rawIsBinary is true', () => {
      it('Then returns empty override pair (no patch, no numstat)', () => {
        // Arrange — no driver opinion and no textconv: the caller's own raw-bytes
        // sniff decides both patch and numstat, so no override is needed here.
        const value = { set: 'nodiff' } as const;
        const named = { textconvConfigured: false, driverBinary: undefined, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result.patch).toBeUndefined();
        expect(result.numstat).toBeUndefined();
      });
    });

    describe('When textconv is not configured and rawIsBinary is false', () => {
      it('Then returns empty override pair (no patch, no numstat)', () => {
        // Arrange
        const value = { set: 'nodiff' } as const;
        const named = { textconvConfigured: false, driverBinary: undefined, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result.patch).toBeUndefined();
        expect(result.numstat).toBeUndefined();
      });
    });
  });

  describe('Given diff attribute is a named driver with diff.<name>.binary = true', () => {
    describe('When textconv is configured', () => {
      it('Then returns patch:text (textconv output is always clean) and numstat:binary (forced)', () => {
        // Arrange — pinned against live git 2.55.0: a forced-binary driver with
        // a textconv still renders the textconv'd hunk as a patch, but numstat
        // still shows the binary marker.
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: true, driverBinary: true, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'binary' });
      });
    });

    describe('When textconv is not configured', () => {
      it('Then returns patch:binary and numstat:binary, regardless of rawIsBinary', () => {
        // Arrange — pinned against live git 2.55.0: with no textconv to fall
        // back on, a forced-binary driver forces BOTH surfaces, even over
        // genuinely text (NUL-free) content.
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: false, driverBinary: true, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'binary', numstat: 'binary' });
      });
    });
  });

  describe('Given diff attribute is a named driver with diff.<name>.binary = false', () => {
    describe('When textconv is configured', () => {
      it('Then returns patch:text and numstat:text', () => {
        // Arrange
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: true, driverBinary: false, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'text' });
      });
    });

    describe('When textconv is not configured, even over NUL-bearing (rawIsBinary) content', () => {
      it('Then returns patch:text and numstat:text', () => {
        // Arrange — pinned against live git 2.55.0: driver binary=false forces
        // TEXT even for a raw NUL-bearing blob with no textconv — git shows
        // the raw bytes as a text hunk, not "Binary files differ".
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: false, driverBinary: false, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'text' });
      });
    });
  });
});

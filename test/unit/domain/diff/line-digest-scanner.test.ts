import { describe, expect, it } from 'vitest';
import { BINARY_DETECTION_BYTES } from '../../../../src/domain/diff/line-diff.js';
import {
  createLineDigestScanner,
  type LineDigestScanner,
} from '../../../../src/domain/diff/line-digest-scanner.js';
import {
  digestNormalizedLine,
  digestsEqual,
  type LineDigest,
  type LineKey,
  NONE_KEY,
} from '../../../../src/domain/diff/whitespace.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Drains a scanner that has already received every chunk it will ever get
// (push(...) calls followed by end()) down to `exhausted`, collecting every
// emitted digest in order.
function drainAll(sut: LineDigestScanner): LineDigest[] {
  const digests: LineDigest[] = [];
  for (let step = sut.next(); step.kind !== 'exhausted'; step = sut.next()) {
    if (step.kind === 'digest') digests.push(step.digest);
  }
  return digests;
}

describe('createLineDigestScanner', () => {
  describe('Given a NUL byte in the chunk immediately after the NUL-detection window closes, When the scanner drains identical chunks', () => {
    it('Then binary stays false and the digest covers both chunks (nulScanOffset only ever grows)', () => {
      // Arrange — the first chunk exactly exhausts the window; a NUL leading
      // the second chunk must be ignored, not detected.
      const firstChunk = new Uint8Array(BINARY_DETECTION_BYTES).fill(0x78); // 'x' * 8000
      const secondChunk = new Uint8Array([0x00, 0x0a]); // NUL then LF, completes the line
      const whole = new Uint8Array(firstChunk.length + secondChunk.length);
      whole.set(firstChunk, 0);
      whole.set(secondChunk, firstChunk.length);
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(firstChunk);
      expect(sut.next().kind).toBe('needs-input');
      sut.push(secondChunk);
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(sut.binary).toBe(false);
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(whole, NONE_KEY));
    });
  });

  describe('Given a NUL byte exactly one position past the window on a partially-consumed budget, When the scanner drains identical chunks', () => {
    it('Then the out-of-window NUL is ignored and binary stays false', () => {
      // Arrange — 7,995 bytes pre-consume the window (5 remain); the NUL sits
      // at chunk2[5], the first position the shrunk window must NOT scan.
      const firstChunk = new Uint8Array(BINARY_DETECTION_BYTES - 5).fill(0x78);
      const secondChunk = new Uint8Array(10).fill(0x79); // 'y'
      secondChunk[5] = 0x00;
      const whole = new Uint8Array(firstChunk.length + secondChunk.length);
      whole.set(firstChunk, 0);
      whole.set(secondChunk, firstChunk.length);
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act — neither chunk carries an LF, so the line only completes at EOF.
      sut.push(firstChunk);
      expect(sut.next().kind).toBe('needs-input');
      sut.push(secondChunk);
      expect(sut.next().kind).toBe('needs-input');
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(sut.binary).toBe(false);
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(whole, NONE_KEY));
    });
  });

  describe('Given a NUL byte at the very last in-window position (index 7 999), When a single chunk carrying it is pushed', () => {
    it('Then binary becomes true', () => {
      // Arrange
      const chunk = new Uint8Array(BINARY_DETECTION_BYTES).fill(0x78);
      chunk[BINARY_DETECTION_BYTES - 1] = 0x00;
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(chunk);

      // Assert
      expect(sut.binary).toBe(true);
    });
  });

  describe('Given a NUL byte at the first out-of-window position (index 8 000), When a single chunk carrying it is pushed', () => {
    it('Then binary stays false', () => {
      // Arrange
      const chunk = new Uint8Array(BINARY_DETECTION_BYTES + 1).fill(0x78);
      chunk[BINARY_DETECTION_BYTES] = 0x00;
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(chunk);

      // Assert
      expect(sut.binary).toBe(false);
    });
  });

  describe('Given a NUL detected in the window, When next() is called with an unterminated line still pending', () => {
    it('Then next() answers exhausted immediately, and stays exhausted on a second call', () => {
      // Arrange — the pending "ab" content is never emitted once binary is known.
      const chunk = enc('ab');
      const nulChunk = new Uint8Array([0x00]);
      const sut = createLineDigestScanner(NONE_KEY, false);
      sut.push(chunk);
      expect(sut.next().kind).toBe('needs-input');
      sut.push(nulChunk);
      sut.end();

      // Act
      const first = sut.next();
      const second = sut.next();

      // Assert
      expect(first.kind).toBe('exhausted');
      expect(second.kind).toBe('exhausted');
    });
  });

  describe('Given a blob with no trailing LF at all, When it is drained', () => {
    it('Then the final digest is unterminated and matches the independent oracle', () => {
      // Arrange
      const bytes = enc('abc');
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(bytes);
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(bytes, NONE_KEY));
      expect(digests[0]?.terminated).toBe(false);
    });
  });

  describe('Given the inert NONE_KEY, When the same content is fed with and without a trailing LF', () => {
    it('Then the unterminated and terminated final digests are unequal', () => {
      // Arrange — the terminator must fold into the hash even under an
      // inactive key: this is the kill test for the mutant that would force
      // `terminated` to `false` regardless of the LF.
      const unterminated = createLineDigestScanner(NONE_KEY, false);
      unterminated.push(enc('a\nb'));
      unterminated.end();
      const terminated = createLineDigestScanner(NONE_KEY, false);
      terminated.push(enc('a\nb\n'));
      terminated.end();

      // Act
      const unterminatedDigests = drainAll(unterminated);
      const terminatedDigests = drainAll(terminated);

      // Assert
      const unterminatedLast = unterminatedDigests.at(-1) as LineDigest;
      const terminatedLast = terminatedDigests.at(-1) as LineDigest;
      expect(digestsEqual(unterminatedLast, terminatedLast)).toBe(false);
    });
  });

  describe('Given an empty blob, When it is drained', () => {
    it('Then no digest is ever emitted', () => {
      // Arrange
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(new Uint8Array(0));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(0);
    });
  });

  describe('Given a blob that is a single LF, When it is drained', () => {
    it('Then exactly one blank, terminated digest is emitted, matching the independent oracle', () => {
      // Arrange
      const bytes = enc('\n');
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(bytes);
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(bytes, NONE_KEY));
    });
  });

  describe('Given a spaces-only line under an active whitespace mode, When ignoreBlankLines is true', () => {
    it('Then the line is skipped and no digest surfaces', () => {
      // Arrange — under mode 'all' the spaces normalize away to nothing.
      const key: LineKey = { mode: 'all', ignoreCrAtEol: false };
      const sut = createLineDigestScanner(key, true);

      // Act
      sut.push(enc('  \n'));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(0);
    });
  });

  describe("Given the same spaces-only line under mode 'none', When ignoreBlankLines is true", () => {
    it('Then the line is NOT blank under this key and its digest still surfaces', () => {
      // Arrange — under mode 'none' nothing is normalized away.
      const sut = createLineDigestScanner(NONE_KEY, true);

      // Act
      sut.push(enc('  \n'));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
    });
  });

  describe('Given a chunk boundary that falls inside a whitespace run, When the two chunks are drained under mode change', () => {
    it("Then the emitted digest matches the whole-line oracle's", () => {
      // Arrange — "a   b\n" split mid-run: chunk1 ends one space into the run.
      const key: LineKey = { mode: 'change', ignoreCrAtEol: false };
      const whole = enc('a   b\n');
      const sut = createLineDigestScanner(key, false);

      // Act
      sut.push(enc('a '));
      expect(sut.next().kind).toBe('needs-input');
      sut.push(enc('  b\n'));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(whole, key));
    });
  });

  describe('Given a chunk boundary that falls between a CR and its LF, When the two chunks are drained under ignoreCrAtEol', () => {
    it("Then the emitted digest matches the whole-line oracle's", () => {
      // Arrange
      const key: LineKey = { mode: 'none', ignoreCrAtEol: true };
      const whole = enc('hi\r\n');
      const sut = createLineDigestScanner(key, false);

      // Act
      sut.push(enc('hi\r'));
      expect(sut.next().kind).toBe('needs-input');
      sut.push(enc('\n'));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(whole, key));
    });
  });

  describe('Given a chunk boundary that falls between the last content byte and the LF, When the two chunks are drained', () => {
    it("Then the emitted digest matches the whole-line oracle's", () => {
      // Arrange
      const whole = enc('ab\n');
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(enc('ab'));
      expect(sut.next().kind).toBe('needs-input');
      sut.push(enc('\n'));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(whole, NONE_KEY));
    });
  });

  describe('Given a single line split across three pushes, When all three chunks are drained', () => {
    it("Then the emitted digest matches the whole-line oracle's", () => {
      // Arrange
      const whole = enc('abc\n');
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      sut.push(enc('a'));
      expect(sut.next().kind).toBe('needs-input');
      sut.push(enc('b'));
      expect(sut.next().kind).toBe('needs-input');
      sut.push(enc('c\n'));
      sut.end();
      const digests = drainAll(sut);

      // Assert
      expect(digests).toHaveLength(1);
      expect(digests[0]).toEqual(digestNormalizedLine(whole, NONE_KEY));
    });
  });

  describe('Given a single line built across many chunks, When a consumed chunk is mutated in place afterward', () => {
    it('Then the emitted digest still matches the digest of the original, unmutated bytes', () => {
      // Arrange — the scanner must hold no reference to a chunk beyond the
      // call that consumes it: 200 independent 8 KiB copies are pushed one at
      // a time, each corrupted with 0xff right after being drained.
      const chunkSize = 8_192;
      const chunkCount = 200;
      const original = new Uint8Array(chunkSize * chunkCount).fill(0x78); // 'x'
      const sut = createLineDigestScanner(NONE_KEY, false);

      // Act
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const copy = original.slice(start, start + chunkSize);
        sut.push(copy);
        sut.next(); // needs-input — no LF anywhere in this line
        copy.fill(0xff);
      }
      sut.end();
      const result = sut.next();

      // Assert
      expect(result.kind).toBe('digest');
      if (result.kind === 'digest') {
        expect(result.digest).toEqual(digestNormalizedLine(original, NONE_KEY));
      }
    });
  });
});

import { describe, expect, it } from 'vitest';
import { BINARY_DETECTION_BYTES } from '../../../../src/domain/diff/line-diff.js';
import {
  applyLadder,
  createLineDigestScanner,
  type LineDigestScanner,
  scanEqual,
} from '../../../../src/domain/diff/line-digest-scanner.js';
import {
  digestNormalizedLine,
  digestsEqual,
  type LineDigest,
  type LineKey,
  NONE_KEY,
  type WhitespaceMode,
} from '../../../../src/domain/diff/whitespace.js';
import {
  DIGEST_COLLISION_LINE_A,
  DIGEST_COLLISION_LINE_B,
} from '../../../fixtures/digest-collision-pair.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const WHITESPACE_MODES: readonly WhitespaceMode[] = ['all', 'change', 'at-eol'];

const EMPTY_CONTENT = new Uint8Array(0);
const NUL_ONLY_CONTENT = new Uint8Array([0x00]);

// A scanner that has been closed owes `exhausted`, so a drain that never gets
// there is a defect rather than a slow test. The bound keeps such a scanner
// from spinning the whole run instead of failing this one test — `next()` is
// synchronous, so a test timeout could never fire on it.
const MAX_DRAIN_STEPS = 1_000;

// Drains a scanner that has already received every chunk it will ever get
// (push(...) calls followed by end()) down to `exhausted`, collecting every
// emitted digest in order.
function drainAll(sut: LineDigestScanner): LineDigest[] {
  const digests: LineDigest[] = [];
  for (let steps = 0; steps < MAX_DRAIN_STEPS; steps++) {
    const step = sut.next();
    if (step.kind === 'exhausted') return digests;
    if (step.kind === 'digest') digests.push(step.digest);
  }
  throw new Error(`scanner did not reach exhausted within ${MAX_DRAIN_STEPS} steps`);
}

// A ladder input in its terminal shape: the whole content pushed, then closed,
// so the very first next() is already the step the ladder is handed.
function fedScanner(content: Uint8Array): LineDigestScanner {
  const scanner = createLineDigestScanner(NONE_KEY, false);
  scanner.push(content);
  scanner.end();
  return scanner;
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

describe('scanEqual', () => {
  describe('Given two distinct lines that collide on the digest, When each is folded under an active whitespace mode', () => {
    it.each(WHITESPACE_MODES)(
      'Then their digests are equal under mode %s — the digest alone cannot tell them apart',
      (mode) => {
        // Arrange
        const key: LineKey = { mode, ignoreCrAtEol: false };
        const sut = digestNormalizedLine;

        // Act
        const digestA = sut(enc(DIGEST_COLLISION_LINE_A), key);
        const digestB = sut(enc(DIGEST_COLLISION_LINE_B), key);

        // Assert
        expect(digestsEqual(digestA, digestB)).toBe(true);
      },
    );
  });

  describe('Given two single-line blobs whose only line is the colliding pair, When scanEqual compares them under an active whitespace mode', () => {
    it.each(WHITESPACE_MODES)('Then it reports them unequal under mode %s', (mode) => {
      // Arrange
      const key: LineKey = { mode, ignoreCrAtEol: false };
      const sut = scanEqual;

      // Act
      const result = sut(enc(DIGEST_COLLISION_LINE_A), enc(DIGEST_COLLISION_LINE_B), key, false);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given multi-line blobs differing only in a colliding line surrounded by identical lines, When scanEqual compares them under an active whitespace mode', () => {
    it.each(WHITESPACE_MODES)('Then it reports them unequal under mode %s', (mode) => {
      // Arrange
      const key: LineKey = { mode, ignoreCrAtEol: false };
      const sut = scanEqual;

      // Act
      const result = sut(
        enc(`head\n${DIGEST_COLLISION_LINE_A}\ntail\n`),
        enc(`head\n${DIGEST_COLLISION_LINE_B}\ntail\n`),
        key,
        false,
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given two blobs that really are equal under the key, When scanEqual compares them', () => {
    it('Then the confirmation still reports them equal', () => {
      // Arrange
      const key: LineKey = { mode: 'all', ignoreCrAtEol: false };
      const sut = scanEqual;

      // Act
      const result = sut(enc('hello world\nsecond\n'), enc('hello  world\nsec ond\n'), key, false);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given blobs equal only after blank lines are skipped, When ignoreBlankLines is true', () => {
    it('Then scanEqual reports them equal', () => {
      // Arrange
      const sut = scanEqual;

      // Act
      const result = sut(enc('a\n\n\nb\n'), enc('\na\nb\n\n'), NONE_KEY, true);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given blobs whose only difference is a trailing blank line, When ignoreBlankLines is false', () => {
    it('Then scanEqual reports them unequal', () => {
      // Arrange
      const sut = scanEqual;

      // Act
      const result = sut(enc('a\n\n'), enc('a\n'), NONE_KEY, false);

      // Assert
      expect(result).toBe(false);
    });
  });
});

// The ladder is exported and driven by the streamed arm too, where a side can
// be flagged binary *after* it has emitted digests and where the two sides run
// dry on different steps. Those shapes never reach it from `scanEqual` — both
// blobs are whole there, so a binary side is flagged before the first step and
// an exact confirmation answers every `true`. They are pinned here directly,
// against the ladder's own contract, rather than through a caller that would
// mask a wrong verdict behind its confirmation.
describe('applyLadder', () => {
  describe('Given an old side flagged binary and a new side that also yields no digest, When the ladder is applied to both first steps', () => {
    it('Then it answers false — a binary side is a difference, not a pair of silent scanners', () => {
      // Arrange
      const oldScanner = fedScanner(NUL_ONLY_CONTENT);
      const newScanner = fedScanner(EMPTY_CONTENT);
      const oldStep = oldScanner.next();
      const newStep = newScanner.next();
      const sut = applyLadder;

      // Act
      const result = sut(oldScanner, newScanner, oldStep, newStep);

      // Assert
      expect(oldScanner.binary).toBe(true);
      expect(newScanner.binary).toBe(false);
      expect(result).toBe(false);
    });
  });

  describe('Given a new side flagged binary and an old side that also yields no digest, When the ladder is applied to both first steps', () => {
    it('Then it answers false — either side alone is enough to refuse', () => {
      // Arrange
      const oldScanner = fedScanner(EMPTY_CONTENT);
      const newScanner = fedScanner(NUL_ONLY_CONTENT);
      const oldStep = oldScanner.next();
      const newStep = newScanner.next();
      const sut = applyLadder;

      // Act
      const result = sut(oldScanner, newScanner, oldStep, newStep);

      // Assert
      expect(oldScanner.binary).toBe(false);
      expect(newScanner.binary).toBe(true);
      expect(result).toBe(false);
    });
  });

  describe('Given an old side that still yields a digest and a new side already exhausted, When the ladder is applied to both steps', () => {
    it('Then it answers false — one side outliving the other is a line-count difference', () => {
      // Arrange
      const oldScanner = fedScanner(enc('a\n'));
      const newScanner = fedScanner(EMPTY_CONTENT);
      const oldStep = oldScanner.next();
      const newStep = newScanner.next();
      const sut = applyLadder;

      // Act
      const result = sut(oldScanner, newScanner, oldStep, newStep);

      // Assert
      expect(oldStep.kind).toBe('digest');
      expect(newStep.kind).toBe('exhausted');
      expect(result).toBe(false);
    });
  });

  describe('Given an old side already exhausted and a new side that still yields a digest, When the ladder is applied to both steps', () => {
    it('Then it answers false — the shorter side running dry first does not make the pair equal', () => {
      // Arrange
      const oldScanner = fedScanner(EMPTY_CONTENT);
      const newScanner = fedScanner(enc('a\n'));
      const oldStep = oldScanner.next();
      const newStep = newScanner.next();
      const sut = applyLadder;

      // Act
      const result = sut(oldScanner, newScanner, oldStep, newStep);

      // Assert
      expect(oldStep.kind).toBe('exhausted');
      expect(newStep.kind).toBe('digest');
      expect(result).toBe(false);
    });
  });
});

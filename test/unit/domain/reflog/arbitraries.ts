import fc from 'fast-check';
import type { ReflogEntry } from '../../../../src/domain/reflog/reflog-entry.js';
import { serializeReflogLine } from '../../../../src/domain/reflog/reflog-format.js';
import { arbObjectId } from '../objects/arbitraries.js';

// Identity name/email exclude angle brackets, control chars, and the
// surrounding-space ambiguity parseIdentity strips.
export const arbIdentityText = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[\n\r<>]/.test(s) && s.trim() === s);

// Messages exclude CR/LF and the framing whitespace sanitizeReflogMessage trims.
export const arbMessage = (): fc.Arbitrary<string> =>
  fc.string({ maxLength: 30 }).filter((s) => !/[\n\r]/.test(s) && s.trim() === s);

const TZ_OFFSETS = ['+0000', '-0500', '+0900', '+0530'] as const;

/** A non-zero timestamp — shared by every arbitrary that must never trip the zero-timestamp refusal. */
export const arbNonZeroTimestamp = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1, max: 4_000_000_000 });

/**
 * A timestamp that CAN be 0 — an explicit constant, so the zero case is
 * guaranteed rather than left to fast-check's boundary bias.
 */
export const arbTimestampIncludingZero = (): fc.Arbitrary<number> =>
  fc.oneof(fc.constant(0), arbNonZeroTimestamp());

/** An arbitrary reflog entry. `timestamp` defaults to the zero-inclusive arbitrary. */
export const arbEntry = (
  timestamp: fc.Arbitrary<number> = arbTimestampIncludingZero(),
): fc.Arbitrary<ReflogEntry> =>
  fc.record({
    oldId: arbObjectId(40),
    newId: arbObjectId(40),
    identity: fc.record({
      name: arbIdentityText(),
      email: arbIdentityText(),
      timestamp,
      timezoneOffset: fc.constantFrom(...TZ_OFFSETS),
    }),
    message: arbMessage(),
  });

// Printable ASCII plus the three whitespace controls a reflog file actually
// carries (LF as the line terminator, TAB as the message separator, CR as a
// message byte git never strips) — the safe subset a lenient parser must
// never throw on. NUL is outside the DECLARED safe subset, not outside real
// files: git's own reader truncates at a NUL, so totality over NUL is not a
// property this parser claims.
const arbReflogSafeUnit = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom('\n', '\t', '\r'),
    fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
  );

/** Arbitrary reflog file text, with and without a terminating LF (mixed by construction). */
export const arbReflogText = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.string({ unit: arbReflogSafeUnit(), maxLength: 200 }), fc.boolean())
    .map(([body, hasTrailingLf]) => (hasTrailingLf ? `${body}\n` : body));

// Single-line garbage: the same safe alphabet minus LF, so it can never
// smuggle in an extra line when joined into a candidate-lines file.
const arbGarbageLine = (): fc.Arbitrary<string> =>
  fc.string({
    unit: fc.oneof(
      fc.constantFrom('\t', '\r'),
      fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
    ),
    maxLength: 60,
  });

/**
 * One candidate reflog line (LF already stripped) — either a validly
 * serialized entry or arbitrary single-line garbage, mixed to fuzz the
 * lenient parser's per-line accept/reject boundary against a real file shape.
 */
export const arbCandidateLine = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbEntry(arbNonZeroTimestamp()).map((entry) =>
      serializeReflogLine(entry, 40).replace(/\n$/, ''),
    ),
    arbGarbageLine(),
  );

const BYTES_ENCODER = new TextEncoder();

const concatByteArrays = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

// A byte an identity name/email may carry: the full latin1-inclusive range
// (printable ASCII through 0xFF), minus the bracket delimiters that would
// shift where the byte-tier parser locates the identity boundaries.
const arbIdentityByte = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0x20, max: 0xff }).filter((b) => b !== 0x3c && b !== 0x3e);

// A byte a message may carry: the full latin1-inclusive range, which
// excludes TAB/CR/LF/NUL by starting at 0x20 — none of those bytes has a
// structural role inside a message once the line's own TAB has been found.
const arbMessageByte = (): fc.Arbitrary<number> => fc.integer({ min: 0x20, max: 0xff });

/**
 * One well-formed reflog line, built directly in BYTES rather than through a
 * UTF-8 string encode: the identity/message payloads are arbitrary bytes
 * across the full latin1-inclusive range, including values (0x80–0xFF) that
 * are not valid UTF-8 on their own. This is what a UTF-8 `serializeReflogLine`
 * round trip cannot exercise — encoding a JS string codepoint 0x80–0xFF
 * always produces a valid 2-byte UTF-8 sequence, never the lone invalid byte
 * a corrupted or legacy-encoded reflog file actually carries.
 */
export const arbReflogLineBytes = (): fc.Arbitrary<Uint8Array> =>
  fc
    .record({
      oldId: arbObjectId(40),
      newId: arbObjectId(40),
      nameBytes: fc.array(arbIdentityByte(), { minLength: 1, maxLength: 12 }),
      emailBytes: fc.array(arbIdentityByte(), { minLength: 1, maxLength: 12 }),
      timestamp: arbNonZeroTimestamp(),
      timezoneOffset: fc.constantFrom(...TZ_OFFSETS),
      messageBytes: fc.array(arbMessageByte(), { minLength: 0, maxLength: 16 }),
    })
    .map(({ oldId, newId, nameBytes, emailBytes, timestamp, timezoneOffset, messageBytes }) =>
      concatByteArrays([
        BYTES_ENCODER.encode(`${oldId} ${newId} `),
        Uint8Array.from(nameBytes),
        BYTES_ENCODER.encode(' <'),
        Uint8Array.from(emailBytes),
        BYTES_ENCODER.encode(`> ${timestamp} ${timezoneOffset}\t`),
        Uint8Array.from(messageBytes),
        BYTES_ENCODER.encode('\n'),
      ]),
    );

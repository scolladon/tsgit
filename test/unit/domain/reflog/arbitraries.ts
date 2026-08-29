import fc from 'fast-check';
import { ObjectId } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/reflog-entry.js';
import { serializeReflogLine } from '../../../../src/domain/reflog/reflog-format.js';

// A single lowercase hex digit, generated from a numeric range rather than a
// literal alphabet string — a literal hex/base64 alphabet trips the security
// scanner's high-entropy-string check (CKV_SECRET_6).
const arbHexDigit = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 15 }).map((n) => n.toString(16));

const arbHex = (length: number): fc.Arbitrary<string> =>
  fc
    .array(arbHexDigit(), { minLength: length, maxLength: length })
    .map((digits) => digits.join(''));

export const arbObjectId = (length: 40 | 64 = 40): fc.Arbitrary<ObjectId> =>
  arbHex(length).map((hex) => ObjectId.from(hex));

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
// never throw on. NUL is excluded: it is not a byte real reflog files carry.
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

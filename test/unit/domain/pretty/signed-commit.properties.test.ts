/**
 * Property tests for splitSignedCommit.
 *
 * Lens 1 (round-trip) fits: folding an arbitrary multi-line signature into a
 * `gpgsig` header between any two headers of a commit, then splitting under
 * that header, gives back the original commit bytes and the signature. The
 * message after the blank line may itself hold `gpgsig`-led and
 * space-led lines, which must stay in the payload. Lenses 2–4 do not fit:
 * nothing is matched or counted, and an unsigned commit is a single case the
 * example suite already pins.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitSignedCommit } from '../../../../src/domain/pretty/signed-commit.js';

const NUM_RUNS = 200;
const LINE_FEED = 0x0a;
const SIGNATURE_HEADER = 'gpgsig';

const fromByteString = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Any byte but a line feed, as a one-char byte string. */
const arbLineByte = fc
  .integer({ min: 0, max: 0xff })
  .filter((byte) => byte !== LINE_FEED)
  .map((byte) => String.fromCharCode(byte));
const arbLine = fc.array(arbLineByte, { maxLength: 12 }).map((chars) => chars.join(''));

const arbHeader = fc
  .tuple(
    fc.constantFrom('parent p', 'encoding x', 'mergetag m', 'extra'),
    fc.array(arbLine, { maxLength: 2 }),
  )
  .map(
    ([first, continuations]) => `${first}\n${continuations.map((line) => ` ${line}\n`).join('')}`,
  );

const arbMessage = fc
  .array(
    fc.oneof(
      arbLine,
      arbLine.map((line) => `${SIGNATURE_HEADER} ${line}`),
    ),
    {
      maxLength: 4,
    },
  )
  .map((lines) => lines.map((line) => `${line}\n`).join(''));

const arbSignedCommit = fc
  .record({
    headers: fc.array(arbHeader, { maxLength: 3 }),
    message: arbMessage,
    signature: fc.array(arbLine, { minLength: 1, maxLength: 5 }),
  })
  .chain((commit) =>
    fc.integer({ min: 0, max: commit.headers.length }).map((at) => ({ ...commit, at })),
  );

const folded = (signature: ReadonlyArray<string>): string =>
  `${SIGNATURE_HEADER} ${signature.join('\n ')}\n`;

describe('splitSignedCommit properties', () => {
  describe('Given an arbitrary commit with a signature folded in among its headers', () => {
    describe('When it is split under the signature header', () => {
      it('Then the payload is the unsigned commit and the signature is unfolded', () => {
        fc.assert(
          fc.property(arbSignedCommit, ({ headers, message, signature, at }) => {
            // Arrange
            const fixed = 'tree t\nauthor a\ncommitter c\n';
            const before = fixed + headers.slice(0, at).join('');
            const after = `${headers.slice(at).join('')}\n${message}`;
            const raw = fromByteString(before + folded(signature) + after);
            const sut = splitSignedCommit;

            // Act
            const result = sut(raw, SIGNATURE_HEADER);

            // Assert
            expect(result).toEqual({
              payload: fromByteString(before + after),
              signature: fromByteString(signature.map((line) => `${line}\n`).join('')),
            });
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

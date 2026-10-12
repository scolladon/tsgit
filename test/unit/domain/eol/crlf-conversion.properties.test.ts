import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CrlfAction, EolSettings } from '../../../../src/domain/eol/crlf-action.js';
import { crlfToGit, crlfToWorkingTree } from '../../../../src/domain/eol/crlf-conversion.js';
import { createLfToCrlfTransform } from '../../../../src/domain/eol/lf-to-crlf-transform.js';

const CR = 0x0d;
const LF = 0x0a;

const settings: EolSettings = {
  autoCrlf: true,
  coreEol: 'crlf',
  safeCrlf: 'warn',
  nativeEol: 'crlf',
};

const encode = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

const textArbitrary = fc
  .array(fc.constantFrom('a', 'b', ' ', '\n', '\r\n'), { maxLength: 60 })
  .map((parts) => encode(parts.join('')));

const textWithLoneLf = textArbitrary.filter((bytes) => bytes.includes(LF));

const addOptions = (bytes: Uint8Array, action: CrlfAction) => ({
  bytes,
  action,
  settings,
  renormalize: false,
  indexHasCrlf: () => Promise.resolve(false),
});

const withoutCr = (bytes: Uint8Array): Uint8Array => bytes.filter((byte) => byte !== CR);

const hasCrlf = (bytes: Uint8Array): boolean =>
  bytes.some((b, i) => b === CR && bytes[i + 1] === LF);

describe('crlf conversion properties', () => {
  describe('Given text without a lone CR', () => {
    describe('When checked out as CRLF and added back as text-input', () => {
      it('Then the blob is the original with every CRLF replaced by LF', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(textArbitrary, async (bytes) => {
            const sut = crlfToGit;
            const checkedOut = crlfToWorkingTree(bytes, 'text-crlf', settings);
            const added = await sut(addOptions(checkedOut, 'text-input'));
            expect(added.bytes).toEqual(withoutCr(bytes));
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When added under a text action', () => {
      it('Then the blob never contains CRLF', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(
            textArbitrary,
            fc.constantFrom<CrlfAction>('text-input', 'text-crlf'),
            async (bytes, action) => {
              const sut = crlfToGit;
              const added = await sut(addOptions(bytes, action));
              expect(hasCrlf(added.bytes)).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      });
    });

    describe('When converted twice in the same direction', () => {
      it('Then the second conversion changes nothing', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(textArbitrary, async (bytes) => {
            const sut = crlfToGit;
            const added = (await sut(addOptions(bytes, 'text-input'))).bytes;
            const checkedOut = crlfToWorkingTree(bytes, 'text-crlf', settings);
            expect((await sut(addOptions(added, 'text-input'))).bytes).toEqual(added);
            expect(crlfToWorkingTree(checkedOut, 'text-crlf', settings)).toEqual(checkedOut);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given text containing a lone LF split into arbitrary chunks', () => {
    describe('When streamed through the LF to CRLF transform', () => {
      it('Then the concatenation equals the whole-buffer checkout', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            textWithLoneLf,
            fc.array(fc.nat({ max: 60 }), { maxLength: 8 }),
            (bytes, cuts) => {
              const sut = createLfToCrlfTransform();
              const points = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
              const out = points
                .slice(1)
                .flatMap((end, i) =>
                  sut.push(bytes.slice(Math.min(points[i] as number, end), end)),
                );
              const streamed = Uint8Array.from(out.flatMap((chunk) => [...chunk]));
              expect(streamed).toEqual(crlfToWorkingTree(bytes, 'text-crlf', settings));
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

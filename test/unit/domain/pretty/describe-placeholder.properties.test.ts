import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DescribeArgs,
  parseDescribePlaceholder,
} from '../../../../src/domain/pretty/describe-placeholder.js';

const NUM_RUNS = 200;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const patternArb = fc.stringMatching(/^[^,)]+$/);

type Option =
  | { readonly kind: 'tags'; readonly value: boolean }
  | { readonly kind: 'abbrev'; readonly value: number }
  | { readonly kind: 'match' | 'exclude'; readonly value: string };

const optionArb: fc.Arbitrary<Option> = fc.oneof(
  fc.boolean().map((value) => ({ kind: 'tags' as const, value })),
  fc.integer({ min: -99, max: 99 }).map((value) => ({ kind: 'abbrev' as const, value })),
  patternArb.map((value) => ({ kind: 'match' as const, value })),
  patternArb.map((value) => ({ kind: 'exclude' as const, value })),
);

const render = (option: Option): string =>
  option.kind === 'tags' ? `tags=${option.value ? 'yes' : 'no'}` : `${option.kind}=${option.value}`;

const expected = (options: ReadonlyArray<Option>): DescribeArgs => {
  const patterns = { match: [] as string[], exclude: [] as string[] };
  let tags: boolean | undefined;
  let abbrev: number | undefined;
  for (const option of options) {
    if (option.kind === 'tags') tags = option.value;
    else if (option.kind === 'abbrev') abbrev = option.value;
    else patterns[option.kind].push(option.value);
  }
  return { tags, abbrev, ...patterns };
};

describe('Given an arbitrary list of well-formed describe options', () => {
  describe('When the rendered placeholder is parsed', () => {
    it('Then it yields the options, last value winning and patterns accumulating', () => {
      fc.assert(
        fc.property(fc.array(optionArb, { maxLength: 6 }), (options) => {
          // Arrange
          const placeholder = `(describe:${options.map(render).join(',')})`;
          const sut = parseDescribePlaceholder;

          // Act
          const result = sut(encode(`${placeholder}rest`), 0);

          // Assert
          expect(result).toEqual({
            args: expected(options),
            length: encode(placeholder).length,
          });
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

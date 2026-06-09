import fc from 'fast-check';

import type { AttributeValue } from '../../../../src/domain/attributes/index.js';

/** An attribute name: a short lower-case identifier. */
export const arbAttributeName = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abcdef'.split('')), { minLength: 1, maxLength: 6 })
    .map((chars) => chars.join(''));

/** A `name=value` value: safe non-whitespace, non-special characters (may be empty). */
const arbAttributeValue = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abc012'.split('')), { minLength: 0, maxLength: 6 })
    .map((c) => c.join(''));

/** One attribute token paired with the name/value it should parse to. */
export interface AttributeTokenSample {
  readonly token: string;
  readonly name: string;
  readonly value: AttributeValue;
}

export const arbAttributeToken = (): fc.Arbitrary<AttributeTokenSample> =>
  fc.oneof(
    arbAttributeName().map((name) => ({ token: name, name, value: true as const })),
    arbAttributeName().map((name) => ({ token: `-${name}`, name, value: false as const })),
    arbAttributeName().map((name) => ({
      token: `!${name}`,
      name,
      value: 'unspecified' as const,
    })),
    fc
      .tuple(arbAttributeName(), arbAttributeValue())
      .map(([name, v]) => ({ token: `${name}=${v}`, name, value: { set: v } })),
  );

/** A `.gitattributes` pattern: `/`-joined letter segments, optional trailing `/`. */
export const arbAttributePattern = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.array(
        fc
          .array(fc.constantFrom(...'abc'.split('')), { minLength: 1, maxLength: 4 })
          .map((c) => c.join('')),
        { minLength: 1, maxLength: 3 },
      ),
      fc.boolean(),
    )
    .map(([segments, trailingSlash]) => `${segments.join('/')}${trailingSlash ? '/' : ''}`);

/** A full rule line: pattern + zero or more distinct-named attribute tokens. */
export const arbAttributeLine = (): fc.Arbitrary<{
  readonly line: string;
  readonly pattern: string;
  readonly tokens: ReadonlyArray<AttributeTokenSample>;
}> =>
  fc
    .tuple(
      arbAttributePattern(),
      fc.uniqueArray(arbAttributeToken(), {
        minLength: 0,
        maxLength: 4,
        selector: (t) => t.name,
      }),
    )
    .map(([pattern, tokens]) => ({
      pattern,
      tokens,
      line: [pattern, ...tokens.map((t) => t.token)].join(' '),
    }));

export const arbAttributesText = (): fc.Arbitrary<string> =>
  fc
    .array(
      arbAttributeLine().map((l) => l.line),
      { minLength: 0, maxLength: 10 },
    )
    .map((lines) => lines.join('\n'));

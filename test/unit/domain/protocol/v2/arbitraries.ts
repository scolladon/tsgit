import fc from 'fast-check';

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

const tokenArb = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...TOKEN_CHARS), { minLength: 1, maxLength: 16 })
    .map((chars) => chars.join(''));

export const commandArb = (): fc.Arbitrary<string> => tokenArb();

export const argsArb = (): fc.Arbitrary<ReadonlyArray<string>> =>
  fc.array(tokenArb(), { minLength: 0, maxLength: 5 });

export const payloadsArb = (): fc.Arbitrary<ReadonlyArray<Uint8Array>> =>
  fc.array(fc.uint8Array({ minLength: 0, maxLength: 24 }), { minLength: 0, maxLength: 5 });

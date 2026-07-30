import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { parseShallowFile } from '../../../../src/application/primitives/internal/parse-shallow.js';
import { readShallow, updateShallow } from '../../../../src/application/primitives/shallow-file.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { arbShallowFileText, arbShallowOidSet } from './arbitraries.js';

/** A line whose first 40 characters can never be all-hex — 'g' at index 0 always fails the prefix regex. */
const arbNonHexLine = (): fc.Arbitrary<string> =>
  fc
    .string({ maxLength: 59 })
    .filter((s) => !s.includes('\n'))
    .map((rest) => `g${rest}`);

describe('shallow-file properties', () => {
  describe('Given an arbitrary shallow oid set', () => {
    describe('When updateShallow writes it and readShallow reads it back', () => {
      it('Then the resulting set equals the input set', async () => {
        // Arrange + Act + Assert — updateShallow deletes the file for an
        // empty set, so the empty case round-trips through the empty set too.
        await fc.assert(
          fc.asyncProperty(arbShallowOidSet(), async (oids) => {
            const ctx = createMemoryContext();
            await ctx.fs.mkdir(ctx.layout.gitDir);

            await updateShallow(ctx, { shallow: [...oids], unshallow: [] });
            const result = await readShallow(ctx);

            expect([...result].sort()).toEqual([...oids].sort());
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given arbitrary well-formed shallow file text', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it never throws and its length equals the generated line count', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbShallowFileText(), ({ text, lineCount }) => {
            const result = parseShallowFile(text, 40);
            expect(result.length).toBe(lineCount);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a single line whose first 40 characters are not all hex', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it always throws SHALLOW_FILE_MALFORMED', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbNonHexLine(), (line) => {
            let caught: unknown;
            try {
              parseShallowFile(`${line}\n`, 40);
              throw new Error('expected throw');
            } catch (err) {
              caught = err;
            }
            expect(caught).toBeInstanceOf(TsgitError);
            if (!(caught instanceof TsgitError)) throw caught;
            expect(caught.data.code).toBe('SHALLOW_FILE_MALFORMED');
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});

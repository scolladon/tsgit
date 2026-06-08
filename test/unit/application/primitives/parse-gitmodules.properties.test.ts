import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type GitmodulesRow,
  parseGitmodules,
} from '../../../../src/application/primitives/parse-gitmodules.js';

// Value alphabet kept free of INI metacharacters (#, ;, ", \, newline, ]) so the
// round-trip reflects the grammar, not comment/quote handling (those are the
// config-read tokenizer's own tests).
const arbValue = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('a', 'b', '/', '.', '-', '_', '1'), { minLength: 1, maxLength: 8 })
    .map((parts) => parts.join(''));

const arbSafeName = (): fc.Arbitrary<string> =>
  fc.constantFrom('a', 'libs/sub', 'x.y', 'foo', 'deep/nested/mod', 'm1');

const arbUnsafeName = (): fc.Arbitrary<string> =>
  fc.constantFrom('../evil', '-flag', 'a/../b', '/abs', 'C:/x', '');

const arbRow = (name: string): fc.Arbitrary<GitmodulesRow> =>
  fc.record(
    {
      name: fc.constant(name),
      path: arbValue(),
      url: arbValue(),
      update: fc.constantFrom('checkout', 'rebase', 'merge', 'none'),
      branch: arbValue(),
    },
    { requiredKeys: ['name', 'path', 'url'] },
  );

const serialize = (rows: ReadonlyArray<GitmodulesRow>): string =>
  rows
    .map((r) => {
      const lines = [`[submodule "${r.name}"]`];
      if (r.path !== undefined) lines.push(`\tpath = ${r.path}`);
      if (r.url !== undefined) lines.push(`\turl = ${r.url}`);
      if (r.update !== undefined) lines.push(`\tupdate = ${r.update}`);
      if (r.branch !== undefined) lines.push(`\tbranch = ${r.branch}`);
      return lines.join('\n');
    })
    .join('\n')
    .concat('\n');

describe('parseGitmodules properties', () => {
  describe('Given arbitrary safe-named submodule rows serialised to .gitmodules', () => {
    describe('When parsed back', () => {
      it('Then name/path/url/update/branch round-trip, in order', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc
              .uniqueArray(arbSafeName(), { minLength: 1, maxLength: 5 })
              .chain((names) => fc.tuple(...names.map((n) => arbRow(n)))),
            (rows) => {
              const result = parseGitmodules(serialize(rows));
              expect(result).toEqual(rows);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a mix of safe- and unsafe-named sections', () => {
    describe('When parsed', () => {
      it('Then no unsafe-named row survives and safe ones are preserved', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSafeName(), arbUnsafeName(), (safe, unsafe) => {
            const text = serialize([
              { name: unsafe, path: 'u' },
              { name: safe, path: 's' },
            ]);
            const result = parseGitmodules(text);
            expect(result.map((r) => r.name)).toEqual([safe]);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

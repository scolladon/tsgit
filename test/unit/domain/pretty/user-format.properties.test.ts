import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCommitView } from '../../../../src/domain/pretty/commit-view.js';
import {
  type AbbrevKind,
  type FormatEnv,
  type FormatOutput,
  formatCommit,
  formatRequirements,
  scanPlaceholders,
} from '../../../../src/domain/pretty/user-format.js';

const NUM_RUNS = 200;
const BUDGET = { describe: 1 } as const;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const VIEW = parseCommitView(
  encode(
    [
      `tree ${'a'.repeat(40)}`,
      `parent ${'b'.repeat(40)}`,
      `parent ${'c'.repeat(40)}`,
      'author A U Thor <author@example.com> 1700000200 +0545',
      'committer C O Mitter <committer@example.com> 1700000300 +0000',
      '',
      'subject\n\nbody\n',
    ].join('\n'),
  ),
);

const fragmentArb = fc.constantFrom(
  'text',
  ' ',
  '%',
  '+',
  '-',
  '%%',
  '%n',
  '%x41',
  '%xZZ',
  '%H',
  '%T',
  '%P',
  '%h',
  '%t',
  '%p',
  '%+h',
  '%-t',
  '% p',
  '%an',
  '%aN',
  '%aE',
  '%aL',
  '%cN',
  '%cE',
  '%cL',
  '%+aN',
  '%ad',
  '%aX',
  '%s',
  '%f',
  '%b',
  '%B',
  '%e',
  '%m',
  '%gd',
  '%S',
  '%N',
  '%Zz',
  '%(unknown)',
  '%+w(5)',
);

const formatArb = fc.array(fragmentArb, { maxLength: 12 }).map((parts) => parts.join(''));

interface Reads {
  readonly abbrev: Set<AbbrevKind>;
  mailmap: boolean;
}

const recordingEnv = (): { readonly env: FormatEnv; readonly reads: Reads } => {
  const reads: Reads = { abbrev: new Set(), mailmap: false };
  const env: FormatEnv = {
    commitId: 'd'.repeat(40),
    abbrev: (kind) => {
      reads.abbrev.add(kind);
      return 'abbrev';
    },
    mapUser: (ident) => {
      reads.mailmap = true;
      return ident;
    },
  };
  return { env, reads };
};

describe('Given an arbitrary format over a well-formed commit', () => {
  describe('When comparing the requirements with what formatting reads', () => {
    it('Then the requirements name exactly the data the expansion reads', () => {
      fc.assert(
        fc.property(formatArb, (format) => {
          // Arrange
          const tokens = scanPlaceholders(encode(format));
          const { env, reads } = recordingEnv();
          const sut = formatRequirements;

          // Act
          const requirements = sut(tokens);
          formatCommit(tokens, VIEW, env, BUDGET);

          // Assert
          expect(requirements.abbrev).toEqual(reads.abbrev);
          expect(requirements.mailmap).toBe(reads.mailmap);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

describe('Given arbitrary format bytes', () => {
  describe('When scanning and expanding', () => {
    it('Then it never throws and always returns bytes', () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 48 }), (format) => {
          // Arrange
          const { env } = recordingEnv();
          const sut = formatCommit;

          // Act
          const result = sut(scanPlaceholders(format), VIEW, env, BUDGET);

          // Assert
          expect('refused' in result || (result as FormatOutput).bytes instanceof Uint8Array).toBe(
            true,
          );
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

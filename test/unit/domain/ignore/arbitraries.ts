import fc from 'fast-check';

import { arbGlobPattern, arbLiteralPattern } from '../pathspec/arbitraries.js';

// A `.gitignore` line body that the parser accepts: optional `!` prefix,
// glob or literal body, optional trailing `/`. The pattern intentionally
// excludes `#`-prefixed and whitespace-only lines (those compose into
// `arbGitignoreText` separately).
export const arbGitignorePattern = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.boolean(), fc.oneof(arbLiteralPattern(), arbGlobPattern()), fc.boolean())
    .map(([negate, body, dirOnly]) => `${negate ? '!' : ''}${body}${dirOnly ? '/' : ''}`);

const arbCommentLine = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abc 12'.split('')), { minLength: 0, maxLength: 10 })
    .map((chars) => `# ${chars.join('')}`);

const arbBlankLine = (): fc.Arbitrary<string> => fc.constant('');

const arbGitignoreLine = (): fc.Arbitrary<string> =>
  fc.oneof(
    { arbitrary: arbGitignorePattern(), weight: 5 },
    { arbitrary: arbCommentLine(), weight: 1 },
    { arbitrary: arbBlankLine(), weight: 1 },
  );

export const arbGitignoreText = (): fc.Arbitrary<string> =>
  fc.array(arbGitignoreLine(), { minLength: 0, maxLength: 12 }).map((lines) => lines.join('\n'));

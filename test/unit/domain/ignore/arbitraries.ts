import fc from 'fast-check';

import {
  chainExclusion,
  type IgnoreLevel,
  parentDirectoryOf,
  type VerboseMatch,
} from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
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

const DIGITS = '0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const MAX_ANCESTORS = 2;
const MAX_ANCESTOR_LENGTH = 4;
const MAX_LAST_LENGTH = 6;
const MAX_FILLERS = 4;
const MAX_TRAILING_NEGATIONS = 2;
const MAX_EXTRA_LEVELS = 2;
const MAX_QUERY_SEGMENTS = 3;
const MAX_ANCESTOR_RULES = 6;

const arbWord = (alphabet: string, maxLength: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength: 1, maxLength })
    .map((chars) => chars.join(''));

export const arbGitignoreRules = (): fc.Arbitrary<ReadonlyArray<string>> =>
  fc.array(arbGitignorePattern(), { minLength: 0, maxLength: MAX_ANCESTOR_RULES });

const levelOf = (basedir: string, rawRules: ReadonlyArray<string>): IgnoreLevel => ({
  basedir: basedir as IgnoreLevel['basedir'],
  rules: parseGitignore(rawRules.join('\n')),
});

export interface ExcludedDirectoryCase {
  readonly stack: ReadonlyArray<IgnoreLevel>;
  readonly dirPath: string;
  readonly path: FilePath;
  readonly isDir: boolean;
  readonly excludingIndex: number;
}

interface ExcludedDirectoryParts {
  readonly ancestors: ReadonlyArray<string>;
  readonly last: string;
  readonly excluder: number;
  readonly fillers: ReadonlyArray<string>;
  readonly insertAt: number;
  readonly negationSegments: ReadonlyArray<string>;
  readonly extraLevels: ReadonlyArray<{
    readonly sub: string;
    readonly rules: ReadonlyArray<string>;
  }>;
  readonly query: ReadonlyArray<string>;
  readonly isDir: boolean;
}

const buildExcludedDirectoryCase = (parts: ExcludedDirectoryParts): ExcludedDirectoryCase => {
  const dirPath = [...parts.ancestors, parts.last].join('/');
  const excluders = [`${parts.last}/`, parts.last, `/${dirPath}/`, `${parts.last[0]}*`];
  const fillers = parts.fillers.filter((word) => word !== parts.last);
  const insertAt = Math.min(parts.insertAt, fillers.length);
  const negations = parts.negationSegments.flatMap((segment) => [
    `!/${dirPath}/${segment}`,
    `!${parts.last}/${segment}`,
  ]);
  const rootRules = [
    ...fillers.slice(0, insertAt),
    excluders[parts.excluder % excluders.length] as string,
    ...fillers.slice(insertAt),
    ...negations,
  ];
  const extra = parts.extraLevels.map(({ sub, rules }) =>
    levelOf(sub === '' ? dirPath : `${dirPath}/${sub}`, rules),
  );
  return {
    stack: [levelOf('', rootRules), ...extra],
    dirPath,
    path: `${dirPath}/${parts.query.join('/')}` as FilePath,
    isDir: parts.isDir,
    excludingIndex: insertAt,
  };
};

// Ancestors are digits and the excluded directory is letters, so no literal
// or letter-led glob can match an ancestor: the directory is the first excluded one.
export const arbExcludedDirectoryCase = (): fc.Arbitrary<ExcludedDirectoryCase> =>
  fc
    .record({
      ancestors: fc.array(arbWord(DIGITS, MAX_ANCESTOR_LENGTH), { maxLength: MAX_ANCESTORS }),
      last: arbWord(LETTERS, MAX_LAST_LENGTH),
      excluder: fc.nat(),
      fillers: fc.array(arbWord(LETTERS, MAX_LAST_LENGTH), { maxLength: MAX_FILLERS }),
      insertAt: fc.nat(MAX_FILLERS),
      negationSegments: fc.array(arbLiteralPattern(), { maxLength: MAX_TRAILING_NEGATIONS }),
      extraLevels: fc.array(
        fc.record({ sub: fc.constantFrom('', 'sub', 'sub/deep'), rules: arbGitignoreRules() }),
        { maxLength: MAX_EXTRA_LEVELS },
      ),
      query: fc.array(arbLiteralPattern(), { minLength: 1, maxLength: MAX_QUERY_SEGMENTS }),
      isDir: fc.boolean(),
    })
    .map(buildExcludedDirectoryCase);

const MAX_UNRELATED_LEVELS = 3;

// The `u-` prefix cannot equal a digits-only ancestor nor the letters-only directory.
export const arbLevelsBeyondDirectory = (
  dirPath: string,
): fc.Arbitrary<ReadonlyArray<IgnoreLevel>> =>
  fc.array(
    fc
      .tuple(fc.boolean(), arbLiteralPattern(), arbGitignoreRules())
      .map(([beneath, segment, rules]) =>
        levelOf(beneath ? `${dirPath}/${segment}` : `u-${segment}`, rules),
      ),
    { minLength: 1, maxLength: MAX_UNRELATED_LEVELS },
  );

export interface StackCase {
  readonly stack: ReadonlyArray<IgnoreLevel>;
  readonly path: FilePath;
  readonly isDir: boolean;
}

const MAX_PATH_SEGMENTS = 4;
const MAX_OWN_RULES = 6;

const arbOwnSegmentRule = (segments: ReadonlyArray<string>): fc.Arbitrary<string> =>
  fc
    .tuple(fc.boolean(), fc.constantFrom(...segments), fc.boolean())
    .map(([negate, segment, dirOnly]) => `${negate ? '!' : ''}${segment}${dirOnly ? '/' : ''}`);

const arbAncestorLevels = (
  segments: ReadonlyArray<string>,
): fc.Arbitrary<ReadonlyArray<IgnoreLevel>> =>
  fc.array(
    fc
      .tuple(fc.integer({ min: 1, max: Math.max(1, segments.length - 1) }), arbGitignoreRules())
      .map(([depth, rules]) => levelOf(segments.slice(0, depth).join('/'), rules)),
    { maxLength: MAX_EXTRA_LEVELS },
  );

const byDepth = (left: IgnoreLevel, right: IgnoreLevel): number =>
  left.basedir.split('/').length - right.basedir.split('/').length;

export const arbStackWithoutExcludedLeadingDirectory = (): fc.Arbitrary<StackCase> =>
  fc
    .array(arbLiteralPattern(), { minLength: 1, maxLength: MAX_PATH_SEGMENTS })
    .chain((segments) =>
      fc.record({
        rootRules: fc.array(fc.oneof(arbOwnSegmentRule(segments), arbGitignorePattern()), {
          maxLength: MAX_OWN_RULES,
        }),
        deeper: segments.length > 1 ? arbAncestorLevels(segments) : fc.constant([]),
        isDir: fc.boolean(),
        segments: fc.constant(segments),
      }),
    )
    .map(({ rootRules, deeper, isDir, segments }) => ({
      stack: [levelOf('', rootRules), ...[...deeper].sort(byDepth)],
      path: segments.join('/') as FilePath,
      isDir,
    }));

/**
 * Fixture: the chain a session would hand over for `directory` once every level is loaded —
 * `chainExclusion` folded over its leading directories, root-first.
 */
export const chainOver = (
  stack: ReadonlyArray<IgnoreLevel>,
  directory: FilePath | '',
): VerboseMatch | undefined =>
  directory === ''
    ? undefined
    : chainExclusion(stack, directory, chainOver(stack, parentDirectoryOf(directory)));

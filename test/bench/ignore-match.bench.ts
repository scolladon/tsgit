/**
 * Bench scenario: matching a walked tree against a parsed ignore ruleset —
 * the cost of the glob matcher alone, with no fs or config noise.
 * tsgit-only: there is no comparable baseline library.
 */
import { type IgnoreLevel, matchInStack, parseGitignore } from '../../src/domain/ignore/index.js';
import { FilePath } from '../../src/domain/objects/object-id.js';
import { benchScenario } from './support/bench-dsl.js';
import { IGNORE_RULES_PLAIN } from './support/ignore-rules.js';

const DIRECTORY_COUNT = 200;
const FILES_PER_DIRECTORY = 100;
const PACKAGE_COUNT = 20;
const EXTENSIONS = ['ts', 'js', 'log', 'pyc', 'o', 'md', 'json', 'txt', 'tmp', 'cache'] as const;

interface Entry {
  readonly path: FilePath;
  readonly isDir: boolean;
}

const buildDirectoryEntries = (directory: number): Entry[] => {
  const base = `pkg${directory % PACKAGE_COUNT}/mod${directory}`;
  const files = Array.from({ length: FILES_PER_DIRECTORY }, (_, file) => ({
    path: FilePath.from(
      `${base}/file${file}.${EXTENSIONS[(directory + file) % EXTENSIONS.length]}`,
    ),
    isDir: false,
  }));
  return [{ path: FilePath.from(base), isDir: true }, ...files];
};

const ENTRIES: ReadonlyArray<Entry> = Array.from({ length: DIRECTORY_COUNT }, (_, directory) =>
  buildDirectoryEntries(directory),
).flat();

const CLASS_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ['*.pyc', '*.py[cod]'],
  ['*.o', '*.[oa]'],
  ['*.swp', '*.s[wv]p'],
  ['build/', 'build[0-9]/'],
  ['dist/', 'dist[0-9]/'],
  ['file9*.md', 'file[0-9][0-9].md'],
  ['mod1*/', 'mod[13579]*/'],
  ['*.cache', '*.[Cc]ache'],
  ['pkg1*/gen/', 'pkg[!0]/gen/'],
  ['*.bak', '*.[bB]ak'],
  ['*.lock', '*.loc[a-k]'],
  ['Thumbs.db', 'Thumbs.d[ab]'],
]);

const RULES_CLASS: ReadonlyArray<string> = IGNORE_RULES_PLAIN.map(
  (line) => CLASS_REPLACEMENTS.get(line) ?? line,
);

const RULES_FLOOR: ReadonlyArray<string> = RULES_CLASS.map((line) =>
  line.replace(/\[[^\]]+\]/g, '?'),
);

const ignoreMatchScenario = (given: string, lines: ReadonlyArray<string>): void => {
  benchScenario(given, 'When every path is matched, Then measure tsgit alone', () => {
    const levels: ReadonlyArray<IgnoreLevel> = [
      { basedir: '', rules: parseGitignore(lines.join('\n')) },
    ];
    const tally = { ignored: 0 };
    return {
      sut: (): void => {
        for (const { path, isDir } of ENTRIES) {
          if (matchInStack(levels, path, isDir) === 'ignored') tally.ignored += 1;
        }
      },
    };
  });
};

ignoreMatchScenario(
  'Given 20000 walked paths and 40 ignore rules without bracket sets',
  IGNORE_RULES_PLAIN,
);
ignoreMatchScenario('Given 20000 walked paths and 40 ignore rules with bracket sets', RULES_CLASS);
ignoreMatchScenario(
  'Given 20000 walked paths and 40 ignore rules whose bracket sets are one-byte wildcards',
  RULES_FLOOR,
);

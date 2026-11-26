/**
 * Bench scenario: the ignore session answering a walk, against the same entries matched over
 * the loaded rules plus one directory match per distinct directory — the work no
 * leading-directory rule can avoid. tsgit-only: there is no comparable baseline library.
 */
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import {
  buildIgnoreEvaluator,
  buildRepoIgnorePredicate,
} from '../../src/application/primitives/internal/ignore-evaluator.js';
import { matchInStack } from '../../src/domain/ignore/index.js';
import { FilePath } from '../../src/domain/objects/object-id.js';
import type { Context } from '../../src/ports/context.js';
import { benchScenario } from './support/bench-dsl.js';
import { IGNORE_RULES_PLAIN } from './support/ignore-rules.js';

const PACKAGE_COUNT = 20;
const LIBRARIES_PER_PACKAGE = 10;
const FILES_PER_LIBRARY = 100;
const EXTENSIONS = ['ts', 'js', 'log', 'pyc', 'o', 'md', 'json', 'txt', 'tmp', 'cache'] as const;

interface Entry {
  readonly path: FilePath;
  readonly isDir: boolean;
}

const buildLibraryEntries = (pkg: number, library: number): Entry[] => {
  const base = `pkg${pkg}/lib${library}`;
  const files = Array.from({ length: FILES_PER_LIBRARY }, (_, file) => ({
    path: FilePath.from(`${base}/file${file}.${EXTENSIONS[(library + file) % EXTENSIONS.length]}`),
    isDir: false,
  }));
  return [{ path: FilePath.from(base), isDir: true }, ...files];
};

const buildPackageEntries = (pkg: number): Entry[] => [
  { path: FilePath.from(`pkg${pkg}`), isDir: true },
  ...Array.from({ length: LIBRARIES_PER_PACKAGE }, (_, library) =>
    buildLibraryEntries(pkg, library),
  ).flat(),
];

const ENTRIES: ReadonlyArray<Entry> = Array.from({ length: PACKAGE_COUNT }, (_, pkg) =>
  buildPackageEntries(pkg),
).flat();

const DIRECTORIES: ReadonlyArray<FilePath> = ENTRIES.filter(({ isDir }) => isDir).map(
  ({ path }) => path,
);

const buildContext = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, IGNORE_RULES_PLAIN.join('\n'));
  return ctx;
};

const assertNoDirectoryIsExcluded = async (ctx: Context): Promise<void> => {
  const { base } = await buildIgnoreEvaluator(ctx);
  const excluded = DIRECTORIES.find(
    (directory) => matchInStack(base, directory, true) === 'ignored',
  );
  if (excluded !== undefined) {
    throw new Error(`fixture directory ${excluded} is excluded by a rule; rename it`);
  }
};

const sessionScenario = (): void => {
  benchScenario(
    'Given 20200 walked entries in 200 directories two levels deep',
    'When the ignore session answers each in walk order, Then measure tsgit alone',
    async () => {
      const ctx = await buildContext();
      await assertNoDirectoryIsExcluded(ctx);
      const tally = { ignored: 0 };
      return {
        sut: async (): Promise<void> => {
          const isIgnored = await buildRepoIgnorePredicate(ctx);
          for (const { path, isDir } of ENTRIES) {
            if (await isIgnored(path, isDir)) tally.ignored += 1;
          }
        },
      };
    },
  );
};

const floorScenario = (): void => {
  benchScenario(
    'Given 20200 walked entries in 200 directories two levels deep',
    'When each entry and each distinct directory is matched once over the loaded rules, Then measure tsgit alone',
    async () => {
      const ctx = await buildContext();
      const tally = { ignored: 0 };
      return {
        sut: async (): Promise<void> => {
          const { base } = await buildIgnoreEvaluator(ctx);
          for (const { path, isDir } of ENTRIES) {
            if (matchInStack(base, path, isDir) === 'ignored') tally.ignored += 1;
          }
          for (const directory of DIRECTORIES) matchInStack(base, directory, true);
        },
      };
    },
  );
};

sessionScenario();
floorScenario();

import { parseGitInt, parseIniSections } from '../../../domain/config/config-ini.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { readUtf8IfPresent } from './fs-probes.js';

type RefStorage = 'files' | 'reftable';

const CONFIG_FILE = 'config';
const REFTABLE: RefStorage = 'reftable';
const MIN_EXTENSION_VERSION = 1;

type ConfigEntry = { readonly key: string; readonly value: string | null };

const topLevelEntries = (text: string, section: string): ReadonlyArray<ConfigEntry> =>
  parseIniSections(text)
    .filter(
      (candidate) =>
        candidate.section.toLowerCase() === section && candidate.subsection === undefined,
    )
    .flatMap((candidate) => candidate.entries);

const lastValueOf = (entries: ReadonlyArray<ConfigEntry>, key: string): string | null | undefined =>
  entries.filter((entry) => entry.key.toLowerCase() === key).at(-1)?.value;

const honoursExtensions = (core: ReadonlyArray<ConfigEntry>): boolean => {
  const version = parseGitInt(lastValueOf(core, 'repositoryformatversion') ?? null);
  return version.ok && version.value >= MIN_EXTENSION_VERSION;
};

/**
 * The ref backend a repository declares in `<gitDir>/config`, as git honours it:
 * `extensions.refStorage` counts from `core.repositoryformatversion` 1 up, and
 * anything but `reftable` reads as the files backend. Read through `fs`, which
 * must reach `gitDir` — a gitlink's repository is its own, never the parent's.
 */
export const refStorageOf = async (fs: FileSystem, gitDir: string): Promise<RefStorage> => {
  const text = await readUtf8IfPresent(fs, `${gitDir}/${CONFIG_FILE}`);
  if (text === undefined) return 'files';
  if (!honoursExtensions(topLevelEntries(text, 'core'))) return 'files';
  return lastValueOf(topLevelEntries(text, 'extensions'), 'refstorage') === REFTABLE
    ? REFTABLE
    : 'files';
};

import { tokenizeConfig } from '../../../domain/config/config-ini.js';
import {
  EXTENSIONS_SECTION,
  enumerateExtensionEntries,
  formatRefusal,
  honoursExtensions,
  lastTopLevelEntry,
  REF_STORAGE_VALUES,
  REFSTORAGE_KEY,
  type RefStorage,
  resolveEnum,
  resolveFormatVersion,
} from '../../../domain/config/repository-format-scan.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { readUtf8IfPresent } from './fs-probes.js';
import { throwFormatRefusal } from './repo-state.js';

const CONFIG_FILE = 'config';

/**
 * The ref backend a repository declares in `<commonDir>/config`, as git honours it:
 * `extensions.refStorage` counts from `core.repositoryformatversion` 1 up. The
 * value and the version are refused when malformed, whatever the version, and the
 * repository-format gate refuses what git refuses: a version above 1, an unknown
 * extension at version 1, a v1-only extension at version 0.
 * Read through `fs`, which must reach `commonDir`, where a linked worktree keeps
 * its config — a gitlink's repository is its own, never the parent's.
 */
export const refStorageOf = async (fs: FileSystem, commonDir: string): Promise<RefStorage> => {
  const source = `${commonDir}/${CONFIG_FILE}`;
  const text = await readUtf8IfPresent(fs, source);
  if (text === undefined) return 'files';
  const tokens = tokenizeConfig(text, source);
  const version = resolveFormatVersion(tokens, source);
  const entry = lastTopLevelEntry(tokens, EXTENSIONS_SECTION, REFSTORAGE_KEY);
  const declared = resolveEnum(
    entry,
    source,
    `${EXTENSIONS_SECTION}.${REFSTORAGE_KEY}`,
    REF_STORAGE_VALUES,
    'files',
  );
  const refusal = formatRefusal(version, enumerateExtensionEntries(tokens));
  if (refusal !== undefined) throwFormatRefusal(refusal);
  return honoursExtensions(version) ? declared : 'files';
};

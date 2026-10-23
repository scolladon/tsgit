import { tokenizeConfig } from '../../../domain/config/config-ini.js';
import {
  EXTENSIONS_SECTION,
  honoursExtensions,
  lastTopLevelEntry,
  REF_STORAGE_VALUES,
  REFSTORAGE_KEY,
  type RefStorage,
  resolveEnum,
  resolveFormatVersion,
} from '../../../domain/config/repository-format-scan.js';
import { repositoryExtensionsUnsupported } from '../../../domain/repository/error.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { readUtf8IfPresent } from './fs-probes.js';

const CONFIG_FILE = 'config';
const V1_ONLY_VERSION = 0;

/**
 * The ref backend a repository declares in `<commonDir>/config`, as git honours it:
 * `extensions.refStorage` counts from `core.repositoryformatversion` 1 up. The
 * value and the version are refused when malformed, whatever the version, and a
 * version 0 repository naming the extension is refused as git refuses it.
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
  if (entry !== undefined && version === V1_ONLY_VERSION) {
    throw repositoryExtensionsUnsupported(V1_ONLY_VERSION, [REFSTORAGE_KEY]);
  }
  return honoursExtensions(version) ? declared : 'files';
};

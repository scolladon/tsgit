/**
 * `repo.config.*` porcelain — nested-namespace shape per ADR-181. The methods
 * exported here are the Context-aware functions the namespace dispatcher in
 * `repository.ts` binds; `repo.config.get(input)` is roughly
 * `configGet(repo.ctx, input)`.
 *
 * Each command:
 *   1. asserts the context targets a repository,
 *   2. parses + validates inputs at the command boundary,
 *   3. composes the slice-7 readers / slice-8/9 writers,
 *   4. returns a typed result envelope (per-action shape, no discriminator).
 */
import type { ConfigKey, ConfigScope } from '../../domain/commands/config-key.js';
import { parseConfigKey } from '../../domain/commands/config-key.js';
import { configMultipleValues } from '../../domain/commands/error.js';
import type { Context } from '../../ports/context.js';
import {
  getAllConfigValues,
  getConfigValue,
  readConfigSections,
} from '../primitives/config-scoped-read.js';
import { qualifyKey } from '../primitives/internal/config-key.js';
import {
  removeConfigSection,
  renameConfigSection,
  setConfigEntry,
  unsetAllConfigEntries,
  unsetConfigEntry,
} from '../primitives/update-config.js';
import { assertRepository } from './internal/repo-state.js';

const brandKey = (raw: string): ConfigKey => raw as unknown as ConfigKey;

// ─── Read methods ───────────────────────────────────────────────────────────

export interface ConfigGetInput {
  readonly key: string;
  readonly scope?: ConfigScope;
}

export type ConfigGetResult =
  | { readonly key: ConfigKey; readonly value: string | null; readonly scope: ConfigScope }
  | { readonly key: ConfigKey; readonly value: undefined };

export const configGet = async (ctx: Context, input: ConfigGetInput): Promise<ConfigGetResult> => {
  await assertRepository(ctx);
  return input.scope === undefined
    ? await getConfigValue({ ctx, key: input.key })
    : await getConfigValue({ ctx, key: input.key, scope: input.scope });
};

export interface ConfigGetAllInput {
  readonly key: string;
  readonly scope?: ConfigScope;
}

export interface ConfigGetAllResult {
  readonly key: ConfigKey;
  readonly values: ReadonlyArray<{ readonly value: string | null; readonly scope: ConfigScope }>;
}

export const configGetAll = async (
  ctx: Context,
  input: ConfigGetAllInput,
): Promise<ConfigGetAllResult> => {
  await assertRepository(ctx);
  return input.scope === undefined
    ? await getAllConfigValues({ ctx, key: input.key })
    : await getAllConfigValues({ ctx, key: input.key, scope: input.scope });
};

export interface ConfigGetRegexpInput {
  readonly keyPattern: RegExp;
  readonly valuePattern?: RegExp;
  readonly scope?: ConfigScope;
}

export interface ConfigEntryView {
  readonly key: ConfigKey;
  /** `null` means the entry is present with no `=` (git's internal NULL). */
  readonly value: string | null;
  readonly scope: ConfigScope;
}

export interface ConfigGetRegexpResult {
  readonly entries: ReadonlyArray<ConfigEntryView>;
}

export const configGetRegexp = async (
  ctx: Context,
  input: ConfigGetRegexpInput,
): Promise<ConfigGetRegexpResult> => {
  await assertRepository(ctx);
  const scoped =
    input.scope === undefined
      ? await readConfigSections({ ctx })
      : await readConfigSections({ ctx, scope: input.scope });
  const entries: ConfigEntryView[] = [];
  for (const { scope, section } of scoped) {
    for (const entry of section.entries) {
      const qualified = qualifyKey(section, entry.key);
      if (!input.keyPattern.test(qualified)) continue;
      if (input.valuePattern !== undefined && !input.valuePattern.test(entry.value ?? '')) continue;
      entries.push({ key: brandKey(qualified), value: entry.value, scope });
    }
  }
  return { entries };
};

export interface ConfigListInput {
  readonly scope?: ConfigScope;
}

export interface ConfigListResult {
  readonly entries: ReadonlyArray<ConfigEntryView>;
}

export const configList = async (
  ctx: Context,
  input?: ConfigListInput,
): Promise<ConfigListResult> => {
  await assertRepository(ctx);
  const scoped =
    input?.scope === undefined
      ? await readConfigSections({ ctx })
      : await readConfigSections({ ctx, scope: input.scope });
  const entries: ConfigEntryView[] = [];
  for (const { scope, section } of scoped) {
    for (const entry of section.entries) {
      const qualified = qualifyKey(section, entry.key);
      entries.push({ key: brandKey(qualified), value: entry.value, scope });
    }
  }
  return { entries };
};

// ─── Write methods ──────────────────────────────────────────────────────────

export interface ConfigSetInput {
  readonly key: string;
  readonly value: string;
  readonly scope?: ConfigScope;
}

export interface ConfigSetResult {
  readonly key: ConfigKey;
  readonly value: string;
  readonly scope: ConfigScope;
}

export const configSet = async (ctx: Context, input: ConfigSetInput): Promise<ConfigSetResult> => {
  await assertRepository(ctx);
  const targetScope: ConfigScope = input.scope ?? 'local';
  const existing = await getAllConfigValues({ ctx, key: input.key, scope: targetScope });
  if (existing.values.length > 1) {
    throw configMultipleValues(input.key, existing.values.length, 'overwrite', targetScope);
  }
  await setConfigEntry({ ctx, key: input.key, value: input.value, scope: targetScope });
  return { key: brandKey(input.key), value: input.value, scope: targetScope };
};

export interface ConfigUnsetInput {
  readonly key: string;
  readonly scope?: ConfigScope;
}

export type ConfigUnsetResult =
  | {
      readonly key: ConfigKey;
      readonly scope: ConfigScope;
      readonly removed: true;
      /** The value that was removed. `null` when the entry had no `=`. */
      readonly previousValue: string | null;
    }
  | { readonly key: ConfigKey; readonly scope: ConfigScope; readonly removed: false };

export const configUnset = async (
  ctx: Context,
  input: ConfigUnsetInput,
): Promise<ConfigUnsetResult> => {
  await assertRepository(ctx);
  const targetScope: ConfigScope = input.scope ?? 'local';
  const existing = await getAllConfigValues({ ctx, key: input.key, scope: targetScope });
  if (existing.values.length === 0) {
    return { key: brandKey(input.key), scope: targetScope, removed: false };
  }
  if (existing.values.length > 1) {
    throw configMultipleValues(input.key, existing.values.length, 'remove', targetScope);
  }
  const [first] = existing.values;
  await unsetConfigEntry({ ctx, key: input.key, scope: targetScope });
  return {
    key: brandKey(input.key),
    scope: targetScope,
    removed: true,
    previousValue: (first as { value: string | null }).value,
  };
};

export interface ConfigUnsetAllInput {
  readonly key: string;
  readonly scope?: ConfigScope;
}

export interface ConfigUnsetAllResult {
  readonly key: ConfigKey;
  readonly scope: ConfigScope;
  readonly removed: number;
}

export const configUnsetAll = async (
  ctx: Context,
  input: ConfigUnsetAllInput,
): Promise<ConfigUnsetAllResult> => {
  await assertRepository(ctx);
  const targetScope: ConfigScope = input.scope ?? 'local';
  const existing = await getAllConfigValues({ ctx, key: input.key, scope: targetScope });
  if (existing.values.length === 0) {
    return { key: brandKey(input.key), scope: targetScope, removed: 0 };
  }
  await unsetAllConfigEntries({ ctx, key: input.key, scope: targetScope });
  return { key: brandKey(input.key), scope: targetScope, removed: existing.values.length };
};

export interface ConfigRenameSectionInput {
  readonly oldName: string;
  readonly newName: string;
  readonly scope?: ConfigScope;
}

export interface ConfigRenameSectionResult {
  readonly oldName: string;
  readonly newName: string;
  readonly scope: ConfigScope;
}

export const configRenameSection = async (
  ctx: Context,
  input: ConfigRenameSectionInput,
): Promise<ConfigRenameSectionResult> => {
  await assertRepository(ctx);
  const targetScope: ConfigScope = input.scope ?? 'local';
  await renameConfigSection({
    ctx,
    oldName: input.oldName,
    newName: input.newName,
    scope: targetScope,
  });
  return { oldName: input.oldName, newName: input.newName, scope: targetScope };
};

export interface ConfigRemoveSectionInput {
  readonly name: string;
  readonly scope?: ConfigScope;
}

export interface ConfigRemoveSectionResult {
  readonly name: string;
  readonly scope: ConfigScope;
}

export const configRemoveSection = async (
  ctx: Context,
  input: ConfigRemoveSectionInput,
): Promise<ConfigRemoveSectionResult> => {
  await assertRepository(ctx);
  const targetScope: ConfigScope = input.scope ?? 'local';
  await removeConfigSection({ ctx, sectionName: input.name, scope: targetScope });
  return { name: input.name, scope: targetScope };
};

// silence the unused-import warning for parseConfigKey — re-exported transitively
// via the primitives, but kept here so future per-command pre-flight validation
// can extend without re-importing.
export { parseConfigKey };

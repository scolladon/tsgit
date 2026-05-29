import type { Context } from '../../../ports/context.js';
import {
  type ConfigGetAllInput,
  type ConfigGetAllResult,
  type ConfigGetInput,
  type ConfigGetRegexpInput,
  type ConfigGetRegexpResult,
  type ConfigGetResult,
  type ConfigListInput,
  type ConfigListResult,
  type ConfigRemoveSectionInput,
  type ConfigRemoveSectionResult,
  type ConfigRenameSectionInput,
  type ConfigRenameSectionResult,
  type ConfigSetInput,
  type ConfigSetResult,
  type ConfigUnsetAllInput,
  type ConfigUnsetAllResult,
  type ConfigUnsetInput,
  type ConfigUnsetResult,
  configGet,
  configGetAll,
  configGetRegexp,
  configList,
  configRemoveSection,
  configRenameSection,
  configSet,
  configUnset,
  configUnsetAll,
} from '../config.js';

/**
 * The nested-namespace surface for `repo.config.*` (ADR-181). Each method
 * runs the caller-supplied `guard()` first (so a disposed repository throws
 * before any work) and then forwards to the corresponding context-aware
 * command in `commands/config.ts`.
 */
export interface ConfigNamespace {
  readonly get: (input: ConfigGetInput) => Promise<ConfigGetResult>;
  readonly getAll: (input: ConfigGetAllInput) => Promise<ConfigGetAllResult>;
  readonly getRegexp: (input: ConfigGetRegexpInput) => Promise<ConfigGetRegexpResult>;
  readonly list: (input?: ConfigListInput) => Promise<ConfigListResult>;
  readonly set: (input: ConfigSetInput) => Promise<ConfigSetResult>;
  readonly unset: (input: ConfigUnsetInput) => Promise<ConfigUnsetResult>;
  readonly unsetAll: (input: ConfigUnsetAllInput) => Promise<ConfigUnsetAllResult>;
  readonly renameSection: (input: ConfigRenameSectionInput) => Promise<ConfigRenameSectionResult>;
  readonly removeSection: (input: ConfigRemoveSectionInput) => Promise<ConfigRemoveSectionResult>;
}

/**
 * Bind the `repo.config.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindConfigNamespace = (ctx: Context, guard: () => void): ConfigNamespace => {
  const ns: ConfigNamespace = {
    get: (input) => {
      guard();
      return configGet(ctx, input);
    },
    getAll: (input) => {
      guard();
      return configGetAll(ctx, input);
    },
    getRegexp: (input) => {
      guard();
      return configGetRegexp(ctx, input);
    },
    list: (input) => {
      guard();
      return configList(ctx, input);
    },
    set: (input) => {
      guard();
      return configSet(ctx, input);
    },
    unset: (input) => {
      guard();
      return configUnset(ctx, input);
    },
    unsetAll: (input) => {
      guard();
      return configUnsetAll(ctx, input);
    },
    renameSection: (input) => {
      guard();
      return configRenameSection(ctx, input);
    },
    removeSection: (input) => {
      guard();
      return configRemoveSection(ctx, input);
    },
  };
  return Object.freeze(ns);
};

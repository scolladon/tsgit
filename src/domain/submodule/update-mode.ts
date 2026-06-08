/**
 * The recognised `submodule.<name>.update` modes git copies from `.gitmodules`
 * into `.git/config` during `init`. A `!command` form or any other token is
 * refused (git: `fatal: invalid value for 'submodule.<name>.update'`) — only
 * these four are valid.
 */
export type SubmoduleUpdateMode = 'checkout' | 'rebase' | 'merge' | 'none';

const VALID_MODES: ReadonlySet<string> = new Set(['checkout', 'rebase', 'merge', 'none']);

/** Returns the mode if recognised, else `undefined` (caller maps to a refusal). */
export const parseUpdateMode = (raw: string): SubmoduleUpdateMode | undefined =>
  VALID_MODES.has(raw) ? (raw as SubmoduleUpdateMode) : undefined;

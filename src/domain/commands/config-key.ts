/**
 * A validated git-config key. Branded to prevent string-typed callers from
 * passing a raw, unvalidated string into config primitives. Construct via
 * `parseConfigKey` only.
 */
export type ConfigKey = string & { readonly __brand: 'ConfigKey' };

/**
 * The four canonical git-config scopes. Order in the union is also the read
 * precedence (lowest precedence first): system → global → local → worktree.
 */
export type ConfigScope = 'system' | 'global' | 'local' | 'worktree';

/**
 * Result of parsing a fully-qualified config key like `section.name` or
 * `section.subsection.name`. Section and name are lower-cased per git's
 * case-insensitive rules; subsection is preserved verbatim.
 */
export interface ParsedConfigKey {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly name: string;
}

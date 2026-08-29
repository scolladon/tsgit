/**
 * The four canonical git-config scopes. Order in the union is also the read
 * precedence (lowest precedence first): system → global → local → worktree.
 */
export type ConfigScope = 'system' | 'global' | 'local' | 'worktree';

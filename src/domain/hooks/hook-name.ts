/**
 * The lifecycle hooks tsgit invokes. Extend the union to add a hook.
 *
 * Kept in the domain layer because both the `HookRunner` port and the
 * `HOOK_FAILED` command error reference it — a port may import domain, but
 * domain may never import a port.
 */
export type HookName =
  | 'pre-commit'
  | 'prepare-commit-msg'
  | 'commit-msg'
  | 'post-commit'
  | 'post-merge'
  | 'post-checkout'
  | 'pre-push'
  | 'pre-rebase'
  | 'post-rewrite';

import type { RepositoryLayout } from '../../../ports/context.js';

/**
 * True when repository-layout discovery refused this repository under the
 * ownership-trust gate (`assertTrusted` in `repo-state.ts`) — an untrusted
 * owner (`DUBIOUS_OWNERSHIP`) or an implicit bare repository refused under
 * `bareRepositories: 'explicit'` (`IMPLICIT_BARE_REPOSITORY`). Both refusals
 * leave the repository's local config file unread in exactly the same way,
 * so every config-read site that must not observe a refused repository's
 * `config` (`loadConfigEntry` in `config-read.ts`, `readSingleScope`'s
 * repository-scope guard in `config-scoped-read.ts`) keys on this one
 * predicate rather than re-deriving the question.
 */
export const layoutFailsTrustGate = (layout: RepositoryLayout): boolean =>
  layout.untrusted === true || layout.implicitBare === true;

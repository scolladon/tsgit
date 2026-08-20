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

/**
 * True when repository-layout discovery refused this repository under
 * either acceptance-tier refusal family: the ownership-trust gate
 * (`layoutFailsTrustGate` — `untrusted` / `implicitBare`) OR the
 * repository-format refusal (`formatRefusal` —
 * `core.repositoryformatversion` / an unknown `extensions.*`). This is the
 * layout-level mirror of what `assertAcceptedRepository` refuses on: it
 * folds the trust gate together with the format refusal into the single
 * question "is this repository accepted at all". Both refusal classes leave
 * the repository's local config file unread in exactly the same way, so
 * every config-read site that must not observe a refused repository's
 * `config` or object state — and there is no reason a future site would be
 * exempt — keys on this one predicate rather than re-deriving the
 * disjunction.
 */
export const layoutFailsAcceptance = (layout: RepositoryLayout): boolean =>
  layoutFailsTrustGate(layout) || layout.formatRefusal !== undefined;

/**
 * The acceptance verdicts a derived child `Context` must inherit from its
 * parent's `RepositoryLayout` — `untrusted`, `implicitBare`, `foreignPath`,
 * `formatRefusal`. These are properties of the REPOSITORY, not of the entry
 * point, so they must survive layout derivation: a derived context that
 * dropped them would read as accepted and re-open the config of a
 * repository the gate refused. Every caller sits behind the acceptance tier
 * today, so honouring this at derivation time is defence in depth rather
 * than a live fix.
 */
export const inheritedAcceptanceVerdicts = (
  layout: RepositoryLayout,
): Pick<RepositoryLayout, 'untrusted' | 'implicitBare' | 'foreignPath' | 'formatRefusal'> => ({
  ...(layout.untrusted !== undefined ? { untrusted: layout.untrusted } : {}),
  ...(layout.implicitBare !== undefined ? { implicitBare: layout.implicitBare } : {}),
  ...(layout.foreignPath !== undefined ? { foreignPath: layout.foreignPath } : {}),
  ...(layout.formatRefusal !== undefined ? { formatRefusal: layout.formatRefusal } : {}),
});

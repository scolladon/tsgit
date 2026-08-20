import type { RepositoryLayout } from '../../../ports/context.js';

/**
 * True when repository-layout discovery refused this repository under the
 * ownership-trust gate (`assertTrusted` in `repo-state.ts`) — an untrusted
 * owner (`DUBIOUS_OWNERSHIP`) or an implicit bare repository refused under
 * `bareRepositories: 'explicit'` (`IMPLICIT_BARE_REPOSITORY`).
 *
 * `loadConfigEntry` in `config-read.ts` is the only site keying on this half
 * alone; every other refusal-aware site takes `layoutFailsAcceptance` below,
 * which states why that one is deliberately narrower. Being down to a single
 * caller does not make this guard redundant — see there before removing it.
 */
export const layoutFailsTrustGate = (layout: RepositoryLayout): boolean =>
  layout.untrusted === true || layout.implicitBare === true;

/**
 * True when either acceptance-tier refusal family rejected this repository:
 * the ownership-trust gate above, or a repository-format refusal
 * (`core.repositoryformatversion` / an unknown `extensions.*`). The
 * layout-level mirror of what `assertAcceptedRepository` refuses on.
 *
 * Refusal-aware sites key on this rather than re-deriving the disjunction:
 * `readSingleScope` (`config-scoped-read.ts`), `isWorktreeScopeActive` and
 * `resolveScopePath` (`config-scope.ts`), `assertUsableForBundleVerify`
 * (`bundle-verify.ts`).
 *
 * `loadConfigEntry` (`config-read.ts`) is the one deliberate exemption, and
 * it is not an oversight to correct. Widening it would drop the read that
 * the format refusal was itself derived from — both key on
 * `<commonDir>/config` — and it would buy nothing:
 * `assertAcceptedRepository` raises the format refusal before any
 * operational verb reads config, and the `config` porcelain that stays on
 * the bare tier reads through the scoped reader, which is on this predicate.
 * Ownership, by contrast, is decidable with no I/O at open time, so guarding
 * on it there is free.
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

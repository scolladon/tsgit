const DEPRECATION_SUPPRESS_ENV_VAR = 'TSGIT_SUPPRESS_DEPRECATIONS';

const warnedCallsites = new Set<string>();

const isSuppressed = (): boolean => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[DEPRECATION_SUPPRESS_ENV_VAR] === '1';
};

/**
 * Emits a deprecation warning at most once per `callsite`. The set-based
 * dedup keeps long-running daemons (e.g. an editor LSP) from spamming the
 * log when the same deprecated path is hit thousands of times.
 *
 * Output is suppressed entirely when the `TSGIT_SUPPRESS_DEPRECATIONS=1`
 * environment variable is set (per ADR-160). Defensive against browser
 * contexts where `process` is undefined — the lookup never throws.
 *
 * See `docs/use/snapshots.md` for the deprecation policy that drives
 * Wave 8 (legacy walker removal in tsgit 2.0).
 */
export const warnDeprecated = (callsite: string, message: string): void => {
  if (isSuppressed()) return;
  if (warnedCallsites.has(callsite)) return;
  warnedCallsites.add(callsite);
  const logger = (globalThis as { console?: Console }).console;
  logger?.warn(`[tsgit deprecation] ${callsite}: ${message}`);
};

/** @internal — for unit tests only. Resets the dedup set. */
export const _resetDeprecationState = (): void => {
  warnedCallsites.clear();
};

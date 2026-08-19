/**
 * Pure comparison: scanned call sites vs the loaded allowlist.
 *
 * - `unguarded` — a call site whose `{module, verb}` is not allowlisted.
 * - `unattributable` — a call site the analyzer could not attribute to an
 *   exported declaration (`verb` is `undefined`). Never dropped silently:
 *   an unattributable call is the exact shape a bypass would take.
 * - `stale` — an allowlist entry matching no `{module, verb}` pair among the
 *   scanned call sites — the `allowlistRot` posture the sibling audits take.
 */
import type { CallSite } from './analyze-call-sites.ts';
import type { AllowEntry } from './load-allowlist.ts';

export interface UnguardedFinding {
  readonly module: string;
  readonly verb: string;
  readonly line: number;
}

export interface UnattributableFinding {
  readonly module: string;
  readonly line: number;
}

export interface AssertTierFindings {
  readonly unguarded: readonly UnguardedFinding[];
  readonly unattributable: readonly UnattributableFinding[];
  readonly stale: readonly AllowEntry[];
}

/** Module paths are repo-relative POSIX paths and verbs are JS identifiers —
 * neither ever contains "::", so it is a safe, readable composite-key join. */
const allowKey = (module: string, verb: string): string => `${module}::${verb}`;

export const computeFindings = (
  callSites: readonly CallSite[],
  allowlist: readonly AllowEntry[],
): AssertTierFindings => {
  const allowed = new Set(allowlist.map((entry) => allowKey(entry.module, entry.verb)));
  const matched = new Set<string>();

  const unguarded: UnguardedFinding[] = [];
  const unattributable: UnattributableFinding[] = [];
  for (const site of callSites) {
    if (site.verb === undefined) {
      unattributable.push({ module: site.module, line: site.line });
      continue;
    }
    const key = allowKey(site.module, site.verb);
    if (allowed.has(key)) {
      matched.add(key);
    } else {
      unguarded.push({ module: site.module, verb: site.verb, line: site.line });
    }
  }

  const stale = allowlist.filter((entry) => !matched.has(allowKey(entry.module, entry.verb)));

  return { unguarded, unattributable, stale };
};

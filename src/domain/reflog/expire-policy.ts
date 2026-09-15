/**
 * `gc.reflogExpire` / `gc.reflogExpireUnreachable` / `gc.<pattern>.*` policy —
 * git's `reflog_expire_config` (entry validation, in file order) and
 * `reflog_expire_options_set_refname` (per-ref slot resolution), pure.
 *
 * The entry type lives here (not in `application/primitives/config-read.ts`)
 * so the application layer imports it, never the reverse.
 */
import { configBadDateValue, configMissingValue } from '../commands/error.js';
import type { RefName } from '../objects/index.js';
import { compileRefGlob } from '../refs/ref-glob.js';

export interface ReflogExpiryConfigEntry {
  /** Subsection text verbatim; `undefined` for a subsectionless `[gc]` entry. */
  readonly pattern: string | undefined;
  readonly slot: 'total' | 'unreachable';
  /** `null` — a present-but-valueless entry (git's internal NULL). */
  readonly value: string | null;
  /** Fully-qualified, lowercased key with the subsection kept verbatim. */
  readonly key: string;
  readonly source: string;
  /** 1-based config-file line. */
  readonly line: number;
}

export interface ExpiryCuts {
  readonly expireCut: number;
  readonly unreachableCut: number;
}

export interface ExplicitExpiryCuts {
  readonly total?: number;
  readonly unreachable?: number;
}

export interface ReflogExpiryPolicy {
  readonly cutoffsFor: (ref: RefName | 'HEAD') => ExpiryCuts;
}

const NEVER = Number.NEGATIVE_INFINITY;
const STASH_REF = 'refs/stash' as RefName;

interface PatternSlots {
  total: number | undefined;
  unreachable: number | undefined;
}

interface CompiledPattern extends PatternSlots {
  readonly test: (ref: string) => boolean;
}

export interface ParsedExpiryConfig {
  readonly patterns: ReadonlyArray<CompiledPattern>;
  readonly globalTotal: number | undefined;
  readonly globalUnreachable: number | undefined;
}

/** Two sections sharing the same subsection text merge into one pattern
 *  entry — found by a first-seen-order lookup, so a later section only
 *  adds slots to it. */
const findOrCreatePattern = (
  byText: Map<string, CompiledPattern>,
  ordered: CompiledPattern[],
  pattern: string,
): CompiledPattern => {
  const existing = byText.get(pattern);
  if (existing !== undefined) return existing;
  const created: CompiledPattern = {
    test: compileRefGlob(pattern),
    total: undefined,
    unreachable: undefined,
  };
  byText.set(pattern, created);
  ordered.push(created);
  return created;
};

const applyEntry = (
  config: { globalTotal: number | undefined; globalUnreachable: number | undefined },
  byText: Map<string, CompiledPattern>,
  ordered: CompiledPattern[],
  entry: ReflogExpiryConfigEntry,
  cutoff: number,
): void => {
  if (entry.pattern === undefined) {
    if (entry.slot === 'total') config.globalTotal = cutoff;
    else config.globalUnreachable = cutoff;
    return;
  }
  const record = findOrCreatePattern(byText, ordered, entry.pattern);
  record[entry.slot] = cutoff;
};

/**
 * git's `reflog_expire_config`: every entry is parsed in file order and the
 * FIRST invalid one throws — whether or not it matches any ref, and
 * regardless of a later valid duplicate that would otherwise override it.
 * `parse` is `resolveExpiryCutoff` bound to the run's `now`.
 */
export const parseReflogExpiryEntries = (
  entries: ReadonlyArray<ReflogExpiryConfigEntry>,
  parse: (raw: string) => number | undefined,
): ParsedExpiryConfig => {
  const byText = new Map<string, CompiledPattern>();
  const ordered: CompiledPattern[] = [];
  const config = {
    globalTotal: undefined as number | undefined,
    globalUnreachable: undefined as number | undefined,
  };
  for (const entry of entries) {
    if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
    const cutoff = parse(entry.value);
    if (cutoff === undefined) {
      throw configBadDateValue(entry.value, {
        key: entry.key,
        source: entry.source,
        line: entry.line,
      });
    }
    applyEntry(config, byText, ordered, entry, cutoff);
  }
  return {
    patterns: ordered,
    globalTotal: config.globalTotal,
    globalUnreachable: config.globalUnreachable,
  };
};

const resolveSlot = (
  explicit: number | undefined,
  matched: PatternSlots | undefined,
  slot: keyof PatternSlots,
  ref: string,
  global: number | undefined,
  fallback: number,
): number => {
  if (explicit !== undefined) return explicit;
  if (matched !== undefined) return matched[slot] ?? NEVER;
  if (ref === STASH_REF) return NEVER;
  return global ?? fallback;
};

/**
 * git's `reflog_expire_options_set_refname`, per slot: an explicit flag
 * wins; else the first matching pattern (checked once, shared by both
 * slots) — its own unset slot is `never`, not a fall-through; else
 * `refs/stash` is `never`; else the last valid `[gc]` value; else the
 * default.
 */
export const expiryPolicyFor = (
  config: ParsedExpiryConfig,
  explicit: ExplicitExpiryCuts,
  defaults: ExpiryCuts,
): ReflogExpiryPolicy => {
  const cutoffsFor = (ref: RefName | 'HEAD'): ExpiryCuts => {
    const matched = config.patterns.find((pattern) => pattern.test(ref));
    return {
      expireCut: resolveSlot(
        explicit.total,
        matched,
        'total',
        ref,
        config.globalTotal,
        defaults.expireCut,
      ),
      unreachableCut: resolveSlot(
        explicit.unreachable,
        matched,
        'unreachable',
        ref,
        config.globalUnreachable,
        defaults.unreachableCut,
      ),
    };
  };
  return { cutoffsFor };
};

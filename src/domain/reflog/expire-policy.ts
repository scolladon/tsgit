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

type ExpirySlot = ReflogExpiryConfigEntry['slot'];

interface PatternSlots {
  readonly total: number | undefined;
  readonly unreachable: number | undefined;
}

interface CompiledPattern extends PatternSlots {
  readonly test: (ref: string) => boolean;
}

export interface ParsedExpiryConfig {
  readonly patterns: ReadonlyArray<CompiledPattern>;
  readonly globalTotal: number | undefined;
  readonly globalUnreachable: number | undefined;
}

interface ValidatedEntry {
  readonly pattern: string | undefined;
  readonly slot: ExpirySlot;
  readonly cutoff: number;
}

const validateEntry = (
  entry: ReflogExpiryConfigEntry,
  parse: (raw: string) => number | undefined,
): ValidatedEntry => {
  if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
  const cutoff = parse(entry.value);
  if (cutoff === undefined) {
    throw configBadDateValue(entry.value, {
      key: entry.key,
      source: entry.source,
      line: entry.line,
    });
  }
  return { pattern: entry.pattern, slot: entry.slot, cutoff };
};

/** Entries sharing a subsection (`undefined` for `[gc]` itself), in
 *  first-seen order — two sections with the same pattern text are one
 *  pattern, a later section only adding or overriding its slots. */
const groupBySubsection = (
  entries: ReadonlyArray<ValidatedEntry>,
): ReadonlyMap<string | undefined, ReadonlyArray<ValidatedEntry>> => {
  const groups = new Map<string | undefined, ValidatedEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.pattern);
    if (group === undefined) groups.set(entry.pattern, [entry]);
    else group.push(entry);
  }
  return groups;
};

const lastCutoff = (entries: ReadonlyArray<ValidatedEntry>, slot: ExpirySlot): number | undefined =>
  entries.reduce<number | undefined>(
    (last, entry) => (entry.slot === slot ? entry.cutoff : last),
    undefined,
  );

const compilePatterns = (
  groups: ReadonlyMap<string | undefined, ReadonlyArray<ValidatedEntry>>,
): ReadonlyArray<CompiledPattern> =>
  [...groups].flatMap(([pattern, group]) =>
    pattern === undefined
      ? []
      : [
          {
            test: compileRefGlob(pattern),
            total: lastCutoff(group, 'total'),
            unreachable: lastCutoff(group, 'unreachable'),
          },
        ],
  );

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
  const groups = groupBySubsection(entries.map((entry) => validateEntry(entry, parse)));
  const globals = groups.get(undefined) ?? [];
  return {
    patterns: compilePatterns(groups),
    globalTotal: lastCutoff(globals, 'total'),
    globalUnreachable: lastCutoff(globals, 'unreachable'),
  };
};

/** Where each slot reads its `[gc]` value and its default from. */
const SLOT_FIELDS = {
  total: { global: 'globalTotal', fallback: 'expireCut' },
  unreachable: { global: 'globalUnreachable', fallback: 'unreachableCut' },
} as const;

interface SlotResolution {
  readonly config: ParsedExpiryConfig;
  readonly explicit: ExplicitExpiryCuts;
  readonly defaults: ExpiryCuts;
  readonly ref: RefName | 'HEAD';
  readonly matched: PatternSlots | undefined;
}

const resolveSlot = (resolution: SlotResolution, slot: ExpirySlot): number => {
  const { config, explicit, defaults, ref, matched } = resolution;
  const explicitCut = explicit[slot];
  if (explicitCut !== undefined) return explicitCut;
  if (matched !== undefined) return matched[slot] ?? NEVER;
  if (ref === STASH_REF) return NEVER;
  return config[SLOT_FIELDS[slot].global] ?? defaults[SLOT_FIELDS[slot].fallback];
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
): ReflogExpiryPolicy => ({
  cutoffsFor: (ref: RefName | 'HEAD'): ExpiryCuts => {
    const matched = config.patterns.find((pattern) => pattern.test(ref));
    const resolution: SlotResolution = { config, explicit, defaults, ref, matched };
    return {
      expireCut: resolveSlot(resolution, 'total'),
      unreachableCut: resolveSlot(resolution, 'unreachable'),
    };
  },
});

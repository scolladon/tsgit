#!/usr/bin/env node
/**
 * Compares two same-runner benchmark snapshots (base vs head) on a
 * per-scenario median-ms basis, scoped to `tsgit`-named entries only
 * (isomorphic-git rows are dropped). A row regresses when the head is
 * more than `policy.thresholdPct` percent slower than the base — the
 * comparison is asymmetric, so improvements never flag. The default
 * threshold is `DEFAULT_THRESHOLD_PCT`; callers may override it (e.g. via
 * the `REGRESSION_THRESHOLD` env var, resolved by the CLI wrapper).
 */
import type { SnapshotEntry } from './bench-to-snapshot.js';

export const DEFAULT_THRESHOLD_PCT = 10;

const TSGIT_KEY_SUFFIX = ' > tsgit';

export const gatedEntries = (entries: readonly SnapshotEntry[]): readonly SnapshotEntry[] =>
  entries.filter((entry) => entry.name.endsWith(TSGIT_KEY_SUFFIX));

type Verdict = 'pass' | 'regress' | 'new' | 'missing';

export interface CompareRow {
  readonly key: string;
  readonly baseMs: number | null;
  readonly currentMs: number | null;
  readonly deltaPct: number | null;
  readonly verdict: Verdict;
}

export interface CompareResult {
  readonly rows: readonly CompareRow[];
  readonly failed: boolean;
}

const classifyRow = (
  key: string,
  baseMs: number | undefined,
  currentMs: number | undefined,
  thresholdPct: number,
): CompareRow => {
  if (baseMs === undefined) {
    return { key, baseMs: null, currentMs: currentMs ?? null, deltaPct: null, verdict: 'new' };
  }
  if (currentMs === undefined) {
    return { key, baseMs, currentMs: null, deltaPct: null, verdict: 'missing' };
  }
  if (baseMs === 0) {
    return { key, baseMs, currentMs, deltaPct: null, verdict: 'missing' };
  }
  const deltaPct = ((currentMs - baseMs) / baseMs) * 100;
  const verdict: Verdict = deltaPct > thresholdPct ? 'regress' : 'pass';
  return { key, baseMs, currentMs, deltaPct, verdict };
};

export const compareToBaseline = (
  base: readonly SnapshotEntry[],
  current: readonly SnapshotEntry[],
  policy: { readonly thresholdPct: number },
): CompareResult => {
  const baseByKey = new Map(base.map((entry) => [entry.name, entry.value]));
  const currentByKey = new Map(current.map((entry) => [entry.name, entry.value]));
  const keys = [...new Set([...baseByKey.keys(), ...currentByKey.keys()])].sort();

  const rows = keys.map((key) =>
    classifyRow(key, baseByKey.get(key), currentByKey.get(key), policy.thresholdPct),
  );
  const failed = rows.some((row) => row.verdict === 'regress');

  return { rows, failed };
};

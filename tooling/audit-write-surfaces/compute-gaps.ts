/**
 * Pure set-difference between declared write surfaces, coverage claims
 * pulled from `interopSurface:` headers, and allowlist exemptions.
 *
 * Output lists are sorted by surface name for deterministic report diffs.
 */
export type WriteKind = 'byte-identical' | 'equivalent-under-readback' | 'readback-only';

export interface WriteSurface {
  readonly name: string;
  readonly kind: WriteKind;
  readonly format: string;
  readonly declaredIn: string;
}

export interface Coverage {
  readonly surface: string;
  readonly coveredBy: ReadonlyArray<string>;
}

export interface AllowEntry {
  readonly surface: string;
  readonly reason: string;
  readonly deferredTo: string | null;
}

export interface ComputeGapsInput {
  readonly surfaces: ReadonlyArray<WriteSurface>;
  readonly covered: ReadonlyArray<Coverage>;
  readonly exempt: ReadonlyArray<AllowEntry>;
}

export interface CoveredSurface {
  readonly name: string;
  readonly kind: WriteKind;
  readonly format: string;
  readonly declaredIn: string;
  readonly coveredBy: ReadonlyArray<string>;
}

export interface ComputeGapsOutput {
  readonly covered: ReadonlyArray<CoveredSurface>;
  readonly exempt: ReadonlyArray<AllowEntry>;
  readonly gaps: ReadonlyArray<WriteSurface>;
  readonly allowlistRot: ReadonlyArray<string>;
  readonly orphanCoverage: ReadonlyArray<Coverage>;
}

const byName = <T,>(get: (item: T) => string) =>
  (a: T, b: T): number => get(a).localeCompare(get(b));

export const computeGaps = (input: ComputeGapsInput): ComputeGapsOutput => {
  const exemptSet = new Set(input.exempt.map((entry) => entry.surface));
  const declaredSet = new Set(input.surfaces.map((surface) => surface.name));
  const coverageMap = new Map<string, Coverage>();
  for (const entry of input.covered) coverageMap.set(entry.surface, entry);

  const covered: CoveredSurface[] = [];
  const gaps: WriteSurface[] = [];

  for (const surface of input.surfaces) {
    if (exemptSet.has(surface.name)) continue;
    const claim = coverageMap.get(surface.name);
    if (claim === undefined) {
      gaps.push(surface);
      continue;
    }
    covered.push({
      name: surface.name,
      kind: surface.kind,
      format: surface.format,
      declaredIn: surface.declaredIn,
      coveredBy: [...claim.coveredBy].sort(),
    });
  }

  const allowlistRot: string[] = [];
  for (const entry of input.exempt) {
    if (!declaredSet.has(entry.surface)) allowlistRot.push(entry.surface);
  }

  const orphanCoverage: Coverage[] = [];
  for (const entry of input.covered) {
    if (!declaredSet.has(entry.surface)) orphanCoverage.push(entry);
  }

  return {
    covered: covered.sort(byName((item) => item.name)),
    exempt: [...input.exempt].sort(byName((item) => item.surface)),
    gaps: gaps.sort(byName((item) => item.name)),
    allowlistRot: allowlistRot.sort(),
    orphanCoverage: orphanCoverage.sort(byName((item) => item.surface)),
  };
};

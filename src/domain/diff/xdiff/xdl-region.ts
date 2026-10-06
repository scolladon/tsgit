/** A 1-based `[line, line + count)` window of each side, as xdiff's recursive algorithms pass them. */
export interface LineRegion {
  readonly line1: number;
  readonly count1: number;
  readonly line2: number;
  readonly count2: number;
}

/** Marks a region with the classic diff — xdiff's `fall_back_to_classic_diff`. */
export type ClassicFallback = (region: LineRegion) => void;

/** Where a recursive algorithm records its verdicts. */
export interface RegionSink {
  readonly oursChanged: Uint8Array;
  readonly theirsChanged: Uint8Array;
  readonly fallback: ClassicFallback;
}

/** Marks every line of the region changed on both sides. */
export function markRegion(sink: RegionSink, region: LineRegion): void {
  sink.oursChanged.fill(1, region.line1 - 1, region.line1 - 1 + region.count1);
  sink.theirsChanged.fill(1, region.line2 - 1, region.line2 - 1 + region.count2);
}

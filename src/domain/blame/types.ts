/**
 * A contiguous run of blamed lines tracked by the blame scoreboard. `count`
 * consecutive lines of the queried file, starting at the 0-based `finalStart`,
 * currently map to the suspect blob's lines `[sourceStart, sourceStart + count)`
 * (also 0-based). As blame passes down the history, `sourceStart` is remapped to
 * each parent's numbering while `finalStart`/`count` stay fixed to the final file.
 */
export interface BlameEntry {
  readonly finalStart: number;
  readonly count: number;
  readonly sourceStart: number;
}

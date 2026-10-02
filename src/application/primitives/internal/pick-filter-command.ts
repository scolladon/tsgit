/** The command `apply_filter` runs for one conversion. */
export interface FilterCommand {
  /** `single` feeds the content on stdin; `process` speaks git's v2 filter protocol. */
  readonly kind: 'single' | 'process';
  readonly command: string;
}

const isNamed = (command: string | undefined): command is string =>
  command !== undefined && command !== '';

/**
 * git's `apply_filter` pick: a configured `process` — even an empty one —
 * shadows the single-file `clean`/`smudge` command, and only a non-empty
 * command runs at all.
 */
export const pickFilterCommand = (
  process: string | undefined,
  single: string | undefined,
): FilterCommand | undefined => {
  if (process === undefined && isNamed(single)) return { kind: 'single', command: single };
  if (isNamed(process)) return { kind: 'process', command: process };
  return undefined;
};

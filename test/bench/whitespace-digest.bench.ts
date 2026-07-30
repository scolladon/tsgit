/**
 * Bench: `digestNormalizedLine` — the go/no-go for replacing a native
 * `indexOf(LF)` scan plus a JS fold pass with a single JS pass that also
 * finds the terminator. No fixture, no `git` — pure in-memory bytes, over
 * every `WhitespaceMode` × {many short lines, one long line}.
 */
import {
  digestNormalizedLine,
  type LineKey,
  type WhitespaceMode,
} from '../../src/domain/diff/whitespace.js';
import { benchScenario } from './support/bench-dsl.js';

const MODES: readonly WhitespaceMode[] = ['all', 'change', 'at-eol', 'none'];

const enc = new TextEncoder();

/** 5,000 short lines, each with trailing whitespace to fold. */
const SHORT_LINES: readonly Uint8Array[] = Array.from({ length: 5_000 }, (_, i) =>
  enc.encode(`line ${i}  \n`),
);

/** One 70,000-byte line, one line's worth of pure whitespace-fold work. */
const LONG_LINE: Uint8Array = enc.encode(`${'a '.repeat(35_000)}\n`);

for (const mode of MODES) {
  const key: LineKey = { mode, ignoreCrAtEol: false };

  benchScenario(
    `Given ${SHORT_LINES.length} short lines`,
    `When digestNormalizedLine folds each line under mode '${mode}', Then measure tsgit`,
    () => ({
      sut: (): void => {
        for (const line of SHORT_LINES) digestNormalizedLine(line, key);
      },
    }),
  );

  benchScenario(
    'Given one 70,000-byte line',
    `When digestNormalizedLine folds it under mode '${mode}', Then measure tsgit`,
    () => ({
      sut: (): void => {
        digestNormalizedLine(LONG_LINE, key);
      },
    }),
  );
}

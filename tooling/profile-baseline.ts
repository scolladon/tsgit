// Writes the committed per-command profiling artifact — `docs/perf/baseline.json`
// (machine-readable) and its `docs/perf/baseline.md` sibling (human-readable) —
// from the digest partitions Part 2's parser produces, keyed by command name.
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DigestPartition, FrameShare } from './profile-digest.ts';

export type CommandBaseline = DigestPartition;

export type Baseline = {
  readonly generatedOn: string;
  readonly commands: Record<string, CommandBaseline>;
};

const PERF_DIR_SEGMENTS = ['docs', 'perf'] as const;
const BASELINE_JSON_FILE = 'baseline.json';
const BASELINE_MD_FILE = 'baseline.md';

/** `<platform-arch> / node <version> / <CPU model>` — metadata only, never compared. */
export const machineBanner = (): string =>
  `${process.platform}-${process.arch} / node ${process.version} / ${os.cpus()[0]?.model}`;

export const renderBaselineJson = (baseline: Baseline): string =>
  `${JSON.stringify(baseline, null, 2)}\n`;

const frameTableRow = (share: FrameShare): string => `| ${share.frame} | ${share.self} |`;

const frameTable = (shares: ReadonlyArray<FrameShare>): string =>
  ['| frame | self |', '| --- | --- |', ...shares.map(frameTableRow)].join('\n');

const setupSection = (setupShares: ReadonlyArray<FrameShare> | undefined): ReadonlyArray<string> =>
  setupShares === undefined
    ? []
    : [
        '',
        '### setupShares',
        '',
        frameTable(setupShares),
        '',
        '_Shared object-write frames reached by both the scratch build and the ' +
          'measured command are attributed to `command`, never `setup`._',
      ];

const commandSection = (name: string, baseline: CommandBaseline): string =>
  [
    `## ${name}`,
    '',
    '### hotShares',
    '',
    frameTable(baseline.hotShares),
    ...setupSection(baseline.setupShares),
  ].join('\n');

export const renderBaselineMarkdown = (baseline: Baseline): string =>
  `${Object.entries(baseline.commands)
    .map(([name, commandBaseline]) => commandSection(name, commandBaseline))
    .join('\n\n')}\n`;

export const writeBaseline = async (baseline: Baseline, root: string): Promise<void> => {
  const perfDir = path.join(root, ...PERF_DIR_SEGMENTS);
  await mkdir(perfDir, { recursive: true });
  await writeFile(path.join(perfDir, BASELINE_JSON_FILE), renderBaselineJson(baseline), 'utf8');
  await writeFile(path.join(perfDir, BASELINE_MD_FILE), renderBaselineMarkdown(baseline), 'utf8');
};

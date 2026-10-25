import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { runGit } from './interop-helpers.js';
import {
  commitOn,
  danglingLinkAt,
  directoryHolding,
  fileAt,
  ignoring,
  KEEP,
  link1,
  type Occupant,
  type Outcome,
  outcomeOfGitStderr,
  regular,
  replacing,
  symlink,
  type TreeEntry,
  v1,
} from './occupant-displacement-fixtures.js';

export type Variant = 'same' | 'reset-updates' | 'reset-adds' | 'reset-deletes';

export interface AbortRow {
  readonly shape: string;
  readonly tracked: ReadonlyArray<TreeEntry>;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly addOccupant?: Occupant;
  readonly variants: ReadonlyArray<Variant>;
}

export const EVERY_VARIANT: ReadonlyArray<Variant> = [
  'same',
  'reset-updates',
  'reset-adds',
  'reset-deletes',
];
export const WITHOUT_ADDS: ReadonlyArray<Variant> = ['same', 'reset-updates', 'reset-deletes'];

export const modifiedInPlace =
  (rel: string): Occupant =>
  (dir) =>
    writeFileSync(path.join(dir, rel), 'modified\n');

export const both =
  (...occupants: ReadonlyArray<Occupant>): Occupant =>
  (dir) => {
    for (const occupant of occupants) occupant(dir);
  };

export const ABORT_ROWS: ReadonlyArray<AbortRow> = [
  {
    shape: 'S1',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', fileAt('d')),
    addOccupant: fileAt('d'),
    variants: ['same', 'reset-updates', 'reset-adds', 'reset-deletes'],
  },
  {
    shape: 'S2',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', directoryHolding('f', 'u')),
    addOccupant: directoryHolding('f', 'u'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'S3a',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', danglingLinkAt('d')),
    addOccupant: danglingLinkAt('d'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'S3b',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', danglingLinkAt('f')),
    addOccupant: danglingLinkAt('f'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'S3c',
    tracked: [link1('l')],
    due: [symlink('l')],
    occupant: replacing('l', directoryHolding('l', 'u')),
    addOccupant: directoryHolding('l', 'u'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'S3d',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', fileAt('d')),
    addOccupant: fileAt('d'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'S3e',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', danglingLinkAt('d')),
    addOccupant: danglingLinkAt('d'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'S3f',
    tracked: [link1('f')],
    due: [symlink('f')],
    occupant: replacing('f', fileAt('f')),
    addOccupant: fileAt('f'),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'I1',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', ignoring('d', fileAt('d'))),
    addOccupant: ignoring('d', fileAt('d')),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'I2',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', ignoring('f/u', directoryHolding('f', 'u'))),
    addOccupant: ignoring('f/u', directoryHolding('f', 'u')),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'I4',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', ignoring('d', fileAt('d'))),
    addOccupant: ignoring('d', fileAt('d')),
    variants: EVERY_VARIANT,
  },
  {
    shape: 'M1',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: modifiedInPlace('f'),
    variants: ['same', 'reset-updates'],
  },
  {
    shape: 'Y3',
    tracked: [v1('f'), v1('g')],
    due: [regular('f'), regular('g')],
    occupant: both(replacing('f', directoryHolding('f', 'u')), replacing('g', fileAt('g'))),
    variants: EVERY_VARIANT,
  },
];

export const entriesOf = (
  variant: Variant,
  row: Pick<AbortRow, 'tracked' | 'due'>,
): {
  base: ReadonlyArray<TreeEntry>;
  main: ReadonlyArray<TreeEntry>;
  theirs: ReadonlyArray<TreeEntry>;
} => {
  if (variant === 'reset-deletes') return { base: [], main: [], theirs: row.due };
  const theirs = { same: row.tracked, 'reset-updates': row.due, 'reset-adds': [] }[variant];
  return { base: row.tracked, main: row.tracked, theirs };
};

/** `main` and `t` both rewrite `keep` off a shared base, so `merge t` stops with `keep` conflicted. */
export const buildStoppedMerge = (
  dir: string,
  entries: ReturnType<typeof entriesOf>,
  stopped: { readonly keepMain?: string; readonly keepTheirs?: string } = {},
): void => {
  const base = commitOn(dir, [KEEP, ...entries.base]);
  const main = commitOn(dir, [regular('keep', stopped.keepMain ?? 'm\n'), ...entries.main], base);
  const theirs = commitOn(
    dir,
    [regular('keep', stopped.keepTheirs ?? 't\n'), ...entries.theirs],
    base,
  );
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/t', theirs]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const NOT_UPTODATE = /Entry '(.*)' not uptodate/;
const UNTRACKED_PATH = /(?:Untracked working tree file|Updating) '(.*?)'/;

export const firstClassified = (stderr: string): Outcome => {
  const local = NOT_UPTODATE.exec(stderr)?.[1];
  if (local !== undefined) return { refused: true, localChanges: [local], untracked: [] };
  const untracked = UNTRACKED_PATH.exec(stderr)?.[1];
  if (untracked !== undefined) return { refused: true, localChanges: [], untracked: [untracked] };
  return outcomeOfGitStderr(stderr);
};

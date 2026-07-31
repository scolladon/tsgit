/**
 * Cross-tool interop — the streaming drop-pass predicate (B4, no `withStat`)
 * and the interned-int stat pass (`withStat: true`) must survive the exact
 * same files as real `git diff --name-status` for each of the five
 * whitespace/CR/blank-line flags. One shared repo (built once in `beforeAll`)
 * carries a linear commit per flag, each touching a mode-only-different file
 * (must be dropped) alongside a real-content-change file (must survive).
 *
 * @proves
 *   surface:        diff.ignoreWhitespace / diff.ignoreCrAtEol / diff.ignoreBlankLines
 *   bucket:         cross-tool-interop
 *   unique:         the streaming predicate path and the interned-Myers stat path agree with
 *                    each other AND with git's --ignore-all-space / --ignore-space-change /
 *                    --ignore-space-at-eol / --ignore-cr-at-eol / --ignore-blank-lines survivors
 *   interopSurface: diff
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  PatchOptions,
  StatDiffChange,
  StatTreeDiff,
  TreeDiff,
} from '../../src/domain/diff/index.js';
import { resolveLineKey } from '../../src/domain/diff/index.js';
import { openRepository } from '../../src/index.node.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, runGitAsync, runGitEnv } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700020000 +0000',
  GIT_COMMITTER_DATE: '1700020000 +0000',
} as const;

interface ScenarioDiffOpts {
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
}

interface Scenario {
  readonly label: string;
  readonly gitFlag: string;
  readonly diffOpts: ScenarioDiffOpts;
  readonly modeOnlyBefore: string;
  readonly modeOnlyAfter: string;
  /**
   * `--ignore-blank-lines` only suppresses numstat/patch output for a
   * blank-only change — the file still shows up in `--name-only` (matches
   * the existing whitespace-interop BL1 finding). Every other flag drops
   * the mode-only file from name-status entirely.
   */
  readonly modeOnlySurvivesNameStatus: boolean;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    label: 'ignore-all-space',
    gitFlag: '--ignore-all-space',
    diffOpts: { ignoreWhitespace: 'all' },
    modeOnlyBefore: 'a b\n',
    modeOnlyAfter: 'a  b\n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-space-change',
    gitFlag: '--ignore-space-change',
    diffOpts: { ignoreWhitespace: 'change' },
    modeOnlyBefore: 'a b\n',
    modeOnlyAfter: 'a    b\n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-space-at-eol',
    gitFlag: '--ignore-space-at-eol',
    diffOpts: { ignoreWhitespace: 'at-eol' },
    modeOnlyBefore: 'a\n',
    modeOnlyAfter: 'a   \n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-cr-at-eol',
    gitFlag: '--ignore-cr-at-eol',
    diffOpts: { ignoreCrAtEol: true },
    modeOnlyBefore: 'a\r\n',
    modeOnlyAfter: 'a\n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-blank-lines',
    gitFlag: '--ignore-blank-lines',
    diffOpts: { ignoreBlankLines: true },
    modeOnlyBefore: 'a\n',
    modeOnlyAfter: 'a\n\n',
    modeOnlySurvivesNameStatus: true,
  },
];

const REAL_BEFORE = 'real one\n';
const REAL_AFTER = 'real two\n';

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;
const shaByLabel = new Map<string, { readonly from: string; readonly to: string }>();

describe.skipIf(!GIT_AVAILABLE)(
  'integration — whitespace-mode predicate/stat parity',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-ws-modes-interop-')));
      await runGitAsync(['init', '-q', '-b', 'main', dir]);
      await runGitAsync(['-C', dir, 'config', 'user.name', 'Ada']);
      await runGitAsync(['-C', dir, 'config', 'user.email', 'ada@example.com']);

      for (const scenario of SCENARIOS) {
        await writeFile(path.join(dir, 'mode-only.txt'), scenario.modeOnlyBefore);
        await writeFile(path.join(dir, 'real.txt'), REAL_BEFORE);
        await runGitAsync(['-C', dir, 'add', 'mode-only.txt', 'real.txt']);
        await runGitAsync(['-C', dir, 'commit', '-q', '-m', `${scenario.label}-base`], {
          env: { ...runGitEnv(), ...IDENTITY },
        });
        const from = (await runGitAsync(['-C', dir, 'rev-parse', 'HEAD'])).trim();

        await writeFile(path.join(dir, 'mode-only.txt'), scenario.modeOnlyAfter);
        await writeFile(path.join(dir, 'real.txt'), REAL_AFTER);
        await runGitAsync(['-C', dir, 'add', 'mode-only.txt', 'real.txt']);
        await runGitAsync(['-C', dir, 'commit', '-q', '-m', `${scenario.label}-change`], {
          env: { ...runGitEnv(), ...IDENTITY },
        });
        const to = (await runGitAsync(['-C', dir, 'rev-parse', 'HEAD'])).trim();

        shaByLabel.set(scenario.label, { from, to });
      }

      repo = await openRepository({ cwd: dir });
    }, 60_000);

    afterAll(async () => {
      await repo.dispose();
      await rm(dir, { recursive: true, force: true });
    });

    const survivorPaths = (treeDiff: TreeDiff): ReadonlyArray<string> =>
      treeDiff.changes
        .filter((c): c is typeof c & { readonly type: 'modify' } => c.type === 'modify')
        .map((c) => c.path as string)
        .sort();

    describe.each(SCENARIOS)('Given a $label change set', (scenario) => {
      describe('When diffing with the predicate path (no withStat), the stat path (withStat:true), and real git', () => {
        it('Then all three agree on which files survive', async () => {
          // Arrange
          const { from, to } = shaByLabel.get(scenario.label)!;
          const liveNameStatus = await runGitAsync([
            '-C',
            dir,
            'diff',
            '--no-ext-diff',
            '--name-only',
            scenario.gitFlag,
            from,
            to,
          ]);
          const livePaths = liveNameStatus
            .split('\n')
            .filter((l) => l.length > 0)
            .sort();

          // Act
          const predicateResult = await repo.diff({ from, to, ...scenario.diffOpts });
          const statResult = await repo.diff({ from, to, ...scenario.diffOpts, withStat: true });

          // Assert
          expect(survivorPaths(predicateResult)).toEqual(livePaths);
          expect(survivorPaths(statResult)).toEqual(livePaths);
          expect(survivorPaths(predicateResult)).toEqual(survivorPaths(statResult));
          expect(livePaths).toEqual(
            scenario.modeOnlySurvivesNameStatus ? ['mode-only.txt', 'real.txt'] : ['real.txt'],
          );
        });
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'integration — whitespace predicate honours .gitattributes diff overrides',
  { timeout: 60_000 },
  () => {
    let attrDir = '';
    let attrRepo: Awaited<ReturnType<typeof openRepository>>;
    let attrFrom = '';
    let attrTo = '';

    beforeAll(async () => {
      attrDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-ws-attr-interop-')));
      await runGitAsync(['init', '-q', '-b', 'main', attrDir]);
      await runGitAsync(['-C', attrDir, 'config', 'user.name', 'Ada']);
      await runGitAsync(['-C', attrDir, 'config', 'user.email', 'ada@example.com']);
      await runGitAsync(['-C', attrDir, 'config', 'diff.identity.textconv', 'cat']);

      await writeFile(
        path.join(attrDir, '.gitattributes'),
        'nodiff.txt -diff\nconv.txt diff=identity\n',
      );
      await writeFile(path.join(attrDir, 'nodiff.txt'), 'a b\n');
      await writeFile(path.join(attrDir, 'conv.txt'), 'a b\n');
      await writeFile(path.join(attrDir, 'plain.txt'), 'a b\n');
      await runGitAsync(['-C', attrDir, 'add', '.']);
      await runGitAsync(['-C', attrDir, 'commit', '-q', '-m', 'base'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      attrFrom = (await runGitAsync(['-C', attrDir, 'rev-parse', 'HEAD'])).trim();

      // Whitespace-only edits to all three files.
      await writeFile(path.join(attrDir, 'nodiff.txt'), 'a  b\n');
      await writeFile(path.join(attrDir, 'conv.txt'), 'a  b\n');
      await writeFile(path.join(attrDir, 'plain.txt'), 'a  b\n');
      await runGitAsync(['-C', attrDir, 'add', '.']);
      await runGitAsync(['-C', attrDir, 'commit', '-q', '-m', 'ws-only'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      attrTo = (await runGitAsync(['-C', attrDir, 'rev-parse', 'HEAD'])).trim();

      attrRepo = await openRepository({ cwd: attrDir });
    }, 60_000);

    afterAll(async () => {
      await attrRepo.dispose();
      await rm(attrDir, { recursive: true, force: true });
    });

    describe('Given whitespace-only edits to a -diff file, a textconv file, and a plain file', () => {
      describe('When diffing with ignoreWhitespace on the predicate path, the stat path, and real git', () => {
        it('Then all three agree — the -diff file survives (binary attr), the plain file drops', async () => {
          // Arrange
          const liveNameOnly = await runGitAsync([
            '-C',
            attrDir,
            'diff',
            '--no-ext-diff',
            '--name-only',
            '--ignore-all-space',
            attrFrom,
            attrTo,
          ]);
          const livePaths = liveNameOnly
            .split('\n')
            .filter((line) => line.length > 0)
            .sort();

          // Act
          const predicateResult = await attrRepo.diff({
            from: attrFrom,
            to: attrTo,
            ignoreWhitespace: 'all',
          });
          const statResult = await attrRepo.diff({
            from: attrFrom,
            to: attrTo,
            ignoreWhitespace: 'all',
            withStat: true,
          });
          const survivors = (treeDiff: TreeDiff): ReadonlyArray<string> =>
            treeDiff.changes.map((c) => ('path' in c ? (c.path as string) : '')).sort();

          // Assert — the attribute-marked binary file must survive like git's
          // (whitespace flags never apply to a `-diff` file); the plain file
          // must still drop; and both tsgit paths must agree with git exactly
          expect(livePaths).toContain('nodiff.txt');
          expect(livePaths).not.toContain('plain.txt');
          expect(survivors(predicateResult)).toEqual(livePaths);
          expect(survivors(statResult)).toEqual(livePaths);
        });
      });
    });
  },
);

/**
 * The divergence ledger — pins today's known disagreements between tsgit and
 * live git, plus controls that must not move, as an executable oracle. Every
 * `tsgitDivergence` field a fix commit corrects is deleted by that commit,
 * which is the visible statement of what it changed: once deleted, the
 * assertion falls back to git's own live verdict, so the suite stays green
 * only if the fix actually landed.
 */
interface LedgerRow {
  readonly fixture: string;
  readonly gitFlag: string | undefined;
  readonly diffOpts: ScenarioDiffOpts;
  /** What tsgit is KNOWN to answer where it differs from git today. Absent ⇒ tsgit
   *  must agree with git. Each fix commit deletes exactly its own entries. */
  readonly tsgitDivergence?: {
    readonly predicateSurvives?: boolean;
    readonly statSurvives?: boolean;
    readonly numstat?: readonly [number | '-', number | '-'];
    readonly patchIsBinary?: boolean;
  };
}

interface LabeledLedgerRow extends LedgerRow {
  readonly label: string;
}

interface LedgerFixture {
  readonly before: string | Uint8Array;
  readonly after: string | Uint8Array;
}

const ledgerRow = (
  fixture: string,
  gitFlag: string | undefined,
  diffOpts: ScenarioDiffOpts,
  tsgitDivergence?: LedgerRow['tsgitDivergence'],
): LabeledLedgerRow => ({
  fixture,
  gitFlag,
  diffOpts,
  label: `${fixture} ${gitFlag ?? 'plain'}`,
  ...(tsgitDivergence !== undefined ? { tsgitDivergence } : {}),
});

const IGNORE_ALL: ScenarioDiffOpts = { ignoreWhitespace: 'all' };
const IGNORE_CHANGE: ScenarioDiffOpts = { ignoreWhitespace: 'change' };
const IGNORE_AT_EOL: ScenarioDiffOpts = { ignoreWhitespace: 'at-eol' };
const IGNORE_CR: ScenarioDiffOpts = { ignoreCrAtEol: true };
const IGNORE_ALL_AND_BLANK: ScenarioDiffOpts = { ignoreWhitespace: 'all', ignoreBlankLines: true };

/** A fixture pinned to already agree with git under all four active-key flags — a control. */
const controlRows = (fixture: string): readonly LabeledLedgerRow[] => [
  ledgerRow(fixture, '-w', IGNORE_ALL),
  ledgerRow(fixture, '-b', IGNORE_CHANGE),
  ledgerRow(fixture, '--ignore-space-at-eol', IGNORE_AT_EOL),
  ledgerRow(fixture, '--ignore-cr-at-eol', IGNORE_CR),
];

const LEDGER_ROWS: readonly LabeledLedgerRow[] = [
  // C4 — a final-terminator difference is whitespace under every active key,
  // matching git (the fix commit that landed this deleted every tsgitDivergence
  // entry in this family; each row now falls back to git's own live verdict).
  ...controlRows('lf-gain.txt'),
  ...controlRows('lf-loss.txt'),
  ...controlRows('lf-gain-multi.txt'),
  ...controlRows('sp-no-eol.txt'),
  ...controlRows('tab-no-eol.txt'),
  ledgerRow('lf-gain-plus-ws.txt', '-w', IGNORE_ALL),
  ledgerRow('lf-gain-plus-ws.txt', '-b', IGNORE_CHANGE),
  ledgerRow('lf-gain-plus-ws.txt', '--ignore-space-at-eol', IGNORE_AT_EOL), // control: both keep
  ledgerRow('lf-gain-plus-ws.txt', '--ignore-cr-at-eol', IGNORE_CR), // control: both keep
  // Controls that must NOT move.
  ...controlRows('lf-gain-plus-txt.txt'),
  ...controlRows('lf-gain-empty.txt'),
  ledgerRow('lf-gain-empty.txt', '-w --ignore-blank-lines', IGNORE_ALL_AND_BLANK), // control: both drop
  ...controlRows('cr-then-lf.txt'),
  // C4's numstat half is cleared too: the terminator-only change on line 2 no
  // longer counts once the last line pair interns to one id under -w.
  ledgerRow('ctx-gain.txt', '-w', IGNORE_ALL),
  ledgerRow('ctx-loss.txt', '-w', IGNORE_ALL),
  // C6 — a CR ending an incomplete final line is significant to git under
  // --ignore-cr-at-eol, matching git (the fix commit that landed this deleted
  // the tsgitDivergence entry; the row now falls back to git's own live verdict).
  ledgerRow('cr-no-eol.txt', '-w', IGNORE_ALL), // control: both drop
  ledgerRow('cr-no-eol.txt', '-b', IGNORE_CHANGE), // control: both drop
  ledgerRow('cr-no-eol.txt', '--ignore-space-at-eol', IGNORE_AT_EOL), // control: both drop
  ledgerRow('cr-no-eol.txt', '--ignore-cr-at-eol', IGNORE_CR),
  // C5 — the line-length/line-count caps used to mark a whitespace-only change
  // binary on the stat arm (a binary side is never dropped), even after the
  // predicate arm stopped reading them. The stat arm now takes its verdict from
  // the same scanner as the predicate arm, so both agree with git here.
  // Cost control: `-w` only.
  ledgerRow('tail-ws.txt', '-w', IGNORE_ALL), // 345 B on disk — buffered arm
  ledgerRow('rand-1line.txt', '-w', IGNORE_ALL), // >64 KiB on disk — streaming arm
  ledgerRow('len-65536.txt', '-w', IGNORE_ALL),
  ledgerRow('lines-100000.txt', '-w', IGNORE_ALL),
  // Survives on both (a real change is never dropped); the line-length cap no
  // longer decides isBinary, so numstat/patch now agree with git here too.
  ledgerRow('long-line-txt.txt', '-w', IGNORE_ALL),
  // The same fixture, on the plain path (no whitespace flag): the line-length
  // cap used to mark it binary there too — a divergence the C5 fix above never
  // swept since it only pinned this fixture's survive verdict. Now a control.
  ledgerRow('long-line-txt.txt', undefined, {}),
  // C7 — under the line-count cap but over the diff-size cap: the stat arm's
  // `diffLines` whole-file fallback used to disagree with the predicate arm and
  // git (kept where both drop). Neither arm decides its verdict via `diffLines`
  // any more, so both agree with git here too.
  ledgerRow('lines-99999.txt', '-w', IGNORE_ALL),
  // C8 — the line-length cap used to mark a plain (no whitespace flag) real
  // change binary too, and the edit-distance-driven degrade that followed it
  // for oversized inputs. Both `longline.txt` (single over-cap line) and
  // `manylines.txt` (many lines, one-line edit — its edit distance is tiny) are
  // now fixed and fully covered by dedicated per-consumer interop cases
  // elsewhere, so their rows are deleted here.
  ledgerRow('manylines.txt', undefined, {}),
  // The NUL-boundary pair — a permanent control proving git's own binary
  // window ([0, 8 000)) is already matched exactly.
  ledgerRow('nul-7999.txt', undefined, {}),
  ledgerRow('nul-8000.txt', undefined, {}),
];

const buildLinesPair = (
  count: number,
  changeAt: number,
  changedBefore: string,
  changedAfter: string,
): LedgerFixture => {
  const beforeLines = Array.from({ length: count }, (_, i) =>
    i === changeAt ? changedBefore : `line-${i}`,
  );
  const afterLines = [...beforeLines];
  afterLines[changeAt] = changedAfter;
  return { before: `${beforeLines.join('\n')}\n`, after: `${afterLines.join('\n')}\n` };
};

/** A 32-bit integer hash with strong avalanche (triple32) — each byte comes from
 *  hashing its own index, not a chained generator, so consecutive bytes carry no
 *  exploitable correlation for deflate's matcher. */
const mix32 = (x: number): number => {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/** A deterministic byte stream over a near-full range (excluding NUL/LF/CR) — dense
 *  enough that deflate cannot find useful matches, so its compressed size stays close
 *  to its raw size instead of shrinking well below it. */
const pseudoRandomBytes = (length: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const candidate = mix32((seed * 1_000_003 + i) >>> 0) & 0xff;
    bytes[i] = candidate === 0x00 || candidate === 0x0a || candidate === 0x0d ? 0x01 : candidate;
  }
  return bytes;
};

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A single line with a NUL at `offset` (0-indexed) — inside [0, 8 000) is git's
 *  and tsgit's shared binary window; at or past it, the line stays text. */
const nulAt = (offset: number, totalLength: number): string =>
  `${'a'.repeat(offset)}\0${'a'.repeat(totalLength - offset - 1)}\n`;

const RAND_HALF_BYTES = 40_000;

const LEDGER_FIXTURES: Readonly<Record<string, LedgerFixture>> = {
  'lf-gain.txt': { before: 'x y', after: 'x y\n' },
  'lf-loss.txt': { before: 'x y\n', after: 'x y' },
  'lf-gain-multi.txt': { before: 'a\nb\nc', after: 'a\nb\nc\n' },
  'sp-no-eol.txt': { before: ' ', after: '\n' },
  'tab-no-eol.txt': { before: 'a\t', after: 'a\n' },
  'cr-then-lf.txt': { before: 'x y\r\n', after: 'x y\n' },
  'cr-no-eol.txt': { before: 'x y\r', after: 'x y' },
  'lf-gain-plus-ws.txt': { before: 'x y', after: 'x  y\n' },
  'lf-gain-plus-txt.txt': { before: 'x y', after: 'x z\n' },
  'lf-gain-empty.txt': { before: '', after: '\n' },
  'ctx-gain.txt': { before: 'a\nb', after: 'A\nb\n' },
  'ctx-loss.txt': { before: 'a\nb\n', after: 'A\nb' },
  'tail-ws.txt': { before: `${'a'.repeat(70_000)}\n`, after: `${'a'.repeat(70_000)} \n` },
  'rand-1line.txt': {
    before: concatBytes(
      pseudoRandomBytes(RAND_HALF_BYTES, 1),
      ascii(' '),
      pseudoRandomBytes(RAND_HALF_BYTES, 2),
      ascii('\n'),
    ),
    after: concatBytes(
      pseudoRandomBytes(RAND_HALF_BYTES, 1),
      ascii('  '),
      pseudoRandomBytes(RAND_HALF_BYTES, 2),
      ascii('\n'),
    ),
  },
  'len-65536.txt': { before: 'a'.repeat(65_536), after: `${'a'.repeat(65_536)} ` },
  'lines-100000.txt': buildLinesPair(100_000, 50_000, 'mid line', 'mid  line'),
  'long-line-txt.txt': { before: `${'a'.repeat(70_000)}\n`, after: `${'a'.repeat(69_999)}b\n` },
  'lines-99999.txt': buildLinesPair(99_999, 50_000, 'mid line', 'mid  line'),
  'longline.txt': { before: `${'a'.repeat(70_000)}\n`, after: `${'a'.repeat(69_999)}b\n` },
  'manylines.txt': buildLinesPair(100_001, 50_000, 'mid line', 'mid line CHANGED'),
  'nul-7999.txt': { before: `${'a'.repeat(8_200)}\n`, after: nulAt(7_999, 8_200) },
  'nul-8000.txt': { before: `${'a'.repeat(8_200)}\n`, after: nulAt(8_000, 8_200) },
};

const flagArgsFor = (gitFlag: string | undefined): readonly string[] =>
  gitFlag === undefined ? [] : gitFlag.split(' ');

/** Live git's survivor verdict — `git diff-tree --no-ext-diff -r <flag> --name-only`. */
const gitLedgerSurvives = async (
  dir: string,
  gitFlag: string | undefined,
  from: string,
  to: string,
): Promise<boolean> => {
  const output = await runGitAsync([
    '-C',
    dir,
    'diff-tree',
    '--no-ext-diff',
    '--no-color',
    '-r',
    ...flagArgsFor(gitFlag),
    '--name-only',
    from,
    to,
  ]);
  return output.trim().length > 0;
};

/** Live git's numstat verdict for the row's single changed file. */
const gitLedgerNumstat = async (
  dir: string,
  gitFlag: string | undefined,
  from: string,
  to: string,
): Promise<readonly [number | '-', number | '-']> => {
  const output = await runGitAsync([
    '-C',
    dir,
    'diff-tree',
    '--no-ext-diff',
    '--no-color',
    '-r',
    ...flagArgsFor(gitFlag),
    '--numstat',
    from,
    to,
  ]);
  const [added, deleted] = output.trim().split('\t');
  return [added === '-' ? '-' : Number(added), deleted === '-' ? '-' : Number(deleted)];
};

/** Live git's patch-body verdict — whether it renders a binary or a text body. */
const gitLedgerPatchIsBinary = async (
  dir: string,
  gitFlag: string | undefined,
  from: string,
  to: string,
): Promise<boolean> => {
  const output = await runGitAsync([
    '-C',
    dir,
    'diff-tree',
    '--no-ext-diff',
    '--no-color',
    '-r',
    ...flagArgsFor(gitFlag),
    '-p',
    from,
    to,
  ]);
  return output.includes('Binary files');
};

const patchOptionsFor = (diffOpts: ScenarioDiffOpts): PatchOptions => ({
  lineKey: resolveLineKey(diffOpts),
  ...(diffOpts.ignoreBlankLines === true ? { ignoreBlankLines: true } : {}),
});

const findModifyChange = (
  changes: StatTreeDiff['changes'],
  fixture: string,
): (StatDiffChange & { readonly type: 'modify' }) | undefined =>
  changes.find(
    (c): c is StatDiffChange & { readonly type: 'modify' } =>
      c.type === 'modify' && c.path === fixture,
  );

interface TsgitLedgerVerdict {
  readonly predicateSurvives: boolean;
  readonly statSurvives: boolean;
  readonly statResult: StatTreeDiff;
}

/** tsgit's predicate-arm and stat-arm verdicts for one row, computed via `repo.diff`. */
const tsgitLedgerVerdict = async (
  repo: Awaited<ReturnType<typeof openRepository>>,
  from: string,
  to: string,
  diffOpts: ScenarioDiffOpts,
  fixture: string,
): Promise<TsgitLedgerVerdict> => {
  const predicateResult = await repo.diff({ from, to, ...diffOpts });
  const statResult = await repo.diff({ from, to, ...diffOpts, withStat: true });
  return {
    predicateSurvives: predicateResult.changes.some(
      (c) => c.type === 'modify' && c.path === fixture,
    ),
    statSurvives: findModifyChange(statResult.changes, fixture) !== undefined,
    statResult,
  };
};

/**
 * Assert one ledger row: the predicate/stat survivor verdicts always; the
 * numstat and patch-binary verdicts only when both git and tsgit's stat arm
 * agree the file is present (git omits a dropped file from `--numstat`/`-p`,
 * and a fully-dropped tsgit side has no `StatDiffChange` to compare).
 */
const assertLedgerRow = async (
  repo: Awaited<ReturnType<typeof openRepository>>,
  dir: string,
  shaByFixture: ReadonlyMap<string, { readonly from: string; readonly to: string }>,
  row: LabeledLedgerRow,
): Promise<void> => {
  const { from, to } = shaByFixture.get(row.fixture)!;
  const gitSurvives = await gitLedgerSurvives(dir, row.gitFlag, from, to);
  const tsgit = await tsgitLedgerVerdict(repo, from, to, row.diffOpts, row.fixture);

  expect(tsgit.predicateSurvives).toBe(row.tsgitDivergence?.predicateSurvives ?? gitSurvives);
  expect(tsgit.statSurvives).toBe(row.tsgitDivergence?.statSurvives ?? gitSurvives);

  if (!gitSurvives || !tsgit.statSurvives) return;

  const statChange = findModifyChange(tsgit.statResult.changes, row.fixture)!;
  const tsgitNumstat: readonly [number | '-', number | '-'] = statChange.binary
    ? ['-', '-']
    : [statChange.added, statChange.deleted];
  const gitNumstat = await gitLedgerNumstat(dir, row.gitFlag, from, to);
  expect(tsgitNumstat).toEqual(row.tsgitDivergence?.numstat ?? gitNumstat);

  const tsgitPatch = await reconstructPatch(
    repo.ctx,
    tsgit.statResult,
    patchOptionsFor(row.diffOpts),
  );
  const gitPatchIsBinary = await gitLedgerPatchIsBinary(dir, row.gitFlag, from, to);
  expect(tsgitPatch.includes('Binary files')).toBe(
    row.tsgitDivergence?.patchIsBinary ?? gitPatchIsBinary,
  );
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — the whitespace-drop divergence ledger',
  { timeout: 120_000 },
  () => {
    let ledgerDir = '';
    let ledgerRepo: Awaited<ReturnType<typeof openRepository>>;
    const shaByFixture = new Map<string, { readonly from: string; readonly to: string }>();

    beforeAll(async () => {
      ledgerDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-ws-ledger-')));
      await runGitAsync(['init', '-q', '-b', 'main', ledgerDir]);
      await runGitAsync(['-C', ledgerDir, 'config', 'user.name', 'Ada']);
      await runGitAsync(['-C', ledgerDir, 'config', 'user.email', 'ada@example.com']);
      await runGitAsync(['-C', ledgerDir, 'config', 'core.autocrlf', 'false']);
      await writeFile(path.join(ledgerDir, '.gitattributes'), '* -text\n');
      await runGitAsync(['-C', ledgerDir, 'add', '.gitattributes']);
      await runGitAsync(['-C', ledgerDir, 'commit', '-q', '-m', 'gitattributes'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });

      for (const [fixture, pair] of Object.entries(LEDGER_FIXTURES)) {
        const filePath = path.join(ledgerDir, fixture);

        await writeFile(filePath, pair.before);
        await runGitAsync(['-C', ledgerDir, 'add', fixture]);
        await runGitAsync(['-C', ledgerDir, 'commit', '-q', '-m', `${fixture}-base`], {
          env: { ...runGitEnv(), ...IDENTITY },
        });
        const from = (await runGitAsync(['-C', ledgerDir, 'rev-parse', 'HEAD'])).trim();

        await writeFile(filePath, pair.after);
        await runGitAsync(['-C', ledgerDir, 'add', fixture]);
        await runGitAsync(['-C', ledgerDir, 'commit', '-q', '-m', `${fixture}-change`], {
          env: { ...runGitEnv(), ...IDENTITY },
        });
        const to = (await runGitAsync(['-C', ledgerDir, 'rev-parse', 'HEAD'])).trim();

        shaByFixture.set(fixture, { from, to });
      }

      ledgerRepo = await openRepository({ cwd: ledgerDir });
    }, 120_000);

    afterAll(async () => {
      await ledgerRepo.dispose();
      await rm(ledgerDir, { recursive: true, force: true });
    });

    describe.each(LEDGER_ROWS)(
      'Given the $label divergence-ledger row, When comparing tsgit against live git',
      (row) => {
        it('Then tsgit matches its pinned verdict — a known divergence, or agreement', async () => {
          // Arrange + Act + Assert — inseparable for a ledger row: the row and
          // the suite-wide fixture repo are the arrangement, and assertLedgerRow
          // resolves the row's commit pair, runs both tsgit arms plus the peer
          // git invocation, and asserts the verdicts agree.
          await assertLedgerRow(ledgerRepo, ledgerDir, shaByFixture, row);
        });
      },
    );
  },
);

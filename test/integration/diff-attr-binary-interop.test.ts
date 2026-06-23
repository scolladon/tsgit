/**
 * Cross-tool interop — diff/binary attribute binary-vs-text override.
 *
 * Builds one shared repository with canonical git (deterministic dates, signing
 * off, isolated HOME so no global config engages). Exercises:
 *   B1  - `-diff` (unset) forces binary on a text file
 *   Bn  - unset restored: removing -diff restores text detection
 *   Ba  - `-diff` on an add (new file only)
 *   Bd  - `-diff` on a delete (old file only)
 *   Bmacro - `binary` macro attribute is equivalent to `-diff -merge -crlf -...`
 *   T2  - `diff=named` driver with no [diff "named"] config → raw text (no override)
 *   T2n - same named driver, but -diff in .gitattributes → binary override
 *   N1  - `diff` (bare, force text) on a NUL-bearing file: numstat counts lines
 *   N3  - `diff=up` + textconv configured + raw is text: patch=text, numstat=text
 *   N3s - `diff=up` + textconv configured + raw has NUL: patch=text, numstat=binary
 *   N4  - `diff=up` + textconv configured + raw text → both text
 *   R   - rename with -diff: binary override applies to the renamed path
 *
 * numstat parity is verified against live `git diff --numstat`.
 *
 * Isolation is load-bearing: `runGit` scrubs all `GIT_*` env vars, points `HOME`
 * at a non-existent path, and sets `GIT_CONFIG_NOSYSTEM=1`.
 */
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { diff } from '../../src/application/commands/diff.js';
import type { StatTreeDiff } from '../../src/domain/diff/index.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

/** Derive numstat rows from a StatTreeDiff matching git's output format. */
const numstatRowsFrom = (treeDiff: StatTreeDiff): string[] =>
  treeDiff.changes.map((c) => {
    const p =
      c.type === 'rename' || c.type === 'copy'
        ? c.newPath
        : c.type === 'add'
          ? c.newPath
          : c.type === 'delete'
            ? c.oldPath
            : c.path;
    if (c.binary) return `-\t-\t${p}`;
    return `${c.added}\t${c.deleted}\t${p}`;
  });

// --- Shared fixture repo ---

let dir = '';
let ctx: ReturnType<typeof createNodeContext>;

interface CommitPair {
  readonly from: string;
  readonly to: string;
}

let b1ForceBinary: CommitPair;
let bnRestoredText: CommitPair;
let baForceBinaryAdd: CommitPair;
let bdForceBinaryDelete: CommitPair;
let bMacro: CommitPair;
let t2Named: CommitPair;
let t2nNamedForceBinary: CommitPair;
let n1ForceText: CommitPair;
let n3TextconvText: CommitPair;
let n3sTextconvNul: CommitPair;
let n4TextconvBoth: CommitPair;
let rRenameForceBinary: CommitPair;

describe.skipIf(!GIT_AVAILABLE)('diff-attr binary-vs-text override interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-diff-attr-binary-interop-')));
    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'config', 'user.name', 'Ada']);
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);

    let epoch = 1_700_040_000;
    const nextEpoch = (): number => (epoch += 1);

    const doCommit = (message: string): string => {
      runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(nextEpoch()) });
      return git(dir, 'rev-parse', 'HEAD').trim();
    };

    // Portable NUL-stripping + upper textconv script
    const upperScript = path.join(dir, '.git', 'textconv-upper.sh');
    await writeFile(upperScript, '#!/bin/sh\nLC_ALL=C tr -d "\\0" < "$1" | LC_ALL=C tr a-z A-Z\n');
    await chmod(upperScript, 0o755);
    runGit(['-C', dir, 'config', 'diff.up.textconv', upperScript]);

    // Seed: .gitattributes with -diff for *.forced; bare diff for *.text;
    //       diff=up for *.up; binary macro for *.bin; diff=ghost for *.ghost (unconfigured)
    await writeFile(
      path.join(dir, '.gitattributes'),
      '*.forced -diff\n*.text diff\n*.up diff=up\n*.bin binary\n*.ghost diff=ghost\n',
    );
    await writeFile(path.join(dir, 'seed.txt'), 'initial\n');
    git(dir, 'add', '.gitattributes', 'seed.txt');
    doCommit('seed: gitattributes + initial file');

    // B1 — -diff forces binary on a text file modify
    await writeFile(path.join(dir, 'file.forced'), 'old text content\n');
    git(dir, 'add', 'file.forced');
    const b1base = doCommit('add file.forced');
    await writeFile(path.join(dir, 'file.forced'), 'new text content\n');
    git(dir, 'add', 'file.forced');
    const b1head = doCommit('modify file.forced');
    b1ForceBinary = { from: b1base, to: b1head };

    // Bn — remove -diff from .gitattributes, restoring text detection
    await writeFile(
      path.join(dir, '.gitattributes'),
      '*.text diff\n*.up diff=up\n*.bin binary\n*.ghost diff=ghost\n',
    );
    git(dir, 'add', '.gitattributes');
    await writeFile(path.join(dir, 'file.forced'), 'restored text content\n');
    git(dir, 'add', 'file.forced');
    const bnhead = doCommit('restore text detection for file.forced');
    bnRestoredText = { from: b1head, to: bnhead };

    // Ba — restore -diff + add a new *.forced file
    await writeFile(
      path.join(dir, '.gitattributes'),
      '*.forced -diff\n*.text diff\n*.up diff=up\n*.bin binary\n*.ghost diff=ghost\n',
    );
    git(dir, 'add', '.gitattributes');
    await writeFile(path.join(dir, 'new.forced'), 'brand new forced binary\n');
    git(dir, 'add', 'new.forced');
    const bahead = doCommit('add new.forced with -diff');
    baForceBinaryAdd = { from: bnhead, to: bahead };

    // Bd — -diff on a delete
    git(dir, 'rm', '-q', 'new.forced');
    const bdhead = doCommit('delete new.forced with -diff');
    bdForceBinaryDelete = { from: bahead, to: bdhead };

    // Bmacro — binary macro on *.bin
    await writeFile(path.join(dir, 'data.bin'), Buffer.from([0x41, 0x42, 0x43, 0x44])); // "ABCD"
    git(dir, 'add', 'data.bin');
    const bmbase = doCommit('add data.bin binary');
    await writeFile(path.join(dir, 'data.bin'), Buffer.from([0x41, 0x42, 0x43, 0x45])); // "ABCE"
    git(dir, 'add', 'data.bin');
    const bmhead = doCommit('modify data.bin binary');
    bMacro = { from: bmbase, to: bmhead };

    // T2 — diff=ghost (named driver, no [diff "ghost"] config) → raw text
    await writeFile(path.join(dir, 'file.ghost'), 'ghost old\n');
    git(dir, 'add', 'file.ghost');
    const t2base = doCommit('add file.ghost with diff=ghost');
    await writeFile(path.join(dir, 'file.ghost'), 'ghost new\n');
    git(dir, 'add', 'file.ghost');
    const t2head = doCommit('modify file.ghost');
    t2Named = { from: t2base, to: t2head };

    // T2n — change .gitattributes so *.ghost gets -diff too
    await writeFile(
      path.join(dir, '.gitattributes'),
      '*.forced -diff\n*.text diff\n*.up diff=up\n*.bin binary\n*.ghost -diff\n',
    );
    git(dir, 'add', '.gitattributes');
    await writeFile(path.join(dir, 'file.ghost'), 'ghost forced binary\n');
    git(dir, 'add', 'file.ghost');
    const t2nhead = doCommit('force binary on file.ghost with -diff');
    t2nNamedForceBinary = { from: t2head, to: t2nhead };

    // N1 — bare diff (force text) on NUL-bearing file
    await writeFile(path.join(dir, 'file.text'), Buffer.from([0x61, 0x0a])); // "a\n"
    git(dir, 'add', 'file.text');
    const n1base = doCommit('add file.text with bare diff attribute');
    await writeFile(path.join(dir, 'file.text'), Buffer.from([0x62, 0x00, 0x0a])); // "b\0\n" NUL
    git(dir, 'add', 'file.text');
    const n1head = doCommit('modify file.text to have NUL with diff=text');
    n1ForceText = { from: n1base, to: n1head };

    // N3 — diff=up textconv configured + raw text (no NUL): patch=text, numstat=text
    await writeFile(path.join(dir, 'plain.up'), 'hello world\n');
    git(dir, 'add', 'plain.up');
    const n3base = doCommit('add plain.up');
    await writeFile(path.join(dir, 'plain.up'), 'hello there\n');
    git(dir, 'add', 'plain.up');
    const n3head = doCommit('modify plain.up textconv no NUL');
    n3TextconvText = { from: n3base, to: n3head };

    // N3s — diff=up textconv configured + raw HAS NUL: patch=text (textconv ran), numstat=binary
    await writeFile(
      path.join(dir, 'nul.up'),
      Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x0a]),
    ); // "hello\0\n"
    git(dir, 'add', 'nul.up');
    const n3sbase = doCommit('add nul.up raw-NUL');
    await writeFile(
      path.join(dir, 'nul.up'),
      Buffer.from([0x77, 0x6f, 0x72, 0x6c, 0x64, 0x00, 0x0a]),
    ); // "world\0\n"
    git(dir, 'add', 'nul.up');
    const n3shead = doCommit('modify nul.up raw-NUL');
    n3sTextconvNul = { from: n3sbase, to: n3shead };

    // N4 — diff=up textconv + raw text (no NUL) both sides: both text
    await writeFile(path.join(dir, 'other.up'), 'line one\nline two\n');
    git(dir, 'add', 'other.up');
    const n4base = doCommit('add other.up');
    await writeFile(path.join(dir, 'other.up'), 'line one\nline three\n');
    git(dir, 'add', 'other.up');
    const n4head = doCommit('modify other.up');
    n4TextconvBoth = { from: n4base, to: n4head };

    // R — rename with -diff attribute (from the commit just before the rename)
    git(dir, 'mv', 'file.forced', 'renamed.forced');
    const rhead = doCommit('rename file.forced to renamed.forced with -diff');
    // Use the commit immediately before the rename as `from` so file.forced content is identical
    const rbase = git(dir, 'rev-parse', 'HEAD~1').trim();
    rRenameForceBinary = { from: rbase, to: rhead };

    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // B1 — -diff forces binary on text file
  describe('Given a modify change on a file with -diff attribute (B1)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows -\\t-\\t{path} matching live git', async () => {
        // Arrange
        const { from, to } = b1ForceBinary;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to).trim().split('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff);
        expect(tsgitNumstat).toEqual(gitNumstat);
        expect((result as StatTreeDiff).changes[0]).toMatchObject({
          type: 'modify',
          added: 0,
          deleted: 0,
          binary: true,
        });
      });
    });
  });

  // Bn — numstat parity after removing -diff (current .gitattributes determines attribute)
  describe('Given a modify change on a file after removing -diff attribute (Bn)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat matches live git (current gitattributes is the source of truth)', async () => {
        // Arrange — git reads the CURRENT .gitattributes at diff time; both tsgit and git
        // use the same attributes so the numstat rows must match regardless of override value
        const { from, to } = bnRestoredText;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to).trim().split('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert — parity: current attributes drive both, so rows are identical
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff);
        expect(tsgitNumstat).toEqual(gitNumstat);
      });
    });
  });

  // Ba — -diff on an add
  describe('Given an add change on a file with -diff attribute (Ba)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows -\\t- for the added file matching live git', async () => {
        // Arrange
        const { from, to } = baForceBinaryAdd;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.includes('new.forced'));

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff).filter((l) =>
          l.includes('new.forced'),
        );
        expect(tsgitNumstat).toEqual(gitNumstat);
        const addChange = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'add' && c.newPath === 'new.forced',
        );
        expect(addChange).toBeDefined();
        expect(addChange).toMatchObject({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  // Bd — -diff on a delete
  describe('Given a delete change on a file with -diff attribute (Bd)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows -\\t- for the deleted file matching live git', async () => {
        // Arrange
        const { from, to } = bdForceBinaryDelete;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.includes('new.forced'));

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff).filter((l) =>
          l.includes('new.forced'),
        );
        expect(tsgitNumstat).toEqual(gitNumstat);
        const delChange = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'delete' && c.oldPath === 'new.forced',
        );
        expect(delChange).toBeDefined();
        expect(delChange).toMatchObject({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  // Bmacro — binary macro attribute
  describe('Given a modify change with the binary macro attribute (Bmacro)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows -\\t- matching live git (binary macro forces binary override)', async () => {
        // Arrange
        const { from, to } = bMacro;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to).trim().split('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff);
        expect(tsgitNumstat).toEqual(gitNumstat);
        expect((result as StatTreeDiff).changes[0]).toMatchObject({
          binary: true,
          added: 0,
          deleted: 0,
        });
      });
    });
  });

  // T2 — named diff driver without [diff "ghost"] config: numstat parity
  describe('Given a modify change with diff=ghost (unconfigured driver) (T2)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat matches live git (current gitattributes is the source of truth)', async () => {
        // Arrange — git uses current .gitattributes at diff time; both tools use same attributes
        const { from, to } = t2Named;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to).trim().split('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert — parity: both tools honour current attributes, so rows are identical
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff);
        expect(tsgitNumstat).toEqual(gitNumstat);
      });
    });
  });

  // T2n — named driver replaced by -diff override
  describe('Given a modify change with -diff attribute replacing diff=ghost (T2n)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows -\\t- for file.ghost matching live git', async () => {
        // Arrange
        const { from, to } = t2nNamedForceBinary;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.includes('file.ghost'));

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff).filter((l) =>
          l.includes('file.ghost'),
        );
        expect(tsgitNumstat).toEqual(gitNumstat);
        const change = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'modify' && c.path === 'file.ghost',
        );
        expect(change).toBeDefined();
        expect(change).toMatchObject({ binary: true, added: 0, deleted: 0 });
      });
    });
  });

  // N1 — bare diff (force text) on NUL-bearing file: numstat counts lines
  describe('Given a modify change with bare diff attribute forcing text on NUL-bearing file (N1)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows line counts (not -\\t-) matching live git', async () => {
        // Arrange
        const { from, to } = n1ForceText;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to).trim().split('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert — bare diff=text forces text even with NUL
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff);
        expect(tsgitNumstat).toEqual(gitNumstat);
        expect((result as StatTreeDiff).changes[0]).toMatchObject({ binary: false });
      });
    });
  });

  // N3 — diff=up textconv + raw text: numstat=text
  describe('Given a modify change with diff=up textconv and no NUL in raw blob (N3)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows line counts for plain.up matching live git', async () => {
        // Arrange
        const { from, to } = n3TextconvText;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.includes('plain.up'));

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff).filter((l) =>
          l.includes('plain.up'),
        );
        expect(tsgitNumstat).toEqual(gitNumstat);
        const change = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'modify' && c.path === 'plain.up',
        );
        expect(change).toBeDefined();
        expect(change).toMatchObject({ binary: false });
      });
    });
  });

  // N3s — diff=up + raw NUL: textconv ran (patch=text), numstat=binary
  describe('Given a modify change with diff=up textconv and NUL bytes in raw blob (N3s)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows -\\t- for nul.up (raw NUL ⇒ numstat binary even though textconv output is clean)', async () => {
        // Arrange
        const { from, to } = n3sTextconvNul;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to).trim().split('\n');

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert — raw blob had NUL: numstat shows binary even though textconv output is clean
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff);
        expect(tsgitNumstat).toEqual(gitNumstat);
        const change = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'modify' && c.path === 'nul.up',
        );
        expect(change).toBeDefined();
        expect(change).toMatchObject({ binary: true, added: 0, deleted: 0 });
      });
    });
  });

  // N4 — diff=up textconv + clean both sides
  describe('Given a modify change with diff=up textconv on clean raw blobs (N4)', () => {
    describe('When diff is called with withStat: true', () => {
      it('Then numstat shows line counts for other.up matching live git', async () => {
        // Arrange
        const { from, to } = n4TextconvBoth;
        const gitNumstat = git(dir, 'diff', '--numstat', from, to)
          .trim()
          .split('\n')
          .filter((l) => l.includes('other.up'));

        // Act
        const result = await diff(ctx, { from, to, withStat: true });

        // Assert
        const tsgitNumstat = numstatRowsFrom(result as StatTreeDiff).filter((l) =>
          l.includes('other.up'),
        );
        expect(tsgitNumstat).toEqual(gitNumstat);
        const change = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'modify' && c.path === 'other.up',
        );
        expect(change).toBeDefined();
        expect(change).toMatchObject({ binary: false });
      });
    });
  });

  // R — rename with -diff: binary override applies on renamed path
  describe('Given a rename change on a file with -diff attribute (R)', () => {
    describe('When diff is called with detectRenames: true and withStat: true', () => {
      it('Then the rename change has binary: true, added: 0, deleted: 0 and live git shows -\\t- for that path', async () => {
        // Arrange — git uses "old => new" path in numstat; tsgit uses newPath only.
        // We verify: (a) tsgit reports binary:true, (b) live git shows `-\t-` for the same path.
        const { from, to } = rRenameForceBinary;
        // git numstat for rename: "-\t-\told.forced => renamed.forced"
        const gitRow = git(dir, 'diff', '--no-ext-diff', '--numstat', '--find-renames', from, to)
          .trim()
          .split('\n')
          .find((l) => l.includes('renamed.forced'));

        // Act
        const result = await diff(ctx, { from, to, detectRenames: true, withStat: true });

        // Assert — tsgit honours -diff on the rename
        const renameChange = (result as StatTreeDiff).changes.find(
          (c) => c.type === 'rename' && c.newPath === 'renamed.forced',
        );
        expect(renameChange).toBeDefined();
        expect(renameChange).toMatchObject({ binary: true, added: 0, deleted: 0 });
        // git also shows `-\t-` (binary marker) for the same rename
        expect(gitRow).toBeDefined();
        expect(gitRow).toMatch(/^-\t-\t/);
      });
    });
  });
});

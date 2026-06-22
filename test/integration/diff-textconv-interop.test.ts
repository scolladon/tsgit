/**
 * Cross-tool interop — textconv driver transforms diff sides.
 *
 * Builds one shared repository with canonical git (deterministic dates, signing
 * off, isolated HOME so no global textconv driver engages). Configures trivial
 * portable textconv commands (`LC_ALL=C tr a-z A-Z` / `LC_ALL=C tr A-Z a-z`) in
 * repo-local `.gitattributes` and `.git/config`, then opens the same repo through
 * `createNodeContext` (which wires `NodeCommandRunner`).
 *
 * Reconstructed patches are compared byte-for-byte to live `git diff --textconv`
 * output. OIDs on the structured `DiffChange` are asserted unchanged (T6 / R2).
 *
 * Isolation is load-bearing: `runGit` from interop-helpers scrubs all `GIT_*` env
 * vars, points `HOME` at a non-existent path, and sets `GIT_CONFIG_NOSYSTEM=1` —
 * no global/system/XDG git config engages.
 */
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { diff } from '../../src/application/commands/diff.js';
import type { StatTreeDiff, TreeDiff } from '../../src/domain/diff/index.js';
import { reconstructPatch } from './diff-reconstruct.js';
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

/** Derive name-status-style strings from a TreeDiff or StatTreeDiff. */
const nameStatusFrom = (treeDiff: TreeDiff | StatTreeDiff): string[] =>
  treeDiff.changes.map((c) => {
    if (c.type === 'modify') return `M\t${c.path}`;
    if (c.type === 'add') return `A\t${c.newPath}`;
    if (c.type === 'delete') return `D\t${c.oldPath}`;
    if (c.type === 'rename') return `R100\t${c.oldPath}\t${c.newPath}`;
    if (c.type === 'copy') return `C100\t${c.oldPath}\t${c.newPath}`;
    return `T\t${c.path}`;
  });

/** Return the display path for a stat change. */
const statChangePath = (c: StatTreeDiff['changes'][number]): string => {
  if (c.type === 'rename' || c.type === 'copy') return c.newPath;
  if (c.type === 'add') return c.newPath;
  if (c.type === 'delete') return c.oldPath;
  return c.path;
};

/** True when both old and new modes are the same (add/delete have only one mode). */
const hasSameModes = (c: StatTreeDiff['changes'][number]): boolean => {
  if (c.type === 'add' || c.type === 'delete') return false;
  return c.oldMode === c.newMode;
};

/** Apply git's numstat omit rule: all-zero counts + same-mode changes are omitted. */
const numstatRowsFrom = (treeDiff: StatTreeDiff): string[] =>
  treeDiff.changes
    .filter((c) => !(c.added === 0 && c.deleted === 0 && !c.binary && hasSameModes(c)))
    .map((c) => {
      const p = statChangePath(c);
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

let seedCommit: string;
let textconvModify: CommitPair;
let textconvAdd: CommitPair;
let namedUnconfigured: CommitPair;

describe.skipIf(!GIT_AVAILABLE)('textconv diff interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-textconv-interop-')));
    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'config', 'user.name', 'Ada']);
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);

    let epoch = 1_700_030_000;
    const nextEpoch = (): number => (epoch += 1);

    const doCommit = (message: string): string => {
      runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(nextEpoch()) });
      return git(dir, 'rev-parse', 'HEAD').trim();
    };

    // Write portable textconv shell scripts (each reads from "$1" — the temp file git
    // passes as argv[1]). Using `tr` directly as command would fail because POSIX `tr`
    // reads stdin, not a filename argument.
    const upperScript = path.join(dir, '.git', 'textconv-upper.sh');
    const lowerScript = path.join(dir, '.git', 'textconv-lower.sh');
    await writeFile(upperScript, '#!/bin/sh\nLC_ALL=C tr a-z A-Z < "$1"\n');
    await writeFile(lowerScript, '#!/bin/sh\nLC_ALL=C tr A-Z a-z < "$1"\n');
    await chmod(upperScript, 0o755);
    await chmod(lowerScript, 0o755);

    // Configure local diff drivers (repo-local .git/config — no global config engaged).
    runGit(['-C', dir, 'config', 'diff.upper.textconv', upperScript]);
    runGit(['-C', dir, 'config', 'diff.lower.textconv', lowerScript]);

    // Seed commit — .gitattributes that assigns diff=upper to *.upper files,
    // diff=lower to *.lower files, and diff=unconfigured to *.unk (T2 fallback).
    await writeFile(
      path.join(dir, '.gitattributes'),
      '*.upper diff=upper\n*.lower diff=lower\n*.unk diff=unconfigured\n',
    );
    await writeFile(path.join(dir, 'seed.upper'), 'hello world\n');
    git(dir, 'add', '.gitattributes', 'seed.upper');
    seedCommit = doCommit('seed: gitattributes + initial upper file');

    // T1: modify a .upper file — both sides transform through `upper` driver.
    await writeFile(path.join(dir, 'seed.upper'), 'hello there\n');
    git(dir, 'add', 'seed.upper');
    const c1 = doCommit('modify seed.upper');
    textconvModify = { from: seedCommit, to: c1 };

    // T-ADD: add a new .lower file — new side only transforms through `lower` driver.
    await writeFile(path.join(dir, 'new.lower'), 'HELLO LOWER\n');
    git(dir, 'add', 'new.lower');
    const c2 = doCommit('add new.lower');
    textconvAdd = { from: c1, to: c2 };

    // T2: modify a .unk file — `diff=unconfigured` has no `[diff "unconfigured"]`
    //     section, so git falls back to raw text diff.
    await writeFile(path.join(dir, 'plain.unk'), 'raw content\n');
    git(dir, 'add', 'plain.unk');
    doCommit('add plain.unk');
    await writeFile(path.join(dir, 'plain.unk'), 'raw content changed\n');
    git(dir, 'add', 'plain.unk');
    const c3 = doCommit('modify plain.unk');
    namedUnconfigured = { from: c2, to: c3 };

    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // T1 — both-sides textconv transform
  describe('Given a modify change with diff=upper configured on both sides (T1)', () => {
    describe('When diff is called and patch is reconstructed', () => {
      it('Then the structured change is type modify', async () => {
        // Arrange
        const { from, to } = textconvModify;

        // Act
        const result = await diff(ctx, { from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type !== 'modify') return;
        expect(change.path).toBe('seed.upper');
      });

      it('Then name-status matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = textconvModify;
        const peer = git(dir, 'diff', '--no-ext-diff', '--name-status', from, to).trim();

        // Act
        const result = await diff(ctx, { from, to });
        const ours = nameStatusFrom(result).join('\n');

        // Assert
        expect(ours).toBe(peer);
      });

      it('Then reconstructed patch matches git diff --textconv byte-for-byte (T1)', async () => {
        // Arrange
        const { from, to } = textconvModify;
        const peer = git(dir, 'diff', '--no-ext-diff', '--textconv', '--no-color', from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert — textconv-transformed content matches
        expect(result).toBe(peer);
      });

      it('Then numstat matches git diff --numstat (T1n)', async () => {
        // Arrange
        const { from, to } = textconvModify;
        const peer = git(dir, 'diff', '--no-ext-diff', '--numstat', from, to).trim();

        // Act
        const result = await diff(ctx, { from, to, withStat: true });
        const ours = numstatRowsFrom(result).join('\n');

        // Assert
        expect(ours).toBe(peer);
      });

      it('Then DiffChange OIDs are the raw tree OIDs — not from textconv output (T6 / R2)', async () => {
        // Arrange — parse raw OIDs from git diff --raw --abbrev=40 output
        // format: `:<old mode> <new mode> <old sha> <new sha> <status>\t<path>`
        const { from, to } = textconvModify;
        const rawLine = git(dir, 'diff', '--no-ext-diff', '--raw', '--abbrev=40', from, to)
          .trim()
          .split('\n')[0];
        const rawMatch = rawLine?.match(/^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40})/);
        const rawOldOid = rawMatch?.[1] ?? '';
        const rawNewOid = rawMatch?.[2] ?? '';

        // Act
        const result = await diff(ctx, { from, to });
        const change = result.changes[0];

        // Assert — OIDs are untouched tree OIDs (non-empty 40-char hashes)
        expect(change?.type).toBe('modify');
        if (change?.type !== 'modify') return;
        expect(rawOldOid).toMatch(/^[0-9a-f]{40}$/);
        expect(rawNewOid).toMatch(/^[0-9a-f]{40}$/);
        expect(change.oldId).toBe(rawOldOid);
        expect(change.newId).toBe(rawNewOid);
      });
    });
  });

  // T-ADD — add side only
  describe('Given an add change with diff=lower configured (T-ADD)', () => {
    describe('When diff is called and patch is reconstructed', () => {
      it('Then reconstructed patch matches git diff --textconv byte-for-byte', async () => {
        // Arrange
        const { from, to } = textconvAdd;
        const peer = git(dir, 'diff', '--no-ext-diff', '--textconv', '--no-color', from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert — new side textconv-transformed (uppercase → lowercase)
        expect(result).toBe(peer);
      });

      it('Then numstat counts the transformed lines', async () => {
        // Arrange
        const { from, to } = textconvAdd;
        const peer = git(dir, 'diff', '--no-ext-diff', '--numstat', from, to).trim();

        // Act
        const result = await diff(ctx, { from, to, withStat: true });
        const ours = numstatRowsFrom(result).join('\n');

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  // T2 — named-but-unconfigured driver falls back to raw diff
  describe('Given a modify change with diff=unconfigured (no driver section, T2)', () => {
    describe('When diff is called and patch is reconstructed', () => {
      it('Then reconstructed patch matches git diff --no-ext-diff (raw fallback)', async () => {
        // Arrange
        const { from, to } = namedUnconfigured;
        const peer = git(dir, 'diff', '--no-ext-diff', '--no-color', from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert — raw bytes used (no textconv transform)
        expect(result).toBe(peer);
      });
    });
  });
});

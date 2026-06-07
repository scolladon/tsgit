/**
 * Cross-tool interop — `shortlog`. Builds one rich repository with canonical git
 * (deterministic dates, signing off), then reconstructs git's `shortlog`,
 * `shortlog -e`, and `shortlog -c` output from tsgit's structured
 * `ShortlogGroup[]` and asserts byte-equality with real `git`. Faithfulness is
 * pinned on the DATA (grouping by identity name, per-entry email, oldest-first
 * within a group, byte-wise group sort, and git's cleaned `[PATCH]` subject) —
 * the library emits no line of its own.
 *
 * @proves
 *   surface:        shortlog
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's shortlog data reconstructs canonical `git shortlog`
 *   interopSurface: shortlog
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type ShortlogGroup,
  shortlog as shortlogCmd,
} from '../../src/application/commands/shortlog.js';
import { compareBytes } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const enc = new TextEncoder();

interface Ident {
  readonly name: string;
  readonly email: string;
}

const ANN: Ident = { name: 'Ann', email: 'ann@x' };
const BOB: Ident = { name: 'Bob', email: 'bob@x' };
const BOB_ALT: Ident = { name: 'Bob', email: 'bob2@x' };
const WRI: Ident = { name: 'Wri Ter', email: 'wri@x' };
const COM: Ident = { name: 'Com Mitter', email: 'com@x' };

const datedEnv = (epoch: number, author: Ident, committer: Ident): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: committer.name,
  GIT_COMMITTER_EMAIL: committer.email,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

let clock = 1_700_000_000;

const commitAs = async (
  dir: string,
  file: string,
  message: string,
  author: Ident,
  committer: Ident = author,
): Promise<void> => {
  clock += 60;
  await writeFile(path.join(dir, `${file}.txt`), `${file}\n`);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: datedEnv(clock, author, committer) });
};

const indent = (subjects: ReadonlyArray<string>): string =>
  subjects.map((s) => `      ${s}\n`).join('');

/** Reconstruct git's default `shortlog` from name-keyed groups. */
const renderDefault = (groups: ReadonlyArray<ShortlogGroup>): string =>
  groups
    .map((g) => `${g.name} (${g.commits.length}):\n${indent(g.commits.map((c) => c.subject))}\n`)
    .join('');

interface EmailSub {
  readonly name: string;
  readonly email: string;
  readonly subjects: ReadonlyArray<string>;
}

/** Re-partition each name-group by email and byte-sort the `name <email>` keys. */
const toEmailSubgroups = (groups: ReadonlyArray<ShortlogGroup>): ReadonlyArray<EmailSub> => {
  const subs: EmailSub[] = [];
  for (const group of groups) {
    const byEmail = new Map<string, string[]>();
    for (const commit of group.commits) {
      const list = byEmail.get(commit.email);
      if (list === undefined) byEmail.set(commit.email, [commit.subject]);
      else list.push(commit.subject);
    }
    for (const [email, subjects] of byEmail) subs.push({ name: group.name, email, subjects });
  }
  return subs.sort((a, b) =>
    compareBytes(enc.encode(`${a.name} <${a.email}>`), enc.encode(`${b.name} <${b.email}>`)),
  );
};

/** Reconstruct git's `shortlog -e` (grouping by name+email). */
const renderEmail = (groups: ReadonlyArray<ShortlogGroup>): string =>
  toEmailSubgroups(groups)
    .map((s) => `${s.name} <${s.email}> (${s.subjects.length}):\n${indent(s.subjects)}\n`)
    .join('');

describe.skipIf(!GIT_AVAILABLE)('shortlog interop', () => {
  let dir = '';
  let ctx: Context;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-shortlog-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'commit.gpgsign', 'false');
    await commitAs(dir, 'r', 'ann root', ANN);
    git(dir, 'checkout', '-q', '-b', 'side');
    await commitAs(dir, 's1', '[PATCH] bob patch', BOB);
    await commitAs(dir, 's2', 'bob side again', BOB_ALT);
    await commitAs(dir, 's3', 'distinct identities', WRI, COM);
    git(dir, 'checkout', '-q', 'main');
    await commitAs(dir, 'm1', 'ann on main', ANN);
    clock += 60;
    runGit(['-C', dir, 'merge', '--no-ff', 'side', '-m', 'merge side branch'], {
      env: datedEnv(clock, ANN, ANN),
    });
    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Then the default summary matches git shortlog (grouping, order, [PATCH], merge)', async () => {
    // Act
    const groups = await shortlogCmd(ctx);

    // Assert
    expect(renderDefault(groups)).toBe(git(dir, 'shortlog', 'HEAD'));
  });

  it('Then the per-email reconstruction matches git shortlog -e', async () => {
    // Act
    const groups = await shortlogCmd(ctx);

    // Assert
    expect(renderEmail(groups)).toBe(git(dir, 'shortlog', '-e', 'HEAD'));
  });

  it('Then grouping by committer matches git shortlog -c', async () => {
    // Act
    const groups = await shortlogCmd(ctx, { by: 'committer' });

    // Assert
    expect(renderDefault(groups)).toBe(git(dir, 'shortlog', '-c', 'HEAD'));
  });
});

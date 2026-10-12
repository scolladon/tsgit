import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { branchMarkRef } from '../../../../../src/application/commands/internal/branch-mark.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const OID = 'a'.repeat(40);

const BASE_CONFIG = `[remote "origin"]
  url = /nowhere
  fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
  remote = origin
  merge = refs/heads/main
[branch "side"]
  remote = origin
  merge = refs/heads/side
[branch "dot"]
  remote = .
  merge = refs/heads/side
[branch "tagged"]
  remote = origin
  merge = refs/tags/x
`;

const BRANCHES = ['main', 'side', 'nou', 'dot', 'tagged'];

/** main, side, nou, dot and tagged, HEAD on `head`, configured as `BASE_CONFIG` then `extra`. */
const repo = async (extra = '', head = 'ref: refs/heads/main'): Promise<Context> => {
  const ctx = createMemoryContext();
  const { gitDir } = ctx.layout;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, `${head}\n`);
  await ctx.fs.writeUtf8(`${gitDir}/config`, `${BASE_CONFIG}${extra}`);
  for (const branch of BRANCHES)
    await ctx.fs.writeUtf8(`${gitDir}/refs/heads/${branch}`, `${OID}\n`);
  return ctx;
};

const failure = (error: unknown): unknown => (error as TsgitError).data;

describe('branchMarkRef', () => {
  describe.each([
    ['@{u}', '', 'origin/main'],
    ['@{UpStream}', '', 'origin/main'],
    ['HEAD@{u}', '', 'origin/main'],
    ['side@{upstream}', '', 'origin/side'],
    ['dot@{u}', '', 'side'],
    ['@{push}', '', 'origin/main'],
    ['side@{push}', '', 'origin/side'],
    ['main@{push}', '[push]\n  default = current\n', 'origin/main'],
    [
      'main@{push}',
      '[push]\n  default = upstream\n[remote]\n  pushDefault = fork\n',
      'origin/main',
    ],
    [
      'main@{push}',
      '[push]\n  default = current\n[remote]\n  pushDefault = fork\n[remote "fork"]\n  fetch = +refs/heads/*:refs/remotes/fork/*\n',
      'fork/main',
    ],
    [
      'main@{push}',
      '[remote]\n  pushDefault = fork\n[branch "main"]\n  pushRemote = origin\n[push]\n  default = current\n',
      'origin/main',
    ],
    [
      'main@{push}',
      '[remote "origin"]\n  push = refs/heads/main:refs/heads/other\n',
      'origin/other',
    ],
    [
      'nou@{push}',
      '[push]\n  default = matching\n[branch "nou"]\n  remote = origin\n  merge = refs/heads/other\n',
      'origin/nou',
    ],
    ['@{-1}@{u}', '', undefined],
    ['main', '', undefined],
    ['main@{1}', '', undefined],
    ['@{u}x', '', undefined],
  ])('Given %j under config %j', (name, extra, expected) => {
    describe('When its branch mark is interpreted', () => {
      it('Then it names the ref git resolves it to, shortened unambiguously', async () => {
        // Arrange
        const ctx = await repo(extra);
        const sut = branchMarkRef;

        // Act
        const result = await sut(ctx, name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a local branch spelt like the upstream', () => {
    describe('When @{u} is interpreted', () => {
      it('Then the upstream keeps the prefix that tells them apart', async () => {
        // Arrange
        const ctx = await repo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/origin/main`, `${OID}\n`);
        const sut = branchMarkRef;

        // Act
        const result = await sut(ctx, '@{u}');

        // Assert
        expect(result).toBe('remotes/origin/main');
      });
    });
  });

  describe('Given HEAD left side for main', () => {
    describe('When @{-1}@{u} is interpreted', () => {
      it("Then it names side's upstream", async () => {
        // Arrange
        const ctx = await repo();
        const line = `${OID} ${OID} A <a@x> 1700000000 +0000\tcheckout: moving from side to main\n`;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, line);
        const sut = branchMarkRef;

        // Act
        const result = await sut(ctx, '@{-1}@{u}');

        // Assert
        expect(result).toBe('origin/side');
      });
    });
  });

  describe.each([
    ['nou@{u}', '', 'ref: refs/heads/main', { reason: 'no-upstream', branch: 'nou' }],
    ['missing@{u}', '', 'ref: refs/heads/main', { reason: 'no-such-branch', branch: 'missing' }],
    [
      'tagged@{u}',
      '',
      'ref: refs/heads/main',
      { reason: 'upstream-not-tracked', upstream: 'refs/tags/x' },
    ],
    ['nou@{push}', '', 'ref: refs/heads/main', { reason: 'no-upstream', branch: 'nou' }],
    ['@{u}', '', OID, { reason: 'detached-head' }],
    ['@{push}', '', OID, { reason: 'detached-head' }],
    [
      'main@{push}',
      '[push]\n  default = nothing\n',
      'ref: refs/heads/main',
      { reason: 'push-default-nothing' },
    ],
    [
      'side@{push}',
      '[remote "origin"]\n  push = refs/heads/main:refs/heads/other\n',
      'ref: refs/heads/main',
      { reason: 'push-refspecs-exclude-branch', remote: 'origin', branch: 'side' },
    ],
    [
      'main@{push}',
      '[push]\n  default = current\n[remote]\n  pushDefault = fork\n',
      'ref: refs/heads/main',
      { reason: 'push-destination-untracked', destination: 'refs/heads/main', remote: 'fork' },
    ],
    [
      'nou@{push}',
      '[branch "nou"]\n  remote = origin\n  merge = refs/heads/other\n',
      'ref: refs/heads/main',
      { reason: 'simple-push-ambiguous' },
    ],
  ])('Given %j under config %j and HEAD %j', (name, extra, head, expected) => {
    describe('When its branch mark is interpreted', () => {
      it("Then it refuses with git's reason", async () => {
        // Arrange
        const ctx = await repo(extra, head);
        const sut = branchMarkRef;

        // Act
        const result = await sut(ctx, name).catch(failure);

        // Assert
        expect(result).toEqual({ code: 'BRANCH_MARK_UNRESOLVED', ...expected });
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { type MergeRunInput, mergeRun } from '../../../../src/application/commands/merge.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  gpgSignerStub,
  type StubCommandRunner,
  stubCommandRunner,
} from '../primitives/helpers/stub-command-runner.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ARMOR = '-----BEGIN PGP SIGNATURE-----\n\nZmFrZXNpZw==\n-----END PGP SIGNATURE-----';

const commitFile = async (ctx: Context, file: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, file);
  await add(ctx, [file]);
  return (await commit(ctx, { message: file, author })).id;
};

interface Signing {
  readonly ctx: Context;
  readonly signer: StubCommandRunner;
}

/** main and feature diverge without conflict, so feature merges into a new commit. */
const diverged = async (
  config: string,
  signer: StubCommandRunner = gpgSignerStub(`${ARMOR}\n`),
): Promise<Signing> => {
  const ctx = createMemoryContext({ command: signer });
  await init(ctx);
  await commitFile(ctx, 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 'theirs');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'ours');
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, config);
  return { ctx, signer };
};

type Given = Omit<MergeRunInput, 'rev'>;

const signatureOf = async (ctx: Context, input: Given): Promise<string | undefined> => {
  const result = await mergeRun(ctx, { author, ...input, rev: 'feature' });
  if (result.kind !== 'merge') throw new Error(`expected a merge, got ${result.kind}`);
  const merged = await readObject(ctx, result.id);
  return merged.type === 'commit' ? merged.data.gpgSignature : undefined;
};

const keysSeen = (signer: StubCommandRunner): ReadonlyArray<string> =>
  signer.calls.flatMap((call) => call.args ?? []);

const GPG_SIGN = '[commit]\n\tgpgSign = true\n';
const branchOptions = (value: string): string => `[branch "main"]\n\tmergeoptions = ${value}\n`;

describe('mergeRun signing', () => {
  describe.each([
    ['sign: true', '', { sign: true }, ARMOR],
    ['commit.gpgSign', GPG_SIGN, {}, ARMOR],
    ['no signing request', '', {}, undefined],
    ['sign: false over commit.gpgSign', GPG_SIGN, { sign: false }, undefined],
    ['branch mergeoptions -S', branchOptions('-S'), {}, ARMOR],
    ['sign: false over branch mergeoptions -S', branchOptions('-S'), { sign: false }, undefined],
  ] as const)('Given %s', (_label, config, given, expected) => {
    describe('When a clean merge commits', () => {
      it('Then the merge commit carries the signature only when git signs it', async () => {
        // Arrange
        const { ctx } = await diverged(config);
        const sut = signatureOf;

        // Act
        const result = await sut(ctx, given);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each([
    ['sign with a key', '', { sign: true, signKey: 'KEY1' }, ['KEY1'], []],
    ['a branch -S<key>', branchOptions('-SKEY2'), {}, ['KEY2'], []],
    ['a bare -S over a branch -S<key>', branchOptions('-SKEY2'), { sign: true }, [], ['KEY2']],
    [
      'a -S<key> over a branch -S<key>',
      branchOptions('-SKEY2'),
      { sign: true, signKey: 'KEY1' },
      ['KEY1'],
      ['KEY2'],
    ],
    [
      'a key alone over a branch -S<key> and commit.gpgSign',
      `${GPG_SIGN}${branchOptions('-SKEY2')}`,
      { signKey: 'KEY1' },
      ['KEY1'],
      ['KEY2'],
    ],
  ] as const)('Given %s', (_label, config, given, present, absent) => {
    describe('When a clean merge commits', () => {
      it('Then the signer is asked for the key git settles on', async () => {
        // Arrange
        const { ctx, signer } = await diverged(config);
        const sut = signatureOf;

        // Act
        await sut(ctx, given);

        // Assert
        expect(signer.calls).toHaveLength(1);
        const keys = keysSeen(signer);
        for (const key of present) expect(keys).toContain(key);
        for (const key of absent) expect(keys).not.toContain(key);
      });
    });
  });

  describe('Given a signer that refuses', () => {
    describe('When a clean merge would commit', () => {
      it('Then the merge stays staged with MERGE_MSG minus its final newline, as git dies', async () => {
        // Arrange
        const { ctx } = await diverged('', stubCommandRunner({ exitCode: 1 }));
        const sut = mergeRun;

        // Act
        const refusal = await sut(ctx, { rev: 'feature', author, sign: true }).then(
          () => undefined,
          (e: unknown) => (e as TsgitError).data,
        );

        // Assert
        expect(refusal).toMatchObject({ code: 'SIGNING_FAILED' });
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(
          "Merge branch 'feature'",
        );
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(true);
      });
    });
  });
});

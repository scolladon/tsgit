import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { reset } from '../../../../src/application/commands/reset.js';
import { status } from '../../../../src/application/commands/status.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const CORE = '[core]\n\trepositoryformatversion = 0\n';

/** Two commits on main, HEAD on main, `config` as the repository config. */
const twoCommitRepo = async (
  config: string,
): Promise<{ readonly ctx: Context; readonly commits: ReadonlyArray<ObjectId> }> => {
  const ctx = createMemoryContext();
  const first = (await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] })).commitIds[0] as string;
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE, parents: [first] }] });
  await seedRepo(ctx, { refs: { 'refs/heads/main': commitIds[0] as string } });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return { ctx, commits: [first, commitIds[0]].map((id) => id as ObjectId) };
};

describe('Given a malformed core.warnAmbiguousRefs and a HEAD that resolves', () => {
  describe.each([
    { label: 'status', run: (ctx: Context) => status(ctx) },
    {
      label: 'reset --soft HEAD',
      run: (ctx: Context) => reset(ctx, { mode: 'soft', rev: 'HEAD' }),
    },
    {
      label: 'branch with an omitted start point',
      run: (ctx: Context) => branchCreate(ctx, { name: 'b1' }),
    },
  ])('When $label names HEAD', ({ run }) => {
    it('Then it refuses the setting, as git get_oid reads it once HEAD resolves', async () => {
      // Arrange
      const { ctx } = await twoCommitRepo(`${CORE}\twarnAmbiguousRefs = maybe\n`);
      const sut = run;

      // Act
      const refusal = await sut(ctx).catch((err: TsgitError) => err.data);

      // Assert
      expect(refusal).toMatchObject({
        code: 'CONFIG_BAD_BOOLEAN_VALUE',
        key: 'core.warnambiguousrefs',
        value: 'maybe',
      });
    });
  });
});

describe('Given reset and a revision expression', () => {
  describe('When it resets softly to HEAD~1', () => {
    it('Then HEAD moves to the parent, as git get_oid_committish reads the expression', async () => {
      // Arrange
      const { ctx, commits } = await twoCommitRepo(CORE);
      const sut = reset;

      // Act
      const result = await sut(ctx, { mode: 'soft', rev: 'HEAD~1' });

      // Assert
      expect(result.id).toBe(commits[0]);
      expect(await resolveRef(ctx, 'HEAD')).toBe(commits[0]);
    });
  });

  describe('When it resets softly to an annotated tag', () => {
    it('Then HEAD moves to the commit the tag peels to', async () => {
      // Arrange
      const { ctx, commits } = await twoCommitRepo(CORE);
      const tag = await writeObject(ctx, {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: commits[0] as ObjectId,
          objectType: 'commit',
          tagName: 'v1',
          tagger: { name: 'A', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' },
          message: 'v1\n',
          extraHeaders: [],
        },
      });
      await seedRepo(ctx, { refs: { 'refs/tags/v1': tag } });
      const sut = reset;

      // Act
      const result = await sut(ctx, { mode: 'soft', rev: 'v1' });

      // Assert
      expect(result.id).toBe(commits[0]);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveCommitIsh } from '../../../../../src/application/commands/internal/commit-ish.js';
import {
  dwimRefName,
  resolveRevisionName,
} from '../../../../../src/application/commands/internal/revision-name.js';
import type { Context } from '../../../../../src/ports/context.js';
import { seedRepo } from '../fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A repository whose `refs/heads/main` holds one commit, plus the given symbolic refs. */
const repoWithSymrefs = async (symrefs: Readonly<Record<string, string>>): Promise<Context> => {
  const ctx = createMemoryContext();
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] });
  await seedRepo(ctx, {
    refs: { 'refs/heads/main': commitIds[0] as string, 'refs/tags/main': commitIds[0] as string },
  });
  for (const [name, target] of Object.entries(symrefs)) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `ref: ${target}\n`);
  }
  return ctx;
};

describe('Given a name dwim_ref resolves', () => {
  describe.each([
    { name: 'main', symrefs: {}, expected: 'refs/tags/main', label: 'the first namespace wins' },
    {
      name: 'HEAD',
      symrefs: { HEAD: 'refs/heads/main' },
      expected: 'refs/heads/main',
      label: 'a symbolic ref is followed',
    },
    {
      name: 'HEAD',
      symrefs: {
        HEAD: 'refs/heads/a',
        'refs/heads/a': 'refs/heads/b',
        'refs/heads/b': 'refs/heads/c',
        'refs/heads/c': 'refs/heads/main',
      },
      expected: 'refs/heads/main',
      label: 'the longest chain git resolves is followed to its end',
    },
    {
      name: 'gone',
      symrefs: { 'refs/heads/gone': 'refs/heads/missing' },
      expected: undefined,
      label: 'a dangling candidate is skipped',
    },
    {
      name: 'loop',
      symrefs: { 'refs/heads/loop': 'refs/heads/loop' },
      expected: undefined,
      label: 'a broken candidate is skipped',
    },
  ])('When dwimRefName resolves $name and $label', ({ name, symrefs, expected }) => {
    it(`Then it names ${expected}`, async () => {
      // Arrange
      const ctx = await repoWithSymrefs(symrefs);
      const sut = dwimRefName;

      // Act
      const result = await sut(ctx, name);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

const OBJECT_NAME_ADVICE = [
  'Git normally never creates a ref that ends with 40 hex characters',
  'because it will be ignored when you just specify 40-hex. These refs',
  'may be created by mistake. For example,',
  '',
  '  git switch -c $br $(git rev-parse ...)',
  '',
  'where "$br" is somehow empty and a 40-hex ref is created. Please',
  'examine these refs and maybe delete them. Turn this message off by',
  'running "git config set advice.objectNameWarning false"',
].join('\n');

/** One commit on `refs/heads/main` and `refs/tags/main`, plus `refs/heads/<refName(commit)>`. */
const repoWithNamedRef = async (
  refName: (commit: string) => string,
  config: string,
  warn: (message: string) => void,
): Promise<{ readonly ctx: Context; readonly commit: string }> => {
  const ctx = createMemoryContext();
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] });
  const commit = commitIds[0] as string;
  const refs = { 'refs/heads/main': commit, 'refs/tags/main': commit };
  await seedRepo(ctx, { refs: { ...refs, [`refs/heads/${refName(commit)}`]: commit } });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return { ctx: { ...ctx, logger: { warn } } as Context, commit };
};

const CORE = '[core]\n\trepositoryformatversion = 0\n';
const short = (commit: string): string => commit.slice(0, 6);
const full = (commit: string): string => commit;
const named =
  (name: string) =>
  (_commit: string): string =>
    name;
const ambiguous = (name: string): string => `refname '${name}' is ambiguous.`;

describe.each([
  { label: 'resolveRevisionName', sut: resolveRevisionName },
  { label: 'resolveCommitIsh', sut: resolveCommitIsh },
])('Given $label', ({ sut }) => {
  describe.each([
    {
      when: 'a branch and a tag',
      ref: named('solo'),
      asked: named('main'),
      config: CORE,
      advice: false,
      warns: true,
    },
    {
      when: 'one namespace',
      ref: named('solo'),
      asked: named('solo'),
      config: CORE,
      advice: false,
      warns: false,
    },
    {
      when: 'two namespaces, core.warnAmbiguousRefs off',
      ref: named('solo'),
      asked: named('main'),
      config: `${CORE}\twarnAmbiguousRefs = false\n`,
      advice: false,
      warns: false,
    },
    {
      when: 'a ref and an abbreviated object id',
      ref: short,
      asked: short,
      config: CORE,
      advice: false,
      warns: true,
    },
    {
      when: 'a full object id and a ref',
      ref: full,
      asked: full,
      config: CORE,
      advice: true,
      warns: true,
    },
    {
      when: 'a full object id and a ref, advice off',
      ref: full,
      asked: full,
      config: `${CORE}[advice]\n\tobjectNameWarning = false\n`,
      advice: false,
      warns: true,
    },
  ])('When a name resolves as $when', ({ ref, asked, config, advice, warns }) => {
    it('Then it warns as git get_oid_basic does', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx, commit } = await repoWithNamedRef(ref, config, (message) =>
        messages.push(message),
      );
      const name = asked(commit);

      // Act
      await sut(ctx, name);

      // Assert
      const expected = [
        ...(warns ? [ambiguous(name)] : []),
        ...(advice ? [OBJECT_NAME_ADVICE] : []),
      ];
      expect(messages).toEqual(expected);
    });
  });
});

const MALFORMED_WARN_AMBIGUOUS_REFS = `${CORE}\twarnAmbiguousRefs = maybe\n`;

const caughtData = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as { readonly data?: unknown }).data;
  }
  return undefined;
};

describe.each([
  { label: 'resolveRevisionName', sut: resolveRevisionName },
  { label: 'resolveCommitIsh', sut: resolveCommitIsh },
])('Given $label and a malformed core.warnAmbiguousRefs', ({ sut }) => {
  describe.each([
    { when: 'a name a ref holds', asked: named('solo') },
    { when: 'a full object id', asked: full },
  ])('When it resolves $when', ({ asked }) => {
    it('Then it refuses the value as git repo_cfg_bool dies', async () => {
      // Arrange
      const { ctx, commit } = await repoWithNamedRef(
        named('solo'),
        MALFORMED_WARN_AMBIGUOUS_REFS,
        () => {},
      );

      // Act
      const result = await caughtData(() => sut(ctx, asked(commit)));

      // Assert
      expect(result).toEqual({
        code: 'CONFIG_BAD_BOOLEAN_VALUE',
        key: 'core.warnambiguousrefs',
        source: `${ctx.layout.gitDir}/config`,
        value: 'maybe',
      });
    });
  });

  describe('When it resolves an abbreviated object id no ref names', () => {
    it('Then it never reads the setting, as git reads it only once a ref matches', async () => {
      // Arrange
      const { ctx, commit } = await repoWithNamedRef(
        named('solo'),
        MALFORMED_WARN_AMBIGUOUS_REFS,
        () => {},
      );

      // Act
      const result = await sut(ctx, short(commit));

      // Assert
      expect(result).toBe(commit);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveCommitIsh } from '../../../../../src/application/commands/internal/commit-ish.js';
import {
  dwimRefName,
  resolveRevisionName,
  resolvingCandidates,
} from '../../../../../src/application/commands/internal/revision-name.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { permissionDenied, type TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { seedRepo } from '../fixtures.js';

/** Two blob contents whose ids share the abbreviation `abcd`. */
const SHARING_ABCD = ['x20507\n', 'x115828\n'];
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

type WarnSink = (message: string, context?: Readonly<Record<string, unknown>>) => void;

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
  warn: WarnSink,
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
      when: 'a full object id and a ref, core.warnAmbiguousRefs off',
      ref: full,
      asked: full,
      config: `${CORE}\twarnAmbiguousRefs = false\n`,
      advice: false,
      warns: false,
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

/** One commit on `refs/heads/<name>` for each name, plus the given raw loose-ref files. */
const repoWithRawRefs = async (
  branches: ReadonlyArray<string>,
  files: Readonly<Record<string, string>>,
  warn: WarnSink,
): Promise<{ readonly ctx: Context; readonly commit: string }> => {
  const ctx = createMemoryContext();
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] });
  const commit = commitIds[0] as string;
  await seedRepo(ctx, {
    refs: Object.fromEntries(branches.map((branch) => [`refs/heads/${branch}`, commit])),
  });
  for (const [name, content] of Object.entries(files)) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, content);
  }
  return { ctx: { ...ctx, logger: { warn } } as Context, commit };
};

describe.each([
  { label: 'resolveRevisionName', sut: resolveRevisionName },
  { label: 'resolveCommitIsh', sut: resolveCommitIsh },
])('Given $label', ({ sut }) => {
  describe.each([
    {
      when: 'a dangling symref ahead of a branch',
      files: { 'refs/tags/dg': 'ref: refs/tags/nope\n' },
      expected: ['ignoring dangling symref refs/tags/dg'],
    },
    {
      when: 'a symref cycle ahead of a branch',
      files: { 'refs/tags/dg': 'ref: refs/tags/dg2\n', 'refs/tags/dg2': 'ref: refs/tags/dg\n' },
      expected: ['ignoring dangling symref refs/tags/dg'],
    },
    {
      when: 'a symref to a broken ref ahead of a branch',
      files: { 'refs/tags/dg': 'ref: refs/tags/bad\n', 'refs/tags/bad': 'garbage\n' },
      expected: ['ignoring dangling symref refs/tags/dg'],
    },
    {
      when: 'a broken ref ahead of a branch',
      files: { 'refs/tags/dg': 'garbage\n' },
      expected: ['ignoring broken ref refs/tags/dg'],
    },
    {
      when: 'a broken top-level name ahead of a branch',
      files: { dg: 'garbage\n' },
      expected: [],
    },
  ])('When it resolves a name with $when', ({ files, expected }) => {
    it('Then it warns as git expand_ref does and resolves the branch', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx, commit } = await repoWithRawRefs(['dg'], files, (message) =>
        messages.push(message),
      );

      // Act
      const result = await sut(ctx, 'dg');

      // Assert
      expect(result).toBe(commit);
      expect(messages).toEqual(expected);
    });
  });

  describe('When it resolves HEAD on an unborn branch alongside a branch named HEAD', () => {
    it('Then it never warns HEAD itself is dangling', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx, commit } = await repoWithRawRefs(
        ['HEAD'],
        { HEAD: 'ref: refs/heads/unborn\n' },
        (message) => messages.push(message),
      );

      // Act
      const result = await sut(ctx, 'HEAD');

      // Assert
      expect(result).toBe(commit);
      expect(messages.filter((message) => message.startsWith('ignoring'))).toEqual([]);
    });
  });
});

describe('Given resolveRevisionName and a name git refuses as a refname', () => {
  describe('When it resolves that name', () => {
    it('Then it warns nothing, as git never reads a malformed candidate', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx } = await repoWithRawRefs(['main'], {}, (message) => messages.push(message));
      const sut = resolveRevisionName;

      // Act
      const result = await sut(ctx, 'bad.lock');

      // Assert
      expect(result).toBeUndefined();
      expect(messages).toEqual([]);
    });
  });
});

describe('Given resolvingCandidates and a name some namespaces skip', () => {
  describe.each([
    {
      when: 'a dangling symref',
      files: { 'refs/tags/dg': 'ref: refs/tags/nope\n' },
      expected: ['ignoring dangling symref refs/tags/dg'],
    },
    {
      when: 'a broken ref',
      files: { 'refs/tags/dg': 'garbage\n' },
      expected: ['ignoring broken ref refs/tags/dg'],
    },
  ])('When it counts the namespaces past $when', ({ files, expected }) => {
    it('Then it skips that namespace warning as git dwim_ref does', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx, commit } = await repoWithRawRefs(['dg'], files, (message) =>
        messages.push(message),
      );
      const sut = resolvingCandidates;

      // Act
      const result = await sut(ctx, 'dg');

      // Assert
      expect(result).toEqual([commit]);
      expect(messages).toEqual(expected);
    });
  });
});

/** `ctx` whose read of the loose ref at `path` (below the git dir) is denied. */
const denyingRead = (ctx: Context, path: string): Context => {
  const target = `${ctx.layout.gitDir}/${path}`;
  const deny = (requested: string): void => {
    if (requested === target) throw permissionDenied(requested);
  };
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      openWithNoFollow: async (requested, mode) => {
        deny(requested);
        return ctx.fs.openWithNoFollow(requested, mode);
      },
      read: async (requested) => {
        deny(requested);
        return ctx.fs.read(requested);
      },
      readUtf8: async (requested) => {
        deny(requested);
        return ctx.fs.readUtf8(requested);
      },
    },
  };
};

describe.each([
  { label: 'resolvingCandidates', sut: resolvingCandidates },
  { label: 'dwimRefName', sut: dwimRefName },
])('Given $label and a candidate whose read is denied', ({ sut }) => {
  describe('When it reads that candidate', () => {
    it('Then the refusal propagates instead of skipping the namespace', async () => {
      // Arrange
      const { ctx } = await repoWithRawRefs(['dg'], {}, () => undefined);
      const denied = denyingRead(ctx, 'refs/heads/dg');

      // Act
      const refusal = await sut(denied, 'dg').catch((err: TsgitError) => err.data);

      // Assert
      expect(refusal).toEqual({
        code: 'PERMISSION_DENIED',
        path: `${ctx.layout.gitDir}/refs/heads/dg`,
      });
    });
  });
});

describe('Given resolvingCandidates and a name a tag and a branch both carry', () => {
  describe.each([
    { check: 'on', config: CORE, expected: 2 },
    { check: 'off', config: `${CORE}\twarnAmbiguousRefs = false\n`, expected: 1 },
  ])('When the ambiguity check is $check', ({ config, expected }) => {
    it(`Then it counts ${expected} namespace(s), as git dwim_ref stops at the first with the check off`, async () => {
      // Arrange
      const { ctx } = await repoWithNamedRef(named('other'), config, () => undefined);
      const sut = resolvingCandidates;

      // Act
      const result = await sut(ctx, 'main');

      // Assert
      expect(result).toHaveLength(expected);
    });
  });
});

type WarnRecord = readonly [string, Readonly<Record<string, unknown>> | undefined];

describe.each([
  { label: 'resolveRevisionName', sut: resolveRevisionName },
  { label: 'resolveCommitIsh', sut: resolveCommitIsh },
])('Given $label', ({ sut }) => {
  describe.each([
    {
      when: 'a name a branch and a tag both hold',
      branches: ['dg'],
      files: { 'refs/tags/dg': null },
      expected: [["refname 'dg' is ambiguous.", { refname: 'dg' }]],
    },
    {
      when: 'a dangling symref ahead of a branch',
      branches: ['dg'],
      files: { 'refs/tags/dg': 'ref: refs/tags/nope\n' },
      expected: [['ignoring dangling symref refs/tags/dg', { refname: 'refs/tags/dg' }]],
    },
    {
      when: 'a broken ref ahead of a branch',
      branches: ['dg'],
      files: { 'refs/tags/dg': 'garbage\n' },
      expected: [['ignoring broken ref refs/tags/dg', { refname: 'refs/tags/dg' }]],
    },
  ] as ReadonlyArray<{
    readonly when: string;
    readonly branches: ReadonlyArray<string>;
    readonly files: Readonly<Record<string, string | null>>;
    readonly expected: ReadonlyArray<WarnRecord>;
  }>)('When it resolves $when', ({ branches, files, expected }) => {
    it('Then the warning carries the ref it names as structured context', async () => {
      // Arrange
      const records: WarnRecord[] = [];
      const { ctx, commit } = await repoWithRawRefs(branches, {}, (message, context) =>
        records.push([message, context]),
      );
      for (const [name, content] of Object.entries(files)) {
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, content ?? `${commit}\n`);
      }

      // Act
      await sut(ctx, 'dg');

      // Assert
      expect(records).toEqual(expected);
    });
  });
});

describe.each([
  { label: 'resolveRevisionName', sut: resolveRevisionName },
  { label: 'resolveCommitIsh', sut: resolveCommitIsh },
])('Given $label and a branch named like an abbreviation two objects share', ({ sut }) => {
  describe('When it resolves that name', () => {
    it('Then it warns nothing, as the ambiguous abbreviation names none of them', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx, commit } = await repoWithNamedRef(named('abcd'), CORE, (message) =>
        messages.push(message),
      );
      for (const text of SHARING_ABCD) {
        await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode(text),
        });
      }

      // Act
      const result = await sut(ctx, 'abcd');

      // Assert
      expect(result).toBe(commit);
      expect(messages).toEqual([]);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { revParse } from '../../../../src/application/commands/rev-parse.js';
import { writeReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const CORE = '[core]\n\trepositoryformatversion = 0\n';

interface ReflogRepo {
  readonly refs?: Readonly<Record<string, 'tip'>>;
  readonly symrefs?: Readonly<Record<string, string>>;
  readonly logs: ReadonlyArray<string>;
  readonly config?: string;
}

/** One commit, the named refs at it, a one-entry reflog for each of `logs`, and HEAD on main. */
const reflogRepo = async (
  seed: ReflogRepo,
  warn: (message: string) => void,
): Promise<{ readonly ctx: Context; readonly tip: ObjectId }> => {
  const base = createMemoryContext();
  const { commitIds } = await seedRepo(base, { commits: [{ tree: EMPTY_TREE }] });
  const tip = commitIds[0] as ObjectId;
  const refs = Object.fromEntries(Object.keys(seed.refs ?? {}).map((name) => [name, tip]));
  await seedRepo(base, { refs: { 'refs/heads/main': tip, ...refs } });
  for (const [name, target] of Object.entries(seed.symrefs ?? {})) {
    await base.fs.writeUtf8(`${base.layout.gitDir}/${name}`, `ref: ${target}\n`);
  }
  const ctx = { ...base, logger: { warn } } as Context;
  const identity = { name: 'A', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };
  for (const log of seed.logs) {
    await writeReflog(ctx, log as RefName, [
      { oldId: ZERO_OID, newId: tip, identity, message: 'create' },
    ]);
  }
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, seed.config ?? CORE);
  return { ctx, tip };
};

const ambiguous = (name: string): string => `refname '${name}' is ambiguous.`;

describe('Given a reflog selector on a name dwim_log reads', () => {
  describe.each([
    {
      when: 'only a branch carries a reflog',
      seed: { refs: { 'refs/tags/amb': 'tip' }, logs: ['refs/heads/main'] },
      arg: 'main@{0}',
      expected: [],
    },
    {
      when: 'a tag and a branch both carry a reflog',
      seed: {
        refs: { 'refs/tags/amb': 'tip', 'refs/heads/amb': 'tip' },
        logs: ['refs/tags/amb', 'refs/heads/amb'],
      },
      arg: 'amb@{0}',
      expected: [ambiguous('amb')],
    },
    {
      when: 'a tag and a branch both carry a reflog and the check is off',
      seed: {
        refs: { 'refs/tags/amb': 'tip', 'refs/heads/amb': 'tip' },
        logs: ['refs/tags/amb', 'refs/heads/amb'],
        config: `${CORE}\twarnAmbiguousRefs = false\n`,
      },
      arg: 'amb@{0}',
      expected: [],
    },
    {
      when: 'HEAD and a branch named HEAD both carry a reflog',
      seed: { refs: { 'refs/heads/HEAD': 'tip' }, logs: ['HEAD', 'refs/heads/HEAD'] },
      arg: 'HEAD@{0}',
      expected: [ambiguous('HEAD')],
    },
    {
      when: 'the current branch and a branch named HEAD resolve',
      seed: {
        refs: { 'refs/heads/HEAD': 'tip' },
        symrefs: { HEAD: 'refs/heads/main' },
        logs: ['refs/heads/main'],
      },
      arg: '@{0}',
      expected: [ambiguous('')],
    },
    {
      when: 'a dangling tag symref precedes a branch with a reflog',
      seed: {
        refs: { 'refs/heads/dg': 'tip' },
        symrefs: { 'refs/tags/dg': 'refs/tags/nope' },
        logs: ['refs/heads/dg'],
      },
      arg: 'dg@{0}',
      expected: [],
    },
    {
      when: 'a symbolic branch whose target carries the reflog',
      seed: { symrefs: { 'refs/heads/sym': 'refs/heads/main' }, logs: ['refs/heads/main'] },
      arg: 'sym@{0}',
      expected: [],
    },
  ])('When revParse reads $arg where $when', ({ seed, arg, expected }) => {
    it('Then it resolves the entry and warns as git does', async () => {
      // Arrange
      const messages: string[] = [];
      const { ctx, tip } = await reflogRepo(seed as ReflogRepo, (message) =>
        messages.push(message),
      );
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toBe(tip);
      expect(messages).toEqual(expected);
    });
  });

  describe('When the name is a branch spelled as a unique abbreviated object id', () => {
    it('Then it warns the name is ambiguous', async () => {
      // Arrange
      const messages: string[] = [];
      const probe = await reflogRepo({ logs: [] }, () => undefined);
      const short = probe.tip.slice(0, 7);
      const { ctx, tip } = await reflogRepo(
        { refs: { [`refs/heads/${short}`]: 'tip' }, logs: [`refs/heads/${short}`] },
        (message) => messages.push(message),
      );
      const sut = revParse;

      // Act
      const result = await sut(ctx, `${short}@{0}`);

      // Assert
      expect(result).toBe(tip);
      expect(messages).toEqual([ambiguous(short)]);
    });
  });
});

describe('Given a malformed core.warnAmbiguousRefs', () => {
  describe.each([{ arg: '@{0}' }, { arg: 'main@{0}' }])('When revParse reads $arg', ({ arg }) => {
    it('Then it refuses the setting once a reflog is found', async () => {
      // Arrange
      const { ctx } = await reflogRepo(
        {
          symrefs: { HEAD: 'refs/heads/main' },
          logs: ['refs/heads/main'],
          config: `${CORE}\twarnAmbiguousRefs = maybe\n`,
        },
        () => undefined,
      );
      const sut = revParse;

      // Act
      const refusal = await sut(ctx, arg).catch((err: TsgitError) => err.data);

      // Assert
      expect(refusal).toMatchObject({
        code: 'CONFIG_BAD_BOOLEAN_VALUE',
        key: 'core.warnambiguousrefs',
        value: 'maybe',
      });
    });
  });

  describe('When revParse reads a name no reflog carries', () => {
    it('Then it reports the selector unresolved without reading the setting', async () => {
      // Arrange
      const { ctx } = await reflogRepo(
        { logs: ['refs/heads/main'], config: `${CORE}\twarnAmbiguousRefs = maybe\n` },
        () => undefined,
      );
      const sut = revParse;

      // Act
      const refusal = await sut(ctx, 'nope@{0}').catch((err: TsgitError) => err.data);

      // Assert
      expect(refusal).toEqual({ code: 'REVPARSE_UNRESOLVED', expression: 'nope@{0}' });
    });
  });
});

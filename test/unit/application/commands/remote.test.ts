import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  remoteAdd,
  remoteList,
  remoteRemove,
  remoteRename,
  remoteSetUrl,
  remoteShow,
} from '../../../../src/application/commands/remote.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { getRefStore, type RefUpdate } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const seed = async (ctx: Context, content?: string): Promise<void> => {
  await init(ctx);
  if (content !== undefined) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
    __resetConfigCacheForTests();
  }
};

const ORIGIN_ID = 'a'.repeat(40) as ObjectId;
const STALE_ID = 'b'.repeat(40) as ObjectId;
const ZERO_ID = '0'.repeat(40) as ObjectId;
const ORIGIN_MAIN = 'refs/remotes/origin/main' as RefName;
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD' as RefName;
const UP2_MAIN = 'refs/remotes/up2/main' as RefName;
const UP2_HEAD = 'refs/remotes/up2/HEAD' as RefName;

const FROZEN_EPOCH_SECONDS = 1_700_000_000;
/** The identity a repository with no `[user]` config logs under, at the frozen clock. */
const FALLBACK_IDENTITY = `tsgit <tsgit@localhost> ${FROZEN_EPOCH_SECONDS} +0000`;

/** Every reflog entry of `name`, as the raw line the files backend writes. */
const reflogLines = async (ctx: Context, name: RefName): Promise<readonly string[]> =>
  (await readReflog(ctx, name)).map(
    ({ oldId, newId, identity, message }) =>
      `${oldId} ${newId} ${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezoneOffset}\t${message}`,
  );

/** Records every `applyRefUpdates` batch the Context's store receives. */
const recordBatches = (ctx: Context): RefUpdate[][] => {
  const store = getRefStore(ctx);
  const batches: RefUpdate[][] = [];
  const original = store.applyRefUpdates.bind(store);
  store.applyRefUpdates = async (updates) => {
    batches.push([...updates]);
    return original(updates);
  };
  return batches;
};

/** Both ref backends, so a rule that binds on each can be swept once. */
const BACKENDS = [
  { label: 'files', frame: (ctx: Context): Context => ctx },
  { label: 'reftable', frame: withReftableStorage },
] as const;

/** `refs/remotes/` is 13 bytes; renaming `origin` (6) to `up2` overwrites
 *  bytes 13..19 of the target, whatever those bytes happen to be. */
const SPLICED_TARGETS = [
  {
    label: 'a target under another remote',
    target: 'refs/remotes/other/main',
    spliced: 'refs/remotes/up2main',
  },
  {
    label: 'a target under refs/heads',
    target: 'refs/heads/feature-long-name',
    spliced: 'refs/heads/feup2long-name',
  },
  {
    label: 'a target under a remote prefixed by the old name',
    target: 'refs/remotes/originX/main',
    spliced: 'refs/remotes/up2X/main',
  },
  {
    label: 'a target under a remote merely containing the old name',
    target: 'refs/remotes/myorigin/main',
    spliced: 'refs/remotes/up2in/main',
  },
  {
    label: 'a target equal to the old remote prefix',
    target: 'refs/remotes/origin',
    spliced: 'refs/remotes/up2',
  },
  {
    label: 'a target one byte longer than the slice',
    target: 'refs/remotes/originz',
    spliced: 'refs/remotes/up2z',
  },
].map((row) => ({ ...row, target: row.target as RefName }));

/** Targets too short for the slice: git's splice refuses over them. */
const SHORT_TARGETS = [
  { label: 'a target one byte shorter than the slice', target: 'refs/remotes/origi' },
  { label: 'a target far shorter than the slice', target: 'refs/heads/main' },
].map((row) => ({ ...row, target: row.target as RefName }));

/** `origin` carrying the canonical refspec — the gate on moving any
 *  tracking ref at all. */
const ORIGIN_TRACKING_CONFIG =
  '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';

/** Fetch refspecs that do NOT map into `refs/remotes/origin/`: git moves no
 *  tracking ref for any of them. */
const UNMAPPED_REFSPECS = [
  { label: 'no fetch refspec at all', refspecs: [] as readonly string[] },
  { label: 'a destination outside refs/remotes', refspecs: ['+refs/heads/*:refs/other/origin/*'] },
  { label: "a mirror's whole-namespace refspec", refspecs: ['+refs/*:refs/*'] },
  {
    label: 'a destination under a remote merely prefixed by the name',
    refspecs: ['+refs/heads/*:refs/remotes/originX/*'],
  },
  {
    label: 'several refspecs, none of them mapping',
    refspecs: ['+refs/tags/*:refs/other/x/*', '+refs/heads/*:refs/remotes/originX/*'],
  },
];

/** Fetch refspecs that DO map into `refs/remotes/origin/`, with the splice
 *  git makes at the first such destination. */
const MAPPED_REFSPECS = [
  {
    label: 'the canonical refspec',
    refspec: '+refs/heads/*:refs/remotes/origin/*',
    rewritten: '+refs/heads/*:refs/remotes/up2/*',
  },
  {
    label: 'a refspec with no force marker',
    refspec: 'refs/heads/release:refs/remotes/origin/release',
    rewritten: 'refs/heads/release:refs/remotes/up2/release',
  },
  {
    label: 'a star in an odd position',
    refspec: '+refs/heads/*:refs/remotes/origin/pre*post',
    rewritten: '+refs/heads/*:refs/remotes/up2/pre*post',
  },
  {
    label: 'no star at all',
    refspec: '+refs/heads/main:refs/remotes/origin/main',
    rewritten: '+refs/heads/main:refs/remotes/up2/main',
  },
  {
    label: 'a destination nested deeper under the remote',
    refspec: '+refs/heads/*:refs/remotes/origin/deep/*',
    rewritten: '+refs/heads/*:refs/remotes/up2/deep/*',
  },
];

/** `[remote "origin"]` carrying exactly `refspecs`, in order. */
const remoteConfigWithFetch = (refspecs: readonly string[]): string =>
  `[remote "origin"]\n\turl = u\n${refspecs.map((spec) => `\tfetch = ${spec}\n`).join('')}`;

/** The ref space `show`'s selection is probed over. */
const SHOW_FIXTURE_REFS = [
  'refs/heads/side',
  'refs/other/origin/z',
  'refs/remotes/origin/deep/x',
  'refs/remotes/origin/main',
  'refs/remotes/zzz/q',
] as unknown as readonly RefName[];

const OUTSIDE_SPEC = '+refs/heads/*:refs/other/origin/*';
const DEEP_SPEC = '+refs/heads/*:refs/remotes/origin/deep/*';
const ZZZ_CONFIG = '[remote "zzz"]\n\turl = z\n\tfetch = +refs/heads/*:refs/remotes/zzz/*\n';

/** What `show` attaches for a remote carrying each refspec shape: every ref
 *  in the repository at least one of them fetches into, and nothing else. */
const SHOW_SELECTION = [
  {
    label: 'no fetch refspec',
    refspecs: [] as readonly string[],
    extraConfig: '',
    expected: [] as readonly string[],
  },
  {
    label: 'a destination outside refs/remotes',
    refspecs: [OUTSIDE_SPEC],
    extraConfig: '',
    expected: ['refs/other/origin/z'],
  },
  {
    label: 'a destination nested under the remote',
    refspecs: [DEEP_SPEC],
    extraConfig: '',
    expected: ['refs/remotes/origin/deep/x'],
  },
  {
    label: 'two destinations, the nested one first',
    refspecs: [DEEP_SPEC, OUTSIDE_SPEC],
    extraConfig: '',
    expected: ['refs/other/origin/z', 'refs/remotes/origin/deep/x'],
  },
  {
    label: 'the same two destinations in the other order',
    refspecs: [OUTSIDE_SPEC, DEEP_SPEC],
    extraConfig: '',
    expected: ['refs/other/origin/z', 'refs/remotes/origin/deep/x'],
  },
  {
    label: 'a destination with no star',
    refspecs: ['+refs/heads/main:refs/remotes/origin/main'],
    extraConfig: '',
    expected: ['refs/remotes/origin/main'],
  },
  {
    label: 'a colon-free refspec naming no wildcard, which lands in FETCH_HEAD',
    refspecs: ['+refs/heads/main'],
    extraConfig: '',
    expected: [],
  },
  {
    label: "a destination inside another configured remote's namespace",
    refspecs: ['+refs/heads/*:refs/remotes/zzz/*'],
    extraConfig: ZZZ_CONFIG,
    expected: ['refs/remotes/zzz/q'],
  },
  {
    label: 'a destination inside the local branch namespace',
    refspecs: ['+refs/heads/*:refs/heads/*'],
    extraConfig: '',
    expected: ['refs/heads/side'],
  },
  {
    label: 'the same destination twice',
    refspecs: ['+refs/heads/*:refs/remotes/origin/*', '+refs/heads/*:refs/remotes/origin/*'],
    extraConfig: '',
    expected: ['refs/remotes/origin/deep/x', 'refs/remotes/origin/main'],
  },
];

/** `origin` with the canonical refspec, plus a branch tracking it. */
const TRACKED_ORIGIN_CONFIG =
  '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n';

/** `origin` with the canonical refspec, one direct tracking ref and a
 *  symbolic `origin/HEAD` aimed at `target`. */
const seedRenameSource = async (ctx: Context, target: RefName): Promise<void> => {
  await seed(ctx, '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
    { kind: 'setSymbolic', name: ORIGIN_HEAD, target },
  ]);
};

/** Renames `origin` to `to`, returning what it threw (or `undefined`). */
const renameRefusal = async (ctx: Context, to: string): Promise<unknown> => {
  try {
    await remoteRename(ctx, { from: 'origin', to });
  } catch (err) {
    return err;
  }
  return undefined;
};

/** A repository the format-acceptance gate rejects — every `remote` verb moved onto it. */
const rejectedCtx = async (content?: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await seed(ctx, content);
  return { ...ctx, layout: { ...ctx.layout, formatRefusal: { kind: 'version', version: 99 } } };
};

describe('application/commands/remote', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    describe('Given a non-repository', () => {
      describe('When remoteList runs', () => {
        it('Then it throws NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = createMemoryContext();
          let caught: unknown;

          // Act
          try {
            await remoteList(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given an initialized repo with no remotes', () => {
      describe('When remoteList runs', () => {
        it('Then it returns an empty list', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const result = await remoteList(ctx);

          // Assert
          expect(result).toEqual({ remotes: [] });
        });
      });
    });

    describe('Given a single remote origin', () => {
      describe('When remoteList runs', () => {
        it('Then it returns the entry with url and fetch refspec', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          const result = await remoteList(ctx);

          // Assert
          expect(result).toEqual({
            remotes: [
              {
                name: 'origin',
                url: 'https://e.com/r.git',
                pushUrl: undefined,
                fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
              },
            ],
          });
        });
      });
    });

    describe('Given a remote with both url and pushurl', () => {
      describe('When remoteList runs', () => {
        it('Then pushUrl is populated', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tpushurl = git@e.com:r.git\n',
          );

          // Act
          const result = await remoteList(ctx);

          // Assert — no `fetch` key, so the refspec list defaults to empty.
          expect(result.remotes[0]?.pushUrl).toBe('git@e.com:r.git');
          expect(result.remotes[0]?.fetchRefspecs).toEqual([]);
        });
      });
    });

    describe('Given a remote section with no url key', () => {
      describe('When remoteList runs', () => {
        it('Then the url defaults to an empty string', async () => {
          // Arrange — a `[remote]` block carrying only a fetch refspec.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');

          // Act
          const result = await remoteList(ctx);

          // Assert — the missing url falls back to '' (not undefined).
          expect(result.remotes[0]?.url).toBe('');
        });
      });
    });

    describe('Given multiple remotes', () => {
      describe('When remoteList runs', () => {
        it('Then they come back sorted by name byte-wise', async () => {
          // Arrange — write in non-sorted order to prove the sort.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "zeta"]\n\turl = z\n[remote "alpha"]\n\turl = a\n[remote "mid"]\n\turl = m\n',
          );

          // Act
          const result = await remoteList(ctx);

          // Assert
          expect(result.remotes.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
        });
      });
    });
  });

  describe('add', () => {
    describe('Given a new name and url', () => {
      describe('When remoteAdd runs', () => {
        it('Then the [remote] block is written with the canonical default fetch refspec', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const result = await remoteAdd(ctx, {
            name: 'upstream',
            url: 'https://e.com/up.git',
          });

          // Assert — result payload reflects what was written.
          expect(result.remote.name).toBe('upstream');
          expect(result.remote.url).toBe('https://e.com/up.git');
          expect(result.remote.fetchRefspecs).toEqual(['+refs/heads/*:refs/remotes/upstream/*']);
          // On-disk config matches.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "upstream"]');
          expect(written).toContain('url = https://e.com/up.git');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/upstream/*');
        });
      });
    });

    describe('Given a new name and url', () => {
      describe('When the resulting config is read back', () => {
        it('Then remoteList binds both url and fetch to that remote section', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          await remoteAdd(ctx, { name: 'upstream', url: 'https://e.com/up.git' });
          __resetConfigCacheForTests();
          const result = await remoteList(ctx);

          // Assert — url and fetch must live UNDER `[remote "upstream"]`, not a
          // stray empty-section header. A loose substring match cannot prove this.
          expect(result.remotes).toEqual([
            {
              name: 'upstream',
              url: 'https://e.com/up.git',
              pushUrl: undefined,
              fetchRefspecs: ['+refs/heads/*:refs/remotes/upstream/*'],
            },
          ]);
        });
      });
    });

    describe('Given a custom fetch refspec', () => {
      describe('When remoteAdd runs with a fetch refspec', () => {
        it('Then the custom refspec is written verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const result = await remoteAdd(ctx, {
            name: 'upstream',
            url: 'https://e.com/u.git',
            fetch: '+refs/heads/release:refs/remotes/upstream/release',
          });

          // Assert
          expect(result.remote.fetchRefspecs).toEqual([
            '+refs/heads/release:refs/remotes/upstream/release',
          ]);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('fetch = +refs/heads/release:refs/remotes/upstream/release');
          expect(written).not.toContain('refs/heads/*');
        });
      });
    });

    describe('Given an already-configured remote name', () => {
      describe('When remoteAdd runs with the same name', () => {
        it('Then it throws REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, {
              name: 'origin',
              url: 'https://e.com/new.git',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('REMOTE_EXISTS');
          if (data.code !== 'REMOTE_EXISTS') throw new Error('unreachable');
          expect(data.remote).toBe('origin');
        });
      });
    });

    describe('Given an empty name', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: '', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name with a newline', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: 'a\nb', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name git accepts although it looks unusual', () => {
      describe('When remoteAdd runs', () => {
        it.each([
          { name: 'a/b', header: '[remote "a/b"]', fetch: '+refs/heads/*:refs/remotes/a/b/*' },
          {
            name: 'a"b',
            header: '[remote "a\\"b"]',
            fetch: '+refs/heads/*:refs/remotes/a\\"b/*',
          },
          { name: 'a]b', header: '[remote "a]b"]', fetch: '+refs/heads/*:refs/remotes/a]b/*' },
        ])(
          'Then the $name section is written as git writes it',
          async ({ name, header, fetch }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seed(ctx);
            const configBefore = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);

            // Act
            await remoteAdd(ctx, { name, url: 'https://x.invalid/' });

            // Assert
            expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).toBe(
              `${configBefore}${header}\n\turl = https://x.invalid/\n\tfetch = ${fetch}\n`,
            );
            expect((await remoteList(ctx)).remotes.map((remote) => remote.name)).toEqual([name]);
          },
        );
      });
    });

    describe('Given an existing remote and a new name nested under or over it', () => {
      describe('When remoteAdd runs', () => {
        it.each([
          { existing: 'a', name: 'a/b', reason: "subset of existing remote 'a'" },
          { existing: 'a', name: 'a/b/c', reason: "subset of existing remote 'a'" },
          { existing: 'x/y', name: 'x', reason: "superset of existing remote 'x/y'" },
        ])(
          'Then $name refuses REMOTE_NAME_INVALID as a $reason before writing any config',
          async ({ existing, name, reason }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seed(ctx, `[remote "${existing}"]\n\turl = u\n`);
            const configBefore = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
            let caught: unknown;

            // Act
            try {
              await remoteAdd(ctx, { name, url: 'u' });
            } catch (err) {
              caught = err;
            }

            // Assert
            expect((caught as TsgitError).data).toEqual({
              code: 'REMOTE_NAME_INVALID',
              name,
              reason,
            });
            expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).toBe(configBefore);
          },
        );
      });
    });

    describe('Given an existing remote and a new name sharing only a leading string with it', () => {
      describe('When remoteAdd runs', () => {
        it('Then the new remote is added', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "a"]\n\turl = u\n');

          // Act
          await remoteAdd(ctx, { name: 'ab', url: 'u' });

          // Assert
          expect((await remoteList(ctx)).remotes.map((remote) => remote.name)).toEqual(['a', 'ab']);
        });
      });
    });

    describe('Given a configured remote whose name cannot form a tracking ref name', () => {
      describe('When remoteAdd runs with that name', () => {
        it('Then the existing remote refuses first, with REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "a b"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: 'a b', url: 'u2' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({ code: 'REMOTE_EXISTS', remote: 'a b' });
        });
      });
    });

    describe('Given a name that cannot form a tracking ref name', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws REMOTE_NAME_INVALID before writing any config', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          const configBefore = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, { name: 'a b', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: 'a b',
            reason: 'name does not form a valid refs/remotes/<name>/ ref name',
          });
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).toBe(configBefore);
        });
      });
    });

    describe('Given a url containing a newline', () => {
      describe('When remoteAdd runs', () => {
        it('Then it throws INVALID_OPTION', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, {
              name: 'origin',
              url: 'https://e.com/\nrest',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('remote.url');
          expect(data.reason).toContain('newline');
        });
      });
    });

    describe('Given a malformed custom fetch refspec', () => {
      describe('When remoteAdd runs with a fetch refspec', () => {
        it('Then it throws REFSPEC_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteAdd(ctx, {
              name: 'origin',
              url: 'u',
              fetch: '',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REFSPEC_INVALID');
        });
      });
    });
  });

  describe('remove', () => {
    describe('Given an unknown remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteRemove(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given a configured remote with no tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then the config block is gone and removedTrackingRefs is empty', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.name).toBe('origin');
          expect(result.removedTrackingRefs).toEqual([]);
          expect(result.clearedBranches).toEqual([]);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('[remote "origin"]');
        });
      });
    });

    describe('Given a configured remote with two tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then both refs are deleted and reported', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/dev`,
            `${'b'.repeat(40)}\n`,
          );

          // Act
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect([...result.removedTrackingRefs].sort()).toEqual([
            'refs/remotes/origin/dev',
            'refs/remotes/origin/main',
          ]);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/dev`)).toBe(false);
        });
      });
    });

    describe('Given a configured remote with a symbolic HEAD and two direct tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then every tracking ref is deleted in one ref transaction', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/dev`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          const batches = recordBatches(ctx);

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(batches).toEqual([
            [
              { kind: 'delete', name: ORIGIN_HEAD },
              { kind: 'delete', name: 'refs/remotes/origin/dev' },
              { kind: 'delete', name: ORIGIN_MAIN },
            ],
          ]);
        });
      });
    });

    describe('Given branches tracking the removed remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then branch.<X>.remote and branch.<X>.merge are cleared', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
          );

          // Act
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.clearedBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('remote = origin');
          expect(written).not.toContain('merge = refs/heads/main');
        });
      });
    });

    describe('Given a branch tracking a different remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then the other branch is not cleared', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = other\n\tmerge = refs/heads/main\n',
          );

          // Act
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.clearedBranches).toEqual([]);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('remote = other');
        });
      });
    });

    describe('Given a branch tracking the remote without a paired merge', () => {
      describe('When remoteRemove runs', () => {
        it('Then only branch.<X>.remote is cleared (merge already absent)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, `${ORIGIN_TRACKING_CONFIG}[branch "main"]\n\tremote = origin\n`);

          // Act
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(result.clearedBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).not.toContain('remote = origin');
        });
      });
    });

    describe('Given two branches tracking the same remote', () => {
      describe('When remoteRemove runs', () => {
        it('Then both are cleared', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n[branch "dev"]\n\tremote = origin\n\tmerge = refs/heads/dev\n',
          );

          // Act
          const result = await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect([...result.clearedBranches].sort()).toEqual(['refs/heads/dev', 'refs/heads/main']);
        });
      });
    });

    describe('Given a tracking symref (HEAD) among the tracking refs', () => {
      describe('When remoteRemove runs', () => {
        it('Then every tracking ref and the symref are gone, --no-deref', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await writeSymbolicRef(
            ctx,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/remotes/origin/main' as RefName,
          );

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/origin/HEAD' as RefName),
          ).toEqual({ kind: 'missing' });
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/origin/main' as RefName),
          ).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given HEAD symbolically naming a tracking ref on a files-backend Context', () => {
      describe('When remoteRemove runs', () => {
        it('Then the coupled HEAD entry carries git\'s "remote: remove" message', async () => {
          // Arrange
          vi.spyOn(Date, 'now').mockReturnValue(FROZEN_EPOCH_SECONDS * 1000);
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/HEAD`, `ref: ${ORIGIN_MAIN}\n`);

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(await reflogLines(ctx, 'HEAD' as RefName)).toEqual([
            `${ORIGIN_ID} ${ZERO_ID} ${FALLBACK_IDENTITY}\tremote: remove`,
          ]);
        });
      });
    });

    describe('Given a logged symbolic origin/HEAD and HEAD naming origin/main on a reftable-backend Context', () => {
      describe('When remoteRemove runs', () => {
        it('Then the kept origin/HEAD log and the coupled HEAD entry both carry "remote: remove"', async () => {
          // Arrange
          vi.spyOn(Date, 'now').mockReturnValue(FROZEN_EPOCH_SECONDS * 1000);
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
            {
              kind: 'setSymbolic',
              name: ORIGIN_HEAD,
              target: ORIGIN_MAIN,
              reflog: { oldId: ZERO_ID, newId: ZERO_ID, message: 'clone' },
            },
            { kind: 'setSymbolic', name: 'HEAD' as RefName, target: ORIGIN_MAIN },
          ]);
          const removal = `${ORIGIN_ID} ${ZERO_ID} ${FALLBACK_IDENTITY}\tremote: remove`;

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(await reflogLines(ctx, ORIGIN_HEAD)).toEqual([
            `${ZERO_ID} ${ZERO_ID} ${FALLBACK_IDENTITY}\tclone`,
            removal,
          ]);
          expect((await reflogLines(ctx, 'HEAD' as RefName)).at(-1)).toBe(removal);
        });
      });
    });

    describe('Given a tracking ref with a reflog file', () => {
      describe('When remoteRemove runs', () => {
        it('Then the reflog file is gone', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          // Reflog entry (synthetic — one line is enough; the parser is forgiving).
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/origin/main`,
            `${'0'.repeat(40)} ${'a'.repeat(40)} Tester <t@e.com> 1700000000 +0000\tfetch\n`,
          );

          // Act
          await remoteRemove(ctx, { name: 'origin' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/remotes/origin/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given an unconfigured name that cannot form a tracking ref name', () => {
      describe('When remoteRemove runs', () => {
        it('Then it refuses REMOTE_NOT_CONFIGURED, as git looks the remote up rather than checking its syntax', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteRemove(ctx, { name: 'a b' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NOT_CONFIGURED',
            remote: 'a b',
          });
        });
      });
    });
    describe.each([
      {
        label: 'no fetch refspec of its own',
        config: '[remote "origin"]\n\turl = u\n',
        removed: [] as readonly string[],
        kept: ['refs/remotes/origin/main', 'refs/remotes/origin/sub/x', 'refs/remotes/zzz/q'],
      },
      {
        label: 'a refspec fetching outside refs/remotes',
        config: '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/other/origin/*\n',
        removed: [],
        kept: ['refs/remotes/origin/main', 'refs/remotes/origin/sub/x', 'refs/remotes/zzz/q'],
      },
      {
        label: 'a refspec fetching only into a nested path',
        config: '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/sub/*\n',
        removed: ['refs/remotes/origin/sub/x'],
        kept: ['refs/remotes/origin/main', 'refs/remotes/zzz/q'],
      },
      {
        label: "a refspec fetching into another remote's namespace",
        config: '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/zzz/*\n',
        removed: ['refs/remotes/zzz/q'],
        kept: ['refs/remotes/origin/main', 'refs/remotes/origin/sub/x'],
      },
      {
        label: 'a second remote fetching into the same namespace',
        config: `${ORIGIN_TRACKING_CONFIG}[remote "k"]\n\turl = k\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
        removed: [],
        kept: ['refs/remotes/origin/main', 'refs/remotes/origin/sub/x', 'refs/remotes/zzz/q'],
      },
      {
        label: 'a second remote fetching into a nested path of it',
        config: `${ORIGIN_TRACKING_CONFIG}[remote "k"]\n\turl = k\n\tfetch = +refs/heads/*:refs/remotes/origin/sub/*\n`,
        removed: ['refs/remotes/origin/main'],
        kept: ['refs/remotes/origin/sub/x', 'refs/remotes/zzz/q'],
      },
      {
        label: 'a second remote mirroring every ref',
        config: `${ORIGIN_TRACKING_CONFIG}[remote "k"]\n\turl = k\n\tfetch = +refs/*:refs/*\n`,
        removed: [],
        kept: ['refs/remotes/origin/main', 'refs/remotes/origin/sub/x', 'refs/remotes/zzz/q'],
      },
    ])('Given $label, When remoteRemove runs', ({ config, removed, kept }) => {
      it('Then exactly the refs it alone fetches into are deleted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
          { kind: 'set', name: 'refs/remotes/origin/sub/x' as RefName, id: ORIGIN_ID },
          { kind: 'set', name: 'refs/remotes/zzz/q' as RefName, id: ORIGIN_ID },
        ]);

        // Act
        const result = await remoteRemove(ctx, { name: 'origin' });

        // Assert
        expect([...result.removedTrackingRefs].sort()).toEqual([...removed].sort());
        const store = getRefStore(ctx);
        for (const name of removed) {
          expect(await store.resolveDirect(name as RefName)).toEqual({ kind: 'missing' });
        }
        for (const name of kept) {
          expect(await store.resolveDirect(name as RefName)).toEqual({
            kind: 'direct',
            id: ORIGIN_ID,
          });
        }
      });
    });
  });

  describe('rename', () => {
    describe('Given an unknown `from`', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'missing', to: 'new' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given a configured remote renamed onto its own name', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_EXISTS naming that remote', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('REMOTE_EXISTS');
          if (data.code !== 'REMOTE_EXISTS') throw new Error('unreachable');
          expect(data.remote).toBe('origin');
        });
      });
    });

    describe('Given an unconfigured remote renamed onto its own name', () => {
      describe('When remoteRename runs', () => {
        it('Then the missing source refuses first', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'nope', to: 'nope' });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
          if (data.code !== 'REMOTE_NOT_CONFIGURED') throw new Error('unreachable');
          expect(data.remote).toBe('nope');
        });
      });
    });

    describe('Given an existing `to`', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = a\n[remote "upstream"]\n\turl = b\n');
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_EXISTS');
        });
      });
    });

    describe('Given the canonical default refspec', () => {
      describe('When remoteRename runs', () => {
        it('Then it is rewritten for the new name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "upstream"]');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/upstream/*');
          expect(written).not.toContain('refs/remotes/origin/');
        });
      });
    });

    describe('Given the canonical default refspec', () => {
      describe('When the renamed config is read back', () => {
        it('Then remoteList binds the rewritten fetch to the new remote section', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          __resetConfigCacheForTests();
          const result = await remoteList(ctx);

          // Assert — the re-emitted fetch spec must attach to `[remote "upstream"]`,
          // not a stray empty-section header.
          expect(result.remotes).toEqual([
            {
              name: 'upstream',
              url: 'u',
              pushUrl: undefined,
              fetchRefspecs: ['+refs/heads/*:refs/remotes/upstream/*'],
            },
          ]);
        });
      });
    });

    describe("Given a fetch refspec aimed at another remote's tracking namespace", () => {
      describe('When remoteRename runs', () => {
        it('Then the refspec is preserved verbatim', async () => {
          // Arrange — the destination names `other`, not the remote being
          // renamed, so git's splice never reaches it.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/other/*\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/other/*');
        });
      });
    });

    describe('Given two refspecs that both map into the tracking namespace', () => {
      describe('When remoteRename runs', () => {
        it('Then both are rewritten AND refspec order is preserved', async () => {
          // Arrange — order matters: the canonical-first/custom-second
          // arrangement must survive the rename so `.git/config` byte
          // layout matches canonical git.
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch = +refs/heads/release:refs/remotes/origin/release\n',
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert — both refspecs present in the original order.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          const canonicalAt = written.indexOf('fetch = +refs/heads/*:refs/remotes/upstream/*');
          const customAt = written.indexOf(
            'fetch = +refs/heads/release:refs/remotes/upstream/release',
          );
          expect(canonicalAt).toBeGreaterThan(-1);
          expect(customAt).toBeGreaterThan(-1);
          expect(canonicalAt).toBeLessThan(customAt);
        });
      });
    });

    describe('Given tracking refs under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then they are moved with the same OIDs', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.movedTrackingRefs).toEqual(['refs/remotes/upstream/main']);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/remotes/origin/main`)).toBe(false);
          const moved = (
            await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/upstream/main`)
          ).trim();
          expect(moved).toBe(oid);
        });
      });
    });

    describe('Given a tracking ref under the old name with an existing reflog', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name keeps that history and gains one full-ref-name rename entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/origin/main`,
            `${'0'.repeat(40)} ${oid} A <a@e.com> 1700000000 +0000\tfetch\n`,
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          const log = await readReflog(ctx, 'refs/remotes/upstream/main' as RefName);

          // Assert — the moved history, plus exactly one appended entry
          // naming the full ref paths, not the remote names.
          expect(log).toHaveLength(2);
          expect(log[0]?.newId).toBe(oid);
          expect(log[1]?.oldId).toBe(oid);
          expect(log[1]?.newId).toBe(oid);
          expect(log[1]?.message).toBe(
            'remote: renamed refs/remotes/origin/main to refs/remotes/upstream/main',
          );
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/remotes/origin/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given a tracking ref under the old name with NO existing reflog', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name has no reflog either', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/remotes/upstream/main`)).toBe(
            false,
          );
        });
      });
    });

    describe('Given an unlogged direct tracking ref on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name has no reflog either', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/main' as RefName,
              id: 'a'.repeat(40) as ObjectId,
            },
          ]);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(await readReflog(ctx, 'refs/remotes/upstream/main' as RefName)).toEqual([]);
        });
      });
    });

    describe.each(UNMAPPED_REFSPECS)('Given $label, When remoteRename runs', ({ refspecs }) => {
      it('Then no tracking ref moves and every refspec survives verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, remoteConfigWithFetch(refspecs));
        await getRefStore(ctx).applyRefUpdates([{ kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID }]);

        // Act
        const result = await remoteRename(ctx, { from: 'origin', to: 'up2' });

        // Assert
        expect(result.movedTrackingRefs).toEqual([]);
        const store = getRefStore(ctx);
        expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
        expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(written).toContain('[remote "up2"]');
        for (const spec of refspecs) expect(written).toContain(`fetch = ${spec}`);
      });
    });

    describe.each(MAPPED_REFSPECS)(
      'Given $label, When remoteRename runs',
      ({ refspec, rewritten }) => {
        it('Then the tracking refs move and the refspec is spliced onto the new name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, remoteConfigWithFetch([refspec]));
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
          ]);

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(result.movedTrackingRefs).toEqual([UP2_MAIN]);
          expect(await getRefStore(ctx).resolveDirect(UP2_MAIN)).toEqual({
            kind: 'direct',
            id: ORIGIN_ID,
          });
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain(`fetch = ${rewritten}`);
        });
      },
    );

    describe('Given one mapping refspec among refspecs that do not map', () => {
      describe('When remoteRename runs', () => {
        it('Then the refs move, only the mapping refspec is spliced, and the order is kept', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const specs = [
            '+refs/tags/*:refs/other/x/*',
            '+refs/heads/*:refs/remotes/origin/*',
            '+refs/notes/*:refs/remotes/originX/*',
          ];
          await seed(ctx, remoteConfigWithFetch(specs));
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
          ]);

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(result.movedTrackingRefs).toEqual([UP2_MAIN]);
          __resetConfigCacheForTests();
          expect((await remoteList(ctx)).remotes[0]?.fetchRefspecs).toEqual([
            '+refs/tags/*:refs/other/x/*',
            '+refs/heads/*:refs/remotes/up2/*',
            '+refs/notes/*:refs/remotes/originX/*',
          ]);
        });
      });
    });

    describe('Given no refspec mapping the tracking namespace and a branch tracking the remote', () => {
      describe('When remoteRename runs', () => {
        it('Then the section and the referrer are still re-pointed at the new name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n');
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
          ]);

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(result.movedTrackingRefs).toEqual([]);
          expect(result.rewrittenBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "up2"]');
          expect(written).toContain('remote = up2');
          // Nothing to rewrite, so the renamed section gets no `fetch` line.
          expect(written).not.toContain('fetch');
        });
      });
    });

    describe('Given an unlogged symbolic tracking ref (HEAD) on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new HEAD symref exists with no reflog either', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/main' as RefName,
              id: 'a'.repeat(40) as ObjectId,
            },
            {
              kind: 'setSymbolic',
              name: 'refs/remotes/origin/HEAD' as RefName,
              target: 'refs/remotes/origin/main' as RefName,
            },
          ]);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(await store.resolveDirect('refs/remotes/upstream/HEAD' as RefName)).toEqual({
            kind: 'symbolic',
            target: 'refs/remotes/upstream/main',
          });
          expect(await readReflog(ctx, 'refs/remotes/upstream/HEAD' as RefName)).toEqual([]);
        });
      });
    });

    describe('Given a branch tracking the renamed remote', () => {
      describe('When remoteRename runs', () => {
        it('Then branch.<X>.remote is rewritten to the new name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
          );

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.rewrittenBranches).toEqual(['refs/heads/main']);
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('remote = upstream');
          expect(written).not.toContain('remote = origin');
        });
      });
    });

    describe('Given a packed-only tracking ref under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then the new name is written loose with the packed id and the old name is gone from packed-refs', async () => {
          // Arrange — write a `packed-refs` file that names
          // refs/remotes/origin/main; no loose file exists. `enumerateRefs`
          // surfaces the packed entry, and the move now rewrites
          // packed-refs to drop it, as `git remote rename` does.
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/remotes/origin/main\n`,
          );

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.movedTrackingRefs).toEqual(['refs/remotes/upstream/main']);
          const moved = (
            await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/remotes/upstream/main`)
          ).trim();
          expect(moved).toBe(oid);
          const packedContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/packed-refs`);
          expect(packedContent).not.toContain('refs/remotes/origin/main');
        });
      });
    });

    describe('Given a packed-only tracking ref under the old name, with an existing reflog', () => {
      describe('When remoteRename runs', () => {
        it('Then the moved history gains one rename entry and the old packed-refs line is gone', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/remotes/origin/main\n`,
          );
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/logs/refs/remotes/origin/main`,
            `${'0'.repeat(40)} ${oid} A <a@e.com> 1700000000 +0000\tfetch\n`,
          );

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          const log = await readReflog(ctx, 'refs/remotes/upstream/main' as RefName);

          // Assert
          expect(log).toHaveLength(2);
          expect(log[1]?.message).toBe(
            'remote: renamed refs/remotes/origin/main to refs/remotes/upstream/main',
          );
          const packedContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/packed-refs`);
          expect(packedContent).not.toContain('refs/remotes/origin/main');
        });
      });
    });

    describe('Given a symbolic tracking ref (HEAD) on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new HEAD symref is re-created with a rewritten target and a null-id rename entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await writeSymbolicRef(
            ctx,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/remotes/origin/main' as RefName,
          );

          // Act
          const result = await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert
          expect(result.movedTrackingRefs).toEqual([
            'refs/remotes/upstream/HEAD',
            'refs/remotes/upstream/main',
          ]);
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/origin/HEAD' as RefName),
          ).toEqual({ kind: 'missing' });
          expect(
            await getRefStore(ctx).resolveDirect('refs/remotes/upstream/HEAD' as RefName),
          ).toEqual({ kind: 'symbolic', target: 'refs/remotes/upstream/main' });
          const log = await readReflog(ctx, 'refs/remotes/upstream/HEAD' as RefName);
          expect(log).toHaveLength(1);
          expect(log[0]?.oldId).toBe('0'.repeat(40));
          expect(log[0]?.newId).toBe('0'.repeat(40));
          expect(log[0]?.message).toBe(
            'remote: renamed refs/remotes/origin/HEAD to refs/remotes/upstream/HEAD',
          );
        });
      });
    });

    describe('Given a symbolic tracking ref (HEAD) on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the new HEAD symref carries the copied log and the old name keeps it with one deletion entry', async () => {
          // Arrange
          vi.spyOn(Date, 'now').mockReturnValue(FROZEN_EPOCH_SECONDS * 1000);
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
            {
              kind: 'setSymbolic',
              name: ORIGIN_HEAD,
              target: ORIGIN_MAIN,
              reflog: { oldId: ZERO_ID, newId: ZERO_ID, message: 'clone' },
            },
          ]);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert — the copied history carries no trailing entry on the
          // create side; the old name's kept log gains the referent's value
          // from before the rename, to the null id, with no message.
          expect(await store.resolveDirect('refs/remotes/upstream/HEAD' as RefName)).toEqual({
            kind: 'symbolic',
            target: 'refs/remotes/upstream/main',
          });
          expect(await store.resolveDirect(ORIGIN_HEAD)).toEqual({ kind: 'missing' });
          const clone = `${ZERO_ID} ${ZERO_ID} ${FALLBACK_IDENTITY}\tclone`;
          expect(await reflogLines(ctx, 'refs/remotes/upstream/HEAD' as RefName)).toEqual([clone]);
          expect(await reflogLines(ctx, ORIGIN_HEAD)).toEqual([
            clone,
            `${ORIGIN_ID} ${ZERO_ID} ${FALLBACK_IDENTITY}\t`,
          ]);
        });
      });
    });

    describe('Given two logged direct tracking refs and a symbolic HEAD on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the creates share one batch, every old name is deleted in one ref transaction, and HEAD is re-created last', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/dev`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(
            `${gitDir}/logs/refs/remotes/origin/dev`,
            `${ZERO_ID} ${STALE_ID} A <a@x> 1700000000 +0000\tfetch\n`,
          );
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(
            `${gitDir}/logs/refs/remotes/origin/main`,
            `${ZERO_ID} ${ORIGIN_ID} A <a@x> 1700000000 +0000\tfetch\n`,
          );
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          const batches = recordBatches(ctx);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(batches).toEqual([
            [
              { kind: 'set', name: 'refs/remotes/up2/dev', id: STALE_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: 'refs/remotes/up2/dev',
                reflog: {
                  oldId: STALE_ID,
                  newId: STALE_ID,
                  message: 'remote: renamed refs/remotes/origin/dev to refs/remotes/up2/dev',
                },
              },
              { kind: 'set', name: UP2_MAIN, id: ORIGIN_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: UP2_MAIN,
                reflog: {
                  oldId: ORIGIN_ID,
                  newId: ORIGIN_ID,
                  message: 'remote: renamed refs/remotes/origin/main to refs/remotes/up2/main',
                },
              },
            ],
            [
              { kind: 'delete', name: ORIGIN_HEAD },
              { kind: 'delete', name: 'refs/remotes/origin/dev' },
              { kind: 'delete', name: ORIGIN_MAIN },
            ],
            [
              {
                kind: 'setSymbolic',
                name: UP2_HEAD,
                target: UP2_MAIN,
                reflog: {
                  oldId: ZERO_ID,
                  newId: ZERO_ID,
                  message: 'remote: renamed refs/remotes/origin/HEAD to refs/remotes/up2/HEAD',
                },
              },
            ],
          ]);
        });
      });
    });

    describe('Given two logged direct tracking refs and a symbolic HEAD on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it("Then the old names' deletes share one ref transaction with HEAD's kept-log entry", async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/remotes/origin/dev' as RefName,
              id: STALE_ID,
              reflog: { oldId: ZERO_ID, newId: STALE_ID, message: 'fetch' },
            },
            {
              kind: 'set',
              name: ORIGIN_MAIN,
              id: ORIGIN_ID,
              reflog: { oldId: ZERO_ID, newId: ORIGIN_ID, message: 'fetch' },
            },
            {
              kind: 'setSymbolic',
              name: ORIGIN_HEAD,
              target: ORIGIN_MAIN,
              reflog: { oldId: ZERO_ID, newId: ZERO_ID, message: 'clone' },
            },
          ]);
          const batches = recordBatches(ctx);

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert
          expect(batches).toEqual([
            [
              { kind: 'set', name: 'refs/remotes/up2/dev', id: STALE_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: 'refs/remotes/up2/dev',
                reflog: {
                  oldId: STALE_ID,
                  newId: STALE_ID,
                  message: 'remote: renamed refs/remotes/origin/dev to refs/remotes/up2/dev',
                },
              },
              { kind: 'set', name: UP2_MAIN, id: ORIGIN_ID, expected: 'absent' },
              {
                kind: 'reflogOnly',
                name: UP2_MAIN,
                reflog: {
                  oldId: ORIGIN_ID,
                  newId: ORIGIN_ID,
                  message: 'remote: renamed refs/remotes/origin/main to refs/remotes/up2/main',
                },
              },
            ],
            [
              { kind: 'delete', name: ORIGIN_HEAD },
              { kind: 'delete', name: 'refs/remotes/origin/dev' },
              { kind: 'delete', name: ORIGIN_MAIN },
              {
                kind: 'reflogOnly',
                name: ORIGIN_HEAD,
                reflog: { oldId: ORIGIN_ID, newId: ZERO_ID, message: '' },
              },
            ],
            [{ kind: 'setSymbolic', name: UP2_HEAD, target: UP2_MAIN }],
          ]);
        });
      });
    });

    describe('Given both direct and symbolic tracking refs under the old name', () => {
      describe('When remoteRename runs', () => {
        it('Then every direct ref moves before the symbolic ref does', async () => {
          // Arrange — git's own order: direct refs first, the symref last.
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/refs/remotes/origin/main`,
            `${'a'.repeat(40)}\n`,
          );
          await writeSymbolicRef(
            ctx,
            'refs/remotes/origin/HEAD' as RefName,
            'refs/remotes/origin/main' as RefName,
          );
          const store = getRefStore(ctx);
          const calls: Array<{ readonly kind: string }> = [];
          const originalApply = store.applyRefUpdates.bind(store);
          store.applyRefUpdates = async (updates) => {
            for (const update of updates) calls.push({ kind: update.kind });
            return originalApply(updates);
          };

          // Act
          await remoteRename(ctx, { from: 'origin', to: 'upstream' });

          // Assert — the LAST `setSymbolic` call is the HEAD re-creation;
          // every `set` (the direct ref) lands before it.
          const setSymbolicIndex = calls.findIndex((c) => c.kind === 'setSymbolic');
          const lastSetIndex = calls.map((c) => c.kind).lastIndexOf('set');
          expect(setSymbolicIndex).toBeGreaterThan(-1);
          expect(lastSetIndex).toBeGreaterThan(-1);
          expect(setSymbolicIndex).toBeGreaterThan(lastSetIndex);
        });
      });
    });

    describe('Given a logged tracking ref and a stale logged ref at its renamed name on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses the existing name before writing any ref or log', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          const originLog = `${ZERO_ID} ${ORIGIN_ID} A <a@x> 1700000000 +0000\tfetch origin\n`;
          const staleLog = `${ZERO_ID} ${STALE_ID} A <a@x> 1700000000 +0000\tstale up2\n`;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/logs/refs/remotes/origin/main`, originLog);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/main`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/logs/refs/remotes/up2/main`, staleLog);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/main',
            expected: 'absent',
            actual: STALE_ID,
          });
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/origin/main`)).toBe(
            `${ORIGIN_ID}\n`,
          );
          expect(await ctx.fs.readUtf8(`${gitDir}/logs/refs/remotes/origin/main`)).toBe(originLog);
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/up2/main`)).toBe(`${STALE_ID}\n`);
          expect(await ctx.fs.readUtf8(`${gitDir}/logs/refs/remotes/up2/main`)).toBe(staleLog);
        });
      });
    });

    describe('Given a logged tracking ref and a stale logged ref at its renamed name on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses the existing name before writing any ref or log', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            {
              kind: 'set',
              name: ORIGIN_MAIN,
              id: ORIGIN_ID,
              reflog: { oldId: ZERO_ID, newId: ORIGIN_ID, message: 'fetch origin' },
            },
            {
              kind: 'set',
              name: UP2_MAIN,
              id: STALE_ID,
              reflog: { oldId: ZERO_ID, newId: STALE_ID, message: 'stale up2' },
            },
          ]);
          const originLog = await readReflog(ctx, ORIGIN_MAIN);
          const staleLog = await readReflog(ctx, UP2_MAIN);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/main',
            expected: 'absent',
            actual: STALE_ID,
          });
          expect(originLog.map((entry) => entry.message)).toEqual(['fetch origin']);
          expect(staleLog.map((entry) => entry.message)).toEqual(['stale up2']);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'direct', id: STALE_ID });
          expect(await readReflog(ctx, ORIGIN_MAIN)).toEqual(originLog);
          expect(await readReflog(ctx, UP2_MAIN)).toEqual(staleLog);
        });
      });
    });

    describe('Given stale refs at two renamed names on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then the refusal names the byte-smallest existing name', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/zzz`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/zzz`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/main`, `${ORIGIN_ID}\n`);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/main',
            expected: 'absent',
            actual: ORIGIN_ID,
          });
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/origin/zzz`)).toBe(`${ORIGIN_ID}\n`);
        });
      });
    });

    describe('Given a symbolic ref already at the renamed HEAD on a files-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses that name with its referent value and every ref stays put', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${STALE_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/HEAD`, 'ref: refs/heads/main\n');

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/HEAD',
            expected: 'absent',
            actual: STALE_ID,
          });
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(ORIGIN_HEAD)).toEqual({
            kind: 'symbolic',
            target: ORIGIN_MAIN,
          });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/main',
          });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given a symbolic ref already at the renamed HEAD on a reftable-backend Context', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses that name with its referent value and every ref stays put', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            { kind: 'set', name: 'refs/heads/main' as RefName, id: STALE_ID },
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
            { kind: 'setSymbolic', name: ORIGIN_HEAD, target: ORIGIN_MAIN },
            { kind: 'setSymbolic', name: UP2_HEAD, target: 'refs/heads/main' as RefName },
          ]);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/HEAD',
            expected: 'absent',
            actual: STALE_ID,
          });
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(ORIGIN_HEAD)).toEqual({
            kind: 'symbolic',
            target: ORIGIN_MAIN,
          });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/main',
          });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given a dangling symbolic ref already at the renamed HEAD', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses that name with an absent actual value and every ref stays put', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/HEAD`, 'ref: refs/heads/nope\n');

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/remotes/up2/HEAD',
            expected: 'absent',
            actual: 'absent',
          });
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({
            kind: 'symbolic',
            target: 'refs/heads/nope',
          });
        });
      });
    });

    describe('Given a cyclic symbolic ref already at the renamed HEAD', () => {
      describe('When remoteRename runs', () => {
        it('Then the unreadable referent refuses the rename and every ref stays put', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/HEAD`, `ref: ${ORIGIN_MAIN}\n`);
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/HEAD`, 'ref: refs/remotes/up2/loop\n');
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/up2/loop`, `ref: ${UP2_HEAD}\n`);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_CYCLE_DETECTED',
            chain: ['refs/remotes/up2/loop', 'refs/remotes/up2/HEAD', 'refs/remotes/up2/loop'],
          });
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given an invalid `to` name', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_NAME_INVALID', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'a b' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: 'a b',
            reason: 'name does not form a valid refs/remotes/<name>/ ref name',
          });
        });
      });
    });

    describe('Given a configured `from` remote whose name cannot form a tracking ref name', () => {
      describe('When remoteRename runs onto a valid name', () => {
        it('Then the remote is renamed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "a b"]\n\turl = u\n');

          // Act
          await remoteRename(ctx, { from: 'a b', to: 'ok' });

          // Assert
          expect((await remoteList(ctx)).remotes.map((remote) => remote.name)).toEqual(['ok']);
        });
      });
    });

    describe('Given a configured `to` remote whose name cannot form a tracking ref name', () => {
      describe('When remoteRename runs onto it', () => {
        it('Then the existing remote refuses first, with REMOTE_EXISTS', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n[remote "a b"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'origin', to: 'a b' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({ code: 'REMOTE_EXISTS', remote: 'a b' });
        });
      });
    });

    describe('Given an unconfigured `from` name that cannot form a tracking ref name', () => {
      describe('When remoteRename runs', () => {
        it('Then it refuses REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          let caught: unknown;

          // Act
          try {
            await remoteRename(ctx, { from: 'a b', to: 'ok' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NOT_CONFIGURED',
            remote: 'a b',
          });
        });
      });
    });

    describe('Given a `to` name that cannot form a tracking ref name', () => {
      describe('When remoteRename runs', () => {
        it('Then it throws REMOTE_NAME_INVALID before moving any ref or rewriting the config', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, ORIGIN_TRACKING_CONFIG);
          const gitDir = ctx.layout.gitDir;
          await ctx.fs.writeUtf8(`${gitDir}/refs/remotes/origin/main`, `${ORIGIN_ID}\n`);
          const configBefore = await ctx.fs.readUtf8(`${gitDir}/config`);

          // Act
          const caught = await renameRefusal(ctx, '..');

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: '..',
            reason: 'name does not form a valid refs/remotes/<name>/ ref name',
          });
          expect(await ctx.fs.readUtf8(`${gitDir}/refs/remotes/origin/main`)).toBe(
            `${ORIGIN_ID}\n`,
          );
          expect(await ctx.fs.readUtf8(`${gitDir}/config`)).toBe(configBefore);
        });
      });
    });

    describe.each(BACKENDS)('Given a symbolic tracking ref on the $label store', ({ frame }) => {
      describe.each(SPLICED_TARGETS)(
        'When remoteRename runs with $label',
        ({ target, spliced }) => {
          it('Then the renamed symref points at the spliced target', async () => {
            // Arrange
            const ctx = frame(createMemoryContext());
            await seedRenameSource(ctx, target);

            // Act
            await remoteRename(ctx, { from: 'origin', to: 'up2' });

            // Assert
            expect(await getRefStore(ctx).resolveDirect(UP2_HEAD)).toEqual({
              kind: 'symbolic',
              target: spliced,
            });
          });
        },
      );

      describe.each(SHORT_TARGETS)('When remoteRename runs with $label', ({ target }) => {
        it('Then it throws INVALID_REF and leaves every tracking ref where it was', async () => {
          // Arrange
          const ctx = frame(createMemoryContext());
          await seedRenameSource(ctx, target);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_REF');
          if (data.code !== 'INVALID_REF') throw new Error('unreachable');
          expect(data.reason).toBe(
            `symbolic ref target '${target}' is shorter than the renamed slice`,
          );
          const store = getRefStore(ctx);
          expect(await store.resolveDirect(ORIGIN_HEAD)).toEqual({ kind: 'symbolic', target });
          expect(await store.resolveDirect(ORIGIN_MAIN)).toEqual({ kind: 'direct', id: ORIGIN_ID });
          expect(await store.resolveDirect(UP2_HEAD)).toEqual({ kind: 'missing' });
          expect(await store.resolveDirect(UP2_MAIN)).toEqual({ kind: 'missing' });
        });
      });

      describe('When remoteRename runs with the new name already taken and a target too short to splice', () => {
        it('Then the short target refuses ahead of the name conflict', async () => {
          // Arrange
          const ctx = frame(createMemoryContext());
          await seedRenameSource(ctx, 'refs/heads/main' as RefName);
          await getRefStore(ctx).applyRefUpdates([{ kind: 'set', name: UP2_MAIN, id: STALE_ID }]);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_REF');
        });
      });
    });

    describe('Given a symref target too short to splice and a branch tracking the remote', () => {
      describe('When remoteRename runs', () => {
        it('Then the section carries the new name while its refspec and referrer still name the old one', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, TRACKED_ORIGIN_CONFIG);
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
            { kind: 'setSymbolic', name: ORIGIN_HEAD, target: 'refs/heads/main' as RefName },
          ]);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_REF');
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "up2"]');
          expect(written).not.toContain('[remote "origin"]');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/origin/*');
          expect(written).toContain('remote = origin');
        });
      });
    });

    describe('Given a renamed tracking name already taken and a branch tracking the remote', () => {
      describe('When remoteRename runs', () => {
        it('Then the section carries the new name while its refspec and referrer still name the old one', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, TRACKED_ORIGIN_CONFIG);
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
            { kind: 'set', name: UP2_MAIN, id: STALE_ID },
          ]);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data.code).toBe('REF_UPDATE_CONFLICT');
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('[remote "up2"]');
          expect(written).toContain('fetch = +refs/heads/*:refs/remotes/origin/*');
          expect(written).toContain('remote = origin');
          expect(await getRefStore(ctx).resolveDirect(ORIGIN_MAIN)).toEqual({
            kind: 'direct',
            id: ORIGIN_ID,
          });
        });
      });
    });

    describe('Given a `to` that is already a configured remote', () => {
      describe('When remoteRename runs', () => {
        it('Then the config is left byte-for-byte as it was', async () => {
          // Arrange — this refusal precedes the section rename, so nothing moves.
          const ctx = createMemoryContext();
          await seed(ctx, `${TRACKED_ORIGIN_CONFIG}[remote "up2"]\n\turl = b\n`);
          const before = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);

          // Act
          const caught = await renameRefusal(ctx, 'up2');

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_EXISTS');
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).toBe(before);
        });
      });
    });
  });

  describe('setUrl', () => {
    describe('Given an unknown remote', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then it throws REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteSetUrl(ctx, { name: 'origin', url: 'x' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
        });
      });
    });

    describe('Given a known remote and a new url', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then remote.<n>.url is replaced and pushurl is untouched', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = old\n\tpushurl = push-old\n');

          // Act
          const result = await remoteSetUrl(ctx, {
            name: 'origin',
            url: 'new',
          });

          // Assert
          expect(result.remote.url).toBe('new');
          expect(result.remote.pushUrl).toBe('push-old');
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('url = new');
          expect(written).toContain('pushurl = push-old');
          expect(written).not.toContain('url = old');
        });
      });
    });

    describe('Given a known remote and { push: true }', () => {
      describe('When remoteSetUrl runs with push: true', () => {
        it('Then remote.<n>.pushurl is replaced and url is untouched', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');

          // Act
          const result = await remoteSetUrl(ctx, {
            name: 'origin',
            url: 'push-new',
            push: true,
          });

          // Assert
          expect(result.remote.pushUrl).toBe('push-new');
          expect(result.remote.url).toBe('u');
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(written).toContain('pushurl = push-new');
          expect(written).toContain('url = u');
        });
      });
    });

    describe('Given a url with a newline', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then it throws INVALID_OPTION', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          let caught: unknown;

          // Act
          try {
            await remoteSetUrl(ctx, {
              name: 'origin',
              url: 'bad\nurl',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('remote.url');
          expect(data.reason).toContain('newline');
        });
      });
    });

    describe('Given a configured remote whose name cannot form a tracking ref name', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then its url is replaced', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "a b"]\n\turl = u\n');

          // Act
          const result = await remoteSetUrl(ctx, { name: 'a b', url: 'u3' });

          // Assert
          expect(result.remote.url).toBe('u3');
        });
      });
    });

    describe('Given an unconfigured name that cannot form a tracking ref name', () => {
      describe('When remoteSetUrl runs', () => {
        it('Then it refuses REMOTE_NOT_CONFIGURED, as git looks the remote up rather than checking its syntax', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteSetUrl(ctx, { name: 'a b', url: 'u' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NOT_CONFIGURED',
            remote: 'a b',
          });
        });
      });
    });
  });

  describe('show', () => {
    describe('Given a name no remote is configured under', () => {
      describe('When remoteShow runs', () => {
        it('Then it reports the name as its own url with nothing else attached', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote).toEqual({
            name: 'origin',
            url: 'origin',
            pushUrl: undefined,
            fetchRefspecs: [],
            trackingRefs: new Map(),
            trackedBy: [],
          });
        });
      });
    });

    describe('Given a name no remote is configured under but tracking refs under it', () => {
      describe('When remoteShow runs', () => {
        it('Then no tracking ref is attached, since nothing fetches into that namespace', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: 'refs/remotes/nope/x' as RefName, id: ORIGIN_ID },
          ]);

          // Act
          const result = await remoteShow(ctx, { name: 'nope' });

          // Assert
          expect(result.remote.trackingRefs).toEqual(new Map());
          expect(result.remote.url).toBe('nope');
        });
      });
    });

    describe('Given a configured remote with no fetch refspec but tracking refs under it', () => {
      describe('When remoteShow runs', () => {
        it('Then no tracking ref is attached, since nothing fetches into that namespace', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await getRefStore(ctx).applyRefUpdates([
            { kind: 'set', name: ORIGIN_MAIN, id: ORIGIN_ID },
          ]);

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.trackingRefs).toEqual(new Map());
          expect(result.remote.url).toBe('u');
        });
      });
    });

    describe('Given a remote with tracking refs and tracking branches', () => {
      describe('When remoteShow runs', () => {
        it('Then trackingRefs and trackedBy reflect them', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
          );
          const oid = 'a'.repeat(40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${oid}\n`);

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.url).toBe('https://e.com/r.git');
          expect(result.remote.fetchRefspecs).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
          expect(result.remote.trackingRefs.size).toBe(1);
          expect(result.remote.trackingRefs.get('refs/remotes/origin/main' as never)).toBe(oid);
          expect(result.remote.trackedBy).toEqual([
            { branch: 'refs/heads/main', merge: 'refs/heads/main' },
          ]);
        });
      });
    });

    describe('Given a remote with pushurl set', () => {
      describe('When remoteShow runs', () => {
        it('Then pushUrl is populated', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n\tpushurl = p\n');

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.pushUrl).toBe('p');
        });
      });
    });

    describe('Given a remote with no tracking refs', () => {
      describe('When remoteShow runs', () => {
        it('Then trackingRefs is an empty Map', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.trackingRefs.size).toBe(0);
          expect(result.remote.trackedBy).toEqual([]);
        });
      });
    });

    describe('Given a remote tracked by a branch with no merge', () => {
      describe('When remoteShow runs', () => {
        it('Then trackedBy[i].merge is undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n[branch "main"]\n\tremote = origin\n');

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect(result.remote.trackedBy).toEqual([
            { branch: 'refs/heads/main', merge: undefined },
          ]);
        });
      });
    });

    describe('Given an unconfigured name that cannot form a tracking ref name', () => {
      describe('When remoteShow runs', () => {
        it('Then it still reports the name as its own url, its syntax never checked', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);

          // Act
          const result = await remoteShow(ctx, { name: 'a b' });

          // Assert
          expect(result.remote.name).toBe('a b');
          expect(result.remote.url).toBe('a b');
          expect(result.remote.fetchRefspecs).toEqual([]);
        });
      });
    });

    describe('Given the empty name', () => {
      describe('When remoteShow runs', () => {
        it('Then it refuses REMOTE_NOT_CONFIGURED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx);
          let caught: unknown;

          // Act
          try {
            await remoteShow(ctx, { name: '' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NOT_CONFIGURED',
            remote: '',
          });
        });
      });
    });
    describe.each(BACKENDS)('Given a planted ref space on the $label store', ({ frame }) => {
      describe.each(SHOW_SELECTION)(
        'When remoteShow runs with $label',
        ({ refspecs, extraConfig, expected }) => {
          it('Then exactly the refs those refspecs fetch into are attached', async () => {
            // Arrange
            const ctx = frame(createMemoryContext());
            await seed(ctx, `${remoteConfigWithFetch(refspecs)}${extraConfig}`);
            await getRefStore(ctx).applyRefUpdates(
              SHOW_FIXTURE_REFS.map((name) => ({ kind: 'set', name, id: ORIGIN_ID }) as const),
            );

            // Act
            const result = await remoteShow(ctx, { name: 'origin' });

            // Assert
            expect([...result.remote.trackingRefs.keys()].sort()).toEqual([...expected].sort());
            for (const name of expected) {
              expect(result.remote.trackingRefs.get(name as RefName)).toBe(ORIGIN_ID);
            }
          });
        },
      );
    });

    describe('Given a detached HEAD and a refspec whose destination is a bare star', () => {
      describe('When remoteShow runs', () => {
        it('Then HEAD is not among the tracking refs, only the refs under refs/', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, remoteConfigWithFetch(['+refs/heads/*:*']));
          await getRefStore(ctx).applyRefUpdates([
            ...SHOW_FIXTURE_REFS.map((name) => ({ kind: 'set', name, id: ORIGIN_ID }) as const),
            { kind: 'set', name: 'HEAD' as RefName, id: ORIGIN_ID },
          ]);

          // Act
          const result = await remoteShow(ctx, { name: 'origin' });

          // Assert
          expect([...result.remote.trackingRefs.keys()].sort()).toEqual([
            'refs/heads/side',
            'refs/other/origin/z',
            'refs/remotes/origin/deep/x',
            'refs/remotes/origin/main',
            'refs/remotes/zzz/q',
          ]);
        });
      });
    });
  });

  describe('the format-acceptance tier', () => {
    describe('Given a repository the format-acceptance gate rejects', () => {
      describe('When remoteList runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx();

          // Act
          let caught: unknown;
          try {
            await remoteList(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteAdd runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx();

          // Act
          let caught: unknown;
          try {
            await remoteAdd(ctx, { name: 'origin', url: 'https://example.com/repo.git' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteRemove runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteRemove(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteRename runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteRename(ctx, { from: 'origin', to: 'upstream' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteSetUrl runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteSetUrl(ctx, { name: 'origin', url: 'https://example.com/other.git' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });

      describe('When remoteShow runs', () => {
        it('Then it throws the carried format refusal', async () => {
          // Arrange
          const ctx = await rejectedCtx('[remote "origin"]\n\turl = u\n');

          // Act
          let caught: unknown;
          try {
            await remoteShow(ctx, { name: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError | undefined)?.data).toMatchObject({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });
    });
  });
});

describe('Given a fetch refspec whose wildcard has no destination to land in', () => {
  const CONFIG = '[remote "origin"]\n\turl = u\n\tfetch = +refs/heads/*\n';

  describe.each([
    { label: 'remoteShow', act: (ctx: Context) => remoteShow(ctx, { name: 'origin' }) },
    { label: 'remoteRemove', act: (ctx: Context) => remoteRemove(ctx, { name: 'origin' }) },
    {
      label: 'remoteRename',
      act: (ctx: Context) => remoteRename(ctx, { from: 'origin', to: 'up2' }),
    },
    { label: 'remoteList', act: (ctx: Context) => remoteList(ctx) },
  ])('When $label reads that remote', ({ act }) => {
    it('Then it refuses the refspec itself, naming the value verbatim', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, CONFIG);

      // Act
      let caught: unknown;
      try {
        await act(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as TsgitError | undefined)?.data).toMatchObject({
        code: 'REFSPEC_INVALID',
        raw: '+refs/heads/*',
      });
    });
  });

  describe('When remoteRemove names a remote nothing configures', () => {
    it('Then the refspec refusal still wins — git builds every remote before it looks one up', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, CONFIG);

      // Act
      let caught: unknown;
      try {
        await remoteRemove(ctx, { name: 'nope' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as TsgitError | undefined)?.data).toMatchObject({
        code: 'REFSPEC_INVALID',
        raw: '+refs/heads/*',
      });
    });
  });
});

describe('Given fetch refspec shapes git accepts', () => {
  describe.each([
    { label: 'a colon-free plain name, which lands in FETCH_HEAD', spec: 'refs/heads/main' },
    { label: 'wildcards on both sides', spec: '+refs/heads/*:refs/remotes/origin/*' },
    { label: 'exact names on both sides', spec: 'refs/heads/main:refs/remotes/origin/main' },
    { label: 'an empty destination', spec: 'refs/heads/main:' },
  ])('When remoteShow reads a remote configured with $label', ({ spec }) => {
    it('Then it reads the remote without refusing', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, `[remote "origin"]\n\turl = u\n\tfetch = ${spec}\n`);

      // Act
      const result = await remoteShow(ctx, { name: 'origin' });

      // Assert
      expect(result.remote.fetchRefspecs).toEqual([spec]);
    });
  });
});

describe('Given fetch refspec shapes git refuses for a mismatched wildcard', () => {
  describe.each([
    {
      label: 'a wildcard source against an exact destination',
      spec: 'refs/heads/*:refs/remotes/origin/x',
    },
    {
      label: 'an exact source against a wildcard destination',
      spec: 'refs/heads/x:refs/remotes/origin/*',
    },
    { label: 'two wildcards on each side', spec: 'refs/heads/**:refs/remotes/origin/**' },
    { label: 'an empty source against a wildcard destination', spec: ':refs/remotes/origin/*' },
  ])('When remoteShow reads a remote configured with $label', ({ spec }) => {
    it('Then it refuses the refspec itself, naming the value verbatim', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, `[remote "origin"]\n\turl = u\n\tfetch = ${spec}\n`);

      // Act
      let caught: unknown;
      try {
        await remoteShow(ctx, { name: 'origin' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as TsgitError | undefined)?.data).toMatchObject({
        code: 'REFSPEC_INVALID',
        raw: spec,
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { branchCreate } from '../../../../../src/application/commands/branch.js';
import {
  invalidateConfigCache,
  memoizeRepoSettingsVerdict,
  readConfig,
} from '../../../../../src/application/primitives/config-read.js';
import { commitHeader } from '../../../../../src/application/primitives/internal/read-commit-graph.js';
import {
  assertRepoSettingsValid,
  repoSettingsVerdictSettled,
} from '../../../../../src/application/primitives/internal/repo-settings-gate.js';
import { assertOperationalRepository } from '../../../../../src/application/primitives/internal/repo-state.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  Blob,
  Commit,
  FilePath,
  ObjectId,
} from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedRepo = async (ctx: Context, head = 'ref: refs/heads/main\n'): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, head);
};

const seedConfig = async (ctx: Context, config: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

const assertRefusesWithBadMaxTreeDepth = async (op: () => Promise<unknown>): Promise<void> => {
  let caught: unknown;
  try {
    await op();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data as BadNumericData;
  expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
  expect(data.key).toBe('core.maxtreedepth');
  expect(data.value).toBe('2.5');
  expect(data.reason).toBe('invalid unit');
};

describe('internal/repo-settings-gate', () => {
  describe('assertRepoSettingsValid', () => {
    describe('Given core.maxTreeDepth = 2.5', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — the whole payload, each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given core.maxTreeDepth = 2147483648 (past the C int ceiling)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason out of range', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2147483648\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2147483648');
          expect(data.reason).toBe('out of range');
        });
      });
    });

    describe('Given a config with no [core] maxTreeDepth entry', () => {
      describe('When called', () => {
        it('Then resolves without throwing', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');

          // Act + Assert — must not throw
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given maxTreeDepth = 2.5 on line 2 then maxTreeDepth = 2048 on line 3 (invalid-then-valid)', () => {
      describe('When called', () => {
        it('Then resolves without throwing (the effective last-wins value reaches the gate)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n\tmaxTreeDepth = 2048\n');

          // Act + Assert — must not throw
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given maxTreeDepth = 2048 on line 2 then maxTreeDepth = 2.5 on line 3 (valid-then-invalid)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE (the effective last-wins value reaches the gate)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2048\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
        });
      });
    });

    describe('Given two synchronous, back-to-back calls before either settles', () => {
      describe('When called', () => {
        it('Then both return the identical promise (single-flight)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');

          // Act
          const first = assertRepoSettingsValid(ctx);
          const second = assertRepoSettingsValid(ctx);

          // Assert
          expect(second).toBe(first);
          await first;
        });
      });
    });

    describe('Given a rejected call whose config is then fixed and invalidated', () => {
      describe('When assertRepoSettingsValid is called again', () => {
        it('Then a rejection is never cached — the second call re-runs and resolves', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          await expect(assertRepoSettingsValid(ctx)).rejects.toBeInstanceOf(TsgitError);

          // Act
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2048\n');
          invalidateConfigCache(ctx);

          // Assert — must not throw and must not still be the stale rejection
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given a resolved session whose file is rewritten to a malformed value, then the operational gate runs again', () => {
      describe('When assertRepoSettingsValid is called again (no invalidateConfigCache call)', () => {
        it('Then the gate itself passes but the next boundary touch refuses — the epoch re-keyed the memo', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');
          await assertRepoSettingsValid(ctx);

          // Act — external rewrite, then the next command's own operational gate
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          const root = await assertOperationalRepository(ctx);

          // Assert — the eager gate does not validate this class, so it passes …
          expect(root).toBe(ctx.layout.workDir);
          // … but the first boundary touch after it must refuse.
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
        });
      });
    });
  });

  describe('assertRepoSettingsValid — core.deltaBaseCacheLimit joins the class', () => {
    describe('Given core.deltaBaseCacheLimit = -1', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE naming core.deltabasecachelimit', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tdeltaBaseCacheLimit = -1\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.deltabasecachelimit');
          expect(data.value).toBe('-1');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given BOTH core.maxTreeDepth and core.deltaBaseCacheLimit are malformed', () => {
      describe('When called', () => {
        it('Then names core.maxtreedepth — the in-function reading order (repo-settings.c:103 before :142)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tdeltaBaseCacheLimit = -1\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.key).toBe('core.maxtreedepth');
        });
      });
    });

    describe('Given a malformed core.deltaBaseCacheLimit AND an explicit cacheBudgets.deltaBaseCacheMaxBytes option', () => {
      describe('When called', () => {
        it('Then resolves — an option-overridden file value is never validated', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRepo(base);
          await seedConfig(base, '[core]\n\tdeltaBaseCacheLimit = -1\n');
          const ctx: Context = { ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 2048 } };

          // Act + Assert — must not throw
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given the same malformed core.deltaBaseCacheLimit WITHOUT the option', () => {
      describe('When called', () => {
        it('Then throws — the file value is read and validated when nothing overrides it', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tdeltaBaseCacheLimit = -1\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.deltabasecachelimit');
        });
      });
    });
  });

  describe('repoSettingsVerdictSettled', () => {
    describe('Given a fresh session that has never called assertRepoSettingsValid', () => {
      describe('When checked', () => {
        it('Then reports false', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = repoSettingsVerdictSettled(ctx);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given assertRepoSettingsValid has resolved for this session', () => {
      describe('When checked', () => {
        it('Then reports true', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');
          await assertRepoSettingsValid(ctx);

          // Act
          const result = repoSettingsVerdictSettled(ctx);

          // Assert
          expect(result).toBe(true);
        });
      });
    });

    describe('Given a settled session whose cache is then invalidated', () => {
      describe('When checked', () => {
        it('Then reports false again', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');
          await assertRepoSettingsValid(ctx);

          // Act
          invalidateConfigCache(ctx);

          // Assert
          expect(repoSettingsVerdictSettled(ctx)).toBe(false);
        });
      });
    });

    describe('Given assertRepoSettingsValid has rejected for this session', () => {
      describe('When checked', () => {
        it('Then reports false — a rejection never settles', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          await expect(assertRepoSettingsValid(ctx)).rejects.toBeInstanceOf(TsgitError);

          // Act
          const result = repoSettingsVerdictSettled(ctx);

          // Assert
          expect(result).toBe(false);
        });
      });
    });
  });

  describe('Given a warm session — gate, an object read, an external config rewrite, then the gate again', () => {
    const WARM_AUTHOR: AuthorIdentity = {
      name: 'A U Thor',
      email: 'author@example.com',
      timestamp: 0,
      timezoneOffset: '+0000',
    };

    /**
     * Builds the exact sequence F1 was found under: a gate settles the
     * repo-settings verdict against a VALID config, an object read confirms
     * the session is warm, an external rewrite (a raw `ctx.fs.writeUtf8` —
     * no `invalidateConfigCache`, mirroring an editor or another process
     * touching `.git/config` directly) poisons `core.maxTreeDepth`, and the
     * operational gate runs again. The eager gate does not validate this
     * class, so this second gate call itself resolves — the assertion that
     * matters is what every FAST-PATHED boundary does next.
     */
    const buildWarmThenPoisonedSession = async (): Promise<{
      readonly ctx: Context;
      readonly commitId: ObjectId;
    }> => {
      const ctx = createMemoryContext();
      await seedRepo(ctx);
      await seedConfig(ctx, '[core]\n\tbare = false\n');

      const blob: Blob = {
        type: 'blob',
        content: new TextEncoder().encode('warm-session'),
        id: '' as ObjectId,
      };
      const blobId = await writeObject(ctx, blob);
      const treeId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, blobId)]);
      const commit: Commit = {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: treeId,
          parents: [],
          author: WARM_AUTHOR,
          committer: WARM_AUTHOR,
          message: 'c0',
          extraHeaders: [],
        },
      };
      const commitId = await writeObject(ctx, commit);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // GATE #1 — settles the repo-settings verdict against the valid config.
      await assertOperationalRepository(ctx);

      // First object read on the warm session — confirms the fast path is live.
      await readObject(ctx, commitId);
      expect(repoSettingsVerdictSettled(ctx)).toBe(true);

      // External rewrite: a raw edit this Context's own write surface never
      // observes — no invalidateConfigCache call.
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

      // GATE #2 — re-keys the epoch; the eager gate itself still passes.
      await assertOperationalRepository(ctx);

      return { ctx, commitId };
    };

    describe('When readObject reads an already-written object', () => {
      it('Then refuses with CONFIG_BAD_NUMERIC_VALUE instead of serving the superseded verdict', async () => {
        // Arrange
        const { ctx, commitId } = await buildWarmThenPoisonedSession();

        // Act + Assert
        await assertRefusesWithBadMaxTreeDepth(() => readObject(ctx, commitId));
      });
    });

    describe('When writeObject writes a brand-new object', () => {
      it('Then refuses with CONFIG_BAD_NUMERIC_VALUE instead of serving the superseded verdict', async () => {
        // Arrange
        const { ctx } = await buildWarmThenPoisonedSession();
        const blob: Blob = {
          type: 'blob',
          content: new TextEncoder().encode('post-poison'),
          id: '' as ObjectId,
        };

        // Act + Assert
        await assertRefusesWithBadMaxTreeDepth(() => writeObject(ctx, blob));
      });
    });

    describe('When commitHeader is asked for a commit', () => {
      it('Then refuses with CONFIG_BAD_NUMERIC_VALUE instead of serving the superseded verdict', async () => {
        // Arrange
        const { ctx, commitId } = await buildWarmThenPoisonedSession();

        // Act + Assert
        await assertRefusesWithBadMaxTreeDepth(() => commitHeader(ctx, commitId));
      });
    });

    describe('When branchCreate creates a branch from HEAD', () => {
      it('Then refuses with CONFIG_BAD_NUMERIC_VALUE instead of serving the superseded verdict', async () => {
        // Arrange
        const { ctx } = await buildWarmThenPoisonedSession();

        // Act + Assert
        await assertRefusesWithBadMaxTreeDepth(() => branchCreate(ctx, { name: 'from-warm' }));
      });
    });
  });

  describe('Given a PRIMITIVE-ONLY session — never gated — settled, externally rewritten, then re-read', () => {
    describe('When the synchronous fast path and a further object read are consulted', () => {
      it('Then the re-keyed parse entry supersedes the verdict on its own and readObject refuses', async () => {
        // Arrange — no `assertOperationalRepository` anywhere in this
        // sequence, so nothing but the verdict's own key comparison can
        // notice the rewrite: the entry is never dropped, only out-keyed.
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedConfig(ctx, '[core]\n\tbare = false\n');
        const blob: Blob = {
          type: 'blob',
          content: new TextEncoder().encode('primitive-only'),
          id: '' as ObjectId,
        };
        const blobId = await writeObject(ctx, blob);
        await readObject(ctx, blobId);
        expect(repoSettingsVerdictSettled(ctx)).toBe(true);

        // Act — a raw rewrite with NO invalidateConfigCache, followed by the
        // plain config read that re-keys the parse entry.
        await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
        await readConfig(ctx);

        // Assert
        expect(repoSettingsVerdictSettled(ctx)).toBe(false);
        await assertRefusesWithBadMaxTreeDepth(() => readObject(ctx, blobId));
      });
    });
  });

  describe('Given the parse cache moves to a NEW key while a verdict is still computing', () => {
    describe('When that verdict resolves', () => {
      it('Then it keeps the key it actually validated rather than adopting the newer one', async () => {
        // Arrange — a real (non-sentinel) key is in the parse cache before
        // the verdict starts, so the call-time snapshot is already valid.
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedConfig(ctx, '[core]\n\tbare = false\n');
        await readConfig(ctx);

        // Act — a compute that validates the CURRENT bytes and only then
        // lets the parse cache move on. Doing the re-key inside `compute`
        // stands in deterministically for the concurrent read that would
        // otherwise land its continuation between the resolution and the
        // memo's own; both leave the same state behind.
        await memoizeRepoSettingsVerdict(ctx, async () => {
          await readConfig(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          await readConfig(ctx);
        });

        // Assert — adopting the newer key would advertise this verdict as
        // current for bytes it never read, and the refusal below would be
        // skipped for the rest of the session.
        expect(repoSettingsVerdictSettled(ctx)).toBe(false);
        await assertRefusesWithBadMaxTreeDepth(() => assertRepoSettingsValid(ctx));
      });
    });
  });
});

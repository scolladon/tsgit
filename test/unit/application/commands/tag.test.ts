import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate, tagDelete, tagList } from '../../../../src/application/commands/tag.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { stubCommandRunner } from '../primitives/helpers/stub-command-runner.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithCommit = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  return { ctx, commitId: c.id };
};

/** A repository with a commit AND a configured `[user]` — the tagger source for annotated tags. */
const seedWithConfiguredUser = async () => {
  const seeded = await seedWithCommit();
  await seeded.ctx.fs.writeUtf8(
    `${seeded.ctx.layout.gitDir}/config`,
    '[user]\n  name = Grace\n  email = grace@example.com\n',
  );
  __resetConfigCacheForTests();
  return seeded;
};

describe('tag', () => {
  describe('Given a fresh tag', () => {
    describe('When tag create', () => {
      it('Then refs/tags/<name> exists', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        expect(sut.id).toBe(commitId);
      });
    });
  });

  describe('Given an existing tag', () => {
    describe('When tag create without force', () => {
      it('Then throws TAG_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
      });
    });
  });

  describe('Given a tag', () => {
    describe('When tag delete', () => {
      it('Then ref is removed', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        await tagDelete(ctx, { name: 'v1.0' });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/tags/v1.0`)).toBe(false);
      });
    });
  });

  describe('Given a non-existent tag', () => {
    describe('When tag delete', () => {
      it('Then throws TAG_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        let caught: unknown;
        try {
          await tagDelete(ctx, { name: 'ghost' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_NOT_FOUND');
      });
    });
  });

  describe('Given two tags', () => {
    describe('When tag list', () => {
      it('Then returns them sorted', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v2.0' });
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        const sut = await tagList(ctx);

        // Assert
        expect(sut.tags.map((t) => t.name)).toEqual(['refs/tags/v1.0', 'refs/tags/v2.0']);
      });
    });
  });

  describe('Given an explicit target oid', () => {
    describe('When tag create', () => {
      it('Then the tag points at that oid (not HEAD)', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = await tagCreate(ctx, { name: 'pin', target: commitId });

        // Assert
        expect(sut.id).toBe(commitId);
      });
    });
  });

  describe('Given an explicit target as a ref name', () => {
    describe('When tag create', () => {
      it('Then resolves it via resolveRef', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = await tagCreate(ctx, { name: 'pin', target: 'refs/heads/main' });

        // Assert
        expect(sut.id).toBe(commitId);
      });
    });
  });

  describe('Given force=true on an existing tag', () => {
    describe('When tag create', () => {
      it('Then the second create overwrites the ref (commit oid is unchanged)', async () => {
        // Arrange — seed a commit and tag it once.
        const { ctx } = await seedWithCommit();
        const first = await tagCreate(ctx, { name: 'v1.0' });

        // Act — second create with force MUST NOT throw and MUST end pointing
        // at the same commit oid (no rewrite of the underlying ref target).
        const sut = await tagCreate(ctx, { name: 'v1.0', force: true });

        // Assert — the fields that prove the ref was rewritten in place
        // (full name + same oid).
        expect(sut.name).toBe('refs/tags/v1.0');
        expect(sut.id).toBe(first.id);
      });
    });
  });

  describe('Given a fresh repo with no tags', () => {
    describe('When tag list', () => {
      it('Then returns an empty array', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const sut = await tagList(ctx);

        // Assert
        expect(sut.tags).toEqual([]);
      });
    });
  });

  describe('Given a subdirectory inside refs/tags', () => {
    describe('When tag list', () => {
      it('Then non-file entries are skipped', async () => {
        // Arrange — a file tag plus a directory entry sharing the refs/tags namespace
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/refs/tags/group`);

        // Act — must not throw: the directory entry is filtered out before resolveRef
        const sut = await tagList(ctx);

        // Assert — only the file tag is listed; the directory is not resolved as a ref
        expect(sut.tags.map((t) => t.name)).toEqual(['refs/tags/v1.0']);
      });
    });
  });

  describe('Given three tags created out of order', () => {
    describe('When tag list', () => {
      it('Then returns them in strict ascending order', async () => {
        // Arrange — insertion order v3, v1, v2 so readdir yields an unsorted array
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v3.0' });
        await tagCreate(ctx, { name: 'v1.0' });
        await tagCreate(ctx, { name: 'v2.0' });

        // Act
        const sut = await tagList(ctx);

        // Assert — comparator must order ascending; an always-(-1)/always-(1) comparator
        // would leave [v3,v1,v2] or reverse it to [v2,v1,v3], neither matching this.
        expect(sut.tags.map((t) => t.name)).toEqual([
          'refs/tags/v1.0',
          'refs/tags/v2.0',
          'refs/tags/v3.0',
        ]);
      });
    });
  });

  describe('Given a target ending in 40 hex but prefixed by a non-hex char', () => {
    describe('When tag create', () => {
      it('Then treated as a ref name and throws REF_NOT_FOUND', async () => {
        // Arrange — 'z' + 40 hex: NOT a full-oid (anchored regex requires ^), so it
        // must be resolved as a ref name and fail because no such ref exists.
        const { ctx } = await seedWithCommit();
        const target = `z${'a'.repeat(40)}`;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'pin', target });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a target starting with 40 hex but with a trailing extra char', () => {
    describe('When tag create', () => {
      it('Then treated as a ref name and throws REF_NOT_FOUND', async () => {
        // Arrange — 40 hex + 'z': NOT a full-oid (anchored regex requires $), so it
        // must be resolved as a ref name and fail because no such ref exists.
        const { ctx } = await seedWithCommit();
        const target = `${'a'.repeat(40)}z`;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'pin', target });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given updateRef throws a non-conflict TsgitError', () => {
    describe('When tag create', () => {
      it('Then that error propagates unchanged (not converted to TAG_EXISTS)', async () => {
        // Arrange — a stale lock file makes the exclusive ref write throw REF_LOCKED.
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/locked.lock`, 'stale');

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'locked' });
        } catch (err) {
          caught = err;
        }

        // Assert — only REF_UPDATE_CONFLICT becomes TAG_EXISTS; REF_LOCKED is rethrown verbatim.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_LOCKED');
      });
    });
  });

  describe('Given core.logAllRefUpdates=always', () => {
    describe('When tag create', () => {
      it('Then the reflog entry message is "tag: <name>"', async () => {
        // Arrange — `always` makes even tag refs loggable, exposing the reflog
        // message tag writes. The message must name the tag, not be empty.
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  logallrefupdates = always\n',
        );
        __resetConfigCacheForTests();

        // Act
        await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        const entries = await readReflog(ctx, 'refs/tags/v1.0' as RefName);
        expect(entries.map((e) => e.message)).toEqual(['tag: v1.0']);
        __resetConfigCacheForTests();
      });
    });
  });

  describe('Given updateRef throws a non-TsgitError', () => {
    describe('When tag create', () => {
      it('Then that error propagates unchanged', async () => {
        // Arrange — wrap fs so the ref rename throws a plain Error inside updateRef.
        const { ctx } = await seedWithCommit();
        const renameFailure = new Error('rename exploded');
        const failingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async (): Promise<void> => {
              throw renameFailure;
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await tagCreate(failingCtx, { name: 'v9.9' });
        } catch (err) {
          caught = err;
        }

        // Assert — the plain Error is rethrown as-is, never dereferenced for `.data.code`.
        expect(caught).toBe(renameFailure);
      });
    });
  });

  describe('Given a configured user, annotate true, and a message', () => {
    describe('When tag create', () => {
      it('Then refs/tags/<name> points at a written tag object, not the commit', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithConfiguredUser();

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0', annotate: true, message: 'v1' });

        // Assert
        expect(sut.id).not.toBe(commitId);
        const obj = await readObject(ctx, sut.id);
        expect(obj.type).toBe('tag');
      });
    });
  });

  describe('Given a configured user and a message, with annotate left unset', () => {
    describe('When tag create', () => {
      it('Then it is annotated — message implies -a', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithConfiguredUser();

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0', message: 'v1' });

        // Assert
        expect(sut.id).not.toBe(commitId);
        const obj = await readObject(ctx, sut.id);
        expect(obj.type).toBe('tag');
      });
    });
  });

  describe('Given neither annotate nor message', () => {
    describe('When tag create', () => {
      it('Then it stays lightweight — the ref points at the target OID with no tag object written', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        expect(sut.id).toBe(commitId);
        const obj = await readObject(ctx, sut.id);
        expect(obj.type).toBe('commit');
      });
    });
  });

  describe('Given annotate true but no configured user', () => {
    describe('When tag create', () => {
      it('Then it throws the author-unconfigured refusal', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', annotate: true, message: 'v1' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('AUTHOR_UNCONFIGURED');
      });
    });
  });

  describe('Given an existing tag and a configured user', () => {
    describe('When annotated tag create without force', () => {
      it('Then it throws TAG_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithConfiguredUser();
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', annotate: true, message: 'v1' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
      });
    });
  });
});

describe('tag — signing', () => {
  const armor = () =>
    '-----BEGIN PGP SIGNATURE-----\n\nZmFrZXNpZw==\n-----END PGP SIGNATURE-----\n';

  /** A repository with a commit and a configured `[user]` (the tagger source), plus optional extra config. */
  const seedSigning = async (
    command?: ReturnType<typeof stubCommandRunner>,
    configText?: string,
  ): Promise<Context> => {
    const ctx = createMemoryContext(command !== undefined ? { command } : {});
    await init(ctx);
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[user]\n  name = Grace\n  email = grace@example.com\n${configText ?? ''}`,
    );
    __resetConfigCacheForTests();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    return ctx;
  };

  const tagRefPath = (ctx: Context, name: string): string =>
    `${ctx.layout.gitDir}/refs/tags/${name}`;

  afterEach(() => __resetConfigCacheForTests());

  describe('Given opts.sign is true and the signer succeeds', () => {
    describe('When tag create with a message', () => {
      it('Then the tag body ends with the returned armor unmodified — no trailing-newline trim (unlike commits)', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true });

        // Assert
        const stored = await readObject(ctx, sut.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given opts.sign is true with no message or annotate', () => {
    describe('When tag create', () => {
      it('Then it still creates a signed annotated tag object — sign implies annotate', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0', sign: true });

        // Assert
        const stored = await readObject(ctx, sut.id);
        expect(stored.type).toBe('tag');
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given opts.sign is true', () => {
    describe('When tag create signs', () => {
      it('Then the signer receives the unsigned tag payload on stdin with no gpgsig header', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        await tagCreate(ctx, { name: 'v1.0', message: 'payload check', sign: true });

        // Assert
        expect(runner.calls).toHaveLength(1);
        const stdin = new TextDecoder().decode(runner.calls[0]?.stdin);
        expect(stdin).toContain('payload check');
        expect(stdin).not.toContain('gpgsig');
      });
    });
  });

  describe('Given tag.gpgSign=true in config and opts.sign is undefined', () => {
    describe('When tag create with a message', () => {
      it('Then it signs — the config default applies', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = true\n');

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0', message: 'v1' });

        // Assert
        const stored = await readObject(ctx, sut.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given tag.gpgSign=true in config and opts.sign is explicitly false', () => {
    describe('When tag create with a message', () => {
      it('Then it does not sign — the explicit false overrides the config default', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = true\n');

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: false });

        // Assert
        expect(runner.calls).toHaveLength(0);
        const stored = await readObject(ctx, sut.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBeUndefined();
      });
    });
  });

  describe('Given tag.gpgSign=true in config but neither annotate, message, nor sign is requested', () => {
    describe('When tag create', () => {
      it('Then the tag stays lightweight and unsigned — tag.gpgSign only signs an already-annotated tag', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = true\n');

        // Act
        const sut = await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        expect(runner.calls).toHaveLength(0);
        const stored = await readObject(ctx, sut.id);
        expect(stored.type).toBe('commit');
      });
    });
  });

  describe('Given opts.signKey overrides a configured user.signingKey', () => {
    describe('When tag create signs', () => {
      it('Then the signer invocation uses the override key, not the configured one', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[user]\n  signingKey = DEFAULTKEY\n');

        // Act
        await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true, signKey: 'OVERRIDEKEY' });

        // Assert
        const invoked = runner.calls[0]?.command ?? '';
        expect(invoked).toContain('OVERRIDEKEY');
        expect(invoked).not.toContain('DEFAULTKEY');
      });
    });
  });

  describe('Given the signer exits non-zero', () => {
    describe('When tag create is called with sign: true', () => {
      it('Then it throws SIGNING_FAILED with reason signer-failed and writes no ref', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1 });
        const ctx = await seedSigning(runner);

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'signer-failed',
          format: 'openpgp',
        });
        expect(await ctx.fs.exists(tagRefPath(ctx, 'v1.0'))).toBe(false);
      });
    });
  });

  describe('Given a context with no CommandRunner (off-node)', () => {
    describe('When tag create is called with sign: true', () => {
      it('Then it throws SIGNING_FAILED with reason off-node and writes no ref', async () => {
        // Arrange
        const ctx = await seedSigning(undefined);

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({ code: 'SIGNING_FAILED', reason: 'off-node' });
        expect(await ctx.fs.exists(tagRefPath(ctx, 'v1.0'))).toBe(false);
      });
    });
  });
});

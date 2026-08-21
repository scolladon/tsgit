import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../../src/application/commands/branch.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { resolveCommitIsh } from '../../../../../src/application/commands/internal/commit-ish.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  ObjectId,
  RefName,
  Tag,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = { name: 'T', email: 't@x', timestamp: 1, timezoneOffset: '+0000' };

/** Init a repo with one commit on main; return ctx + the commit id. */
const seedCommit = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const { id } = await commit(ctx, { message: 'first', author });
  return { ctx, head: id };
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

describe('resolveCommitIsh', () => {
  describe('Given an exact 40-hex object id', () => {
    describe('When resolved', () => {
      it('Then returns it verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = 'a'.repeat(40);

        // Act
        const result = await resolveCommitIsh(ctx, id);

        // Assert
        expect(result).toBe(id);
      });
    });
  });

  describe('Given a SHA-256 repository and an exact 64-hex object id', () => {
    describe('When resolved', () => {
      it('Then returns it verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await init(ctx);
        const id = 'a'.repeat(64);

        // Act
        const result = await resolveCommitIsh(ctx, id);

        // Assert
        expect(result).toBe(id);
      });
    });
  });

  describe('Given a SHA-256 repository with one loose object', () => {
    describe('When a 40-hex prefix of its id is resolved', () => {
      it('Then it is NOT taken verbatim — it resolves via the prefix scan to the full 64-hex id', async () => {
        // Arrange — this is the trap: under a permissive 40-OR-64 check, this
        // 40-char string would be (wrongly) accepted as a full oid and
        // returned truncated instead of reaching resolveOidPrefix.
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await init(ctx);
        const id = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([0x9a]),
        });
        const prefix40 = id.slice(0, 40);

        // Act
        const result = await resolveCommitIsh(ctx, prefix40);

        // Assert
        expect(result).toBe(id);
        expect(result).not.toBe(prefix40);
      });
    });
  });

  describe('Given an abbreviated object id matching a commit', () => {
    describe('When resolved', () => {
      it('Then resolves it to the full commit id', async () => {
        // Arrange
        const { ctx, head } = await seedCommit();

        // Act
        const result = await resolveCommitIsh(ctx, head.slice(0, 7));

        // Assert
        expect(result).toBe(head);
      });
    });
  });

  describe('Given a branch name', () => {
    describe('When resolved', () => {
      it('Then resolves it to the branch tip', async () => {
        // Arrange
        const { ctx, head } = await seedCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        const result = await resolveCommitIsh(ctx, 'feature');

        // Assert
        expect(result).toBe(head);
      });
    });
  });

  describe('Given a commit-ish that cannot be resolved', () => {
    describe('When resolved', () => {
      it.each([
        { commitIsh: 'nope', label: 'an unknown commit-ish throws REF_NOT_FOUND' },
        {
          commitIsh: `${'a'.repeat(40)}0`,
          label:
            'a 41-char string of 40 hex plus an extra char: the anchored oid regex rejects it and it falls through to REF_NOT_FOUND',
        },
        {
          commitIsh: 'a',
          label:
            'a single hex character below the abbreviated-oid floor: the 40-length oid regex rejects it and it falls through to REF_NOT_FOUND',
        },
        {
          commitIsh: 'z'.repeat(40),
          label:
            'a 40-character string of non-hex characters: the hex-only oid regex rejects it and it falls through to REF_NOT_FOUND',
        },
      ])('Then $label', async ({ commitIsh }) => {
        // Arrange
        const { ctx } = await seedCommit();

        // Act
        const code = await codeOf(() => resolveCommitIsh(ctx, commitIsh));

        // Assert
        expect(code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given the short name origin/<branch> of a remote-tracking ref', () => {
    describe('When resolved', () => {
      it('Then resolves via refs/remotes/<base>', async () => {
        // Arrange
        const { ctx, head } = await seedCommit();
        await updateRef(ctx, 'refs/remotes/origin/main' as RefName, head, {
          reflogMessage: 'seed',
        });

        // Act
        const result = await resolveCommitIsh(ctx, 'origin/main');

        // Assert
        expect(result).toBe(head);
      });
    });
  });

  describe('Given an annotated tag pointing to a commit', () => {
    describe('When resolved by the tag short name', () => {
      it('Then peels the tag to its commit', async () => {
        // Arrange — a real annotated tag object under refs/tags/v1
        const { ctx, head } = await seedCommit();
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: head,
            objectType: 'commit',
            tagName: 'v1',
            tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
            message: 'v1',
            extraHeaders: [],
          },
        };
        const tagId = await writeObject(ctx, tag);
        await updateRef(ctx, 'refs/tags/v1' as RefName, tagId, { reflogMessage: 'seed' });

        // Act
        const result = await resolveCommitIsh(ctx, 'v1');

        // Assert — peeled to the commit, not the tag object
        expect(result).toBe(head);
        expect(result).not.toBe(tagId);
      });
    });
  });

  describe('Given a 40-hex string that also names an existing branch', () => {
    describe('When resolved', () => {
      it('Then the oid fast-path wins and it returns the 40-hex verbatim, not the branch tip', async () => {
        // Arrange — a branch literally named as a 40-hex oid, pointing elsewhere
        const { ctx, head } = await seedCommit();
        const hexName = 'a'.repeat(40);
        await updateRef(ctx, `refs/heads/${hexName}` as RefName, head, { reflogMessage: 'seed' });

        // Act
        const result = await resolveCommitIsh(ctx, hexName);

        // Assert — resolved as an object id, not DWIM'd to the same-named branch
        expect(result).toBe(hexName);
        expect(result).not.toBe(head);
      });
    });
  });
});

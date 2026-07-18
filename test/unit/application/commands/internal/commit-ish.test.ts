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
        const sut = await resolveCommitIsh(ctx, id);

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe('Given an abbreviated object id matching a commit', () => {
    describe('When resolved', () => {
      it('Then resolves it to the full commit id', async () => {
        // Arrange
        const { ctx, head } = await seedCommit();

        // Act
        const sut = await resolveCommitIsh(ctx, head.slice(0, 7));

        // Assert
        expect(sut).toBe(head);
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
        const sut = await resolveCommitIsh(ctx, 'feature');

        // Assert
        expect(sut).toBe(head);
      });
    });
  });

  describe('Given an unknown commit-ish', () => {
    describe('When resolved', () => {
      it('Then throws REF_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedCommit();

        // Act
        const code = await codeOf(() => resolveCommitIsh(ctx, 'nope'));

        // Assert
        expect(code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a 41-char string of 40 hex plus an extra char', () => {
    describe('When resolved', () => {
      it('Then the anchored oid regex rejects it and it falls through to REF_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedCommit();

        // Act
        const code = await codeOf(() => resolveCommitIsh(ctx, `${'a'.repeat(40)}0`));

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
        const sut = await resolveCommitIsh(ctx, 'origin/main');

        // Assert
        expect(sut).toBe(head);
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
        const sut = await resolveCommitIsh(ctx, 'v1');

        // Assert — peeled to the commit, not the tag object
        expect(sut).toBe(head);
        expect(sut).not.toBe(tagId);
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
        const sut = await resolveCommitIsh(ctx, hexName);

        // Assert — resolved as an object id, not DWIM'd to the same-named branch
        expect(sut).toBe(hexName);
        expect(sut).not.toBe(head);
      });
    });
  });

  describe('Given a single hex character below the abbreviated-oid floor', () => {
    describe('When resolved', () => {
      it('Then the 40-length oid regex rejects it and it falls through to REF_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedCommit();

        // Act
        const code = await codeOf(() => resolveCommitIsh(ctx, 'a'));

        // Assert
        expect(code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a 40-character string of non-hex characters', () => {
    describe('When resolved', () => {
      it('Then the hex-only oid regex rejects it and it falls through to REF_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedCommit();

        // Act
        const code = await codeOf(() => resolveCommitIsh(ctx, 'z'.repeat(40)));

        // Assert
        expect(code).toBe('REF_NOT_FOUND');
      });
    });
  });
});

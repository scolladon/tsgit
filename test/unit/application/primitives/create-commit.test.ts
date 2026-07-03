import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'alice@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

async function emptyTreeId(ctx: Awaited<ReturnType<typeof buildSeededContext>>): Promise<ObjectId> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
}

describe('createCommit', () => {
  describe('Given valid input with empty parents (root commit)', () => {
    describe('When createCommit is called', () => {
      it('Then returns an ObjectId and readObject roundtrips', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'initial',
        });
        const read = await readObject(ctx, id);
        // Assert
        expect(read.type).toBe('commit');
        expect((read as Commit).data.message).toMatch(/^initial/);
      });
    });
  });

  describe('Given message containing NUL', () => {
    describe('When createCommit is called', () => {
      it('Then throws INVALID_COMMIT /message contains NUL/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'bad\0message',
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
          expect((error as TsgitError).message).toMatch(/message contains NUL/);
        }
      });
    });
  });

  describe('Given message size just-under 16 MiB', () => {
    describe('When createCommit is called', () => {
      it('Then succeeds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const msg = 'x'.repeat(16 * 1024 * 1024 - 1);
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: msg,
        });
        // Assert
        expect(id).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('Given message size exactly 16 MiB (at cap)', () => {
    describe('When createCommit is called', () => {
      it('Then succeeds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const msg = 'x'.repeat(16 * 1024 * 1024);
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: msg,
        });
        // Assert
        expect(id).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('Given message size just-over 16 MiB', () => {
    describe('When createCommit is called', () => {
      it('Then throws INVALID_COMMIT /message exceeds 16 MiB/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const msg = 'x'.repeat(16 * 1024 * 1024 + 1);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: msg,
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
          expect((error as TsgitError).message).toMatch(/exceeds 16 MiB/);
        }
      });
    });
  });

  describe('Given author.name containing newline', () => {
    describe('When createCommit is called', () => {
      it('Then throws INVALID_IDENTITY /forbidden control character/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: { ...AUTHOR, name: 'Evil\nname' },
            committer: AUTHOR,
            message: 'm',
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_IDENTITY');
          expect((error as TsgitError).message).toMatch(/forbidden control character/);
        }
      });
    });
  });

  describe('Given committer.email containing carriage return', () => {
    describe('When createCommit is called', () => {
      it('Then throws INVALID_IDENTITY', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: AUTHOR,
            committer: { ...AUTHOR, email: 'bad\r@a.com' },
            message: 'm',
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_IDENTITY');
        }
      });
    });
  });

  describe('Given gpgSignature containing NUL', () => {
    describe('When createCommit is called', () => {
      it('Then throws INVALID_COMMIT /gpgSignature/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'm',
            gpgSignature: '-----BEGIN PGP-----\0BAD',
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
          expect((error as TsgitError).message).toMatch(/gpgSignature/);
        }
      });
    });
  });

  describe('Given a gpgSignature with a genuine PGP armor (blank line after BEGIN, trailing LF)', () => {
    describe('When createCommit is called', () => {
      it('Then it succeeds and the armor roundtrips verbatim on the commit object', async () => {
        // Arrange
        // A real armor block carries a blank line after -----BEGIN... and a
        // trailing LF — the gpgSignature guard only rejects NUL/CR, so this
        // must be accepted and stored byte-for-byte.
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const armor = '-----BEGIN PGP SIGNATURE-----\n\nZmFrZQ==\n-----END PGP SIGNATURE-----\n';

        // Act
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'm',
          gpgSignature: armor,
        });

        // Assert
        const read = await readObject(ctx, id);
        if (read.type !== 'commit') {
          expect.unreachable();
          return;
        }
        expect(read.data.gpgSignature).toBe(armor);
      });
    });
  });

  describe('Given extraHeader value containing LF-LF', () => {
    describe('When createCommit is called', () => {
      it('Then throws INVALID_COMMIT /extraHeader/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'm',
            extraHeaders: [{ key: 'mergetag', value: 'x\n\nforged' }],
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
          expect((error as TsgitError).message).toMatch(/extraHeader/);
        }
      });
    });
  });

  describe('Given an extraHeader whose key contains %s', () => {
    describe('When createCommit is called', () => {
      it.each([
        ['empty', ''],
        ['NUL', 'a\0b'],
        ['CR', 'a\rb'],
        ['LF', 'a\nb'],
        ['space', 'two words'],
        ['tab', 'a\tb'],
      ])('Then throws INVALID_COMMIT /extraHeader key/', async (_label, badKey) => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        try {
          await createCommit(ctx, {
            tree,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'm',
            extraHeaders: [{ key: badKey, value: 'safe' }],
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
          expect((error as TsgitError).message).toMatch(/extraHeader key/);
        }
      });
    });
  });

  describe('Given a clean extraHeader entry', () => {
    describe('When createCommit is called', () => {
      it('Then succeeds (kills `hasHeaderInjectionChars` ConditionalExpression true)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'm',
          extraHeaders: [{ key: 'mergetag', value: 'a clean value with no separator' }],
        });
        // Assert
        expect(id).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('Given a commit with gpgSignature', () => {
    describe('When createCommit is called and readObject roundtrips', () => {
      it('Then the commit has the signature', async () => {
        // Arrange
        // Kills the ternary ConditionalExpression/EqualityOperator mutants around
        // `input.gpgSignature !== undefined ? { gpgSignature } : {}`: under `false`,
        // the signature would be dropped; under `true` it would appear with undefined.
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const sig = '-----BEGIN PGP-----\nfake-base64-sig\n-----END PGP-----';
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'signed',
          gpgSignature: sig,
        });
        const read = await readObject(ctx, id);
        // Assert
        if (read.type !== 'commit') expect.unreachable();
        expect(read.data.gpgSignature).toBe(sig);
      });
    });
  });

  describe('Given a commit with no gpgSignature', () => {
    describe('When createCommit is called and readObject roundtrips', () => {
      it('Then the data.gpgSignature key is absent', async () => {
        // Arrange
        // Kills the ternary `true` mutant: under `true`, the spread would include
        // `{ gpgSignature: undefined }` — the KEY would be present. `.toBeUndefined()`
        // cannot distinguish missing key vs. key-set-to-undefined; `'gpgSignature' in`
        // does.
        const ctx = await buildSeededContext();
        const tree = await emptyTreeId(ctx);
        const id = await createCommit(ctx, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'unsigned',
        });
        const read = await readObject(ctx, id);
        // Assert
        if (read.type !== 'commit') expect.unreachable();
        expect('gpgSignature' in read.data).toBe(false);
      });
    });
  });
});

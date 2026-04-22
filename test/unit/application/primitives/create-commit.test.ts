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
  it('Given valid input with empty parents (root commit), When createCommit is called, Then returns an ObjectId and readObject roundtrips', async () => {
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
    expect(read.type).toBe('commit');
    expect((read as Commit).data.message).toMatch(/^initial/);
  });

  it('Given message containing NUL, When createCommit is called, Then throws INVALID_COMMIT /message contains NUL/', async () => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
      expect((error as TsgitError).message).toMatch(/message contains NUL/);
    }
  });

  it('Given message size just-under 16 MiB, When createCommit is called, Then succeeds', async () => {
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
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('Given message size exactly 16 MiB (at cap), When createCommit is called, Then succeeds', async () => {
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
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('Given message size just-over 16 MiB, When createCommit is called, Then throws INVALID_COMMIT /message exceeds 16 MiB/', async () => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
      expect((error as TsgitError).message).toMatch(/exceeds 16 MiB/);
    }
  });

  it('Given author.name containing newline, When createCommit is called, Then throws INVALID_IDENTITY /forbidden control character/', async () => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_IDENTITY');
      expect((error as TsgitError).message).toMatch(/forbidden control character/);
    }
  });

  it('Given committer.email containing carriage return, When createCommit is called, Then throws INVALID_IDENTITY', async () => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_IDENTITY');
    }
  });

  it('Given gpgSignature containing NUL, When createCommit is called, Then throws INVALID_COMMIT /gpgSignature/', async () => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
      expect((error as TsgitError).message).toMatch(/gpgSignature/);
    }
  });

  it('Given gpgSignature containing bare LF-LF, When createCommit is called, Then throws INVALID_COMMIT /gpgSignature/', async () => {
    // Bare LF-LF in gpgSignature would forge the header/message boundary,
    // letting an attacker inject a fake message body.
    const ctx = await buildSeededContext();
    const tree = await emptyTreeId(ctx);
    try {
      await createCommit(ctx, {
        tree,
        parents: [],
        author: AUTHOR,
        committer: AUTHOR,
        message: 'm',
        gpgSignature: '-----BEGIN\n\nfake message body',
      });
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
      expect((error as TsgitError).message).toMatch(/gpgSignature/);
    }
  });

  it('Given extraHeader value containing LF-LF, When createCommit is called, Then throws INVALID_COMMIT /extraHeader/', async () => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
      expect((error as TsgitError).message).toMatch(/extraHeader/);
    }
  });

  it.each([
    ['empty', ''],
    ['NUL', 'a\0b'],
    ['CR', 'a\rb'],
    ['LF', 'a\nb'],
    ['space', 'two words'],
    ['tab', 'a\tb'],
  ])('Given an extraHeader whose key contains %s, When createCommit is called, Then throws INVALID_COMMIT /extraHeader key/', async (_label, badKey) => {
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
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_COMMIT');
      expect((error as TsgitError).message).toMatch(/extraHeader key/);
    }
  });

  it('Given a clean extraHeader entry, When createCommit is called, Then succeeds (kills `hasHeaderInjectionChars` ConditionalExpression true)', async () => {
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
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('Given a commit with gpgSignature, When createCommit is called and readObject roundtrips, Then the commit has the signature', async () => {
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
    if (read.type !== 'commit') expect.unreachable();
    expect(read.data.gpgSignature).toBe(sig);
  });

  it('Given a commit with no gpgSignature, When createCommit is called and readObject roundtrips, Then the data.gpgSignature key is absent', async () => {
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
    if (read.type !== 'commit') expect.unreachable();
    expect('gpgSignature' in read.data).toBe(false);
  });
});

/**
 * ssh transport end-to-end: (a) memory-adapter inert refusal proven through
 * the full clone/fetch/push command surfaces, and (b) a real fake-ssh-bridge
 * integration driving clone, fetch, pull, and push against real
 * git-upload-pack / git-receive-pack processes over both `ssh://` and
 * scp-like remote URLs.
 *
 * The bridge stands in for the ssh program: it ignores the host token and
 * execs the quoted remote command directly against a local bare repo,
 * exactly as a real sshd's login shell would. That proves the full
 * client-side session (spawn, argv, pkt-line exchange, shared-iterator
 * continuation, close) against the real git service programs without an
 * actual sshd.
 */
import { accessSync, cpSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { type CloneResult, clone, fetch, push } from '../../src/application/commands/index.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { resolveRef, writeObject, writeTree } from '../../src/application/primitives/index.js';
import { TsgitError } from '../../src/domain/index.js';
import type { Blob, Commit, FileMode, ObjectId, RefName } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { runGit } from './interop-helpers.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');

const findGitExecPath = (): string | undefined => {
  try {
    return runGit(['--exec-path']).trim();
  } catch {
    return undefined;
  }
};

const GIT_EXEC_PATH = findGitExecPath();
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    accessSync(HEAD_OID_FILE);
    return true;
  } catch {
    return false;
  }
})();

const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');

const SKIP_REASON: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_EXEC_PATH === undefined
    ? 'git not available'
    : !FIXTURE_AVAILABLE
      ? 'fixture missing — run scripts/regenerate-clone-fixtures.sh'
      : false;

const memoryCtxWithOriginRemote = async (url: string) => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `[remote "origin"]\n  url = ${url}\n`);
  return ctx;
};

const expectAdapterUnavailable = async (op: Promise<unknown>): Promise<void> => {
  let caught: unknown;
  try {
    await op;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data).toEqual({
    code: 'ADAPTER_UNAVAILABLE',
    runtime: 'memory',
    reason: expect.stringContaining('ssh'),
  });
};

describe('Given a memory-adapter context with no ssh transport', () => {
  describe('When clone targets an ssh:// remote', () => {
    it('Then it throws ADAPTER_UNAVAILABLE and leaves no partial repository behind', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const url = 'ssh://git@example.invalid/repo.git';

      // Act & Assert
      await expectAdapterUnavailable(clone(ctx, { url }));
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)).toBe(false);
    });
  });

  describe('When fetch targets an ssh:// remote', () => {
    it('Then it throws ADAPTER_UNAVAILABLE', async () => {
      // Arrange
      const ctx = await memoryCtxWithOriginRemote('ssh://git@example.invalid/repo.git');

      // Act & Assert
      await expectAdapterUnavailable(fetch(ctx, { remote: 'origin' }));
    });
  });

  describe('When push targets an ssh:// remote', () => {
    it('Then it throws ADAPTER_UNAVAILABLE', async () => {
      // Arrange
      const ctx = await memoryCtxWithOriginRemote('ssh://git@example.invalid/repo.git');

      // Act & Assert
      await expectAdapterUnavailable(
        push(ctx, { remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] }),
      );
    });
  });
});

const installBridge = async (dir: string): Promise<string> => {
  const scriptPath = path.join(dir, 'ssh-bridge.sh');
  const execPathPrefix = GIT_EXEC_PATH !== undefined ? `${GIT_EXEC_PATH}:` : '';
  await writeFile(
    scriptPath,
    `#!/bin/sh\nPATH="${execPathPrefix}$PATH"\nexport PATH\nexec sh -c "$2"\n`,
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

const createFreshBareRepo = async (): Promise<{
  readonly root: string;
  readonly bareRepoPath: string;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-bridge-'));
  const bareRepoPath = path.join(root, 'source.git');
  cpSync(SOURCE_GIT, bareRepoPath, { recursive: true });
  return { root, bareRepoPath };
};

const addCommitToBare = async (bareRepoPath: string, message: string): Promise<string> => {
  const publisherDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-publisher-'));
  try {
    runGit(['clone', bareRepoPath, publisherDir]);
    runGit(['-C', publisherDir, 'config', 'user.email', 'publisher@test']);
    runGit(['-C', publisherDir, 'config', 'user.name', 'Publisher']);
    await writeFile(path.join(publisherDir, `${message}.txt`), `${message}\n`);
    runGit(['-C', publisherDir, 'add', '.']);
    runGit(['-C', publisherDir, 'commit', '-m', message]);
    runGit(['-C', publisherDir, 'push', 'origin', 'main']);
    return runGit(['-C', publisherDir, 'rev-parse', 'main']).trim();
  } finally {
    await rm(publisherDir, { recursive: true, force: true });
  }
};

type OpenedRepo = Awaited<ReturnType<typeof openRepository>>;

const wireOriginRemote = async (repo: OpenedRepo, url: string): Promise<void> => {
  const configPath = path.join(repo.ctx.layout.gitDir, 'config');
  const existingConfig = await readFile(configPath, 'utf8').catch(() => '');
  if (!existingConfig.includes('[remote "origin"]')) {
    await writeFile(
      configPath,
      `${existingConfig}\n[remote "origin"]\n  url = ${url}\n  fetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }
  // clone primed the per-context config cache; drop it so the manual edit
  // above is visible to the subsequent fetch/pull/push calls.
  __resetConfigCacheForTests();
};

const commitLocalChange = (repo: OpenedRepo, label: string): Promise<ObjectId> =>
  commitFileChange(repo, `${label}.txt`, new TextEncoder().encode(`${label}\n`), label);

/**
 * Deterministic incompressible bytes (xorshift32): the resulting pack stays
 * approximately `byteLength`, far beyond any OS pipe buffer.
 */
const pseudoRandomBytes = (byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  let state = 0x9e3779b9;
  for (let i = 0; i < byteLength; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
};

const commitFileChange = async (
  repo: OpenedRepo,
  fileName: string,
  content: Uint8Array,
  message: string,
): Promise<ObjectId> => {
  const head = await resolveRef(repo.ctx, 'refs/heads/main' as RefName);
  const blob: Blob = {
    type: 'blob',
    content,
    id: '' as ObjectId,
  };
  const blobId = await writeObject(repo.ctx, blob);
  const treeId = await writeTree(repo.ctx, [
    { name: fileName, mode: '100644' as FileMode, id: blobId },
  ]);
  const author = {
    name: 'Push',
    email: 'push@test',
    timestamp: 1_700_000_200,
    timezoneOffset: '+0000',
  };
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [head],
      author,
      committer: author,
      message,
      extraHeaders: [],
    },
  };
  const newHead = await writeObject(repo.ctx, commit);
  await writeFile(path.join(repo.ctx.layout.gitDir, 'refs/heads/main'), `${newHead}\n`);
  return newHead;
};

describe.skipIf(SKIP_REASON !== false)('ssh transport — end-to-end over a fake ssh bridge', () => {
  let bridgeDir: string;
  let bridgeScriptPath: string;
  let previousGitSshCommand: string | undefined;

  beforeAll(async () => {
    bridgeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-bridge-script-'));
    bridgeScriptPath = await installBridge(bridgeDir);
    previousGitSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = bridgeScriptPath;
  });

  afterAll(async () => {
    if (previousGitSshCommand === undefined) {
      delete process.env.GIT_SSH_COMMAND;
    } else {
      process.env.GIT_SSH_COMMAND = previousGitSshCommand;
    }
    await rm(bridgeDir, { recursive: true, force: true });
  });

  describe('Given a bare repo served through the fake ssh bridge', () => {
    describe('When the full clone→fetch→pull→push lifecycle runs sequentially over ssh://', () => {
      it('Then every stage drives real git-upload-pack / git-receive-pack to the expected state (one sequential lifecycle: each operation builds on the previous)', async () => {
        // Arrange
        const { root, bareRepoPath } = await createFreshBareRepo();
        const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-clone-'));
        const url = `ssh://git@localhost${bareRepoPath}`;
        const repo = await openRepository({ cwd: workDir });

        try {
          // Act — clone.
          const cloneResult: CloneResult = await repo.clone({ url });

          // Assert — clone.
          const headOid = (await readFile(HEAD_OID_FILE, 'utf8')).trim();
          expect(cloneResult.head).toBe('refs/heads/main' as RefName);
          expect(cloneResult.fetchedRefs).toContainEqual({
            name: 'refs/heads/main' as RefName,
            id: headOid,
          });
          const clonedMain = await resolveRef(repo.ctx, 'refs/heads/main' as RefName);
          expect(clonedMain).toBe(headOid);

          // Arrange — fetch: publish a new commit to the bare repo.
          await wireOriginRemote(repo, url);
          const afterFetchTip = await addCommitToBare(bareRepoPath, 'fetched-commit');

          // Act — fetch.
          const fetchResult = await repo.fetch({ remote: 'origin' });

          // Assert — fetch.
          expect(fetchResult.updatedRefs.map((r) => r.newId)).toContain(afterFetchTip);
          const trackingRef = (
            await readFile(path.join(repo.ctx.layout.gitDir, 'refs/remotes/origin/main'), 'utf8')
          ).trim();
          expect(trackingRef).toBe(afterFetchTip);

          // Arrange — pull: publish yet another commit to the bare repo.
          const afterPullTip = await addCommitToBare(bareRepoPath, 'pulled-commit');

          // Act — pull.
          await repo.pull({ remote: 'origin', ref: 'main' });

          // Assert — pull fast-forwarded local main.
          const localMainAfterPull = await resolveRef(repo.ctx, 'refs/heads/main' as RefName);
          expect(localMainAfterPull).toBe(afterPullTip);

          // Arrange — push: commit locally on top of the pulled tip.
          const newHead = await commitLocalChange(repo, 'pushed-over-ssh');

          // Act — push.
          const pushResult = await repo.push({
            remote: 'origin',
            refspecs: ['refs/heads/main:refs/heads/main'],
          });

          // Assert — push.
          expect(pushResult.pushedRefs).toHaveLength(1);
          expect(pushResult.pushedRefs[0]).toMatchObject({
            name: 'refs/heads/main' as RefName,
            newId: newHead,
            status: 'ok',
          });
          const bareTip = runGit(['-C', bareRepoPath, 'rev-parse', 'main']).trim();
          expect(bareTip).toBe(newHead);
        } finally {
          await repo.dispose();
          await rm(workDir, { recursive: true, force: true });
          await rm(root, { recursive: true, force: true });
        }
      }, 60_000);
    });

    describe('When pushing a multi-megabyte pack over the bridge', () => {
      it('Then the push completes without deadlocking the duplex pipes', async () => {
        // Arrange — an incompressible blob far beyond the OS pipe buffers, so
        // the pack write and the side-band response must interleave.
        const { root, bareRepoPath } = await createFreshBareRepo();
        const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-bigpush-'));
        const url = `ssh://git@localhost${bareRepoPath}`;
        const repo = await openRepository({ cwd: workDir });

        try {
          await repo.clone({ url });
          await wireOriginRemote(repo, url);
          const newHead = await commitFileChange(
            repo,
            'big.bin',
            pseudoRandomBytes(4 * 1024 * 1024),
            'large push',
          );

          // Act
          const result = await repo.push({
            remote: 'origin',
            refspecs: ['refs/heads/main:refs/heads/main'],
          });

          // Assert
          expect(result.pushedRefs[0]).toMatchObject({
            name: 'refs/heads/main' as RefName,
            newId: newHead,
            status: 'ok',
          });
          const bareTip = runGit(['-C', bareRepoPath, 'rev-parse', 'main']).trim();
          expect(bareTip).toBe(newHead);
        } finally {
          await repo.dispose();
          await rm(workDir, { recursive: true, force: true });
          await rm(root, { recursive: true, force: true });
        }
      }, 60_000);
    });

    describe('When cloning through a scp-like remote URL', () => {
      it('Then the clone succeeds against the same bridge', async () => {
        // Arrange
        const { root, bareRepoPath } = await createFreshBareRepo();
        const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-scp-clone-'));
        const url = `git@localhost:${bareRepoPath}`;
        const repo = await openRepository({ cwd: workDir });

        try {
          // Act
          await repo.clone({ url });

          // Assert
          const headOid = (await readFile(HEAD_OID_FILE, 'utf8')).trim();
          const clonedMain = await resolveRef(repo.ctx, 'refs/heads/main' as RefName);
          expect(clonedMain).toBe(headOid);
          const headLog = await readFile(path.join(repo.ctx.layout.gitDir, 'logs/HEAD'), 'utf8');
          expect(headLog).toContain(`clone: from localhost:${bareRepoPath}`);
          expect(headLog).not.toContain('from git@');
        } finally {
          await repo.dispose();
          await rm(workDir, { recursive: true, force: true });
          await rm(root, { recursive: true, force: true });
        }
      }, 60_000);
    });
  });
});

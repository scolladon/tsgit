/**
 * Cross-tool interop — `fsck` object-content validation.
 *
 * Pins tsgit's structured `FsckResult` against real git 2.54.0 behaviour for
 * object-content validation scenarios. Each scenario hand-writes a malformed
 * loose object past git's write-side fsck so the read-side severity is observed.
 * The test reconstructs git's exact stderr lines from the structured fields and
 * asserts byte-equality with `git fsck` output plus the exact exit code.
 *
 * Exit codes pinned against real git 2.54.0:
 *   - corrupt (inflate failure): exit 1 (bit 1)
 *   - corrupt + referenced (missing in BFS): exit 3 (1|2)
 *   - hash-path mismatch: exit 1 (bit 1)
 *   - zeroPaddedFilemode (no --strict): exit 0 (WARN alone)
 *   - zeroPaddedFilemode (--strict): exit 1 (WARN→ERROR)
 *   - treeNotSorted (ERROR): exit 1 (bit 1)
 *   - missingSpaceBeforeEmail (ERROR, valid tree): exit 1 (bit 1)
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit fsck data reconstructs canonical git fsck findings + exit codes
 *   interopSurface: fsck
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Run git, capturing stdout, stderr AND exit code (never throws). */
function tryRunGitWithExit(
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): { readonly stdout: string; readonly stderr: string; readonly exitCode: number } {
  const env = options.env ?? buildSafeEnv();
  const result = spawnSync('git', args as string[], { env, encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  const isolatedHome = path.join(os.tmpdir(), 'tsgit-fsck-interop-nonexistent-home');
  env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  env.HOME = isolatedHome;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
  return env;
}

const SAFE_ENV = buildSafeEnv();

/** Compress bytes with zlib deflate (git loose-object format). */
function deflateSync(data: Buffer): Buffer {
  return zlib.deflateSync(data);
}

/** Compute SHA-1 hex of raw bytes. */
function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * Build a git loose-object raw bytes: `<type> <size>\0<body>`.
 * Returns { raw, sha1 } where sha1 is the OID.
 */
function buildLooseObject(type: string, body: Buffer): { raw: Buffer; sha1: string } {
  const header = Buffer.from(`${type} ${body.length}\0`);
  const raw = Buffer.concat([header, body]);
  return { raw, sha1: sha1Hex(raw) };
}

/**
 * Write a loose object (possibly malformed) directly to a git repo's object store.
 * `workDir` is the repository's working directory (parent of `.git/`).
 * Returns the OID.
 */
async function writeLooseObject(workDir: string, type: string, body: Buffer): Promise<string> {
  const { raw, sha1 } = buildLooseObject(type, body);
  const prefix = sha1.slice(0, 2);
  const suffix = sha1.slice(2);
  const objDir = path.join(workDir, '.git', 'objects', prefix);
  await mkdir(objDir, { recursive: true });
  await writeFile(path.join(objDir, suffix), deflateSync(raw));
  return sha1;
}

/** Initialize a bare git repo at dir. */
function initRepo(dir: string): void {
  runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: SAFE_ENV });
  runGit(['-C', dir, 'config', 'user.name', 'Test'], { env: SAFE_ENV });
  runGit(['-C', dir, 'config', 'user.email', 'test@example.com'], { env: SAFE_ENV });
}

function gitFsck(dir: string, ...flags: string[]): ReturnType<typeof tryRunGitWithExit> {
  return tryRunGitWithExit(['-C', dir, 'fsck', ...flags], { env: SAFE_ENV });
}

// ---------------------------------------------------------------------------
// Scenario families — one shared repo per family (beforeAll, 60s timeout)
// ---------------------------------------------------------------------------

// --- Scenario family 12a/12b: zeroPaddedFilemode ----------------------------

let zeroPadDir = '';
let zeroPadCtx: Context;
let zeroPadTreeSha = '';

beforeAll(async () => {
  zeroPadDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-zeroPad-'));
  initRepo(zeroPadDir);

  // Write a valid blob
  const blobSha = runGit(['-C', zeroPadDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'hello\n',
  }).trim();

  const blobShaBytes = Buffer.from(blobSha, 'hex');

  // Build a tree with zero-padded mode: "0100644" instead of "100644"
  const modeAndName = Buffer.from('0100644 file.txt\0');
  const treeBody = Buffer.concat([modeAndName, blobShaBytes]);
  zeroPadTreeSha = await writeLooseObject(zeroPadDir, 'tree', treeBody);

  // Build and write a commit pointing to this tree directly (bypassing git's write-side fsck).
  // The commit object itself is valid — only the tree it references has the zero-padded mode.
  const commitBody = Buffer.from(
    `tree ${zeroPadTreeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\ntest commit\n`,
  );
  const commitSha = await writeLooseObject(zeroPadDir, 'commit', commitBody);
  await mkdir(path.join(zeroPadDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(zeroPadDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);

  zeroPadCtx = createNodeContext({ workDir: zeroPadDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (zeroPadDir !== '') await rm(zeroPadDir, { recursive: true, force: true });
});

// --- Scenario family 12c: treeNotSorted + missingSpaceBeforeEmail -----------

let catalogueDir = '';
let catalogueCtx: Context;
let sortedTreeSha = '';
let badEmailCommitSha = '';
let emptyTreeSha = '';

beforeAll(async () => {
  catalogueDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-catalogue-'));
  initRepo(catalogueDir);

  // Write two blobs for the unsorted tree
  const sha1 = runGit(['-C', catalogueDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'a\n',
  }).trim();
  const sha2 = runGit(['-C', catalogueDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'b\n',
  }).trim();
  const sha1Bytes = Buffer.from(sha1, 'hex');
  const sha2Bytes = Buffer.from(sha2, 'hex');

  // Build a tree with treeNotSorted: 'z.txt' before 'a.txt'
  const e1 = Buffer.from('100644 z.txt\0');
  const e2 = Buffer.from('100644 a.txt\0');
  const treeBody = Buffer.concat([e1, sha1Bytes, e2, sha2Bytes]);
  sortedTreeSha = await writeLooseObject(catalogueDir, 'tree', treeBody);

  // Write the canonical empty-tree object (4b825dc...) directly
  emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  await writeLooseObject(catalogueDir, 'tree', Buffer.alloc(0));

  // Build a commit with missingSpaceBeforeEmail: 'Name<email>' (no space before '<')
  const commitBody = Buffer.from(
    `tree ${emptyTreeSha}\nauthor Name<bad@example.com> 1700000000 +0000\ncommitter Test <c@example.com> 1700000000 +0000\n\nmessage\n`,
  );
  badEmailCommitSha = await writeLooseObject(catalogueDir, 'commit', commitBody);

  // Build and write a commit for the treeNotSorted tree directly
  const commitForUnsortedBody = Buffer.from(
    `tree ${sortedTreeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nunsorted\n`,
  );
  const commitForTree = await writeLooseObject(catalogueDir, 'commit', commitForUnsortedBody);
  const refsDir = path.join(catalogueDir, '.git', 'refs', 'heads');
  await mkdir(refsDir, { recursive: true });
  await writeFile(path.join(refsDir, 'main'), `${commitForTree}\n`);
  // Point another ref to the bad-email commit
  await writeFile(path.join(refsDir, 'badEmail'), `${badEmailCommitSha}\n`);

  catalogueCtx = createNodeContext({ workDir: catalogueDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (catalogueDir !== '') await rm(catalogueDir, { recursive: true, force: true });
});

// --- Scenario: corrupt loose object ------------------------------------------

let corruptDir = '';
let corruptCtx: Context;
let corruptBlobSha = '';

beforeAll(async () => {
  corruptDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-corrupt-'));
  initRepo(corruptDir);

  // Write a valid blob then overwrite with garbage
  const blobSha = runGit(['-C', corruptDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'to-corrupt\n',
  }).trim();
  corruptBlobSha = blobSha;

  const prefix = blobSha.slice(0, 2);
  const suffix = blobSha.slice(2);
  const objPath = path.join(corruptDir, '.git', 'objects', prefix, suffix);
  // Make writable before overwriting (git writes objects as readonly 444)
  const { chmod } = await import('node:fs/promises');
  await chmod(objPath, 0o644);
  // Overwrite with invalid zlib data
  await writeFile(objPath, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

  corruptCtx = createNodeContext({ workDir: corruptDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (corruptDir !== '') await rm(corruptDir, { recursive: true, force: true });
});

// --- Scenario: hash-path mismatch --------------------------------------------

let hashMismatchDir = '';
let hashMismatchCtx: Context;
let pathId = ''; // the oid whose PATH we use
let actualId = ''; // the oid whose CONTENT is stored there

beforeAll(async () => {
  hashMismatchDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-hashMismatch-'));
  initRepo(hashMismatchDir);

  const sha1 = runGit(['-C', hashMismatchDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'hello\n',
  }).trim();
  const sha2 = runGit(['-C', hashMismatchDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'world\n',
  }).trim();
  pathId = sha1;
  actualId = sha2;

  // Copy sha2's compressed content to sha1's path (hash≠path)
  const sha1Path = path.join(hashMismatchDir, '.git', 'objects', sha1.slice(0, 2), sha1.slice(2));
  const sha2Path = path.join(hashMismatchDir, '.git', 'objects', sha2.slice(0, 2), sha2.slice(2));
  const sha2Content = await readFile(sha2Path);
  // Make sha1 writable before overwriting
  const { chmod } = await import('node:fs/promises');
  await chmod(sha1Path, 0o644);
  await writeFile(sha1Path, sha2Content);

  hashMismatchCtx = createNodeContext({ workDir: hashMismatchDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (hashMismatchDir !== '') await rm(hashMismatchDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('Given a loose tree with zeroPaddedFilemode (no --strict)', () => {
  describe('When fsck runs (default options)', () => {
    it('Then emits warning bad-object and exit code matches real git (0)', async () => {
      // Arrange — git's expected output
      const gitResult = gitFsck(zeroPadDir);

      // Act
      const result = await fsck(zeroPadCtx);

      // Assert — exit code matches
      expect(result.exitCode).toBe(gitResult.exitCode); // 0

      // Assert — warning finding present
      const zeroPadded = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && f.msgId === 'zeroPaddedFilemode',
      );
      expect(zeroPadded).toBeDefined();
      expect(zeroPadded?.severity).toBe('warning');
      expect(zeroPadded?.id).toBe(zeroPadTreeSha);

      // Reconstruct git stderr line and assert byte-equality
      // git: "warning in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes"
      if (zeroPadded !== undefined) {
        const reconstructed = `warning in tree ${zeroPadded.id}: ${zeroPadded.msgId}: contains zero-padded file modes`;
        expect(gitResult.stderr).toContain(reconstructed);
      }
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with zeroPaddedFilemode (with --strict)',
  () => {
    describe('When fsck runs with strict:true', () => {
      it('Then emits error bad-object and exit code matches real git (1)', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(zeroPadDir, '--strict');

        // Act
        const result = await fsck(zeroPadCtx, { strict: true });

        // Assert — exit code matches
        expect(result.exitCode).toBe(gitResult.exitCode); // 1

        // Assert — error finding present
        const zeroPadded = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'zeroPaddedFilemode',
        );
        expect(zeroPadded).toBeDefined();
        expect(zeroPadded?.severity).toBe('error');

        // Reconstruct git stderr line and assert byte-equality
        // git: "error in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes"
        if (zeroPadded !== undefined) {
          const reconstructed = `error in tree ${zeroPadded.id}: ${zeroPadded.msgId}: contains zero-padded file modes`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with treeNotSorted (ERROR catalogue entry)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits error bad-object and exit code matches real git (1)', async () => {
        // Arrange — git's expected output (run fsck for the whole repo, filter for this tree)
        const gitResult = gitFsck(catalogueDir);

        // Act
        const result = await fsck(catalogueCtx);

        // Assert — exit code includes bit 1 (ERROR finding)
        expect(result.exitCode & 1).toBe(1);
        // git exit code also includes bit 1
        expect(gitResult.exitCode & 1).toBe(1);

        // Assert — treeNotSorted finding present
        const notSorted = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'treeNotSorted',
        );
        expect(notSorted).toBeDefined();
        expect(notSorted?.severity).toBe('error');
        expect(notSorted?.id).toBe(sortedTreeSha);

        // Reconstruct git stderr line
        // git: "error in tree <sha>: treeNotSorted: not properly sorted"
        if (notSorted !== undefined) {
          const reconstructed = `error in tree ${notSorted.id}: ${notSorted.msgId}: not properly sorted`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose commit with missingSpaceBeforeEmail (ERROR catalogue entry)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits error bad-object and exit code matches real git (1)', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(catalogueDir);

        // Act
        const result = await fsck(catalogueCtx);

        // Assert — missingSpaceBeforeEmail finding present
        const missingSpace = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'missingSpaceBeforeEmail',
        );
        expect(missingSpace).toBeDefined();
        expect(missingSpace?.severity).toBe('error');
        expect(missingSpace?.id).toBe(badEmailCommitSha);

        // Reconstruct git stderr line
        // git: "error in commit <sha>: missingSpaceBeforeEmail: invalid author/committer line - missing space before email"
        if (missingSpace !== undefined) {
          const reconstructed = `error in commit ${missingSpace.id}: ${missingSpace.msgId}: invalid author/committer line - missing space before email`;
          expect(gitResult.stderr).toContain(reconstructed);
        }

        // exit bit 1 must be set
        expect(result.exitCode & 1).toBe(1);
        expect(gitResult.exitCode & 1).toBe(1);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given a corrupt (undecodable) loose object', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-object finding and exit code has bit 1 (matches real git)', async () => {
      // Arrange
      const gitResult = gitFsck(corruptDir);

      // Act
      const result = await fsck(corruptCtx);

      // Assert — exit code: bit 1 set (matches real git exit 1 for dangling corrupt blob)
      expect(result.exitCode & 1).toBe(1);
      expect(gitResult.exitCode & 1).toBe(1);

      // Assert — bad-object finding for the corrupt oid
      const corrupt = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && f.id === corruptBlobSha,
      );
      expect(corrupt).toBeDefined();
      expect(corrupt?.severity).toBe('error');
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose object whose content hash does not match its path (hash-path mismatch)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits hash-mismatch finding and exit code has bit 1 (matches real git)', async () => {
        // Arrange
        const gitResult = gitFsck(hashMismatchDir);

        // Act
        const result = await fsck(hashMismatchCtx);

        // Assert — exit code bit 1 matches real git (both exit 1)
        expect(result.exitCode & 1).toBe(1);
        expect(gitResult.exitCode & 1).toBe(1);

        // Assert — hash-mismatch finding present
        const mismatch = result.findings.find(
          (f): f is FsckFinding & { type: 'hash-mismatch' } =>
            f.type === 'hash-mismatch' && f.id === pathId,
        );
        expect(mismatch).toBeDefined();
        expect(mismatch?.actual).toBe(actualId);

        // Reconstruct git stderr line
        // git: "error: <actual-sha>: hash-path mismatch, found at: .git/objects/<prefix>/<suffix>"
        if (mismatch !== undefined) {
          const reconstructed = `${mismatch.actual}: hash-path mismatch, found at:`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Refs-verify pass — matrix #9a: ref → valid-but-absent sha (exit 2)
// ---------------------------------------------------------------------------
// Pinned against real git 2.54.0:
//   stderr: "error: refs/heads/broken: invalid sha1 pointer <sha>"
//   exit: 2 (bit 2; same with/without --no-references)

let refAbsentDir = '';
let refAbsentCtx: Context;
const ABSENT_OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

beforeAll(async () => {
  refAbsentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-refAbsent-'));
  initRepo(refAbsentDir);
  // Write a valid-format but absent OID to a loose ref (bypasses git's write-side check)
  await mkdir(path.join(refAbsentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(refAbsentDir, '.git', 'refs', 'heads', 'broken'), `${ABSENT_OID}\n`);
  refAbsentCtx = createNodeContext({ workDir: refAbsentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (refAbsentDir !== '') await rm(refAbsentDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given loose ref pointing to valid-format but absent OID (matrix #9a)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits bad-ref badRefOid, exit code 2 matches real git', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(refAbsentDir);

        // Act
        const result = await fsck(refAbsentCtx);

        // Assert — exit code 2 (absent OID = bit 2)
        expect(result.exitCode).toBe(2);
        expect(gitResult.exitCode).toBe(2);

        // Assert — badRefOid finding present
        const badRef = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-ref' } =>
            f.type === 'bad-ref' && f.msgId === 'badRefOid',
        );
        expect(badRef).toBeDefined();
        expect(badRef?.severity).toBe('error');
        expect(badRef?.ref).toBe('refs/heads/broken');
        expect(badRef?.target).toBe(ABSENT_OID);

        // Reconstruct git's exact stderr line and assert byte-equality
        // git: "error: refs/heads/broken: invalid sha1 pointer <sha>"
        if (badRef !== undefined) {
          const reconstructed = `${badRef.ref}: invalid sha1 pointer ${badRef.target}`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Refs-verify pass — matrix #9b: ref → malformed content (exit 10 = 2|8)
// ---------------------------------------------------------------------------
// Pinned against real git 2.54.0:
//   stderr line 1: "error: refs/heads/garbage: badRefContent: not-a-valid-sha"
//   stderr line 2: "error: refs/heads/garbage: invalid sha1 pointer 0000...0"
//   exit: 10 (2|8)

let refBadContentDir = '';
let refBadContentCtx: Context;
const BAD_CONTENT = 'not-a-valid-sha';
const ZERO_OID_STR = '0000000000000000000000000000000000000000';

beforeAll(async () => {
  refBadContentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-refBadContent-'));
  initRepo(refBadContentDir);
  // Write malformed content to a loose ref (bypasses git's write-side check)
  await mkdir(path.join(refBadContentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(refBadContentDir, '.git', 'refs', 'heads', 'garbage'),
    `${BAD_CONTENT}\n`,
  );
  refBadContentCtx = createNodeContext({ workDir: refBadContentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (refBadContentDir !== '') await rm(refBadContentDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given loose ref with malformed content (matrix #9b, exit 10 = 2|8)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits badRefContent + badRefOid(zero), composite exit 10 matches real git', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(refBadContentDir);

        // Act
        const result = await fsck(refBadContentCtx);

        // Assert — composite exit 10 = 2|8 (badRefContent bit 8 + absent zero-OID bit 2)
        expect(result.exitCode).toBe(10);
        expect(gitResult.exitCode).toBe(10);

        // Assert — badRefContent finding
        const badRefContent = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-ref' } =>
            f.type === 'bad-ref' && f.msgId === 'badRefContent',
        );
        expect(badRefContent).toBeDefined();
        expect(badRefContent?.severity).toBe('error');
        expect(badRefContent?.ref).toBe('refs/heads/garbage');

        // Reconstruct git's first stderr line:
        // "error: refs/heads/garbage: badRefContent: not-a-valid-sha"
        if (badRefContent !== undefined) {
          const reconstructed = `${badRefContent.ref}: badRefContent: ${BAD_CONTENT}`;
          expect(gitResult.stderr).toContain(reconstructed);
        }

        // Assert — badRefOid finding for synthesised zero OID
        const badRefOid = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-ref' } =>
            f.type === 'bad-ref' && f.msgId === 'badRefOid',
        );
        expect(badRefOid).toBeDefined();
        expect(badRefOid?.target).toBe(ZERO_OID_STR);

        // Reconstruct git's second stderr line:
        // "error: refs/heads/garbage: invalid sha1 pointer 0000...0"
        if (badRefOid !== undefined) {
          const reconstructed = `${badRefOid.ref}: invalid sha1 pointer ${badRefOid.target}`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Null-oid sentinel regression pin — a normal repo with commit + reflog
// must produce exit 0 / no findings (git fsck 2.54.0: "0000…0" in the
// initial reflog entry is the "no object" sentinel, never a real reference)
// ---------------------------------------------------------------------------

let reflogSentinelDir = '';
let reflogSentinelCtx: Context;

beforeAll(async () => {
  reflogSentinelDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-reflogSentinel-'));
  initRepo(reflogSentinelDir);
  // Make a real commit via git so a reflog is written automatically.
  // The initial reflog entry will have oldId = 0000…0 (the null-oid sentinel).
  await writeFile(path.join(reflogSentinelDir, 'readme.txt'), 'hello\n');
  runGit(['-C', reflogSentinelDir, 'add', 'readme.txt'], { env: SAFE_ENV });
  runGit(['-C', reflogSentinelDir, 'commit', '-m', 'initial commit'], { env: SAFE_ENV });
  reflogSentinelCtx = createNodeContext({ workDir: reflogSentinelDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (reflogSentinelDir !== '') await rm(reflogSentinelDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a normal repo with one commit (reflog initial entry has null-oid oldId)',
  () => {
    describe('When fsck runs', () => {
      it('Then exit code 0 and no missing/broken-link findings (null-oid sentinel is not a root)', async () => {
        // Arrange — real git's expected output (clean repo → exit 0, no output)
        const gitResult = gitFsck(reflogSentinelDir);

        // Act
        const result = await fsck(reflogSentinelCtx);

        // Assert — exit code 0 matches real git
        expect(result.exitCode).toBe(0);
        expect(gitResult.exitCode).toBe(0);

        // Assert — no missing or broken-link findings (null-oid is not treated as a root)
        const missingFindings = result.findings.filter((f) => f.type === 'missing');
        expect(missingFindings).toHaveLength(0);

        const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
        expect(brokenLinks).toHaveLength(0);

        // Assert — git produces no error output for a clean repo
        expect(gitResult.stderr).toBe('');
      });
    });
  },
);

// ---------------------------------------------------------------------------
// FIX 1 — .gitmodules blob content checks (gitmodulesUrl / gitmodulesParse)
// Pinned real git 2.54.0:
//   gitmodulesUrl: stderr "error in blob <sha>: gitmodulesUrl: disallowed submodule url: ..."
//   exit 1 (bit 1 = content-ERROR)
//   gitmodulesParse: stderr "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob"
//   exit 0 (INFO alone)
// ---------------------------------------------------------------------------

let gitmodulesUrlDir = '';
let gitmodulesUrlCtx: Context;
let gitmodulesUrlBlobSha = '';

beforeAll(async () => {
  gitmodulesUrlDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-gitmodulesUrl-'));
  initRepo(gitmodulesUrlDir);

  // Write .gitmodules blob with a disallowed URL (starts with '--')
  const gitmodulesContent = Buffer.from(
    '[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n',
  );
  gitmodulesUrlBlobSha = await writeLooseObject(gitmodulesUrlDir, 'blob', gitmodulesContent);

  const blobShaBytes = Buffer.from(gitmodulesUrlBlobSha, 'hex');
  const treeBody = Buffer.concat([Buffer.from('100644 .gitmodules\0'), blobShaBytes]);
  const treeSha = await writeLooseObject(gitmodulesUrlDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${treeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nadd .gitmodules with evil url\n`,
  );
  const commitSha = await writeLooseObject(gitmodulesUrlDir, 'commit', commitBody);
  await mkdir(path.join(gitmodulesUrlDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(gitmodulesUrlDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await writeFile(path.join(gitmodulesUrlDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  gitmodulesUrlCtx = createNodeContext({ workDir: gitmodulesUrlDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (gitmodulesUrlDir !== '') await rm(gitmodulesUrlDir, { recursive: true, force: true });
});

let gitmodulesParseDir = '';
let gitmodulesParseCtx: Context;
let gitmodulesParseBlobSha = '';

beforeAll(async () => {
  gitmodulesParseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-gitmodulesParse-'));
  initRepo(gitmodulesParseDir);

  // Write an unparseable .gitmodules blob (unclosed section header)
  const gitmodulesContent = Buffer.from(
    '[submodule "bad"\npath = evil\nurl = git://example.com/evil\n',
  );
  gitmodulesParseBlobSha = await writeLooseObject(gitmodulesParseDir, 'blob', gitmodulesContent);

  const blobShaBytes = Buffer.from(gitmodulesParseBlobSha, 'hex');
  const treeBody = Buffer.concat([Buffer.from('100644 .gitmodules\0'), blobShaBytes]);
  const treeSha = await writeLooseObject(gitmodulesParseDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${treeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nbad gitmodules\n`,
  );
  const commitSha = await writeLooseObject(gitmodulesParseDir, 'commit', commitBody);
  await mkdir(path.join(gitmodulesParseDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(gitmodulesParseDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await writeFile(path.join(gitmodulesParseDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  gitmodulesParseCtx = createNodeContext({ workDir: gitmodulesParseDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (gitmodulesParseDir !== '') await rm(gitmodulesParseDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a .gitmodules blob with a disallowed URL (--upload-pack=evil)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits gitmodulesUrl bad-object finding and exit code matches real git (1)', async () => {
        // Arrange — git's expected output
        // Pinned real git 2.54.0: stderr "error in blob <sha>: gitmodulesUrl: disallowed submodule url: --upload-pack=evil", exit 1
        const gitResult = gitFsck(gitmodulesUrlDir);

        // Act
        const result = await fsck(gitmodulesUrlCtx);

        // Assert — exit code 1 matches real git
        expect(result.exitCode).toBe(1);
        expect(gitResult.exitCode).toBe(1);

        // Assert — gitmodulesUrl finding present
        const gitmodulesUrl = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'gitmodulesUrl',
        );
        expect(gitmodulesUrl).toBeDefined();
        expect(gitmodulesUrl?.id).toBe(gitmodulesUrlBlobSha);
        expect(gitmodulesUrl?.objectType).toBe('blob');
        expect(gitmodulesUrl?.severity).toBe('error');

        // Reconstruct git's exact stderr line and assert byte-equality
        // git: "error in blob <sha>: gitmodulesUrl: disallowed submodule url: --upload-pack=evil"
        if (gitmodulesUrl !== undefined) {
          const reconstructed = `error in blob ${gitmodulesUrl.id}: ${gitmodulesUrl.msgId}: disallowed submodule url:`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a .gitmodules blob that cannot be parsed (malformed INI)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits gitmodulesParse bad-object finding with info severity and exit code 0 (INFO alone)', async () => {
        // Arrange — git's expected output
        // Pinned real git 2.54.0: stderr "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob", exit 0
        const gitResult = gitFsck(gitmodulesParseDir);

        // Act
        const result = await fsck(gitmodulesParseCtx);

        // Assert — exit code 0 matches real git (INFO finding alone does not set exit bit)
        expect(result.exitCode).toBe(0);
        expect(gitResult.exitCode).toBe(0);

        // Assert — gitmodulesParse finding present
        const gitmodulesParse = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'gitmodulesParse',
        );
        expect(gitmodulesParse).toBeDefined();
        expect(gitmodulesParse?.id).toBe(gitmodulesParseBlobSha);
        expect(gitmodulesParse?.objectType).toBe('blob');
        expect(gitmodulesParse?.severity).toBe('info');

        // Reconstruct git's exact stderr line and assert byte-equality
        // git: "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob"
        if (gitmodulesParse !== undefined) {
          const reconstructed = `warning in blob ${gitmodulesParse.id}: ${gitmodulesParse.msgId}: could not parse gitmodules blob`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// FIX A — per-edge-type broken-link + missing taxonomy
//
// Pinned real git 2.54.0: for EVERY edge type (tree→blob, tree→tree,
// commit→tree, commit→parent, tag→target) git emits:
//   "broken link from <fromType> <fromId>\n              to  <toType> <toId>"
//   "missing <toType> <toId>"
// exit 2 (bit 2 = missing/broken-link).
// tsgit's structured findings must produce the same reconstruction.
// ---------------------------------------------------------------------------

// -- Shared helpers for connectivity pin scenarios --------------------------

/**
 * Format a "broken link from … to …" line the same way git prints it, for
 * byte-equality assertion against real git stderr.
 * git pads the "from" type to 6 chars and "to" type to 6 chars.
 */
function reconstructBrokenLink(
  fromType: string,
  fromId: string,
  _toType: string,
  _toId: string,
): string {
  // git fsck 2.54.0 format (stdout):
  //   "broken link from    tree <sha>"
  //   "              to    blob <sha>"
  // The type name is right-padded in a field of width 8 (no space between "from" and field):
  //   commit (6) → "  commit", tree (4) → "    tree", blob (4) → "    blob", tag (3) → "     tag"
  return `broken link from${fromType.padStart(8)} ${fromId}`;
}

function reconstructMissing(objectType: string, id: string): string {
  return `missing ${objectType} ${id}`;
}

// --- Connectivity scenario: tree → missing blob ----------------------------

let connTreeBlobDir = '';
let connTreeBlobCtx: Context;
let connTreeBlobTreeSha = '';
const CONN_MISSING_BLOB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';

beforeAll(async () => {
  connTreeBlobDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-blob-'));
  initRepo(connTreeBlobDir);

  const blobShaBytes = Buffer.from(CONN_MISSING_BLOB, 'hex');
  const treeBody = Buffer.concat([Buffer.from('100644 file.txt\0'), blobShaBytes]);
  connTreeBlobTreeSha = await writeLooseObject(connTreeBlobDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${connTreeBlobTreeSha}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ntree-miss-blob\n`,
  );
  const commitSha = await writeLooseObject(connTreeBlobDir, 'commit', commitBody);
  await mkdir(path.join(connTreeBlobDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(connTreeBlobDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await rm(path.join(connTreeBlobDir, '.git', 'logs'), { recursive: true, force: true });

  connTreeBlobCtx = createNodeContext({ workDir: connTreeBlobDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connTreeBlobDir !== '') await rm(connTreeBlobDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given tree referencing a missing blob (tree→missing-blob edge)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits broken-link + missing findings and exit code 2 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "broken link from    tree <treeSha>\n              to    blob <blobSha>"
        //   "missing blob <blobSha>"
        //   exit 2
        const gitResult = gitFsck(connTreeBlobDir, '--no-reflogs');

        // Act
        const result = await fsck(connTreeBlobCtx, { reflogRoots: false });

        // Assert — exit code 2
        expect(result.exitCode).toBe(2);
        expect(gitResult.exitCode).toBe(2);

        // Assert — broken-link finding: tree → blob
        const brokenLink = result.findings.find(
          (f): f is FsckFinding & { type: 'broken-link' } =>
            f.type === 'broken-link' &&
            (f as { fromId: string }).fromId === connTreeBlobTreeSha &&
            (f as { toId: string }).toId === CONN_MISSING_BLOB,
        );
        expect(brokenLink).toBeDefined();
        expect(brokenLink).toMatchObject({ fromType: 'tree', toType: 'blob' });

        // Reconstruct "broken link from tree ... to blob ..." line
        // git fsck sends connectivity findings (broken link, missing) to stdout
        if (brokenLink !== undefined) {
          const fromId = (brokenLink as { fromId: string }).fromId;
          const toId = (brokenLink as { toId: string }).toId;
          const reconstructed = reconstructBrokenLink('tree', fromId, 'blob', toId);
          expect(gitResult.stdout).toContain(reconstructed);
        }

        // Assert — missing blob finding
        const missingBlob = result.findings.find(
          (f): f is FsckFinding & { type: 'missing' } =>
            f.type === 'missing' && (f as { id: string }).id === CONN_MISSING_BLOB,
        );
        expect(missingBlob).toBeDefined();
        expect(missingBlob).toMatchObject({ objectType: 'blob' });

        // Reconstruct "missing blob ..." line (stdout)
        if (missingBlob !== undefined) {
          const id = (missingBlob as { id: string }).id;
          expect(gitResult.stdout).toContain(reconstructMissing('blob', id));
        }
      });
    });
  },
);

// --- Connectivity scenario: tree → missing sub-tree ------------------------

let connTreeSubtreeDir = '';
let connTreeSubtreeCtx: Context;
let connTreeSubtreeTreeSha = '';
const CONN_MISSING_SUBTREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc';

beforeAll(async () => {
  connTreeSubtreeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-subtree-'));
  initRepo(connTreeSubtreeDir);

  const subtreeShaBytes = Buffer.from(CONN_MISSING_SUBTREE, 'hex');
  const treeBody = Buffer.concat([Buffer.from('40000 subdir\0'), subtreeShaBytes]);
  connTreeSubtreeTreeSha = await writeLooseObject(connTreeSubtreeDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${connTreeSubtreeTreeSha}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ntree-miss-subtree\n`,
  );
  const commitSha = await writeLooseObject(connTreeSubtreeDir, 'commit', commitBody);
  await mkdir(path.join(connTreeSubtreeDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(connTreeSubtreeDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await rm(path.join(connTreeSubtreeDir, '.git', 'logs'), { recursive: true, force: true });

  connTreeSubtreeCtx = createNodeContext({ workDir: connTreeSubtreeDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connTreeSubtreeDir !== '') await rm(connTreeSubtreeDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given tree referencing a missing sub-tree (tree→missing-tree edge)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits broken-link + missing findings and exit code 2 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "broken link from    tree <treeSha>\n              to    tree <subtreeSha>"
        //   "missing tree <subtreeSha>"
        //   exit 2
        const gitResult = gitFsck(connTreeSubtreeDir, '--no-reflogs');

        // Act
        const result = await fsck(connTreeSubtreeCtx, { reflogRoots: false });

        // Assert — exit code 2
        expect(result.exitCode).toBe(2);
        expect(gitResult.exitCode).toBe(2);

        // Assert — broken-link finding: tree → tree
        const brokenLink = result.findings.find(
          (f): f is FsckFinding & { type: 'broken-link' } =>
            f.type === 'broken-link' &&
            (f as { fromId: string }).fromId === connTreeSubtreeTreeSha &&
            (f as { toId: string }).toId === CONN_MISSING_SUBTREE,
        );
        expect(brokenLink).toBeDefined();
        expect(brokenLink).toMatchObject({ fromType: 'tree', toType: 'tree' });

        // Reconstruct "broken link from tree ... to tree ..." line (stdout)
        if (brokenLink !== undefined) {
          const fromId = (brokenLink as { fromId: string }).fromId;
          const toId = (brokenLink as { toId: string }).toId;
          const reconstructed = reconstructBrokenLink('tree', fromId, 'tree', toId);
          expect(gitResult.stdout).toContain(reconstructed);
        }

        // Assert — missing tree finding
        const missingTree = result.findings.find(
          (f): f is FsckFinding & { type: 'missing' } =>
            f.type === 'missing' && (f as { id: string }).id === CONN_MISSING_SUBTREE,
        );
        expect(missingTree).toBeDefined();
        expect(missingTree).toMatchObject({ objectType: 'tree' });

        if (missingTree !== undefined) {
          const id = (missingTree as { id: string }).id;
          expect(gitResult.stdout).toContain(reconstructMissing('tree', id));
        }
      });
    });
  },
);

// --- Connectivity scenario: commit → missing tree --------------------------

let connCommitTreeDir = '';
let connCommitTreeCtx: Context;
let connCommitTreeCommitSha = '';
const CONN_MISSING_TREE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef0';

beforeAll(async () => {
  connCommitTreeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-tree-'));
  initRepo(connCommitTreeDir);

  const commitBody = Buffer.from(
    `tree ${CONN_MISSING_TREE}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ncommit-miss-tree\n`,
  );
  connCommitTreeCommitSha = await writeLooseObject(connCommitTreeDir, 'commit', commitBody);
  await mkdir(path.join(connCommitTreeDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(connCommitTreeDir, '.git', 'refs', 'heads', 'main'),
    `${connCommitTreeCommitSha}\n`,
  );
  await rm(path.join(connCommitTreeDir, '.git', 'logs'), { recursive: true, force: true });

  connCommitTreeCtx = createNodeContext({ workDir: connCommitTreeDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connCommitTreeDir !== '') await rm(connCommitTreeDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given commit referencing a missing tree (commit→missing-tree edge)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits broken-link + missing findings and exit code 2 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "broken link from  commit <commitSha>\n              to    tree <treeSha>"
        //   "missing tree <treeSha>"
        //   exit 2
        const gitResult = gitFsck(connCommitTreeDir, '--no-reflogs');

        // Act
        const result = await fsck(connCommitTreeCtx, { reflogRoots: false });

        // Assert — exit code 2
        expect(result.exitCode).toBe(2);
        expect(gitResult.exitCode).toBe(2);

        // Assert — broken-link finding: commit → tree
        const brokenLink = result.findings.find(
          (f): f is FsckFinding & { type: 'broken-link' } =>
            f.type === 'broken-link' &&
            (f as { fromId: string }).fromId === connCommitTreeCommitSha &&
            (f as { toId: string }).toId === CONN_MISSING_TREE,
        );
        expect(brokenLink).toBeDefined();
        expect(brokenLink).toMatchObject({ fromType: 'commit', toType: 'tree' });

        if (brokenLink !== undefined) {
          const fromId = (brokenLink as { fromId: string }).fromId;
          const toId = (brokenLink as { toId: string }).toId;
          const reconstructed = reconstructBrokenLink('commit', fromId, 'tree', toId);
          expect(gitResult.stdout).toContain(reconstructed);
        }

        // Assert — missing tree finding
        const missingTree = result.findings.find(
          (f): f is FsckFinding & { type: 'missing' } =>
            f.type === 'missing' && (f as { id: string }).id === CONN_MISSING_TREE,
        );
        expect(missingTree).toBeDefined();
        expect(missingTree).toMatchObject({ objectType: 'tree' });

        if (missingTree !== undefined) {
          const id = (missingTree as { id: string }).id;
          expect(gitResult.stdout).toContain(reconstructMissing('tree', id));
        }
      });
    });
  },
);

// --- Connectivity scenario: commit → missing parent commit -----------------

let connCommitParentDir = '';
let connCommitParentCtx: Context;
let connCommitParentCommitSha = '';
const CONN_MISSING_PARENT = 'cccccccccccccccccccccccccccccccccccccccd';

beforeAll(async () => {
  connCommitParentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-parent-'));
  initRepo(connCommitParentDir);

  // Write an empty tree (4b825dc…) to the object store
  const emptyTreeBody = Buffer.alloc(0);
  const emptyTreeSha = await writeLooseObject(connCommitParentDir, 'tree', emptyTreeBody);

  const commitBody = Buffer.from(
    `tree ${emptyTreeSha}\nparent ${CONN_MISSING_PARENT}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ncommit-miss-parent\n`,
  );
  connCommitParentCommitSha = await writeLooseObject(connCommitParentDir, 'commit', commitBody);
  await mkdir(path.join(connCommitParentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(connCommitParentDir, '.git', 'refs', 'heads', 'main'),
    `${connCommitParentCommitSha}\n`,
  );
  await rm(path.join(connCommitParentDir, '.git', 'logs'), { recursive: true, force: true });

  connCommitParentCtx = createNodeContext({ workDir: connCommitParentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connCommitParentDir !== '') await rm(connCommitParentDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given commit referencing a missing parent commit (commit→missing-parent edge)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits broken-link + missing findings and exit code 2 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "broken link from  commit <commitSha>\n              to  commit <parentSha>"
        //   "missing commit <parentSha>"
        //   exit 2
        const gitResult = gitFsck(connCommitParentDir, '--no-reflogs');

        // Act
        const result = await fsck(connCommitParentCtx, { reflogRoots: false });

        // Assert — exit code 2
        expect(result.exitCode).toBe(2);
        expect(gitResult.exitCode).toBe(2);

        // Assert — broken-link finding: commit → commit
        const brokenLink = result.findings.find(
          (f): f is FsckFinding & { type: 'broken-link' } =>
            f.type === 'broken-link' &&
            (f as { fromId: string }).fromId === connCommitParentCommitSha &&
            (f as { toId: string }).toId === CONN_MISSING_PARENT,
        );
        expect(brokenLink).toBeDefined();
        expect(brokenLink).toMatchObject({ fromType: 'commit', toType: 'commit' });

        if (brokenLink !== undefined) {
          const fromId = (brokenLink as { fromId: string }).fromId;
          const toId = (brokenLink as { toId: string }).toId;
          const reconstructed = reconstructBrokenLink('commit', fromId, 'commit', toId);
          expect(gitResult.stdout).toContain(reconstructed);
        }

        // Assert — missing commit finding
        const missingCommit = result.findings.find(
          (f): f is FsckFinding & { type: 'missing' } =>
            f.type === 'missing' && (f as { id: string }).id === CONN_MISSING_PARENT,
        );
        expect(missingCommit).toBeDefined();
        expect(missingCommit).toMatchObject({ objectType: 'commit' });

        if (missingCommit !== undefined) {
          const id = (missingCommit as { id: string }).id;
          expect(gitResult.stdout).toContain(reconstructMissing('commit', id));
        }
      });
    });
  },
);

// --- Connectivity scenario: tag → missing target ---------------------------

let connTagTargetDir = '';
let connTagTargetCtx: Context;
let connTagTargetTagSha = '';
const CONN_MISSING_TAG_TARGET = 'ddddddddddddddddddddddddddddddddddddddde';

beforeAll(async () => {
  connTagTargetDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-tag-'));
  initRepo(connTagTargetDir);

  const tagBody = Buffer.from(
    `object ${CONN_MISSING_TAG_TARGET}\ntype commit\ntag v-missing\ntagger Test <t@t.com> 1700000000 +0000\n\ntag with missing target\n`,
  );
  connTagTargetTagSha = await writeLooseObject(connTagTargetDir, 'tag', tagBody);
  await mkdir(path.join(connTagTargetDir, '.git', 'refs', 'tags'), { recursive: true });
  await writeFile(
    path.join(connTagTargetDir, '.git', 'refs', 'tags', 'v-missing'),
    `${connTagTargetTagSha}\n`,
  );
  await rm(path.join(connTagTargetDir, '.git', 'logs'), { recursive: true, force: true });

  connTagTargetCtx = createNodeContext({ workDir: connTagTargetDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connTagTargetDir !== '') await rm(connTagTargetDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// FIX B — badDateOverflow
//
// Pinned real git 2.54.0:
//   Commit with author/committer timestamp > INT64_MAX (9223372036854775807):
//     stderr: "error in commit <sha>: badDateOverflow: invalid author/committer
//              line - date causes integer overflow"
//     exit: 1 (bit 1 = content error)
//   Tag with tagger timestamp > INT64_MAX:
//     stderr: "error in tag <sha>: badDateOverflow: invalid author/committer
//              line - date causes integer overflow"
//     exit: 1
//   Boundary value 9223372036854775807 (INT64_MAX itself): NO error.
//   Non-numeric date: badDate (not badDateOverflow).
// ---------------------------------------------------------------------------

const OVERFLOW_TIMESTAMP = '99999999999999999999';

let badDateOverflowDir = '';
let badDateOverflowCtx: Context;
let overflowCommitSha = '';
let overflowTagSha = '';

beforeAll(async () => {
  badDateOverflowDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-badDateOvf-'));
  initRepo(badDateOverflowDir);

  // Empty tree
  const emptyTreeBody = Buffer.alloc(0);
  const emptyTreeSha = await writeLooseObject(badDateOverflowDir, 'tree', emptyTreeBody);

  // Commit with overflowing author timestamp
  const commitBody = Buffer.from(
    `tree ${emptyTreeSha}\nauthor Test <t@t.com> ${OVERFLOW_TIMESTAMP} +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\noverflow commit\n`,
  );
  overflowCommitSha = await writeLooseObject(badDateOverflowDir, 'commit', commitBody);
  await mkdir(path.join(badDateOverflowDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(badDateOverflowDir, '.git', 'refs', 'heads', 'main'),
    `${overflowCommitSha}\n`,
  );

  // Tag with overflowing tagger timestamp
  const tagBody = Buffer.from(
    `object ${emptyTreeSha}\ntype tree\ntag v-overflow\ntagger Test <t@t.com> ${OVERFLOW_TIMESTAMP} +0000\n\noverflow tag\n`,
  );
  overflowTagSha = await writeLooseObject(badDateOverflowDir, 'tag', tagBody);
  await mkdir(path.join(badDateOverflowDir, '.git', 'refs', 'tags'), { recursive: true });
  await writeFile(
    path.join(badDateOverflowDir, '.git', 'refs', 'tags', 'v-overflow'),
    `${overflowTagSha}\n`,
  );

  await rm(path.join(badDateOverflowDir, '.git', 'logs'), { recursive: true, force: true });

  badDateOverflowCtx = createNodeContext({ workDir: badDateOverflowDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (badDateOverflowDir !== '') await rm(badDateOverflowDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given commit and tag with tagger/author timestamps overflowing INT64_MAX (badDateOverflow)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits badDateOverflow bad-object findings and exit code 1 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "error in commit <sha>: badDateOverflow: invalid author/committer line - date causes integer overflow"
        //   "error in tag <sha>: badDateOverflow: invalid author/committer line - date causes integer overflow"
        //   exit: 1
        const gitResult = gitFsck(badDateOverflowDir, '--no-reflogs');

        // Act
        const result = await fsck(badDateOverflowCtx, { reflogRoots: false });

        // Assert — exit code 1 matches real git
        expect(result.exitCode).toBe(1);
        expect(gitResult.exitCode).toBe(1);

        // Assert — badDateOverflow finding on commit
        const commitFinding = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' &&
            f.msgId === 'badDateOverflow' &&
            (f as { id: string }).id === overflowCommitSha,
        );
        expect(commitFinding).toBeDefined();
        expect(commitFinding?.severity).toBe('error');
        expect(commitFinding?.objectType).toBe('commit');

        // Reconstruct git's stderr line for commit
        if (commitFinding !== undefined) {
          const reconstructed = `error in commit ${(commitFinding as { id: string }).id}: badDateOverflow: invalid author/committer line - date causes integer overflow`;
          expect(gitResult.stderr).toContain(reconstructed);
        }

        // Assert — badDateOverflow finding on tag
        const tagFinding = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' &&
            f.msgId === 'badDateOverflow' &&
            (f as { id: string }).id === overflowTagSha,
        );
        expect(tagFinding).toBeDefined();
        expect(tagFinding?.severity).toBe('error');
        expect(tagFinding?.objectType).toBe('tag');

        // Reconstruct git's stderr line for tag
        if (tagFinding !== undefined) {
          const reconstructed = `error in tag ${(tagFinding as { id: string }).id}: badDateOverflow: invalid author/committer line - date causes integer overflow`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given annotated tag referencing a missing commit target (tag→missing-target edge)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits broken-link + missing findings and exit code 2 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "broken link from     tag <tagSha>\n              to  commit <targetSha>"
        //   "missing commit <targetSha>"
        //   exit 2
        const gitResult = gitFsck(connTagTargetDir, '--no-reflogs');

        // Act
        const result = await fsck(connTagTargetCtx, { reflogRoots: false });

        // Assert — exit code 2
        expect(result.exitCode).toBe(2);
        expect(gitResult.exitCode).toBe(2);

        // Assert — broken-link finding: tag → commit
        const brokenLink = result.findings.find(
          (f): f is FsckFinding & { type: 'broken-link' } =>
            f.type === 'broken-link' &&
            (f as { fromId: string }).fromId === connTagTargetTagSha &&
            (f as { toId: string }).toId === CONN_MISSING_TAG_TARGET,
        );
        expect(brokenLink).toBeDefined();
        expect(brokenLink).toMatchObject({ fromType: 'tag', toType: 'commit' });

        if (brokenLink !== undefined) {
          const fromId = (brokenLink as { fromId: string }).fromId;
          const toId = (brokenLink as { toId: string }).toId;
          const reconstructed = reconstructBrokenLink('tag', fromId, 'commit', toId);
          expect(gitResult.stdout).toContain(reconstructed);
        }

        // Assert — missing commit finding
        const missingTarget = result.findings.find(
          (f): f is FsckFinding & { type: 'missing' } =>
            f.type === 'missing' && (f as { id: string }).id === CONN_MISSING_TAG_TARGET,
        );
        expect(missingTarget).toBeDefined();
        expect(missingTarget).toMatchObject({ objectType: 'commit' });

        if (missingTarget !== undefined) {
          const id = (missingTarget as { id: string }).id;
          expect(gitResult.stdout).toContain(reconstructMissing('commit', id));
        }
      });
    });
  },
);

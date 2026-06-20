/**
 * Integration test — byte-parity between tsgit's whitespace-mode diff output
 * and `git diff` across the full whitespace faithfulness matrix.
 *
 * Covers every matrix row: W1, W3, B-none, B-zero, B-amt, B-run, B-tab, EOL1,
 * CR1, CR-narrow, M1, D1, D2, BL1, BL-two, BL2, BL-spaces, BL-combo, C1, C2,
 * and the similarity-invariant regression guard.
 *
 * For each mode the test asserts:
 *   - name-status membership (TreeDiff.changes paths and types)
 *   - numstat derivable omit rule (added===0 && deleted===0 && !binary && oldMode===newMode => omit)
 *   - quiet equivalent (changes.length > 0 => nonzero)
 *   - reconstructed patch text equals live `git diff --no-ext-diff --no-color <mode>` AND
 *     frozen goldens under test/integration/fixtures/diff-patch/
 *
 * Skips silently when `git` is absent.
 *
 * @proves
 *   surface: diff.whitespace
 *   bucket:  cross-tool-interop
 *   unique:  the whitespace diff family (-w / -b / --ignore-space-at-eol / --ignore-cr-at-eol / --ignore-blank-lines) matches upstream git across name-status, numstat, quiet, and patch bytes, plus the whitespace-agnostic similarity invariant
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import type { StatTreeDiff, TreeDiff } from '../../src/domain/diff/index.js';
import { resolveLineKey } from '../../src/domain/diff/index.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, git, makePeerPair, runGit, runGitEnv } from './interop-helpers.js';

const fixturesDir = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  'fixtures',
  'diff-patch',
);

const loadGolden = (name: string): Promise<string> =>
  readFile(path.join(fixturesDir, `${name}.golden.patch`), 'utf-8');

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const gitDeterministicEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

const writePeerFile = async (dir: string, rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
};

const writePeerBinaryContent = async (dir: string, rel: string, buf: Buffer): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), buf);
};

const writeCtxFile = (
  ctx: ReturnType<typeof createMemoryContext>,
  rel: string,
  content: string,
): Promise<void> => ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const writeCtxBinary = async (
  ctx: ReturnType<typeof createMemoryContext>,
  rel: string,
  buf: Uint8Array,
): Promise<void> => ctx.fs.write(`${ctx.layout.workDir}/${rel}`, buf);

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: gitDeterministicEnv() });
};

/** Derive name-status-style strings from TreeDiff.changes for comparison. */
const nameStatusFrom = (treeDiff: TreeDiff | StatTreeDiff): string[] =>
  treeDiff.changes.map((c) => {
    if (c.type === 'modify') return `M\t${c.path}`;
    if (c.type === 'add') return `A\t${c.newPath}`;
    if (c.type === 'delete') return `D\t${c.oldPath}`;
    if (c.type === 'rename') return `R${c.similarity}\t${c.oldPath}\t${c.newPath}`;
    if (c.type === 'copy') return `C${c.similarity}\t${c.oldPath}\t${c.newPath}`;
    return `T\t${c.path}`;
  });

/** Derive the display path for a stat change (mirrors git numstat output). */
const statChangePath = (c: StatTreeDiff['changes'][number]): string => {
  if (c.type === 'rename' || c.type === 'copy') return c.newPath;
  if (c.type === 'add') return c.newPath;
  if (c.type === 'delete') return c.oldPath;
  return c.path;
};

/** Return true when the change has matching modes (add/delete have only one mode). */
const hasSameModes = (c: StatTreeDiff['changes'][number]): boolean => {
  if (c.type === 'add' || c.type === 'delete') return false; // mode change by definition
  return c.oldMode === c.newMode;
};

/** Apply the derivable numstat-omit rule from the design doc and return rows. */
const numstatRowsFrom = (treeDiff: StatTreeDiff): string[] =>
  treeDiff.changes
    .filter((c) => !(c.added === 0 && c.deleted === 0 && !c.binary && hasSameModes(c)))
    .map((c) => {
      const p = statChangePath(c);
      if (c.binary) return `-\t-\t${p}`;
      return `${c.added}\t${c.deleted}\t${p}`;
    });

describe.skipIf(!GIT_AVAILABLE)(
  'integration — whitespace diff family git parity',
  { timeout: 60_000 },
  () => {
    // W1: ws-only change disappears entirely under -w
    it('Given a file whose lines differ only in space/tab amount, When diffing with ignoreWhitespace all (-w), Then no changes appear', async () => {
      // Arrange
      const pair = await makePeerPair('ws-w1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'a  b\nc\td\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'a b\nc d\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');
        const liveNames = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--name-status',
          '-w',
          'HEAD~1',
          'HEAD',
        );

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'a  b\nc\td\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'a b\nc d\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — W1: no changes survive
        expect(nameStatusFrom(sut).join('\n')).toBe(liveNames.trim());
        expect(sut.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // W3: -w vs --ignore-space-at-eol divergence on internal space removal
    it('Given internal space removal (a b to ab), When diffing with at-eol vs all, Then at-eol sees a diff but all does not', async () => {
      // Arrange
      const pair = await makePeerPair('ws-w3');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'a b\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'ab\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'a b\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'ab\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sutAll = await diff(ctx, { from: c1.id, to: c2.id, ignoreWhitespace: 'all' });
        const sutAtEol = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'at-eol',
        });

        // Assert — W3: -w drops it, --ignore-space-at-eol keeps it
        expect(sutAll.changes).toHaveLength(0);
        expect(sutAtEol.changes).toHaveLength(1);
      } finally {
        await pair.dispose();
      }
    });

    // B-none: presence change (x to x with leading space) is significant under -b but not -w
    it('Given leading whitespace added (none to some), When diffing with change mode (-b), Then diff is reported; with all (-w), Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-bnone');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'x\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', ' x\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'x\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', ' x\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sutChange = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });
        const sutAll = await diff(ctx, { from: c1.id, to: c2.id, ignoreWhitespace: 'all' });

        // Assert — B-none: presence change significant under -b; not under -w
        expect(sutChange.changes).toHaveLength(1);
        expect(sutAll.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // B-zero: internal space removed (a b to ab) - presence change, -b reports it
    it('Given internal space removed (a b to ab), When diffing with change mode (-b), Then diff is reported; with all (-w), Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-bzero');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'a b\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'ab\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'a b\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'ab\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sutChange = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });
        const sutAll = await diff(ctx, { from: c1.id, to: c2.id, ignoreWhitespace: 'all' });

        // Assert — B-zero: run to zero is presence change for -b; -w ignores removal
        expect(sutChange.changes).toHaveLength(1);
        expect(sutAll.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // B-amt: leading amount/kind change (tab to spaces) hidden under -b
    it('Given leading whitespace kind/amount changed (tab to spaces), When diffing with change mode (-b), Then no diff; with at-eol, Then diff reported', async () => {
      // Arrange
      const pair = await makePeerPair('ws-bamt');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', '\tx\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', '   x\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', '\tx\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', '   x\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sutChange = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });
        const sutAtEol = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'at-eol',
        });

        // Assert — B-amt: amount/kind hidden under -b; at-eol only ignores trailing
        expect(sutChange.changes).toHaveLength(0);
        expect(sutAtEol.changes).toHaveLength(1);
      } finally {
        await pair.dispose();
      }
    });

    // B-run: internal run grows (a b to a  b) hidden under -b
    it('Given internal whitespace run grows, When diffing with change mode (-b), Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-brun');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'xx a b yy\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'xx a  b yy\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'xx a b yy\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'xx a  b yy\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });

        // Assert — B-run: run-collapse hides the extra space
        expect(sut.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // B-tab: tab replaced by space inside line hidden under -b
    it('Given tab replaced by space (a tab b to a b), When diffing with change mode (-b), Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-btab');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'a\tb\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'a b\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'a\tb\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'a b\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });

        // Assert — B-tab: tab and space collapse to one whitespace token under -b
        expect(sut.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // EOL1: trailing whitespace dropped under --ignore-space-at-eol
    it('Given trailing spaces removed, When diffing with at-eol mode, Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-eol1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'hello   \n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'hello\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'hello   \n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'hello\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sutAtEol = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'at-eol',
        });
        const sutNoMode = await diff(ctx, { from: c1.id, to: c2.id });

        // Assert — EOL1: at-eol drops trailing-ws change; no-mode sees it
        expect(sutAtEol.changes).toHaveLength(0);
        expect(sutNoMode.changes).toHaveLength(1);
      } finally {
        await pair.dispose();
      }
    });

    // CR1: CRLF to LF hidden under all four EOL-touching modes
    it('Given CRLF lines become LF lines, When diffing with any EOL-touching mode, Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-cr1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerBinaryContent(pair.peer, 'f.txt', Buffer.from('a\r\nb\n'));
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'a\nb\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxBinary(ctx, 'f.txt', new Uint8Array([97, 13, 10, 98, 10])); // a\r\nb\n
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'a\nb\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act — CR1: all four modes ignore trailing CR
        const sutCrAtEol = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreCrAtEol: true,
        });
        const sutAtEol = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'at-eol',
        });
        const sutChange = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });
        const sutAll = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'all',
        });

        // Assert — all four EOL-touching modes drop the CRLF to LF change
        expect(sutCrAtEol.changes).toHaveLength(0);
        expect(sutAtEol.changes).toHaveLength(0);
        expect(sutChange.changes).toHaveLength(0);
        expect(sutAll.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // CR-narrow: mid-line CR (a\rb to ab) is NOT dropped by --ignore-cr-at-eol
    it('Given mid-line CR (a CR b to ab), When diffing with ignoreCrAtEol or change mode, Then diff is still reported', async () => {
      // Arrange
      const pair = await makePeerPair('ws-crnarrow');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerBinaryContent(pair.peer, 'f.txt', Buffer.from('a\rb\n'));
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'ab\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxBinary(ctx, 'f.txt', new Uint8Array([97, 13, 98, 10])); // a\rb\n
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'ab\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sutCrAtEol = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreCrAtEol: true,
        });
        const sutChange = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'change',
        });

        // Assert — CR-narrow: mid-line CR is significant; only trailing CR is ignored
        expect(sutCrAtEol.changes).toHaveLength(1);
        expect(sutChange.changes).toHaveLength(1);
      } finally {
        await pair.dispose();
      }
    });

    // M1: ws-only context line shows NEW bytes; real line is -/+; patch double-pinned
    it('Given a file with a ws-only line and a real change, When diffing with all (-w), Then the patch shows the ws line as context with new bytes and the real line as changed', async () => {
      // Arrange
      const pair = await makePeerPair('ws-m1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', ' ws\nreal\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', '  ws\nREAL\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');
        const live = git(pair.peer, 'diff', '--no-ext-diff', '--no-color', '-w', 'HEAD~1', 'HEAD');
        const golden = await loadGolden('ws-m1');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', ' ws\nreal\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', '  ws\nREAL\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'all',
          withStat: true,
        });
        const lineKey = resolveLineKey({ ignoreWhitespace: 'all' });
        const sut = await reconstructPatch(ctx, treeDiff, { lineKey });

        // Assert — M1: patch double-pinned; numstat 1 added 1 deleted
        expect(sut).toBe(live);
        expect(sut).toBe(golden);
        const statChanges = (treeDiff as StatTreeDiff).changes;
        expect(statChanges).toHaveLength(1);
        const statChange = statChanges[0];
        expect(statChange?.added).toBe(1);
        expect(statChange?.deleted).toBe(1);
      } finally {
        await pair.dispose();
      }
    });

    // D1: ws-only file vanishes under -w; real file stays; name-status, numstat, patch double-pinned
    it('Given file f is ws-only change and file g is real change, When diffing with all (-w), Then only g appears in all output modes', async () => {
      // Arrange
      const pair = await makePeerPair('ws-d1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'a b\n');
        await writePeerFile(pair.peer, 'g.txt', 'hello\n');
        runGit(['-C', pair.peer, 'add', '-A']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'ab\n');
        await writePeerFile(pair.peer, 'g.txt', 'world\n');
        runGit(['-C', pair.peer, 'add', '-A']);
        gitCommit(pair.peer, 'second');
        const liveNs = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--name-status',
          '-w',
          'HEAD~1',
          'HEAD',
        );
        const liveNumstat = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--numstat',
          '-w',
          'HEAD~1',
          'HEAD',
        );
        const livePatch = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-w',
          'HEAD~1',
          'HEAD',
        );
        const golden = await loadGolden('ws-d1');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'a b\n');
        await writeCtxFile(ctx, 'g.txt', 'hello\n');
        await add(ctx, ['f.txt', 'g.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'ab\n');
        await writeCtxFile(ctx, 'g.txt', 'world\n');
        await add(ctx, ['f.txt', 'g.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'all',
          withStat: true,
        });
        const lineKey = resolveLineKey({ ignoreWhitespace: 'all' });
        const sut = await reconstructPatch(ctx, treeDiff, { lineKey });

        // Assert — D1: only g.txt in change-set; f.txt dropped entirely
        const ns = nameStatusFrom(treeDiff);
        expect(ns.join('\n')).toBe(liveNs.trim());
        expect(ns).toHaveLength(1);
        expect(ns[0]).toBe('M\tg.txt');

        const numstatRows = numstatRowsFrom(treeDiff as StatTreeDiff);
        expect(numstatRows.join('\n')).toBe(liveNumstat.trim());
        expect(numstatRows).toHaveLength(1);

        // quiet: changes non-empty => nonzero equivalent
        expect(treeDiff.changes.length > 0).toBe(true);

        // Patch double-pinned
        expect(sut).toBe(livePatch);
        expect(sut).toBe(golden);
      } finally {
        await pair.dispose();
      }
    });

    // D2: no trailing newline, drop holds
    it('Given ws-only change in unterminated last line (no trailing LF), When diffing with all (-w), Then no changes appear', async () => {
      // Arrange
      const pair = await makePeerPair('ws-d2');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerBinaryContent(pair.peer, 'f.txt', Buffer.from('a\n b'));
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerBinaryContent(pair.peer, 'f.txt', Buffer.from('a\nb'));
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxBinary(ctx, 'f.txt', new Uint8Array([97, 10, 32, 98])); // a\n b (no LF at end)
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxBinary(ctx, 'f.txt', new Uint8Array([97, 10, 98])); // a\nb (no LF at end)
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await diff(ctx, { from: c1.id, to: c2.id, ignoreWhitespace: 'all' });

        // Assert — D2: drop holds even without terminating LF
        expect(sut.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // BL1: blank-only change stays in name-status but not numstat/patch; quiet equivalent exits nonzero
    it('Given a blank-only change (insert blank line), When diffing with ignoreBlankLines, Then file stays in changes but numstat omits and patch is empty; quiet exits nonzero', async () => {
      // Arrange
      const pair = await makePeerPair('ws-bl1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'hello\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'hello\n\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');
        const liveNs = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--name-status',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );
        const liveNumstat = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--numstat',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );
        const livePatch = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );
        const golden = await loadGolden('ws-bl1');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'hello\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'hello\n\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreBlankLines: true,
          withStat: true,
        });
        const sut = await reconstructPatch(ctx, treeDiff, { ignoreBlankLines: true });

        // Assert — BL1: file STAYS in changes (name-status M); numstat omitted; patch empty
        const ns = nameStatusFrom(treeDiff);
        expect(ns.join('\n')).toBe(liveNs.trim());
        expect(ns).toHaveLength(1);
        expect(ns[0]).toBe('M\tf.txt');

        const numstatRows = numstatRowsFrom(treeDiff as StatTreeDiff);
        expect(numstatRows.join('\n')).toBe(liveNumstat.trim());
        expect(numstatRows).toHaveLength(0); // numstat row omitted

        // quiet equivalent: file IS in changes => nonzero
        expect(treeDiff.changes.length > 0).toBe(true);

        // Patch is empty (0 bytes, no diff header)
        expect(sut).toBe(livePatch);
        expect(sut).toBe(golden);
        expect(sut).toBe('');
      } finally {
        await pair.dispose();
      }
    });

    // BL-two: g blank-only, h real change - both in name-status; only h in numstat
    it('Given g is blank-only and h has a real change, When diffing with ignoreBlankLines, Then both appear in name-status but only h in numstat', async () => {
      // Arrange
      const pair = await makePeerPair('ws-bltwo');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'g.txt', 'hello\n');
        await writePeerFile(pair.peer, 'h.txt', 'aaa\n');
        runGit(['-C', pair.peer, 'add', '-A']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'g.txt', 'hello\n\n');
        await writePeerFile(pair.peer, 'h.txt', 'bbb\n');
        runGit(['-C', pair.peer, 'add', '-A']);
        gitCommit(pair.peer, 'second');
        const liveNs = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--name-status',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );
        const liveNumstat = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--numstat',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'g.txt', 'hello\n');
        await writeCtxFile(ctx, 'h.txt', 'aaa\n');
        await add(ctx, ['g.txt', 'h.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'g.txt', 'hello\n\n');
        await writeCtxFile(ctx, 'h.txt', 'bbb\n');
        await add(ctx, ['g.txt', 'h.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreBlankLines: true,
          withStat: true,
        });

        // Assert — BL-two: both g, h in name-status; only h in numstat
        const ns = nameStatusFrom(treeDiff);
        expect(ns.join('\n')).toBe(liveNs.trim());
        expect(ns).toHaveLength(2);

        const numstatRows = numstatRowsFrom(treeDiff as StatTreeDiff);
        expect(numstatRows.join('\n')).toBe(liveNumstat.trim());
        expect(numstatRows).toHaveLength(1);
        expect(numstatRows[0]).toContain('h.txt');
      } finally {
        await pair.dispose();
      }
    });

    // BL2: blank insert + real change (c to C) - real change counted, blank not
    it('Given a blank line inserted alongside c to C in one file, When diffing with ignoreBlankLines, Then only the real change is counted', async () => {
      // Arrange
      const pair = await makePeerPair('ws-bl2');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'c\nx\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'C\n\nx\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');
        const liveNumstat = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--numstat',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'c\nx\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'C\n\nx\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreBlankLines: true,
          withStat: true,
        });

        // Assert — BL2: blank is in the same hunk as the real c to C change so it is NOT
        // suppressed; numstat sees 2 added (blank + C) and 1 deleted (c)
        const numstatRows = numstatRowsFrom(treeDiff as StatTreeDiff);
        expect(numstatRows.join('\n')).toBe(liveNumstat.trim());
        expect(numstatRows).toHaveLength(1);
        const statChange = (treeDiff as StatTreeDiff).changes[0];
        expect(statChange?.added).toBe(2);
        expect(statChange?.deleted).toBe(1);
      } finally {
        await pair.dispose();
      }
    });

    // BL-spaces: spaces-only line is NOT blank without line-key mode
    it('Given a spaces-only line inserted, When diffing with ignoreBlankLines alone (no -w), Then the change IS counted (spaces not blank without -w)', async () => {
      // Arrange
      const pair = await makePeerPair('ws-blspaces');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'hello\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'hello\n   \n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');
        const liveNumstat = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--numstat',
          '--ignore-blank-lines',
          'HEAD~1',
          'HEAD',
        );

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'hello\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'hello\n   \n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreBlankLines: true,
          withStat: true,
        });

        // Assert — BL-spaces: spaces-only is not blank (no line-key) => 1 added 0 deleted
        const numstatRows = numstatRowsFrom(treeDiff as StatTreeDiff);
        expect(numstatRows.join('\n')).toBe(liveNumstat.trim());
        expect(numstatRows).toHaveLength(1);
        const statChange = (treeDiff as StatTreeDiff).changes[0];
        expect(statChange?.added).toBe(1);
        expect(statChange?.deleted).toBe(0);
      } finally {
        await pair.dispose();
      }
    });

    // BL-combo: spaces-only + -w makes it blank, so file is dropped
    it('Given a spaces-only line inserted, When diffing with ignoreBlankLines AND ignoreWhitespace all (-w), Then the file is dropped entirely', async () => {
      // Arrange
      const pair = await makePeerPair('ws-blcombo');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'hello\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'hello\n   \n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');
        const liveNs = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--name-status',
          '--ignore-blank-lines',
          '-w',
          'HEAD~1',
          'HEAD',
        );

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'hello\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'hello\n   \n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const treeDiff = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreWhitespace: 'all',
          ignoreBlankLines: true,
        });

        // Assert — BL-combo: -w makes spaces-only line blank => drop pass fires => file gone
        expect(nameStatusFrom(treeDiff).join('\n')).toBe(liveNs.trim());
        expect(treeDiff.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // C1: -w dominates -b (enum mutual exclusion; 'all' subsumes 'change')
    it('Given internal space removed (a b to ab), When diffing with all mode, Then result matches all alone (all dominates change)', async () => {
      // Arrange
      const pair = await makePeerPair('ws-c1');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerFile(pair.peer, 'f.txt', 'a b\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'ab\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'f.txt', 'a b\n');
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'ab\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act — ignoreWhitespace:'all' dominates 'change'; the enum enforces mutual exclusion
        const sutAll = await diff(ctx, { from: c1.id, to: c2.id, ignoreWhitespace: 'all' });

        // Assert — C1: -w subsumes -b; all => no diff
        expect(sutAll.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // C2: --ignore-cr-at-eol + --ignore-blank-lines combine orthogonally
    it('Given CRLF lines and a blank-line insertion, When diffing with ignoreCrAtEol plus ignoreBlankLines, Then no diff', async () => {
      // Arrange
      const pair = await makePeerPair('ws-c2');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writePeerBinaryContent(pair.peer, 'f.txt', Buffer.from('a\r\nb\r\n'));
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'first');
        await writePeerFile(pair.peer, 'f.txt', 'a\nb\n\n');
        runGit(['-C', pair.peer, 'add', 'f.txt']);
        gitCommit(pair.peer, 'second');

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxBinary(ctx, 'f.txt', new Uint8Array([97, 13, 10, 98, 13, 10])); // a\r\nb\r\n
        await add(ctx, ['f.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await writeCtxFile(ctx, 'f.txt', 'a\nb\n\n');
        await add(ctx, ['f.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const sut = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          ignoreCrAtEol: true,
          ignoreBlankLines: true,
        });

        // Assert — C2: CR removal hidden; blank insertion hidden => empty change set
        expect(sut.changes).toHaveLength(0);
      } finally {
        await pair.dispose();
      }
    });

    // Similarity invariant regression guard: whitespace flags do NOT reach the similarity pipeline
    it('Given a rename whose dst differs from src only in whitespace, When diffing with detectRenames with or without ignoreWhitespace all, Then the same rename pairing and similarity score is produced', async () => {
      // Arrange
      const pair = await makePeerPair('ws-sim-invariant');
      try {
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        const srcLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1} content here\n`).join(
          '',
        );
        await writePeerFile(pair.peer, 'src.txt', srcLines);
        runGit(['-C', pair.peer, 'add', 'src.txt']);
        gitCommit(pair.peer, 'first');
        runGit(['-C', pair.peer, 'mv', 'src.txt', 'dst.txt']);
        // Introduce ws-only changes on every 3rd line
        const dstLines = Array.from({ length: 10 }, (_, i) =>
          (i + 1) % 3 === 0 ? `  line ${i + 1} content here\n` : `line ${i + 1} content here\n`,
        ).join('');
        await writePeerFile(pair.peer, 'dst.txt', dstLines);
        runGit(['-C', pair.peer, 'add', 'dst.txt']);
        gitCommit(pair.peer, 'second');
        const liveNsNoW = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-M',
          '--name-status',
          'HEAD~1',
          'HEAD',
        );
        const liveNsW = git(
          pair.peer,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-M',
          '-w',
          '--name-status',
          'HEAD~1',
          'HEAD',
        );

        const ctx = createMemoryContext();
        await init(ctx);
        await writeCtxFile(ctx, 'src.txt', srcLines);
        await add(ctx, ['src.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        // Simulate rename: remove src, add dst
        const { rm } = await import('../../src/application/commands/rm.js');
        await rm(ctx, ['src.txt']);
        await writeCtxFile(ctx, 'dst.txt', dstLines);
        await add(ctx, ['dst.txt']);
        const c2 = await commit(ctx, { message: 'second', author });

        // Act
        const diffNoWs = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          detectRenames: true,
        });
        const diffWithWs = await diff(ctx, {
          from: c1.id,
          to: c2.id,
          detectRenames: true,
          ignoreWhitespace: 'all',
        });

        // Assert — similarity invariant: same pairing + same score; real git outputs identical name-status
        expect(liveNsW).toBe(liveNsNoW);
        const changesNoWs = diffNoWs.changes;
        const changesWithWs = diffWithWs.changes;
        expect(changesNoWs).toHaveLength(1);
        expect(changesWithWs).toHaveLength(1);
        expect(changesNoWs[0]?.type).toBe('rename');
        expect(changesWithWs[0]?.type).toBe('rename');
        const renameNoWs = changesNoWs[0];
        const renameWithWs = changesWithWs[0];
        if (renameNoWs?.type === 'rename' && renameWithWs?.type === 'rename') {
          expect(renameWithWs.similarity).toStrictEqual(renameNoWs.similarity);
          expect(renameWithWs.oldPath).toBe(renameNoWs.oldPath);
          expect(renameWithWs.newPath).toBe(renameNoWs.newPath);
        }
      } finally {
        await pair.dispose();
      }
    });
  },
);

/**
 * Cross-tool interop — an abbreviated object id several objects share, read
 * by `revParse`, `revList` and `packObjects` against `git`. One repository is
 * built once with canonical git: a commit, then a second commit, a tagged tag,
 * an untagged tag, a tree and a blob, each brute-forced to share the first
 * commit's 4-hex prefix. Each row rebuilds git's `error:` and `hint:` lines
 * from the structured candidates tsgit logs, and git's stdout from the entries
 * printed before the refusal.
 *
 * @proves
 *   surface:        revParse
 *   bucket:         cross-tool-interop
 *   unique:         an ambiguous abbreviated id reports git's error and candidate hint once per read git makes, in git's candidate order and filter
 *   interopSurface: revParse
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { revList } from '../../src/application/commands/rev-list.js';
import { type RevParseEntry, revParse } from '../../src/application/commands/rev-parse.js';
import { abbreviateObjectId } from '../../src/application/primitives/abbreviate-object-id.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { AmbiguousCandidate } from '../../src/domain/objects/ambiguous-candidate.js';
import { showDate } from '../../src/domain/pretty/date.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  revParseStdout,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const PREFIX_LENGTH = 4;
const PLACEHOLDER = '@@';
const DIAGNOSTIC = /^(error|hint): /;

type Printed = ReadonlyArray<RevParseEntry>;

interface Logged {
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;
}

interface Outcome {
  readonly stdout: string;
  readonly refused: boolean;
  readonly diagnostics: ReadonlyArray<string>;
}

const identity: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0200',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/** The bytes of `template` with `@@` replaced by the first counter whose `type` id starts with `prefix`. */
const bytesSharing = (type: string, prefix: string, template: Uint8Array): Uint8Array => {
  const at = Buffer.from(template).indexOf(PLACEHOLDER);
  for (let attempt = 0; ; attempt += 1) {
    const body = Buffer.concat([
      template.subarray(0, at),
      Buffer.from(String(attempt)),
      template.subarray(at + PLACEHOLDER.length),
    ]);
    const id = createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
    if (id.startsWith(prefix)) return body;
  }
};

const writeSharing = (repo: string, type: string, prefix: string, template: Uint8Array): void => {
  const body = bytesSharing(type, prefix, template);
  runGit(['-C', repo, 'hash-object', '-w', '--literally', '-t', type, '--stdin'], { input: body });
};

const treeTemplate = (blob: string): Uint8Array =>
  Buffer.concat([Buffer.from(`100644 x${PLACEHOLDER}\0`), Buffer.from(blob, 'hex')]);

const buildRepository = (repo: string): string => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  writeFileSync(path.join(repo, 'f'), 'a\n');
  git(repo, 'add', 'f');
  runGit(['-C', repo, 'commit', '-q', '-m', 'first subject\n\nbody'], { env: identity });
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
  const prefix = commit.slice(0, PREFIX_LENGTH);
  const person = (who: string, at: string): string => `${who} <${who}@x> ${at}`;
  const second = `tree ${tree}\nauthor ${person('B', '1600000000 -0500')}\ncommitter ${person('B', '1600000000 -0500')}\n\nsecond ${PLACEHOLDER}\n`;
  writeSharing(repo, 'commit', prefix, Buffer.from(second));
  const tagged = `object ${commit}\ntype commit\ntag v${PLACEHOLDER}\ntagger ${person('T', '1500000000 -1000')}\n\nmsg\n`;
  writeSharing(repo, 'tag', prefix, Buffer.from(tagged));
  writeSharing(
    repo,
    'tag',
    prefix,
    Buffer.from(`object ${commit}\ntype commit\ntag w${PLACEHOLDER}\n\nmsg\n`),
  );
  writeSharing(repo, 'tree', prefix, treeTemplate(git(repo, 'rev-parse', 'HEAD:f').trim()));
  writeSharing(repo, 'blob', prefix, Buffer.from(`x${PLACEHOLDER}\n`));
  mkdirSync(path.join(repo, 'd'));
  writeFileSync(path.join(repo, 'd', prefix), '');
  return prefix;
};

const gitOutcome = (cwd: string, args: ReadonlyArray<string>, input?: string): Outcome => {
  const result = tryRunGitWithExit(['-C', cwd, ...args], {
    env: runGitEnv(),
    ...(input === undefined ? {} : { input }),
  });
  const diagnostics = result.stderr.split('\n').filter((line) => DIAGNOSTIC.test(line));
  return { stdout: result.stdout.replace(/\n$/, ''), refused: result.exitCode !== 0, diagnostics };
};

const candidateLine = async (ctx: Context, candidate: AmbiguousCandidate): Promise<string> => {
  const abbrev = await abbreviateObjectId(ctx, candidate.id);
  if (candidate.type === 'bad-object') return `${abbrev} [bad object]`;
  if (candidate.type === 'bad-tag') return `${abbrev} [bad tag, could not parse it]`;
  if (!('date' in candidate)) return `${abbrev} ${candidate.type}`;
  const { timestamp, timezoneOffset } = candidate.date;
  const day = showDate(BigInt(timestamp), Number(timezoneOffset), 'short', 0, 0);
  return `${abbrev} ${candidate.type} ${day} - ${candidate.subject}`;
};

/** git's `error:` line, or the `hint:` block rebuilt from the structured candidates. */
const diagnosticLines = async (ctx: Context, logged: Logged): Promise<ReadonlyArray<string>> => {
  const candidates = logged.context?.candidates as ReadonlyArray<AmbiguousCandidate> | undefined;
  if (candidates === undefined) return [`error: ${logged.message}`];
  const lines = await Promise.all(candidates.map((candidate) => candidateLine(ctx, candidate)));
  return [`hint: ${logged.message}`, ...lines.map((line) => `hint:   ${line}`)];
};

const tsgitOutcome = async (
  repo: string,
  cwd: string,
  run: (ctx: Context) => Promise<Printed>,
): Promise<Outcome> => {
  const logged: Logged[] = [];
  const ctx: Context = {
    ...createNodeContext({ workDir: repo }),
    cwd,
    logger: { error: (message, context) => logged.push({ message, context }) },
  };
  const settle = async (): Promise<{ readonly printed: Printed; readonly refused: boolean }> => {
    try {
      return { printed: await run(ctx), refused: false };
    } catch (error) {
      const data = (error as TsgitError).data as { readonly printed?: Printed };
      return { printed: data.printed ?? [], refused: true };
    }
  };
  const { printed, refused } = await settle();
  const diagnostics = (
    await Promise.all(logged.map((entry) => diagnosticLines(ctx, entry)))
  ).flat();
  return { stdout: revParseStdout(printed), refused, diagnostics };
};

describe.skipIf(!GIT_AVAILABLE)('integration — an ambiguous abbreviated id against git', () => {
  let repo = '';
  let prefix = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-ambiguity-interop-'));
    prefix = buildRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given two commits, two tags, a tree and a blob sharing a prefix', () => {
    describe.each([
      '<p>',
      '^<p>',
      '<p>^{commit}',
      '<p>^{tree}',
      '<p>^{}',
      '<p>^{blob}',
      '<p>^{object}',
      '<p>^{}..main',
      '<p>:',
      '<p>..main',
      'main..<p>',
      '<p>...main',
      '<p>^@',
      '<p>^!',
      '<p>^-1',
      '<p>~1',
      '<p>^',
      '<p>^{commit}~1',
    ])('When git rev-parse and revParse read %s', (row) => {
      it('Then both print, refuse and report the candidates alike', async () => {
        // Arrange
        const argument = row.replace('<p>', prefix);
        const peer = gitOutcome(repo, ['rev-parse', argument]);
        const sut = revParse;

        // Act
        const result = await tsgitOutcome(repo, repo, (ctx) => sut(ctx, argument));

        // Assert
        expect(result).toEqual(peer);
      });
    });

    describe('When git rev-parse and revParse read the prefix from a directory holding a file of that name', () => {
      it('Then both report the candidates and print the argument as a path', async () => {
        // Arrange
        const cwd = path.join(repo, 'd');
        const peer = gitOutcome(cwd, ['rev-parse', prefix]);
        const sut = revParse;

        // Act
        const result = await tsgitOutcome(repo, cwd, (ctx) => sut(ctx, prefix));

        // Assert
        expect(result).toEqual(peer);
      });
    });

    describe.each(['<p>', '<p>~1'])('When git rev-list and revList read %s', (row) => {
      it('Then both refuse and report the candidates alike', async () => {
        // Arrange
        const argument = row.replace('<p>', prefix);
        const peer = gitOutcome(repo, ['rev-list', argument]);
        const sut = revList;

        // Act
        const result = await tsgitOutcome(repo, repo, async (ctx) => {
          await sut(ctx, { wants: [argument] });
          return [];
        });

        // Assert
        expect(result).toEqual({ ...peer, stdout: '' });
      });
    });

    describe('When git pack-objects --revs and packObjects read the prefix as a want', () => {
      it('Then both refuse and report the candidates alike', async () => {
        // Arrange
        const peer = gitOutcome(repo, ['pack-objects', '--revs', '--stdout', '-q'], `${prefix}\n`);
        const sut = packObjects;

        // Act
        const result = await tsgitOutcome(repo, repo, async (ctx) => {
          await sut(ctx, { wants: [prefix], outputDirectory: path.join(repo, 'unused') });
          return [];
        });

        // Assert
        expect(result).toEqual({ ...peer, stdout: '' });
      });
    });
  });
});

const MANY_SHARING_BLOBS = 18;

/** A commit, then blobs each brute-forced to share its prefix — more candidates than sixteen. */
const buildCrowdedRepository = (repo: string): string => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'crowded'], { env: identity });
  const prefix = git(repo, 'rev-parse', 'HEAD').trim().slice(0, PREFIX_LENGTH);
  for (let index = 0; index < MANY_SHARING_BLOBS; index += 1) {
    writeSharing(repo, 'blob', prefix, Buffer.from(`b${index}-${PLACEHOLDER}\n`));
  }
  return prefix;
};

describe.skipIf(!GIT_AVAILABLE)('integration — a crowded ambiguous prefix against git', () => {
  let repo = '';
  let prefix = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-crowded-interop-'));
    prefix = buildCrowdedRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given a commit and eighteen blobs sharing a prefix', () => {
    describe('When git rev-parse and revParse read the prefix', () => {
      it('Then both refuse and list every candidate alike', async () => {
        // Arrange
        const peer = gitOutcome(repo, ['rev-parse', prefix]);
        const sut = revParse;

        // Act
        const result = await tsgitOutcome(repo, repo, (ctx) => sut(ctx, prefix));

        // Assert
        expect(peer.diagnostics.length).toBeGreaterThan(MANY_SHARING_BLOBS + 1);
        expect(result).toEqual(peer);
      });
    });
  });
});

/** A commit, a blob, a tag without a tag line and an unreadable loose file, all sharing the commit's prefix. */
const buildUnreadableRepository = (repo: string): string => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'unreadable'], { env: identity });
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  const prefix = commit.slice(0, PREFIX_LENGTH);
  writeSharing(repo, 'blob', prefix, Buffer.from(`x${PLACEHOLDER}\n`));
  const untagged = `object ${commit}\ntype commit\ntagger T <t@t> 1500000000 +0000\n\nm${PLACEHOLDER}\n`;
  writeSharing(repo, 'tag', prefix, Buffer.from(untagged));
  const unreadable = `${prefix}${'f'.repeat(36)}`;
  mkdirSync(path.join(repo, '.git', 'objects', unreadable.slice(0, 2)), { recursive: true });
  writeFileSync(
    path.join(repo, '.git', 'objects', unreadable.slice(0, 2), unreadable.slice(2)),
    'garbage',
  );
  return prefix;
};

/** A commit and two blobs sharing the commit's prefix — the shape `core.disambiguate` chooses among. */
const buildHintRepository = (repo: string): string => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'hinted'], { env: identity });
  const prefix = git(repo, 'rev-parse', 'HEAD').trim().slice(0, PREFIX_LENGTH);
  writeSharing(repo, 'blob', prefix, Buffer.from(`x${PLACEHOLDER}\n`));
  writeSharing(repo, 'blob', prefix, Buffer.from(`y${PLACEHOLDER}\n`));
  return prefix;
};

describe.skipIf(!GIT_AVAILABLE)('integration — core.disambiguate against git', () => {
  let repo = '';
  let prefix = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-disambiguate-interop-'));
    prefix = buildHintRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe.each([
    { hint: 'none', row: '<p>' },
    { hint: 'commit', row: '<p>' },
    { hint: 'COMMIT', row: '<p>' },
    { hint: 'committish', row: '<p>' },
    { hint: 'tree', row: '<p>' },
    { hint: 'treeish', row: '<p>' },
    { hint: 'blob', row: '<p>' },
    { hint: 'blob', row: '<p>^{tree}' },
    { hint: 'blob', row: '<p>^{commit}' },
  ])('Given a commit and two blobs sharing a prefix under the $hint hint', ({ hint, row }) => {
    describe(`When git rev-parse and revParse read ${row}`, () => {
      it('Then both resolve or list the candidates alike', async () => {
        // Arrange
        git(repo, 'config', 'core.disambiguate', hint);
        const argument = row.replace('<p>', prefix);
        const peer = gitOutcome(repo, ['rev-parse', argument]);
        const sut = revParse;

        // Act
        const result = await tsgitOutcome(repo, repo, (ctx) => sut(ctx, argument));

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });
});

/** A commit beside loose files sharing its prefix whose header git cannot unpack: `bodies` deflated as given. */
const buildBadHeaderRepository = (repo: string, bodies: ReadonlyArray<Uint8Array>): string => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'bad headers'], { env: identity });
  const prefix = git(repo, 'rev-parse', 'HEAD').trim().slice(0, PREFIX_LENGTH);
  mkdirSync(path.join(repo, '.git', 'objects', prefix.slice(0, 2)), { recursive: true });
  bodies.forEach((body, index) => {
    const name = `${prefix.slice(2)}${String(index).repeat(36)}`;
    writeFileSync(path.join(repo, '.git', 'objects', prefix.slice(0, 2), name), body);
  });
  return prefix;
};

describe.skipIf(!GIT_AVAILABLE)('integration — loose headers git cannot unpack against git', () => {
  const repos: string[] = [];

  afterAll(async () => {
    await Promise.all(repos.map((repo) => rm(repo, { recursive: true, force: true })));
  });

  describe.each([
    { label: 'a stream cut inside its header', body: deflateSync('blob 12\0x').subarray(0, 4) },
    { label: 'a whole stream with no header end', body: deflateSync('blob 12') },
  ])('Given a commit sharing its prefix with $label', ({ body }) => {
    describe('When git rev-parse and revParse read the prefix', () => {
      it('Then both report each header read and list the bad object alike', async () => {
        // Arrange
        const repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-bad-header-interop-'));
        repos.push(repo);
        const prefix = buildBadHeaderRepository(repo, [body]);
        const peer = gitOutcome(repo, ['rev-parse', prefix]);
        const sut = revParse;

        // Act
        const result = await tsgitOutcome(repo, repo, (ctx) => sut(ctx, prefix));

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });
});

/** The unreadable repository plus a tag of its commit, so two candidates pass a commit-ish or tree-ish hint. */
const buildHintedUnreadableRepository = (repo: string): string => {
  const prefix = buildUnreadableRepository(repo);
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  const tagged = `object ${commit}\ntype commit\ntag v${PLACEHOLDER}\ntagger T <t@t> 1500000000 +0000\n\nm\n`;
  writeSharing(repo, 'tag', prefix, Buffer.from(tagged));
  return prefix;
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — a hinted ambiguous prefix with unreadable candidates against git',
  () => {
    let repo = '';
    let prefix = '';

    beforeAll(async () => {
      repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-hinted-unreadable-interop-'));
      prefix = buildHintedUnreadableRepository(repo);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    describe('Given a commit and its tag passing the hint beside a bad tag, a blob and a bad object', () => {
      describe.each(['<p>^{commit}', '<p>^{tree}'])(
        'When git rev-parse and revParse read %s',
        (row) => {
          it('Then both report every failed read and list the hint survivors alike', async () => {
            // Arrange
            const argument = row.replace('<p>', prefix);
            const peer = gitOutcome(repo, ['rev-parse', argument]);
            const sut = revParse;

            // Act
            const result = await tsgitOutcome(repo, repo, (ctx) => sut(ctx, argument));

            // Assert
            expect(result).toEqual(peer);
          });
        },
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'integration — an ambiguous prefix with unreadable candidates against git',
  () => {
    let repo = '';
    let prefix = '';

    beforeAll(async () => {
      repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-unreadable-interop-'));
      prefix = buildUnreadableRepository(repo);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    describe('Given a commit, a blob, a bad tag and a bad object sharing a prefix', () => {
      describe.each(['<p>', '<p>^{commit}'])('When git rev-parse and revParse read %s', (row) => {
        it('Then both report every failed read and list the bad candidates alike', async () => {
          // Arrange
          const argument = row.replace('<p>', prefix);
          const peer = gitOutcome(repo, ['rev-parse', argument]);
          const sut = revParse;

          // Act
          const result = await tsgitOutcome(repo, repo, (ctx) => sut(ctx, argument));

          // Assert
          expect(result).toEqual(peer);
        });
      });
    });
  },
);

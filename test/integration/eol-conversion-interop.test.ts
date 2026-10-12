/**
 * Cross-tool interop — EOL conversion faithfulness.
 *
 * The git-only goldens come first: canonical git alone reproduces every add
 * cell (blob bytes and `warning:` line count) and every checkout cell
 * (worktree bytes) of the transcribed matrices, and its `core.safecrlf` lines
 * equal the ones rebuilt from structured data. Everything tsgit is compared
 * to is therefore proven against git before tsgit is involved.
 *
 * @proves
 *   surface:        add.eol, checkout.eol
 *   bucket:         cross-tool-interop
 *   unique:         canonical git converts line endings per core.autocrlf, core.eol and attribute exactly as the transcribed matrices record
 *   interopSurface: add, checkout
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { status } from '../../src/application/commands/status.js';
import type { EolNotice } from '../../src/domain/eol/crlf-conversion.js';
import { TsgitError } from '../../src/domain/index.js';
import {
  ADD_MATRIX,
  ATTRIBUTE_COLUMNS,
  blobAt,
  CHECKOUT_MATRIX,
  EDGE_FIXTURES,
  type EolRepoOptions,
  enc,
  expectedBytes,
  findRow,
  HEURISTIC_FIXTURES,
  IDENT_FIXTURES,
  initEolRepo,
  looseObjectIds,
  MATRIX_FIXTURES,
  type MatrixRow,
  reconstructSafecrlfLine,
  SAFECRLF_TRIO,
  setEolConfig,
  writeInfoAttributes,
} from './eol-interop-fixtures.js';
import { GIT_AVAILABLE, git, lsStage, runGit, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 120_000;
const bytesOf = (latin1: string): Uint8Array => new Uint8Array(Buffer.from(latin1, 'latin1'));
const WARNING_PREFIX = 'warning:';
const FIXTURE_NAMES = MATRIX_FIXTURES.map((fixture) => fixture.name);

const attributeLines = (attribute: string | undefined): ReadonlyArray<string> =>
  attribute === undefined ? [] : [`* ${attribute}`];

const writeFixtures = (dir: string): void => {
  for (const { name, bytes } of MATRIX_FIXTURES) writeFileSync(path.join(dir, name), bytes);
};

const rowTitle = (row: MatrixRow<unknown>): string => `autocrlf=${row.autoCrlf} eol=${row.eol}`;

const rowConfig = (row: MatrixRow<unknown>) => ({
  ...(row.autoCrlf === 'unset' ? {} : { autoCrlf: row.autoCrlf }),
  ...(row.eol === 'unset' ? {} : { eol: row.eol }),
});

const countWarnings = (stderr: string): number =>
  stderr.split('\n').filter((line) => line.startsWith(WARNING_PREFIX)).length;

const addColumn = (dir: string, attribute: string | undefined) => {
  writeInfoAttributes(dir, attributeLines(attribute));
  rmSync(path.join(dir, '.git', 'index'), { force: true });
  writeFixtures(dir);
  const result = tryRunGitWithExit(['-C', dir, 'add', ...FIXTURE_NAMES]);
  return {
    exitCode: result.exitCode,
    warnings: countWarnings(result.stderr),
    blobs: FIXTURE_NAMES.map((name) => enc(blobAt(dir, name))),
  };
};

const commitRaw = (dir: string): void => {
  writeFixtures(dir);
  git(dir, 'add', ...FIXTURE_NAMES);
  git(dir, 'commit', '-q', '-m', 'raw');
};

const checkoutColumn = (dir: string, attribute: string | undefined): ReadonlyArray<string> => {
  writeInfoAttributes(dir, attributeLines(attribute));
  for (const name of FIXTURE_NAMES) rmSync(path.join(dir, name));
  git(dir, 'checkout', '--', ...FIXTURE_NAMES);
  return FIXTURE_NAMES.map((name) => enc(new Uint8Array(readFileSync(path.join(dir, name)))));
};

/** Everything one tool did for one `add`: exit class, refusal text, warning count, resulting state. */
interface AddOutcome {
  readonly exitCode: number;
  readonly refusal: string | undefined;
  readonly warnings: number;
}

interface RepoSnapshot {
  readonly stage: string;
  readonly objects: ReadonlyArray<string>;
}

const REFUSED_EXIT_CODE = 128;

const snapshotOf = (dir: string): RepoSnapshot => ({
  stage: lsStage(dir),
  objects: looseObjectIds(dir),
});

const addWithGit = (dir: string, pathspec: ReadonlyArray<string>): AddOutcome => {
  const result = tryRunGitWithExit(['-C', dir, 'add', ...pathspec]);
  return {
    exitCode: result.exitCode,
    refusal: result.exitCode === 0 ? undefined : result.stderr.trim(),
    warnings: countWarnings(result.stderr),
  };
};

const refusalOf = (error: TsgitError): string =>
  error.data.code === 'EOL_ROUND_TRIP_UNSAFE'
    ? reconstructSafecrlfLine(error.data, 'fatal')
    : error.data.code;

const tsgitAdd = async (
  dir: string,
  pathspec: ReadonlyArray<string>,
): Promise<{ readonly outcome: AddOutcome; readonly notices: ReadonlyArray<EolNotice> }> => {
  try {
    const { eolNotices } = await add(createNodeContext({ workDir: dir }), pathspec);
    return {
      outcome: { exitCode: 0, refusal: undefined, warnings: eolNotices.length },
      notices: eolNotices,
    };
  } catch (error) {
    if (!(error instanceof TsgitError)) throw error;
    const outcome = { exitCode: REFUSED_EXIT_CODE, refusal: refusalOf(error), warnings: 0 };
    return { outcome, notices: [] };
  }
};

interface Scenario {
  readonly config?: EolRepoOptions;
  readonly infoAttributes?: ReadonlyArray<string>;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly pathspec: ReadonlyArray<string>;
}

const writeFiles = (dir: string, files: Scenario['files']): void => {
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes);
};

const prepareRepo = (dir: string, scenario: Scenario): void => {
  initEolRepo(dir, { ...scenario.config, infoAttributes: scenario.infoAttributes ?? [] });
  writeFiles(dir, scenario.files);
};

const countCrlf = (bytes: Uint8Array): number =>
  bytes.filter((byte, index) => byte === 0x0a && bytes[index - 1] === 0x0d).length;

const countLoneLf = (bytes: Uint8Array): number =>
  bytes.filter((byte, index) => byte === 0x0a && bytes[index - 1] !== 0x0d).length;

describe.skipIf(!GIT_AVAILABLE)('eol conversion interop', () => {
  let root = '';
  let counter = 0;

  const freshDir = (): string => {
    counter += 1;
    const dir = path.join(root, `repo-${counter}`);
    mkdirSync(dir);
    return dir;
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-eol-interop-')));
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('Given the transcribed matrices', () => {
    describe('When git adds the five fixtures under each config row and attribute column', () => {
      it.each(ADD_MATRIX.map((row) => [rowTitle(row), row] as const))(
        'Then %s matches the add matrix',
        (_title, row) => {
          // Arrange
          const dir = freshDir();
          initEolRepo(dir, rowConfig(row));
          const expected = findRow(ADD_MATRIX, row.autoCrlf, row.eol).cells.map((cell, column) => ({
            exitCode: 0,
            warnings: cell.warnings,
            blobs: MATRIX_FIXTURES.map((fixture, index) =>
              enc(expectedBytes(cell.blobs[index] ?? '=', fixture.bytes)),
            ),
            column: ATTRIBUTE_COLUMNS[column],
          }));

          // Act
          const result = ATTRIBUTE_COLUMNS.map((attribute) => ({
            ...addColumn(dir, attribute),
            column: attribute,
          }));

          // Assert
          expect(result).toEqual(expected);
        },
        SETUP_TIMEOUT,
      );
    });

    describe('When git checks the five committed fixtures out under each config row and attribute column', () => {
      it.each(CHECKOUT_MATRIX.map((row) => [rowTitle(row), row] as const))(
        'Then %s matches the checkout matrix',
        (_title, row) => {
          // Arrange
          const dir = freshDir();
          initEolRepo(dir);
          commitRaw(dir);
          setEolConfig(dir, rowConfig(row));
          const expected = findRow(CHECKOUT_MATRIX, row.autoCrlf, row.eol).cells.map((codes) =>
            MATRIX_FIXTURES.map((fixture, index) =>
              enc(expectedBytes(codes[index] ?? '=', fixture.bytes)),
            ),
          );

          // Act
          const result = ATTRIBUTE_COLUMNS.map((attribute) => checkoutColumn(dir, attribute));

          // Assert
          expect(result).toEqual(expected);
        },
        SETUP_TIMEOUT,
      );
    });
  });

  describe('Given core.safecrlf and the a1/b2/c3 trio under core.autocrlf=true', () => {
    const addTrio = (safeCrlf: 'warn' | 'true') => {
      const dir = freshDir();
      initEolRepo(dir, { autoCrlf: 'true', safeCrlf });
      for (const { name, bytes } of SAFECRLF_TRIO) writeFileSync(path.join(dir, name), bytes);
      return tryRunGitWithExit(['-C', dir, 'add', ...SAFECRLF_TRIO.map(({ name }) => name)]);
    };

    describe('When core.safecrlf is warn', () => {
      it('Then git warns about the LF file with the reconstructed line', () => {
        // Arrange
        const expected = reconstructSafecrlfLine({ path: 'b2', loss: 'lf-to-crlf' }, 'warning');

        // Act
        const result = addTrio('warn');

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr.trim()).toBe(expected);
      });
    });

    describe('When core.safecrlf is true', () => {
      it('Then git dies at the LF file with the reconstructed line', () => {
        // Arrange
        const expected = reconstructSafecrlfLine({ path: 'b2', loss: 'lf-to-crlf' }, 'fatal');

        // Act
        const result = addTrio('true');

        // Assert
        expect(result.exitCode).toBe(128);
        expect(result.stderr.trim()).toBe(expected);
      });
    });

    describe('When core.safecrlf is true and a CRLF file is added under core.autocrlf=input', () => {
      it('Then git dies with the CRLF direction line', () => {
        // Arrange
        const dir = freshDir();
        initEolRepo(dir, { autoCrlf: 'input', safeCrlf: 'true' });
        writeFileSync(path.join(dir, 'a1'), SAFECRLF_TRIO[0]?.bytes ?? new Uint8Array());
        const expected = reconstructSafecrlfLine({ path: 'a1', loss: 'crlf-to-lf' }, 'fatal');

        // Act
        const result = tryRunGitWithExit(['-C', dir, 'add', 'a1']);

        // Assert
        expect(result.exitCode).toBe(128);
        expect(result.stderr.trim()).toBe(expected);
      });
    });
  });

  describe('Given tsgit and git add the same inputs', () => {
    interface Twin {
      readonly gitDir: string;
      readonly tsDir: string;
    }

    const twinRepos = (scenario: Scenario): Twin => {
      const twin = { gitDir: freshDir(), tsDir: freshDir() };
      prepareRepo(twin.gitDir, scenario);
      prepareRepo(twin.tsDir, scenario);
      return twin;
    };

    const addOnBoth = async (twin: Twin, pathspec: ReadonlyArray<string>) => {
      const git = { ...addWithGit(twin.gitDir, pathspec), ...snapshotOf(twin.gitDir) };
      const { outcome, notices } = await tsgitAdd(twin.tsDir, pathspec);
      return { git, tsgit: { ...outcome, ...snapshotOf(twin.tsDir) }, notices };
    };

    const restage = (twin: Twin, files: Scenario['files'], attribute: string | undefined): void => {
      for (const dir of [twin.gitDir, twin.tsDir]) {
        writeInfoAttributes(dir, attributeLines(attribute));
        rmSync(path.join(dir, '.git', 'index'), { force: true });
        writeFiles(dir, files);
      }
    };

    const runColumns = async (
      scenario: Scenario,
      attributes: ReadonlyArray<string | undefined>,
    ) => {
      const twin = twinRepos(scenario);
      const git = [];
      const tsgit = [];
      for (const attribute of attributes) {
        restage(twin, scenario.files, attribute);
        const result = await addOnBoth(twin, scenario.pathspec);
        git.push({ attribute, ...result.git, objects: [] });
        tsgit.push({ attribute, ...result.tsgit, objects: [] });
      }
      return {
        git,
        tsgit,
        objects: snapshotOf(twin.gitDir).objects,
        tsObjects: snapshotOf(twin.tsDir).objects,
      };
    };

    const matrixFiles = Object.fromEntries(MATRIX_FIXTURES.map((f) => [f.name, f.bytes]));

    describe('When the five matrix fixtures are added under each config row and attribute column', () => {
      it.each(ADD_MATRIX.map((row) => [rowTitle(row), row] as const))(
        'Then %s yields the same blobs and as many notices as git has warnings',
        async (_title, row) => {
          // Arrange
          const scenario = { config: rowConfig(row), files: matrixFiles, pathspec: FIXTURE_NAMES };
          const sut = runColumns;

          // Act
          const result = await sut(scenario, ATTRIBUTE_COLUMNS);

          // Assert
          expect(result.tsgit).toEqual(result.git);
          expect(result.tsObjects).toEqual(result.objects);
        },
        SETUP_TIMEOUT,
      );
    });

    describe('When the edge fixtures are added under each attribute', () => {
      const EDGE_ATTRIBUTES = [
        'crlf',
        '-crlf',
        'crlf=input',
        'text=input',
        'text=foo',
        'text=foo crlf',
        'text=auto eol=lf',
        'text=auto eol=crlf',
        '-text eol=crlf',
        'binary text',
        'text eol=crlf',
      ];

      it('Then every blob equals the one git stages', async () => {
        // Arrange
        const files = { ...matrixFiles, ...EDGE_FIXTURES };
        const scenario = { files, pathspec: Object.keys(files) };
        const sut = runColumns;

        // Act
        const result = await sut(scenario, EDGE_ATTRIBUTES);

        // Assert
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When the empty file is added under text eol=crlf with core.safecrlf=true', () => {
      it('Then both succeed with the empty blob', async () => {
        // Arrange
        const scenario = {
          config: { safeCrlf: 'true' as const },
          infoAttributes: ['* text eol=crlf'],
          files: { empty: new Uint8Array() },
          pathspec: ['empty'],
        };
        const sut = addOnBoth;

        // Act
        const result = await sut(twinRepos(scenario), scenario.pathspec);

        // Assert
        expect(result.git.exitCode).toBe(0);
        expect(result.git.stage).toContain('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When a symlink is added under text eol=crlf ident', () => {
      it('Then both stage the raw target', async () => {
        // Arrange
        const target = 'a\r\nb\n$Id$';
        const scenario = { infoAttributes: ['* text eol=crlf ident'], files: {}, pathspec: ['l'] };
        const twin = twinRepos(scenario);
        symlinkSync(target, path.join(twin.gitDir, 'l'));
        symlinkSync(target, path.join(twin.tsDir, 'l'));
        const sut = addOnBoth;

        // Act
        const result = await sut(twin, scenario.pathspec);

        // Assert
        expect(enc(blobAt(twin.tsDir, 'l'))).toBe(enc(bytesOf(target)));
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When the binary heuristic fixtures are added under text=auto', () => {
      it('Then every blob equals the one git stages', async () => {
        // Arrange
        const scenario = {
          infoAttributes: ['* text=auto'],
          files: HEURISTIC_FIXTURES,
          pathspec: Object.keys(HEURISTIC_FIXTURES),
        };
        const sut = addOnBoth;

        // Act
        const result = await sut(twinRepos(scenario), scenario.pathspec);

        // Assert
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When the ident fixtures are added under ident', () => {
      it('Then every collapsed blob equals the one git stages', async () => {
        // Arrange
        const scenario = {
          infoAttributes: ['* ident'],
          files: IDENT_FIXTURES,
          pathspec: Object.keys(IDENT_FIXTURES),
        };
        const sut = addOnBoth;

        // Act
        const result = await sut(twinRepos(scenario), scenario.pathspec);

        // Assert
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When a committed CRLF blob is re-staged with a new CRLF line', () => {
      const INDEX_RULE_ROWS: ReadonlyArray<readonly [string, EolRepoOptions, string | undefined]> =
        [
          ['text=auto', {}, 'text=auto'],
          ['core.autocrlf=true', { autoCrlf: 'true' }, undefined],
          ['core.autocrlf=input', { autoCrlf: 'input' }, undefined],
          ['text', {}, 'text'],
          ['text=auto eol=crlf', {}, 'text=auto eol=crlf'],
        ];

      it.each(INDEX_RULE_ROWS)(
        'Then %s matches git',
        async (_title, config, attribute) => {
          // Arrange
          const twin = twinRepos({ files: { f: bytesOf('a\r\nb\r\n') }, pathspec: ['f'] });
          for (const dir of [twin.gitDir, twin.tsDir]) {
            git(dir, 'add', 'f');
            setEolConfig(dir, config);
            writeInfoAttributes(dir, attributeLines(attribute));
          }
          writeFiles(twin.gitDir, { f: bytesOf('a\r\nb\r\nc\r\n') });
          writeFiles(twin.tsDir, { f: bytesOf('a\r\nb\r\nc\r\n') });
          const sut = addOnBoth;

          // Act
          const result = await sut(twin, ['f']);

          // Assert
          expect(result.tsgit).toEqual(result.git);
        },
        SETUP_TIMEOUT,
      );
    });

    describe('When core.safecrlf varies over one file per direction', () => {
      const DIRECTIONS = [
        { name: 'lf', bytes: bytesOf('a\nb\n'), config: { autoCrlf: 'true' }, attributes: [] },
        {
          name: 'crlf',
          bytes: bytesOf('a\r\nb\r\n'),
          config: { autoCrlf: 'input' },
          attributes: [],
        },
        { name: 'mixed', bytes: bytesOf('a\r\nb\n'), config: { autoCrlf: 'true' }, attributes: [] },
        {
          name: 'crlf-attr',
          bytes: bytesOf('a\r\nb\r\n'),
          config: {},
          attributes: ['crlf-attr eol=lf'],
        },
      ] as const;
      const SAFE_VALUES = [undefined, 'warn', 'false', 'true'] as const;
      const CASES = DIRECTIONS.flatMap((direction) =>
        SAFE_VALUES.map((safeCrlf) => [direction.name, safeCrlf, direction] as const),
      );

      it.each(CASES)(
        'Then %s with core.safecrlf=%s matches git and carries the fixture counts',
        async (_name, safeCrlf, direction) => {
          // Arrange
          const scenario: Scenario = {
            config: { ...direction.config, ...(safeCrlf === undefined ? {} : { safeCrlf }) },
            infoAttributes: direction.attributes,
            files: { [direction.name]: direction.bytes },
            pathspec: [direction.name],
          };
          const sut = addOnBoth;

          // Act
          const result = await sut(twinRepos(scenario), scenario.pathspec);

          // Assert
          expect(result.tsgit).toEqual(result.git);
          const counts = result.notices.map(({ crlf, loneLf }) => ({ crlf, loneLf }));
          if (safeCrlf !== 'false' && safeCrlf !== 'true') {
            expect(counts).toEqual([
              { crlf: countCrlf(direction.bytes), loneLf: countLoneLf(direction.bytes) },
            ]);
          }
        },
        SETUP_TIMEOUT,
      );
    });

    describe('When core.safecrlf=true refuses b2 in the literal add a1 b2 c3', () => {
      it('Then the index and the loose objects equal git and c3 is never hashed', async () => {
        // Arrange
        const scenario: Scenario = {
          config: { autoCrlf: 'true', safeCrlf: 'true' },
          files: Object.fromEntries(SAFECRLF_TRIO.map((f) => [f.name, f.bytes])),
          pathspec: ['a1', 'b2', 'c3'],
        };
        const sut = addOnBoth;

        // Act
        const result = await sut(twinRepos(scenario), scenario.pathspec);

        // Assert
        expect(result.git.exitCode).toBe(REFUSED_EXIT_CODE);
        expect(result.git.stage).toBe('');
        expect(result.git.objects).toHaveLength(1);
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When core.safecrlf=true refuses b2 in the bulk add .', () => {
      it('Then the refusal names b2 and the index and loose objects equal git with a1 only', async () => {
        // Arrange
        const scenario: Scenario = {
          config: { autoCrlf: 'true', safeCrlf: 'true' },
          files: Object.fromEntries(SAFECRLF_TRIO.map((f) => [f.name, f.bytes])),
          pathspec: ['.'],
        };
        const sut = addOnBoth;

        // Act
        const result = await sut(twinRepos(scenario), scenario.pathspec);

        // Assert
        expect(result.git.exitCode).toBe(REFUSED_EXIT_CODE);
        expect(result.git.refusal).toBe(
          reconstructSafecrlfLine({ path: 'b2', loss: 'lf-to-crlf' }, 'fatal'),
        );
        expect(result.git.stage).toBe('');
        expect(result.git.objects).toHaveLength(1);
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When core.autocrlf or core.safecrlf is not a boolean', () => {
      const BAD_VALUES = [
        ['core.autocrlf', 'foo'],
        ['core.safecrlf', 'foo'],
      ] as const;

      it.each(BAD_VALUES)('Then %s=%s refuses add and status on both tools', async (key, value) => {
        // Arrange
        const twin = twinRepos({ files: { f: bytesOf('x\n') }, pathspec: ['f'] });
        for (const dir of [twin.gitDir, twin.tsDir]) runGit(['-C', dir, 'config', key, value]);
        const tsContext = () => createNodeContext({ workDir: twin.tsDir });
        const wasRefused = (run: () => Promise<unknown>): Promise<boolean> =>
          run().then(
            () => false,
            (error: unknown) => error instanceof TsgitError,
          );
        const sut = wasRefused;

        // Act
        const refused = {
          add: await sut(() => add(tsContext(), ['f'])),
          status: await sut(() => status(tsContext())),
        };

        // Assert
        expect(tryRunGitWithExit(['-C', twin.gitDir, 'add', 'f']).exitCode).toBe(REFUSED_EXIT_CODE);
        expect(tryRunGitWithExit(['-C', twin.gitDir, 'status']).exitCode).toBe(REFUSED_EXIT_CODE);
        expect(refused).toEqual({ add: true, status: true });
      });

      it('Then core.eol=foo is accepted by both tools', async () => {
        // Arrange
        const twin = twinRepos({ files: { f: bytesOf('x\n') }, pathspec: ['f'] });
        for (const dir of [twin.gitDir, twin.tsDir])
          runGit(['-C', dir, 'config', 'core.eol', 'foo']);
        const sut = addOnBoth;

        // Act
        const result = await sut(twin, ['f']);

        // Assert
        expect(result.git.exitCode).toBe(0);
        expect(result.tsgit).toEqual(result.git);
      });
    });
  });

  describe('Given tsgit and git renormalize the same committed CRLF files', () => {
    const CRLF_TWO = bytesOf('a\r\nb\r\n');
    const CRLF_THREE = bytesOf('a\r\nb\r\nz\r\n');

    interface RenormalizeState {
      readonly stage: string;
      readonly tags: string;
      readonly objects: ReadonlyArray<string>;
      readonly worktree: Readonly<Record<string, string>>;
    }

    const committedTwin = (files: Scenario['files']): { gitDir: string; tsDir: string } => {
      const twin = { gitDir: freshDir(), tsDir: freshDir() };
      for (const dir of [twin.gitDir, twin.tsDir]) {
        initEolRepo(dir, { infoAttributes: [] });
        for (const [name, bytes] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
          writeFileSync(path.join(dir, name), bytes);
        }
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'raw');
        writeInfoAttributes(dir, ['* text=auto']);
      }
      return twin;
    };

    const stateOf = (dir: string, names: ReadonlyArray<string>): RenormalizeState => ({
      stage: lsStage(dir),
      tags: git(dir, 'ls-files', '-t'),
      objects: looseObjectIds(dir),
      worktree: Object.fromEntries(
        names.map((name) => [name, readFileSync(path.join(dir, name)).toString('latin1')]),
      ),
    });

    const renormalizeOnBoth = async (
      twin: { gitDir: string; tsDir: string },
      pathspec: ReadonlyArray<string>,
      names: ReadonlyArray<string>,
    ) => {
      const gitRun = tryRunGitWithExit(['-C', twin.gitDir, 'add', '--renormalize', ...pathspec]);
      const result = await add(createNodeContext({ workDir: twin.tsDir }), pathspec, {
        renormalize: true,
      });
      return {
        gitExit: gitRun.exitCode,
        git: stateOf(twin.gitDir, names),
        tsgit: stateOf(twin.tsDir, names),
        result,
      };
    };

    describe('When text=auto is set after the commit and add --renormalize . runs', () => {
      it('Then both stage the LF blob aNbNzN', async () => {
        // Arrange
        const twin = committedTwin({ f: CRLF_THREE });
        const sut = renormalizeOnBoth;

        // Act
        const result = await sut(twin, ['.'], ['f']);

        // Assert
        expect(result.gitExit).toBe(0);
        expect(result.tsgit).toEqual(result.git);
        expect(enc(blobAt(twin.tsDir, 'f'))).toBe(enc(bytesOf('a\nb\nz\n')));
        expect(result.result.modified).toEqual(['f']);
      });
    });

    describe('When status is clean under the new text=auto and add --renormalize . then runs', () => {
      it('Then git stages M and tsgit stages the same blob', async () => {
        // Arrange
        const twin = committedTwin({ f: CRLF_TWO });
        const statusBefore = git(twin.gitDir, 'status', '--short');
        const sut = renormalizeOnBoth;

        // Act
        const result = await sut(twin, ['.'], ['f']);

        // Assert
        // tsgit's own status reads the attributes only from the status-conversion part on;
        // here the git side and the staged entry id of both tools are compared.
        expect(statusBefore).toBe('');
        expect(git(twin.gitDir, 'status', '--short')).toBe('M  f\n');
        expect(result.tsgit.stage).toBe(result.git.stage);
      });
    });

    describe('When add --renormalize . runs on a CRLF blob under text=auto', () => {
      it('Then it exits 0 with the LF blob in both tools', async () => {
        // Arrange
        const twin = committedTwin({ f: CRLF_TWO });
        const sut = renormalizeOnBoth;

        // Act
        const result = await sut(twin, ['.'], ['f']);

        // Assert
        expect(result.gitExit).toBe(0);
        expect(enc(blobAt(twin.gitDir, 'f'))).toBe(enc(bytesOf('a\nb\n')));
        expect(result.tsgit).toEqual(result.git);
      });
    });

    describe('When the tree holds a sparse cone, a modified file and an untracked file', () => {
      it('Then skip-worktree entries stay, m is renormalized, u is not staged, the worktree is untouched', async () => {
        // Arrange
        const files = { 'in/f': CRLF_TWO, 'out/f': CRLF_TWO, m: CRLF_TWO };
        const twin = committedTwin(files);
        for (const dir of [twin.gitDir, twin.tsDir]) {
          git(dir, 'sparse-checkout', 'set', '--cone', 'in');
          writeFileSync(path.join(dir, 'm'), CRLF_THREE);
          writeFileSync(path.join(dir, 'u'), CRLF_TWO);
        }
        const sut = renormalizeOnBoth;

        // Act
        const result = await sut(twin, ['.'], ['in/f', 'm', 'u']);

        // Assert
        expect(result.gitExit).toBe(0);
        expect(result.tsgit).toEqual(result.git);
        expect(result.tsgit.tags).toContain('S out/f');
        expect(enc(blobAt(twin.tsDir, 'm'))).toBe(enc(bytesOf('a\nb\nz\n')));
        expect(result.tsgit.worktree).toEqual({
          'in/f': 'a\r\nb\r\n',
          m: 'a\r\nb\r\nz\r\n',
          u: 'a\r\nb\r\n',
        });
      });
    });

    describe('When a tracked file named by the pathspec is gone from the worktree', () => {
      it('Then both tools refuse and leave the index alone', async () => {
        // Arrange
        const twin = committedTwin({ f: CRLF_TWO, g: CRLF_TWO });
        for (const dir of [twin.gitDir, twin.tsDir]) rmSync(path.join(dir, 'g'));
        const stageBefore = lsStage(twin.tsDir);
        const gitRun = tryRunGitWithExit(['-C', twin.gitDir, 'add', '--renormalize', '.']);
        let code: string | undefined;

        // Act
        try {
          await add(createNodeContext({ workDir: twin.tsDir }), ['.'], { renormalize: true });
        } catch (error) {
          code = error instanceof TsgitError ? error.data.code : undefined;
        }

        // Assert
        expect(gitRun.exitCode).toBe(REFUSED_EXIT_CODE);
        expect(code).toBe('PATHSPEC_NO_MATCH');
        expect(lsStage(twin.gitDir)).toBe(stageBefore);
        expect(lsStage(twin.tsDir)).toBe(stageBefore);
      });
    });

    describe('When the pathspec is empty', () => {
      it('Then git prints Nothing specified and exits 0 while tsgit keeps its EMPTY_PATHSPEC refusal', async () => {
        // Arrange
        const twin = committedTwin({ f: CRLF_TWO });
        const gitRun = tryRunGitWithExit(['-C', twin.gitDir, 'add', '--renormalize']);
        let code: string | undefined;

        // Act
        try {
          await add(createNodeContext({ workDir: twin.tsDir }), [], { renormalize: true });
        } catch (error) {
          code = error instanceof TsgitError ? error.data.code : undefined;
        }

        // Assert
        expect(gitRun.exitCode).toBe(0);
        expect(gitRun.stderr).toContain('Nothing specified, nothing added.');
        expect(code).toBe('EMPTY_PATHSPEC');
      });
    });

    describe('When -A is combined with renormalize and an untracked file exists', () => {
      it('Then neither tool stages the untracked file', async () => {
        // Arrange
        const twin = committedTwin({ f: CRLF_TWO });
        for (const dir of [twin.gitDir, twin.tsDir]) writeFileSync(path.join(dir, 'u'), CRLF_TWO);
        const gitRun = tryRunGitWithExit(['-C', twin.gitDir, 'add', '--renormalize', '-A']);

        // Act
        await add(createNodeContext({ workDir: twin.tsDir }), [], { all: true, renormalize: true });

        // Assert
        expect(gitRun.exitCode).toBe(0);
        expect(lsStage(twin.tsDir)).toBe(lsStage(twin.gitDir));
        expect(lsStage(twin.tsDir)).not.toContain('\tu');
      });
    });
  });
});

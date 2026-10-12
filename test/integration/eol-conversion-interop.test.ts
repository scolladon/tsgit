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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADD_MATRIX,
  ATTRIBUTE_COLUMNS,
  blobAt,
  CHECKOUT_MATRIX,
  enc,
  expectedBytes,
  findRow,
  initEolRepo,
  MATRIX_FIXTURES,
  type MatrixRow,
  reconstructSafecrlfLine,
  SAFECRLF_TRIO,
  setEolConfig,
  writeInfoAttributes,
} from './eol-interop-fixtures.js';
import { GIT_AVAILABLE, git, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 120_000;
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
});

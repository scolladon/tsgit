import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  isRegularFileVia,
  lookupWindowsProgram,
  programNotFound,
  programResolverFor,
  realProgramLookupHost,
  windowsCommandInterpreter,
} from '../../../../src/adapters/node/windows-program-lookup.js';

const hostWith = (path: string | undefined, files: ReadonlyArray<string>) => ({
  env: path === undefined ? {} : { PATH: path },
  isFile: (candidate: string): boolean => files.includes(candidate),
});

describe('lookupWindowsProgram', () => {
  describe('Given a bare name present in a later PATH entry and in the working directory', () => {
    describe('When looked up', () => {
      it('Then resolves to the PATH entry, never the working directory', () => {
        // Arrange
        const host = hostWith('C:\\empty;C:\\gnupg\\bin', [
          'C:\\repo\\gpg.exe',
          'C:\\gnupg\\bin\\gpg.exe',
        ]);
        const sut = lookupWindowsProgram;

        // Act
        const result = sut('gpg', host);

        // Assert
        expect(result).toBe('C:\\gnupg\\bin\\gpg.exe');
      });
    });
  });

  describe('Given a PATH entry holding both `<name>.exe` and the bare name', () => {
    describe('When looked up', () => {
      it('Then prefers `<name>.exe`', () => {
        // Arrange
        const host = hostWith('C:\\bin', ['C:\\bin\\gpg', 'C:\\bin\\gpg.exe']);
        const sut = lookupWindowsProgram;

        // Act
        const result = sut('gpg', host);

        // Assert
        expect(result).toBe('C:\\bin\\gpg.exe');
      });
    });
  });

  describe('Given a PATH entry holding only the bare name', () => {
    describe('When looked up', () => {
      it('Then resolves to the bare name in that entry', () => {
        // Arrange
        const host = hostWith('C:\\bin', ['C:\\bin\\gpg']);
        const sut = lookupWindowsProgram;

        // Act
        const result = sut('gpg', host);

        // Assert
        expect(result).toBe('C:\\bin\\gpg');
      });
    });
  });

  describe('Given a name already ending in `.EXE`', () => {
    describe('When looked up', () => {
      it('Then looks for that name alone, adding no second suffix', () => {
        // Arrange
        const visited: string[] = [];
        const host = {
          env: { PATH: 'C:\\bin' },
          isFile: (candidate: string): boolean => {
            visited.push(candidate);
            return false;
          },
        };
        const sut = lookupWindowsProgram;

        // Act
        const result = sut('gpg2.EXE', host);

        // Assert
        expect(result).toBeUndefined();
        expect(visited).toEqual(['C:\\bin\\gpg2.EXE']);
      });
    });
  });

  describe('Given empty PATH entries', () => {
    describe('When looked up', () => {
      it('Then skips them rather than searching the working directory', () => {
        // Arrange
        const visited: string[] = [];
        const host = {
          env: { PATH: ';C:\\bin;' },
          isFile: (candidate: string): boolean => {
            visited.push(candidate);
            return false;
          },
        };
        const sut = lookupWindowsProgram;

        // Act
        sut('gpg', host);

        // Assert
        expect(visited).toEqual(['C:\\bin\\gpg.exe', 'C:\\bin\\gpg']);
      });
    });
  });

  describe('Given no PATH at all', () => {
    describe('When looked up', () => {
      it('Then finds nothing', () => {
        // Arrange
        const host = hostWith(undefined, ['gpg.exe']);
        const sut = lookupWindowsProgram;

        // Act
        const result = sut('gpg', host);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each(['C:\\tools\\gpg.exe', 'tools/gpg'])(
    'Given the name %s carrying a path separator',
    (program) => {
      describe('When looked up', () => {
        it('Then uses it as given', () => {
          // Arrange
          const host = hostWith('C:\\bin', []);
          const sut = lookupWindowsProgram;

          // Act
          const result = sut(program, host);

          // Assert
          expect(result).toBe(program);
        });
      });
    },
  );
});

describe('windowsCommandInterpreter', () => {
  describe.each([
    {
      env: { ComSpec: 'D:\\Win\\system32\\cmd.exe', SystemRoot: 'C:\\Windows' },
      expected: 'D:\\Win\\system32\\cmd.exe',
      label: 'an absolute ComSpec is used as is',
    },
    {
      env: { ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' },
      expected: 'D:\\Win\\System32\\cmd.exe',
      label: 'a relative ComSpec falls back to the SystemRoot interpreter',
    },
    {
      env: { SystemRoot: 'D:\\Win' },
      expected: 'D:\\Win\\System32\\cmd.exe',
      label: 'a missing ComSpec falls back to the SystemRoot interpreter',
    },
    {
      env: { SystemRoot: 'Win' },
      expected: 'C:\\Windows\\System32\\cmd.exe',
      label: 'a relative SystemRoot falls back to the default Windows directory',
    },
    {
      env: {},
      expected: 'C:\\Windows\\System32\\cmd.exe',
      label: 'neither variable falls back to the default Windows directory',
    },
  ])('Given an environment where $label', ({ env, expected }) => {
    describe('When the interpreter is chosen', () => {
      it('Then it is that absolute path', () => {
        // Arrange
        const sut = windowsCommandInterpreter;

        // Act
        const result = sut(env);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('realProgramLookupHost', () => {
  describe.each([
    { path: fileURLToPath(import.meta.url), expected: true, label: 'a regular file' },
    { path: fileURLToPath(new URL('.', import.meta.url)), expected: false, label: 'a directory' },
    {
      path: fileURLToPath(new URL('missing.exe', import.meta.url)),
      expected: false,
      label: 'a missing path',
    },
  ])('Given $label', ({ path, expected }) => {
    describe('When asked whether it is a file', () => {
      it(`Then answers ${expected}`, () => {
        // Arrange
        const sut = realProgramLookupHost.isFile;

        // Act
        const result = sut(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the production host', () => {
    describe('When its environment is read', () => {
      it('Then it is the live process environment', () => {
        // Arrange
        const sut = realProgramLookupHost;

        // Act
        const result = sut.env;

        // Assert
        expect(result).toBe(process.env);
      });
    });
  });
});

describe('isRegularFileVia', () => {
  const failingWith = (code: string) => (): never => {
    throw Object.assign(new Error(`stat ${code}`), { code });
  };

  describe.each(['EACCES', 'EPERM', 'ENAMETOOLONG'])(
    'Given a candidate whose stat fails with %s',
    (code) => {
      describe('When probed', () => {
        it('Then it is no program, so the search moves on', () => {
          // Arrange
          const stat = failingWith(code);
          const sut = isRegularFileVia;

          // Act
          const result = sut(stat)('C:\\locked\\ssh.exe');

          // Assert
          expect(result).toBe(false);
        });
      });
    },
  );

  describe('Given a candidate whose stat fails with an error carrying no code', () => {
    describe('When probed', () => {
      it('Then that error propagates', () => {
        // Arrange
        const failure = new Error('stat failed');
        const stat = (): never => {
          throw failure;
        };
        const sut = isRegularFileVia;

        // Act
        const result = (() => {
          try {
            return sut(stat)('C:\\bin\\ssh.exe');
          } catch (error) {
            return error;
          }
        })();

        // Assert
        expect(result).toBe(failure);
      });
    });
  });

  describe('Given a candidate whose stat fails with any other error', () => {
    describe('When probed', () => {
      it('Then that error propagates', () => {
        // Arrange
        const stat = failingWith('EIO');
        const sut = isRegularFileVia;

        // Act
        const result = (() => {
          try {
            return sut(stat)('C:\\bin\\ssh.exe');
          } catch (error) {
            return error;
          }
        })();

        // Assert
        expect((result as NodeJS.ErrnoException).code).toBe('EIO');
      });
    });
  });
});

describe('programResolverFor', () => {
  describe('Given the win32 platform and a program held by a PATH entry', () => {
    describe('When a bare name is resolved', () => {
      it('Then it resolves to that PATH entry', () => {
        // Arrange
        const host = hostWith('C:\\bin', ['C:\\bin\\ssh.exe']);
        const sut = programResolverFor;

        // Act
        const result = sut('win32', host)('ssh');

        // Assert
        expect(result).toBe('C:\\bin\\ssh.exe');
      });
    });
  });

  describe('Given a POSIX platform and a program no PATH entry holds', () => {
    describe('When a bare name is resolved', () => {
      it('Then it is left as given for the spawn to search', () => {
        // Arrange
        const host = hostWith('/usr/bin', []);
        const sut = programResolverFor;

        // Act
        const result = sut('linux', host)('ssh');

        // Assert
        expect(result).toBe('ssh');
      });
    });
  });
});

describe('programNotFound', () => {
  describe('Given a program name', () => {
    describe('When its start failure is built', () => {
      it('Then the error names the program and the PATH search', () => {
        // Arrange
        const sut = programNotFound;

        // Act
        const result = sut('ssh');

        // Assert
        expect(result.message).toBe('cannot run ssh: not found on PATH');
      });
    });
  });
});
